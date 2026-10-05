import * as fs from 'fs';
import * as path from 'path';
import {
  DSTACK_RUNTIME_EVENT_TYPE,
  TdxEvent,
  parseTdxMeasurements,
  replayRtmrs,
  verifyEventLog,
} from './tdx-quote';

// A recorded TDX quote and its event log, shipped with the dstack simulator
const fixture = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, 'fixtures', 'dstack-simulator-quote.json'),
    'utf-8',
  ),
) as { quote: string; eventLog: string };
const QUOTE = Buffer.from(fixture.quote, 'hex');
const EVENTS = JSON.parse(fixture.eventLog) as TdxEvent[];

const withEvents = (events: TdxEvent[]) => JSON.stringify(events);

describe('replayRtmrs', () => {
  it('replays RTMR0–3 of the quote from its event log', () => {
    expect(replayRtmrs(fixture.eventLog)).toEqual(
      parseTdxMeasurements(QUOTE).rtmrs,
    );
  });

  it('leaves an RTMR with no events at zero', () => {
    expect(replayRtmrs('[]')).toEqual(Array(4).fill('00'.repeat(48)));
  });

  it('rejects a runtime event whose payload does not match its digest', () => {
    const events = EVENTS.map((event) =>
      event.event === 'compose-hash'
        ? { ...event, event_payload: '00'.repeat(32) }
        : event,
    );

    expect(() => replayRtmrs(withEvents(events))).toThrow(
      'Runtime event compose-hash does not match its digest',
    );
  });

  it('rejects an event for an unknown RTMR', () => {
    const event = { ...EVENTS[0], imr: 4 };

    expect(() => replayRtmrs(withEvents([event]))).toThrow('unknown RTMR: 4');
  });

  it('checks runtime events of the fixture', () => {
    expect(
      EVENTS.some(
        (event) =>
          event.event_type === DSTACK_RUNTIME_EVENT_TYPE &&
          event.event === 'compose-hash',
      ),
    ).toBe(true);
  });
});

describe('verifyEventLog', () => {
  it('accepts the event log of the quote', () => {
    expect(verifyEventLog(QUOTE, fixture.eventLog)).toEqual([]);
  });

  it('reports each RTMR the event log does not replay to', () => {
    const events = EVENTS.filter((event) => event.imr !== 1);

    expect(verifyEventLog(QUOTE, withEvents(events))).toEqual([
      'RTMR1 does not match the event log',
    ]);
  });

  it('reports an event log that cannot be replayed', () => {
    expect(verifyEventLog(QUOTE, 'not json')[0]).toMatch(
      'The event log cannot be replayed',
    );
  });

  it('rejects a truncated quote', () => {
    expect(() => parseTdxMeasurements(Buffer.alloc(600))).toThrow(
      'TDX quote too short',
    );
  });
});
