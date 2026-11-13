import { onionKeyFromSeed } from './onion-key';
import { startOnionService } from './tor-process';

// RFC 8032 section 7.1, test 1, and tor's address for its public key
const KEY = onionKeyFromSeed(
  Buffer.from(
    '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
    'hex',
  ),
);
const ADDRESS = '25njqamcweflpvkl73j4szahhihoc4xt3ktcgjnpaingr5yhkenl5sid';

const options = {
  key: KEY,
  virtualPort: 443,
  target: '127.0.0.1:3000',
  // ADD_ONION answers without the network
  extraArgs: ['--DisableNetwork', '1'],
};

describe('startOnionService', () => {
  it('fails when tor cannot start', async () => {
    await expect(
      startOnionService({ ...options, command: ['/nonexistent/tor'] }),
    ).rejects.toThrow('tor exited before it opened its control socket');
  });

  // CI installs tor and sets TOR_BINARY
  const withTor = process.env.TOR_BINARY ? describe : describe.skip;
  withTor('with tor', () => {
    const command = [process.env.TOR_BINARY!];

    it('adds the onion service of the key, and tor exits on stop', async () => {
      const service = await startOnionService({ ...options, command });

      expect(service.serviceId).toBe(ADDRESS);
      service.stop();
      await expect(service.exited).resolves.toBe(0);
    }, 60000);

    it('refuses an onion service other than the expected one', async () => {
      await expect(
        startOnionService({
          ...options,
          command,
          key: { ...KEY, publicKey: Buffer.alloc(32, 6) },
        }),
      ).rejects.toThrow(`tor added onion service ${ADDRESS}, not `);
    }, 60000);
  });
});
