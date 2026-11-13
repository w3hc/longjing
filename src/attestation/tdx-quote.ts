import { sha384 } from '@noble/hashes/sha2';
import {
  bytesToHex,
  concatBytes,
  equalBytes,
  hexToBytes,
  utf8ToBytes,
} from '../common/bytes';

// TDX quote v4: 48-byte header, then the TD report body, whose report_data
// is 64 bytes at offset 520
const QUOTE_HEADER_LENGTH = 48;
const TDX_REPORT_DATA_OFFSET = QUOTE_HEADER_LENGTH + 520;
const TDX_REPORT_DATA_LENGTH = 64;
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
 * Reads the report_data a TDX quote attests to.
 */
export function tdxQuoteReportData(quote: Uint8Array): Uint8Array {
  const end = TDX_REPORT_DATA_OFFSET + TDX_REPORT_DATA_LENGTH;
  if (quote.length < end) {
    throw new Error(`TDX quote too short: ${quote.length} bytes`);
  }
  return quote.subarray(TDX_REPORT_DATA_OFFSET, end);
}

/**
 * Reads MRTD and RTMR0–3 from a TDX quote.
 */
export function parseTdxMeasurements(quote: Uint8Array): TdxMeasurements {
  if (quote.length < TDX_QUOTE_BODY_END) {
    throw new Error(`TDX quote too short: ${quote.length} bytes`);
  }
  const measurement = (offset: number) =>
    bytesToHex(quote.subarray(offset, offset + MEASUREMENT_LENGTH));
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
  const rtmrs: Uint8Array[] = [0, 1, 2, 3].map(
    () => new Uint8Array(MEASUREMENT_LENGTH),
  );
  for (const event of events) {
    if (!Number.isInteger(event.imr) || event.imr < 0 || event.imr > 3) {
      throw new Error(`Event extends an unknown RTMR: ${event.imr}`);
    }
    const digest = hexToBytes(event.digest);
    if (digest.length > MEASUREMENT_LENGTH) {
      throw new Error('Event digest is longer than 48 bytes');
    }
    if (
      event.event_type === DSTACK_RUNTIME_EVENT_TYPE &&
      !equalBytes(digest, runtimeEventDigest(event))
    ) {
      throw new Error(`Runtime event ${event.event} does not match its digest`);
    }
    const padded = concatBytes(
      digest,
      new Uint8Array(MEASUREMENT_LENGTH - digest.length),
    );
    rtmrs[event.imr] = sha384(concatBytes(rtmrs[event.imr], padded));
  }
  const [rtmr0, rtmr1, rtmr2, rtmr3] = rtmrs.map(bytesToHex);
  return [rtmr0, rtmr1, rtmr2, rtmr3];
}

/**
 * Checks that the event log replays to the RTMRs of the quote.
 * @returns The failed checks, empty when every RTMR matches
 */
export function verifyEventLog(quote: Uint8Array, eventLog: string): string[] {
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

function runtimeEventDigest(event: TdxEvent): Uint8Array {
  const eventType = new Uint8Array(4);
  new DataView(eventType.buffer).setUint32(0, event.event_type, true);
  return sha384(
    concatBytes(
      eventType,
      utf8ToBytes(':'),
      utf8ToBytes(event.event),
      utf8ToBytes(':'),
      hexToBytes(event.event_payload),
    ),
  );
}
