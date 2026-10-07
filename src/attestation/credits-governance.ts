import { Interface, getAddress } from 'ethers';
import {
  ChainReader,
  DEFAULT_MIN_DELAY_SECONDS,
  call,
  readTimelock,
} from './app-governance';

const CREDITS = new Interface([
  'function owner() view returns (address)',
  'function paused() view returns (bool)',
]);

export interface CreditsGovernance {
  credits: string;
  owner: string;
  paused: boolean;
  /** Set when the owner is a TimelockController */
  timelock?: { minDelay: bigint; selfAdministered: boolean };
}

/**
 * Reads who can change LongjingCredits' verifiers, serverAddress and refund
 * key, and how fast (docs/GOVERNANCE.md).
 * @param reader A provider on the chain LongjingCredits is deployed on
 * @param credits The LongjingCredits address
 */
export async function readCreditsGovernance(
  reader: ChainReader,
  credits: string,
): Promise<CreditsGovernance> {
  credits = getAddress(credits);
  const [owner, paused] = await Promise.all([
    call<string>(reader, credits, CREDITS, 'owner'),
    call<boolean>(reader, credits, CREDITS, 'paused'),
  ]);
  let timelock: CreditsGovernance['timelock'];
  try {
    timelock = await readTimelock(reader, owner);
  } catch {
    timelock = undefined;
  }
  return { credits, owner, paused, timelock };
}

/**
 * Checks that a timelock of at least minDelay owns LongjingCredits, so every
 * admin change is public for that long before it can even be queued.
 * @returns The failed checks, and warnings that do not break the guarantee
 */
export function checkCreditsGovernance(
  governance: CreditsGovernance,
  options: { minDelay?: bigint } = {},
): { failures: string[]; warnings: string[] } {
  const { minDelay = DEFAULT_MIN_DELAY_SECONDS } = options;
  const failures: string[] = [];
  const warnings: string[] = [];
  const { timelock } = governance;

  if (!timelock) {
    failures.push(
      `LongjingCredits is owned by ${governance.owner}, not a timelock: a single account can queue verifier, serverAddress and refund key changes`,
    );
  } else {
    if (timelock.minDelay < minDelay) {
      failures.push(
        `The LongjingCredits timelock delay is ${timelock.minDelay}s, under the required ${minDelay}s`,
      );
    }
    if (!timelock.selfAdministered) {
      warnings.push(
        'The LongjingCredits timelock does not administer itself: check no other admin can change its roles without delay',
      );
    }
  }
  if (governance.paused) {
    warnings.push(
      'LongjingCredits is paused: deposits are closed, exits stay open',
    );
  }
  return { failures, warnings };
}
