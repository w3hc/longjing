import { createHash } from 'crypto';

// TDX quote v4: 48-byte header, then the TD report body
const QUOTE_HEADER_LENGTH = 48;
const MEASUREMENT_LENGTH = 48;
const TDX_QUOTE_MRTD_OFFSET = QUOTE_HEADER_LENGTH + 136;
const TDX_QUOTE_RTMR_OFFSETS = [328, 376, 424, 472].map(
  (offset) => QUOTE_HEADER_LENGTH + offset,
);
const TDX_QUOTE_BODY_END = QUOTE_HEADER_LENGTH + 584;

/** Event type dstack uses for the runtime events it extends RTMR3 with. */
export const DSTACK_RUNTIME_EVENT_TYPE = 0x08000001;

/** One entry of the dstack event log. */
export interface TdxEvent {
  imr: number;
  event_type: number;
  /** Hex SHA-384 digest extended into the RTMR. */
  digest: string;
  /** Name of a dstack runtime event, such as `compose-hash`. */
  event: string;
  /** Hex payload of a dstack runtime event. */
  event_payload: string;
}

/** Hex measurements read from a TDX quote. */
export interface TdxMeasurements {
  mrtd: string;
  rtmrs: [string, string, string, string];
}

/**
 * Reads MRTD and RTMR0–3 from a TDX quote.
 */
export function parseTdxMeasurements(quote: Buffer): TdxMeasurements {
  if (quote.length < TDX_QUOTE_BODY_END) {
    throw new Error(`TDX quote too short: ${quote.length} bytes`);
  }
  const measurement = (offset: number) =>
    quote.subarray(offset, offset + MEASUREMENT_LENGTH).toString('hex');
  const [rtmr0, rtmr1, rtmr2, rtmr3] = TDX_QUOTE_RTMR_OFFSETS.map(measurement);
  return {
    mrtd: measurement(TDX_QUOTE_MRTD_OFFSET),
    rtmrs: [rtmr0, rtmr1, rtmr2, rtmr3],
  };
}

/**
 * Replays RTMR0–3 from the event log: each RTMR starts at 48 zero bytes and
 * every event extends it as RTMR = SHA-384(RTMR || digest). A dstack runtime
 * event must also carry the digest of its own name and payload, so its
 * payload (the compose hash, for one) can be trusted once the RTMRs match.
 * @param eventLog The event log as returned by dstack, a JSON array
 * @returns The four replayed RTMRs, hex
 */
export function replayRtmrs(
  eventLog: string,
): [string, string, string, string] {
  const events = JSON.parse(eventLog) as TdxEvent[];
  const rtmrs = [0, 1, 2, 3].map(() => Buffer.alloc(MEASUREMENT_LENGTH));
  for (const event of events) {
    if (!Number.isInteger(event.imr) || event.imr < 0 || event.imr > 3) {
      throw new Error(`Event extends an unknown RTMR: ${event.imr}`);
    }
    const digest = Buffer.from(event.digest, 'hex');
    if (digest.length > MEASUREMENT_LENGTH) {
      throw new Error('Event digest is longer than 48 bytes');
    }
    if (
      event.event_type === DSTACK_RUNTIME_EVENT_TYPE &&
      !digest.equals(runtimeEventDigest(event))
    ) {
      throw new Error(`Runtime event ${event.event} does not match its digest`);
    }
    const padded = Buffer.concat([
      digest,
      Buffer.alloc(MEASUREMENT_LENGTH - digest.length),
    ]);
    rtmrs[event.imr] = createHash('sha384')
      .update(rtmrs[event.imr])
      .update(padded)
      .digest();
  }
  const [rtmr0, rtmr1, rtmr2, rtmr3] = rtmrs.map((rtmr) =>
    rtmr.toString('hex'),
  );
  return [rtmr0, rtmr1, rtmr2, rtmr3];
}

/**
 * Checks that the event log replays to the RTMRs of the quote.
 * @returns The failed checks, empty when every RTMR matches
 */
export function verifyEventLog(quote: Buffer, eventLog: string): string[] {
  const { rtmrs } = parseTdxMeasurements(quote);
  let replayed: string[];
  try {
    replayed = replayRtmrs(eventLog);
  } catch (error) {
    return [
      `The event log cannot be replayed: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
  return rtmrs.flatMap((rtmr, index) =>
    rtmr === replayed[index]
      ? []
      : [`RTMR${index} does not match the event log`],
  );
}

function runtimeEventDigest(event: TdxEvent): Buffer {
  const eventType = Buffer.alloc(4);
  eventType.writeUInt32LE(event.event_type);
  return createHash('sha384')
    .update(eventType)
    .update(':')
    .update(event.event)
    .update(':')
    .update(Buffer.from(event.event_payload, 'hex'))
    .digest();
}
