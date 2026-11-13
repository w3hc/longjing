import { BoundAttestation } from '../../src/attestation/attestation.types';
import { buildReportData } from '../../src/attestation/report-data';
import { onionAddress } from '../../src/tor/onion-key';
import {
  AttestationRefused,
  GatewayRequest,
  GatewayResponse,
  GatewayTransport,
  openGateway,
} from './gateway';

const ONION_KEY = Buffer.alloc(32, 6);
const ONION = `${onionAddress(ONION_KEY)}.onion`;
const CERTIFICATE = Buffer.from([0x30, 0x03, 0x01, 0x02, 0x03]);

/** An honest local gateway: mock platform, onion key bound, no manifest */
function attest(nonce: Buffer, tlsCertificate?: Buffer): BoundAttestation {
  const reportData = buildReportData(
    { onionPublicKey: ONION_KEY, tlsCertificateDer: tlsCertificate },
    nonce,
  );
  return {
    platform: 'mock',
    quote: '',
    reportData: Buffer.from(reportData).toString('hex'),
    measurement: '',
    timestamp: new Date().toISOString(),
    nonce: '0x' + nonce.toString('hex'),
    keys: {
      identityPublicKey: null,
      refundSignerPublicKey: null,
      tlsCertificate: tlsCertificate?.toString('base64') ?? null,
      onionPublicKey: '0x' + ONION_KEY.toString('hex'),
    },
    onionAddress: ONION,
  };
}

class FakeTransport implements GatewayTransport {
  readonly requests: GatewayRequest[] = [];
  tamper: (attestation: BoundAttestation) => BoundAttestation = (a) => a;

  constructor(
    readonly host = '127.0.0.1',
    readonly secure = false,
    readonly certificate: Buffer | null = null,
  ) {}

  request(request: GatewayRequest): Promise<GatewayResponse> {
    this.requests.push(request);
    const ok = (body: unknown, status = 200) =>
      Promise.resolve({
        status,
        body: JSON.stringify(body),
        certificate: this.certificate,
      });
    if (request.path.startsWith('/attestation?nonce=')) {
      const nonce = Buffer.from(request.path.split('=')[1], 'hex');
      return ok(this.tamper(attest(nonce, this.certificate ?? undefined)));
    }
    if (request.path === '/attestation/manifest') {
      return ok({ message: 'no key manifest' }, 503);
    }
    return ok({ accepted: true });
  }

  posts() {
    return this.requests.filter((r) => r.method === 'POST');
  }
}

describe('openGateway', () => {
  it('verifies with a fresh nonce, then posts', async () => {
    const transport = new FakeTransport();

    const gateway = await openGateway(transport, { development: true });
    const second = await openGateway(transport, { development: true });
    const res = await gateway.post('/longjing/request', { payload: 'hi' });

    expect(res).toEqual({ status: 200, json: { accepted: true } });
    expect(gateway.attestation.nonce).not.toBe(second.attestation.nonce);
    expect(transport.requests[0].path).toMatch(
      /^\/attestation\?nonce=[0-9a-f]{64}$/,
    );
    expect(transport.posts()).toHaveLength(1);
  });

  it('refuses a swapped key and sends nothing', async () => {
    const transport = new FakeTransport();
    transport.tamper = (a) => ({
      ...a,
      keys: { ...a.keys, refundSignerPublicKey: { x: '0x01', y: '0x02' } },
    });

    await expect(openGateway(transport, { development: true })).rejects.toThrow(
      AttestationRefused,
    );
    expect(transport.posts()).toHaveLength(0);
  });

  it('refuses an attestation replayed for another nonce', async () => {
    const transport = new FakeTransport();
    const stale = attest(Buffer.alloc(32, 1));
    transport.tamper = () => stale;

    await expect(openGateway(transport, { development: true })).rejects.toThrow(
      'reportData does not commit to the returned keys and nonce',
    );
  });

  it('refuses a .onion host that is not the bound onion service', async () => {
    const other = `${onionAddress(Buffer.alloc(32, 7))}.onion`;

    await expect(
      openGateway(new FakeTransport(other), { development: true }),
    ).rejects.toThrow('The .onion host is not the bound onion service');
    await expect(
      openGateway(new FakeTransport(ONION), { development: true }),
    ).resolves.toBeDefined();
  });

  it('refuses a mock attestation over HTTP outside development', async () => {
    const error = (await openGateway(new FakeTransport()).catch(
      (e: unknown) => e,
    )) as AttestationRefused;

    expect(error.failures).toEqual([
      'The gateway attests with mock, not a dstack TDX quote',
      'The gateway was not reached over TLS',
      'The attestation has no event log to replay',
      'The gateway serves no key manifest',
    ]);
  });

  it('pins later requests to the attested certificate', async () => {
    const transport = new FakeTransport('127.0.0.1', true, CERTIFICATE);

    const gateway = await openGateway(transport, { development: true });
    await gateway.post('/longjing/request', {});

    expect(transport.requests[1].pinnedCertificate).toEqual(CERTIFICATE);
    expect(transport.posts()[0].pinnedCertificate).toEqual(CERTIFICATE);
  });

  it('refuses a session certificate other than the bound one', async () => {
    const transport = new FakeTransport('127.0.0.1', true, CERTIFICATE);
    transport.tamper = (a) => {
      const nonce = Buffer.from(a.nonce!.slice(2), 'hex');
      return attest(nonce, Buffer.from([0x30, 0x00]));
    };

    await expect(openGateway(transport, { development: true })).rejects.toThrow(
      'The TLS session certificate is not the one bound by the attestation',
    );
    expect(transport.posts()).toHaveLength(0);
  });
});
