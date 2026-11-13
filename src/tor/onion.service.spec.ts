import { KeyDerivationService } from '../keys/key-derivation.service';
import { onionKeyFromSeed } from './onion-key';
import { OnionService, onionServiceEnabled } from './onion.service';
import * as torProcess from './tor-process';

const KEY = onionKeyFromSeed(Buffer.alloc(32, 1));

describe('onionServiceEnabled', () => {
  it('is always on in production', () => {
    expect(onionServiceEnabled({ NODE_ENV: 'production' })).toBe(true);
  });

  it('is on locally only with ONION_SERVICE=true', () => {
    expect(onionServiceEnabled({ NODE_ENV: 'development' })).toBe(false);
    expect(
      onionServiceEnabled({ NODE_ENV: 'test', ONION_SERVICE: 'true' }),
    ).toBe(true);
  });
});

describe('OnionService', () => {
  const env = { ...process.env };
  const keys = (key = KEY) =>
    ({ getOnionKey: () => key }) as unknown as KeyDerivationService;

  afterEach(() => {
    process.env = { ...env };
    jest.restoreAllMocks();
  });

  it('starts nothing locally by default', async () => {
    process.env.NODE_ENV = 'test';
    const start = jest.spyOn(torProcess, 'startOnionService');

    await new OnionService(keys()).onApplicationBootstrap();

    expect(start).not.toHaveBeenCalled();
  });

  it('forwards port 443 of the derived key to the HTTPS listener', async () => {
    process.env.NODE_ENV = 'production';
    const stop = jest.fn();
    const start = jest
      .spyOn(torProcess, 'startOnionService')
      .mockResolvedValue({
        serviceId: 'x',
        exited: new Promise(() => undefined),
        stop,
      });
    const service = new OnionService(keys());

    await service.onApplicationBootstrap();
    service.onApplicationShutdown();

    expect(start).toHaveBeenCalledWith({
      key: KEY,
      virtualPort: 443,
      target: '127.0.0.1:3000',
    });
    expect(stop).toHaveBeenCalled();
  });

  it('fails startup in production when tor fails', async () => {
    process.env.NODE_ENV = 'production';
    jest
      .spyOn(torProcess, 'startOnionService')
      .mockRejectedValue(new Error('tor exited'));

    await expect(
      new OnionService(keys()).onApplicationBootstrap(),
    ).rejects.toThrow('Cannot start in production without the onion service');
  });

  it('starts without an onion service locally when tor fails', async () => {
    process.env.NODE_ENV = 'test';
    process.env.ONION_SERVICE = 'true';
    jest
      .spyOn(torProcess, 'startOnionService')
      .mockRejectedValue(new Error('tor exited'));

    await expect(
      new OnionService(keys()).onApplicationBootstrap(),
    ).resolves.toBeUndefined();
  });

  it('exits in production when tor dies', async () => {
    process.env.NODE_ENV = 'production';
    let die: (code: number) => void = () => undefined;
    jest.spyOn(torProcess, 'startOnionService').mockResolvedValue({
      serviceId: 'x',
      exited: new Promise((resolve) => (die = resolve)),
      stop: jest.fn(),
    });
    const exit = jest
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);

    await new OnionService(keys()).onApplicationBootstrap();
    die(1);
    await new Promise((resolve) => setImmediate(resolve));

    expect(exit).toHaveBeenCalledWith(1);
  });
});
