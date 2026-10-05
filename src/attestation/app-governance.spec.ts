import {
  AbiCoder,
  Interface,
  TransactionRequest,
  ZeroAddress,
  getAddress,
  id,
  zeroPadValue,
} from 'ethers';
import {
  AppGovernance,
  ChainReader,
  checkAppGovernance,
  composeHashFromEventLog,
  readAppGovernance,
} from './app-governance';

const APP = getAddress('0x00000000000000000000000000000000000000a1');
const APP_OWNER = getAddress('0x00000000000000000000000000000000000000b2');
const TIMELOCK = getAddress('0x00000000000000000000000000000000000000c3');
const SAFE = getAddress('0x00000000000000000000000000000000000000d4');
const IMPLEMENTATION = getAddress('0x00000000000000000000000000000000000000e5');
const V1 = id('v1');
const V2 = id('v2');
const WEEK = 7n * 24n * 60n * 60n;

const abi = new Interface([
  'function owner() view returns (address)',
  'function pendingOwner() view returns (address)',
  'function requireTcbUpToDate() view returns (bool)',
  'function allowedComposeHashes(bytes32) view returns (bool)',
  'function app() view returns (address)',
  'function timelock() view returns (address)',
  'function guardian() view returns (address)',
  'function getMinDelay() view returns (uint256)',
  'function hasRole(bytes32, address) view returns (bool)',
]);

function hashLog(name: string, hash: string, blockNumber: number) {
  return {
    topics: [id(`${name}(bytes32)`)],
    data: AbiCoder.defaultAbiCoder().encode(['bytes32'], [hash]),
    blockNumber,
  };
}

