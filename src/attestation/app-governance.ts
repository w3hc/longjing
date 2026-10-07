import {
  Interface,
  Provider,
  ZeroAddress,
  getAddress,
  zeroPadValue,
} from 'ethers';

const DSTACK_APP = new Interface([
  'function owner() view returns (address)',
  'function pendingOwner() view returns (address)',
  'function requireTcbUpToDate() view returns (bool)',
  'function allowedComposeHashes(bytes32) view returns (bool)',
  'event ComposeHashAdded(bytes32 composeHash)',
  'event ComposeHashRemoved(bytes32 composeHash)',
  'event Upgraded(address indexed implementation)',
]);

const APP_OWNER = new Interface([
  'function app() view returns (address)',
  'function timelock() view returns (address)',
  'function guardian() view returns (address)',
]);

const TIMELOCK = new Interface([
  'function getMinDelay() view returns (uint256)',
  'function hasRole(bytes32, address) view returns (bool)',
]);

const DEFAULT_ADMIN_ROLE = zeroPadValue('0x', 32);

export const DEFAULT_MIN_DELAY_SECONDS = 7n * 24n * 60n * 60n;

export type ChainReader = Pick<Provider, 'call' | 'getLogs' | 'getBlockNumber'>;

export interface ComposeHashRecord {
  composeHash: string;
  allowed: boolean;
  /** Block numbers of every ComposeHashAdded and ComposeHashRemoved */
  added: number[];
  removed: number[];
}

export interface AppGovernance {
  app: string;
  owner: string;
  pendingOwner: string;
  requireTcbUpToDate: boolean;
  /** Set when the owner is a LongjingAppOwner for this app */
  appOwner?: {
    address: string;
    timelock: string;
    guardian: string;
    minDelay: bigint;
    /** Whether the timelock administers itself, so role changes are delayed too */
    timelockSelfAdministered: boolean;
  };
  /** Every compose hash ever allowed, in order of first addition */
  composeHashes: ComposeHashRecord[];
  upgrades: { implementation: string; blockNumber: number }[];
}

/**
 * Reads the governance of a DstackApp: who can add compose hashes, how fast,
 * and every compose hash it ever allowed (docs/GOVERNANCE.md).
 * @param reader A provider on the chain of the dstack KMS (Base)
 * @param app The DstackApp address, which is the dstack app id
 * @param options.fromBlock The block the app was created at, to bound log queries
 * @param options.blockRange Blocks per getLogs call, for RPCs that cap ranges
 */
export async function readAppGovernance(
  reader: ChainReader,
  app: string,
  options: { fromBlock?: number; blockRange?: number } = {},
): Promise<AppGovernance> {
  app = getAddress(app);
  const [owner, pendingOwner, requireTcbUpToDate] = await Promise.all([
    call<string>(reader, app, DSTACK_APP, 'owner'),
    call<string>(reader, app, DSTACK_APP, 'pendingOwner'),
    call<boolean>(reader, app, DSTACK_APP, 'requireTcbUpToDate'),
  ]);

  return {
    app,
    owner,
    pendingOwner,
    requireTcbUpToDate,
    appOwner: await readAppOwner(reader, app, owner),
    ...(await readHistory(reader, app, options)),
  };
}

async function readAppOwner(
  reader: ChainReader,
  app: string,
  owner: string,
): Promise<AppGovernance['appOwner']> {
  let governed: string, timelock: string, guardian: string;
  try {
    [governed, timelock, guardian] = await Promise.all([
      call<string>(reader, owner, APP_OWNER, 'app'),
      call<string>(reader, owner, APP_OWNER, 'timelock'),
      call<string>(reader, owner, APP_OWNER, 'guardian'),
    ]);
  } catch {
    return undefined;
  }
  if (governed !== app) {
    return undefined;
  }
  const { minDelay, selfAdministered } = await readTimelock(reader, timelock);
  return {
    address: owner,
    timelock,
    guardian,
    minDelay,
    timelockSelfAdministered: selfAdministered,
  };
}

/**
 * Reads a TimelockController's delay, and whether it administers itself, so
 * that changing its roles is delayed too. Rejects when the address is not one.
 */
export async function readTimelock(
  reader: ChainReader,
  timelock: string,
): Promise<{ minDelay: bigint; selfAdministered: boolean }> {
  const [minDelay, selfAdministered] = await Promise.all([
    call<bigint>(reader, timelock, TIMELOCK, 'getMinDelay'),
    call<boolean>(reader, timelock, TIMELOCK, 'hasRole', [
      DEFAULT_ADMIN_ROLE,
      timelock,
    ]),
  ]);
  return { minDelay, selfAdministered };
}

