import { Interface, TransactionRequest, getAddress } from 'ethers';
import { ChainReader } from './app-governance';
import {
  CreditsGovernance,
  checkCreditsGovernance,
  readCreditsGovernance,
} from './credits-governance';

const CREDITS = getAddress('0x00000000000000000000000000000000000000a1');
const TIMELOCK = getAddress('0x00000000000000000000000000000000000000c3');
const DEPLOYER = getAddress('0x00000000000000000000000000000000000000d4');
const WEEK = 7n * 24n * 60n * 60n;

const abi = new Interface([
  'function owner() view returns (address)',
  'function paused() view returns (bool)',
  'function getMinDelay() view returns (uint256)',
  'function hasRole(bytes32, address) view returns (bool)',
]);

function mockReader(owner: string) {
  const results: Record<string, Record<string, unknown>> = {
    [CREDITS]: { owner, paused: false },
    [TIMELOCK]: { getMinDelay: WEEK, hasRole: true },
  };
  return {
    call: jest.fn((tx: TransactionRequest) => {
      const parsed = abi.parseTransaction({ data: tx.data as string })!;
      const value = results[getAddress(tx.to as string)]?.[parsed.name];
      // A call to an account without code returns no data
      if (value === undefined) {
        return Promise.resolve('0x');
      }
      return Promise.resolve(
        abi.encodeFunctionResult(parsed.fragment, [value]),
      );
    }),
    getBlockNumber: jest.fn(),
    getLogs: jest.fn(),
  } as unknown as ChainReader;
}

function governance(
  overrides: Partial<CreditsGovernance> = {},
): CreditsGovernance {
  return {
    credits: CREDITS,
    owner: TIMELOCK,
    paused: false,
    timelock: { minDelay: WEEK, selfAdministered: true },
    ...overrides,
  };
}

describe('readCreditsGovernance', () => {
  it('reads a timelock owner', async () => {
    expect(await readCreditsGovernance(mockReader(TIMELOCK), CREDITS)).toEqual(
      governance(),
    );
  });

  it('leaves the timelock unset when an account without code owns it', async () => {
    const state = await readCreditsGovernance(mockReader(DEPLOYER), CREDITS);

    expect(state.owner).toBe(DEPLOYER);
    expect(state.timelock).toBeUndefined();
  });
});

describe('checkCreditsGovernance', () => {
  it('passes a self-administered timelock with a long enough delay', () => {
    expect(checkCreditsGovernance(governance())).toEqual({
      failures: [],
      warnings: [],
    });
  });

  it('fails when the deployer still owns the contract', () => {
    const { failures } = checkCreditsGovernance(
      governance({ owner: DEPLOYER, timelock: undefined }),
    );

    expect(failures).toEqual([expect.stringContaining(DEPLOYER)]);
  });

  it('fails a delay under the minimum', () => {
    const { failures } = checkCreditsGovernance(
      governance({ timelock: { minDelay: WEEK - 1n, selfAdministered: true } }),
    );

    expect(failures).toEqual([expect.stringContaining('under the required')]);
  });

  it('accepts a shorter delay when the minimum allows it', () => {
    const { failures } = checkCreditsGovernance(
      governance({ timelock: { minDelay: 60n, selfAdministered: true } }),
      { minDelay: 60n },
    );

    expect(failures).toEqual([]);
  });

  it('warns about a timelock with another admin, and a pause', () => {
    const { failures, warnings } = checkCreditsGovernance(
      governance({
        paused: true,
        timelock: { minDelay: WEEK, selfAdministered: false },
      }),
    );

    expect(failures).toEqual([]);
    expect(warnings).toHaveLength(2);
  });
});
