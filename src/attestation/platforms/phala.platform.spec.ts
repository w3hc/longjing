import { DstackClient } from '@phala/dstack-sdk';
import { PhalaPlatform } from './phala.platform';

describe('PhalaPlatform', () => {
  const env = { ...process.env };

  beforeEach(() => {
    process.env.DSTACK_SIMULATOR_ENDPOINT = 'http://localhost:8090';
  });

  afterEach(() => {
    process.env = { ...env };
    jest.restoreAllMocks();
  });

  it('returns the event log with the quote', async () => {
    const eventLog = JSON.stringify([
      { imr: 3, event_type: 1, digest: 'ab', event: '', event_payload: '' },
    ]);
    const getQuote = jest
      .spyOn(DstackClient.prototype, 'getQuote')
      .mockResolvedValue({
        quote: '0x' + '00'.repeat(1024),
        event_log: eventLog,
        replayRtmrs: () => [],
      });
    const reportData = Buffer.alloc(64, 5);

    const quote = await new PhalaPlatform().generateQuote(reportData);

    expect(getQuote).toHaveBeenCalledWith(reportData);
    expect(quote.eventLog).toBe(eventLog);
    expect(quote.reportData).toBe(reportData.toString('hex'));
  });
});