async function readHistory(
  reader: ChainReader,
  app: string,
  {
    fromBlock = 0,
    blockRange = 10_000,
  }: { fromBlock?: number; blockRange?: number },
): Promise<Pick<AppGovernance, 'composeHashes' | 'upgrades'>> {
  const topics = ['ComposeHashAdded', 'ComposeHashRemoved', 'Upgraded'].map(
    (name) => DSTACK_APP.getEvent(name)!.topicHash,
  );
  const latest = await reader.getBlockNumber();
  const records = new Map<string, ComposeHashRecord>();
  const upgrades: AppGovernance['upgrades'] = [];

  for (let start = fromBlock; start <= latest; start += blockRange) {
    const logs = await reader.getLogs({
      address: app,
      topics: [topics],
      fromBlock: start,
      toBlock: Math.min(start + blockRange - 1, latest),
    });
    for (const log of logs) {
      const event = DSTACK_APP.parseLog(log);
      if (!event) continue;
      if (event.name === 'Upgraded') {
        upgrades.push({
          implementation: event.args[0] as string,
          blockNumber: log.blockNumber,
        });
        continue;
      }
      const composeHash = event.args[0] as string;
      const record = records.get(composeHash) ?? {
        composeHash,
        allowed: false,
        added: [],
        removed: [],
      };
      records.set(composeHash, record);
      (event.name === 'ComposeHashAdded' ? record.added : record.removed).push(
        log.blockNumber,
      );
    }
  }

  // The initial compose hash is set in initialize, which does emit ComposeHashAdded;
  // allowed is still read from the contract rather than replayed from the log
  const composeHashes = [...records.values()];
  await Promise.all(
    composeHashes.map(async (record) => {
      record.allowed = await call<boolean>(
        reader,
        app,
        DSTACK_APP,
        'allowedComposeHashes',
        [record.composeHash],
      );
    }),
  );
  return { composeHashes, upgrades };
}

export async function call<T>(
  reader: ChainReader,
  to: string,
  iface: Interface,
  method: string,
  args: unknown[] = [],
): Promise<T> {
  const data = await reader.call({
    to,
    data: iface.encodeFunctionData(method, args),
  });
  return iface.decodeFunctionResult(method, data)[0] as T;
}

/**
 * Checks the rules of docs/GOVERNANCE.md: a LongjingAppOwner behind a timelock
 * owns the app, the delay is long enough, TCB must be up to date, and only the
 * running build is allowed.
 * @param governance The state read by readAppGovernance
 * @param options.minDelay The shortest acceptable timelock delay, in seconds
 * @param options.composeHash The compose hash of the running build, from its event log
 * @returns The failed checks, and warnings that do not break the guarantee
 */
export function checkAppGovernance(
  governance: AppGovernance,
  options: { minDelay?: bigint; composeHash?: string } = {},
): { failures: string[]; warnings: string[] } {
  const { minDelay = DEFAULT_MIN_DELAY_SECONDS, composeHash } = options;
  const failures: string[] = [];
  const warnings: string[] = [];
  const { appOwner } = governance;

  if (!appOwner) {
    failures.push(
      `The app is owned by ${governance.owner}, not a LongjingAppOwner behind a timelock: it can add builds without delay`,
    );
  } else {
    if (appOwner.minDelay < minDelay) {
      failures.push(
        `The timelock delay is ${appOwner.minDelay}s, under the required ${minDelay}s`,
      );
    }
    if (!appOwner.timelockSelfAdministered) {
      warnings.push(
        'The timelock does not administer itself: check no other admin can change its roles without delay',
      );
    }
    if (appOwner.guardian === ZeroAddress) {
      warnings.push(
        'No guardian: compose hashes cannot be removed without delay',
      );
    }
  }
  if (governance.pendingOwner !== ZeroAddress) {
    warnings.push(
      `An ownership transfer to ${governance.pendingOwner} is pending: that address can take the app over at any time`,
    );
  }
  if (!governance.requireTcbUpToDate) {
    failures.push(
      'requireTcbUpToDate is off: out-of-date TCBs can boot the app',
    );
  }

  const allowed = governance.composeHashes.filter((record) => record.allowed);
  if (composeHash) {
    const running = governance.composeHashes.find(
      (record) => record.composeHash === normalizeHash(composeHash),
    );
    if (!running?.allowed) {
      failures.push(`The running compose hash ${composeHash} is not allowed`);
    }
  }
  if (allowed.length > 1) {
    warnings.push(
      `${allowed.length} compose hashes are allowed: every one of them can derive the keys`,
    );
  }
  return { failures, warnings };
}

/**
 * Reads the compose hash from a dstack event log, the JSON array returned by
 * GetQuote. The event log is not authenticated by itself: trust it only once
 * verifyEventLog matches its replay to the verified quote (docs/ATTESTATION.md#verification).
 */
export function composeHashFromEventLog(eventLog: string): string | undefined {
  let events: unknown;
  try {
    events = JSON.parse(eventLog);
  } catch {
    return undefined;
  }
  if (!Array.isArray(events)) {
    return undefined;
  }
  const event = (events as { event?: string; event_payload?: string }[]).find(
    (entry) => entry?.event === 'compose-hash',
  );
  return event?.event_payload ? normalizeHash(event.event_payload) : undefined;
}

function normalizeHash(hash: string): string {
  return `0x${hash.replace(/^0x/, '').toLowerCase()}`;
}
