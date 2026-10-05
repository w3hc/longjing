import { Interface, ZeroHash, getAddress, id } from 'ethers';
import {
  buildReleaseBatch,
  checkAppCompose,
  composeHashOf,
  safeTransactionBuilderFile,
} from './release-batch';

const APP_OWNER = getAddress('0x00000000000000000000000000000000000000b2');
const TIMELOCK = getAddress('0x00000000000000000000000000000000000000c3');
const V1 = id('v1');
const V2 = id('v2');
const V3 = id('v3');
const DIGEST = 'a'.repeat(64);

const abi = new Interface([
  'function execute(bytes data) returns (bytes)',
  'function addComposeHash(bytes32 composeHash)',
  'function removeComposeHash(bytes32 composeHash)',
  'function scheduleBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt, uint256 delay)',
  'function executeBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt)',
]);

function innerCalls(payloads: string[]) {
  return payloads.map((payload) => {
    const inner = abi.decodeFunctionData('execute', payload)[0] as string;
    const call = abi.parseTransaction({ data: inner })!;
    return [call.name, call.args[0] as string];
  });
}

describe('composeHashOf', () => {
  it('is the SHA-256 of the file bytes', () => {
    expect(composeHashOf(Buffer.from('abc'))).toBe(
      '0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('checkAppCompose', () => {
  const dockerCompose = `services:\n  longjing:\n    image: ghcr.io/w3hc/longjing@sha256:${DIGEST}\n`;

  it('accepts the repository compose file pinned by digest', () => {
    const appCompose = Buffer.from(
      JSON.stringify({ docker_compose_file: dockerCompose }),
    );
    expect(checkAppCompose(appCompose, dockerCompose)).toEqual([]);
  });

  it('rejects another compose file', () => {
    const appCompose = Buffer.from(
      JSON.stringify({ docker_compose_file: `${dockerCompose}  extra: 1\n` }),
    );
    expect(checkAppCompose(appCompose, dockerCompose)).toEqual([
      expect.stringContaining('is not this repository'),
    ]);
  });

  it('rejects an image pinned by tag', () => {
    const tagged =
      'services:\n  longjing:\n    image: ghcr.io/w3hc/longjing:latest\n';
    const appCompose = Buffer.from(
      JSON.stringify({ docker_compose_file: tagged }),
    );
    expect(checkAppCompose(appCompose, tagged)).toEqual([
      'ghcr.io/w3hc/longjing:latest is not pinned by digest',
    ]);
  });

  it('rejects a file that is not JSON', () => {
    expect(checkAppCompose(Buffer.from('nope'), dockerCompose)).toEqual([
      'app-compose.json is not JSON',
    ]);
  });
});

describe('buildReleaseBatch', () => {
  const batch = buildReleaseBatch({
    appOwner: APP_OWNER,
    timelock: TIMELOCK,
    delay: 604800n,
    composeHash: V3,
    allowed: [V1, V2],
  });

  it('adds the release and removes every other allowed hash', () => {
    const [targets, values, payloads, predecessor, salt, delay] =
      abi.decodeFunctionData('scheduleBatch', batch.schedule.data);

    expect(batch.schedule.to).toBe(TIMELOCK);
    expect(targets).toEqual([APP_OWNER, APP_OWNER, APP_OWNER]);
    expect(values).toEqual([0n, 0n, 0n]);
    expect(innerCalls(payloads as string[])).toEqual([
      ['addComposeHash', V3],
      ['removeComposeHash', V1],
      ['removeComposeHash', V2],
    ]);
    expect(predecessor).toBe(ZeroHash);
    expect(salt).toBe(V3);
    expect(delay).toBe(604800n);
    expect(batch.retired).toEqual([V1, V2]);
  });

  it('executes the same operation it schedules', () => {
    const scheduled = abi.decodeFunctionData(
      'scheduleBatch',
      batch.schedule.data,
    );
    const executed = abi.decodeFunctionData('executeBatch', batch.execute.data);
    expect(executed.toArray()).toEqual(scheduled.toArray().slice(0, 5));
  });

  it('does not remove the release itself when it is already allowed', () => {
    const readd = buildReleaseBatch({
      appOwner: APP_OWNER,
      timelock: TIMELOCK,
      delay: 604800n,
      composeHash: V2.toUpperCase().replace('0X', '0x'),
      allowed: [V1, V2],
    });
    expect(readd.retired).toEqual([V1]);
  });
});

describe('safeTransactionBuilderFile', () => {
  it('wraps one transaction for the Transaction Builder', () => {
    const file = safeTransactionBuilderFile(8453n, 'name', 'description', {
      to: TIMELOCK,
      data: '0x1234',
    });
    expect(file).toMatchObject({
      version: '1.0',
      chainId: '8453',
      meta: { name: 'name', description: 'description' },
      transactions: [{ to: TIMELOCK, value: '0', data: '0x1234' }],
    });
  });
});
