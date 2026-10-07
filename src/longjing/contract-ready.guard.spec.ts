import { ServiceUnavailableException } from '@nestjs/common';
import { BlockchainService } from './blockchain.service';
import { ContractReadyGuard } from './contract-ready.guard';

describe('ContractReadyGuard', () => {
  const guard = (available: boolean) =>
    new ContractReadyGuard({
      isAvailable: () => available,
    } as unknown as BlockchainService);

  afterEach(() => {
    process.env.NODE_ENV = 'test';
  });

  it('refuses requests in prod until the contract answers', () => {
    process.env.NODE_ENV = 'production';
    expect(() => guard(false).canActivate()).toThrow(
      ServiceUnavailableException,
    );
  });

  it('lets requests through in prod once the contract answers', () => {
    process.env.NODE_ENV = 'production';
    expect(guard(true).canActivate()).toBe(true);
  });

  it('lets requests through in local without a contract', () => {
    expect(guard(false).canActivate()).toBe(true);
  });
});