function mockReader(owner: string, latest = 25_000) {
  const allowed = new Set([V2]);
  const results: Record<string, Record<string, unknown>> = {
    [APP]: {
      owner,
      pendingOwner: ZeroAddress,
      requireTcbUpToDate: true,
    },
    [APP_OWNER]: { app: APP, timelock: TIMELOCK, guardian: SAFE },
    [TIMELOCK]: { getMinDelay: WEEK, hasRole: true },
  };
  const logs = [
    hashLog('ComposeHashAdded', V1, 100),
    hashLog('ComposeHashAdded', V2, 12_000),
    hashLog('ComposeHashRemoved', V1, 12_000),
    {
      topics: [id('Upgraded(address)'), zeroPadValue(IMPLEMENTATION, 32)],
      data: '0x',
      blockNumber: 20_000,
    },
  ];

  const reader = {
    call: jest.fn((tx: TransactionRequest) => {
      const parsed = abi.parseTransaction({ data: tx.data as string })!;
      const to = getAddress(tx.to as string);
      if (to === APP && parsed.name === 'allowedComposeHashes') {
        return Promise.resolve(
          abi.encodeFunctionResult(parsed.fragment, [
            allowed.has(parsed.args[0] as string),
          ]),
        );
      }
      const value = results[to]?.[parsed.name];
      if (value === undefined) {
        return Promise.reject(new Error('execution reverted'));
      }
      return Promise.resolve(
        abi.encodeFunctionResult(parsed.fragment, [value]),
      );
    }),
    getBlockNumber: jest.fn(() => Promise.resolve(latest)),
    getLogs: jest.fn(
      ({ fromBlock, toBlock }: { fromBlock: number; toBlock: number }) =>
        Promise.resolve(
          logs.filter(
            (log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock,
          ),
        ),
    ),
  };
  return { reader, results };
}

function governance(overrides: Partial<AppGovernance> = {}): AppGovernance {
  return {
    app: APP,
    owner: APP_OWNER,
    pendingOwner: ZeroAddress,
    requireTcbUpToDate: true,
    appOwner: {
      address: APP_OWNER,
      timelock: TIMELOCK,
      guardian: SAFE,
      minDelay: WEEK,
      timelockSelfAdministered: true,
    },
    composeHashes: [
      { composeHash: V1, allowed: false, added: [100], removed: [12_000] },
      { composeHash: V2, allowed: true, added: [12_000], removed: [] },
    ],
    upgrades: [],
    ...overrides,
  };
}

describe('readAppGovernance', () => {
  it('reads the owner chain and every compose hash ever allowed', async () => {
    const { reader } = mockReader(APP_OWNER);

    const state = await readAppGovernance(
      reader as unknown as ChainReader,
      APP,
    );

    expect(state.appOwner).toEqual({
      address: APP_OWNER,
      timelock: TIMELOCK,
      guardian: SAFE,
      minDelay: WEEK,
      timelockSelfAdministered: true,
    });
    expect(state.requireTcbUpToDate).toBe(true);
    expect(state.composeHashes).toEqual(governance().composeHashes);
    expect(state.upgrades).toEqual([
      { implementation: IMPLEMENTATION, blockNumber: 20_000 },
    ]);
  });

  it('queries logs in bounded ranges', async () => {
    const { reader } = mockReader(APP_OWNER);

    await readAppGovernance(reader as unknown as ChainReader, APP, {
      fromBlock: 50,
      blockRange: 10_000,
    });

    expect(
      reader.getLogs.mock.calls.map(([range]) => [
        range.fromBlock,
        range.toBlock,
      ]),
    ).toEqual([
      [50, 10_049],
      [10_050, 20_049],
      [20_050, 25_000],
    ]);
  });

  it('leaves appOwner unset when the owner is not a LongjingAppOwner', async () => {
    const { reader } = mockReader(SAFE);

    const state = await readAppGovernance(
      reader as unknown as ChainReader,
      APP,
    );

    expect(state.owner).toBe(SAFE);
    expect(state.appOwner).toBeUndefined();
  });

  it('leaves appOwner unset when the LongjingAppOwner governs another app', async () => {
    const { reader, results } = mockReader(APP_OWNER);
    results[APP_OWNER].app = SAFE;

    const state = await readAppGovernance(
      reader as unknown as ChainReader,
      APP,
    );

    expect(state.appOwner).toBeUndefined();
  });
});

describe('checkAppGovernance', () => {
  it('passes the governed setup', () => {
    expect(checkAppGovernance(governance(), { composeHash: V2 })).toEqual({
      failures: [],
      warnings: [],
    });
  });

  it('fails an app owned without a timelock', () => {
    const { failures } = checkAppGovernance(
      governance({ owner: SAFE, appOwner: undefined }),
    );
    expect(failures).toEqual([
      expect.stringContaining('not a LongjingAppOwner'),
    ]);
  });

  it('fails a delay under the minimum', () => {
    const { failures } = checkAppGovernance(governance(), {
      minDelay: WEEK + 1n,
    });
    expect(failures).toEqual([expect.stringContaining('under the required')]);
  });

  it('fails when TCB is not required up to date', () => {
    const { failures } = checkAppGovernance(
      governance({ requireTcbUpToDate: false }),
    );
    expect(failures).toEqual([expect.stringContaining('requireTcbUpToDate')]);
  });

  it('fails a running compose hash that is not allowed', () => {
    const { failures } = checkAppGovernance(governance(), {
      composeHash: V1.slice(2).toUpperCase(),
    });
    expect(failures).toEqual([expect.stringContaining('is not allowed')]);
  });

  it('warns about several allowed hashes, a pending owner and no guardian', () => {
    const state = governance({ pendingOwner: SAFE });
    state.composeHashes[0].allowed = true;
    state.appOwner!.guardian = ZeroAddress;
    state.appOwner!.timelockSelfAdministered = false;

    const { failures, warnings } = checkAppGovernance(state);

    expect(failures).toEqual([]);
    expect(warnings).toHaveLength(4);
  });
});

describe('composeHashFromEventLog', () => {
  it('reads the compose-hash event payload', () => {
    const eventLog = JSON.stringify([
      { imr: 3, event: 'app-id', event_payload: 'a1' },
      { imr: 3, event: 'compose-hash', event_payload: V2.slice(2) },
    ]);
    expect(composeHashFromEventLog(eventLog)).toBe(V2);
  });

  it('returns undefined without one', () => {
    expect(composeHashFromEventLog('[]')).toBeUndefined();
    expect(composeHashFromEventLog('not json')).toBeUndefined();
  });
});
