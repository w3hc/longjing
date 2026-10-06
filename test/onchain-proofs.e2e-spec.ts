/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
import { exec } from 'child_process';
import { promisify } from 'util';
import { ethers } from 'ethers';
import * as snarkjs from 'snarkjs';
import { ProofGenService } from '../src/longjing/proof-gen.service';
import { RefundSignerService } from '../src/longjing/refund-signer.service';
import { KeyDerivationService } from '../src/keys/key-derivation.service';

const execAsync = promisify(exec);

// Submits one real proof per circuit to the real contract and verifiers on Anvil
describe('Real proofs on chain (e2e)', () => {
  const RPC_URL = 'http://127.0.0.1:8545';
  // Anvil accounts #0 (deployer, depositor) and #1 (slasher)
  const DEPLOYER_KEY =
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
  const SLASHER_KEY =
    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
  const DEPOSIT = ethers.parseEther('0.2');
  const ABI = [
    'function deposit(bytes32 _idCommitment) payable',
    'function merkleRoot() view returns (bytes32)',
    'function getAnonymitySetSize() view returns (uint256)',
    'function getMerkleProof(uint256 _leafIndex) view returns (bytes32[20] pathElements, uint8[20] pathIndices)',
    'function getDeposit(bytes32 _idCommitment) view returns (tuple(bytes32 idCommitment, uint256 rlnStake, uint256 policyStake, uint256 timestamp, bool active))',
    'function withdraw(bytes32 _idCommitment, address _recipient, uint256[8] _proof, uint256[7] _publicSignals)',
    'function redeemRefund(bytes32 _idCommitment, bytes32 _nullifier, uint256 _refundValue, address _recipient, uint256[8] _proof, uint256[8] _publicSignals)',
    'function slashDoubleSpend(bytes32 _secretKey, bytes32 _nullifier, bytes32 _idCommitment, uint256[8] _proof, uint256[4] _publicSignals)',
    'error RefundAlreadyRedeemed()',
  ];

  const env = { ...process.env };
  const prover = new ProofGenService();
  let provider: ethers.JsonRpcProvider;
  let contract: ethers.Contract;
  let slasher: ethers.Wallet;
  let refundSigner: RefundSignerService;

  const bytes32 = (v: bigint) => ethers.toBeHex(v, 32);
  const freshRecipient = () => ethers.Wallet.createRandom().address;

  const deposit = async (secretKey: bigint) => {
    const idCommitment = await prover.generateIdCommitment(secretKey);
    await (
      await contract.deposit(bytes32(idCommitment), { value: DEPOSIT })
    ).wait();
    return idCommitment;
  };

  beforeAll(async () => {
    // No request cache, so balances read right after a transaction are fresh
    provider = new ethers.JsonRpcProvider(RPC_URL, undefined, {
      cacheTimeout: -1,
    });
    try {
      await provider.getBlockNumber();
    } catch {
      throw new Error(
        `Anvil is not running on ${RPC_URL}. Start it with: anvil`,
      );
    }

    const { stdout } = await execAsync(
      `cd contracts && NODE_ENV=test forge script script/DeployLongjingCredits.s.sol:DeployLongjingCredits --rpc-url ${RPC_URL} --broadcast 2>&1`,
    );
    const address = /LongjingCredits deployed at: (0x[a-fA-F0-9]{40})/.exec(
      stdout,
    )?.[1];
    if (!address) throw new Error(`Deployment failed:\n${stdout}`);

    // NonceManager: ethers' cached nonce lags behind forge's deployment
    const deployer = new ethers.NonceManager(
      new ethers.Wallet(DEPLOYER_KEY, provider),
    );
    contract = new ethers.Contract(address, ABI, deployer);
    slasher = new ethers.Wallet(SLASHER_KEY, provider);

    // No dstack here: the dev key, which the local deployment registers on chain
    refundSigner = new RefundSignerService({
      getRefundSignerPrivateKey: () => null,
    } as unknown as KeyDerivationService);
  }, 120000);

  afterAll(async () => {
    process.env = { ...env };
    // snarkjs keeps the curve's worker threads alive
    await (globalThis as any).curve_bn128?.terminate();
  });

  it('withdraws with a real withdrawal proof', async () => {
    const secretKey = 0x5ec12e7001n;
    const idCommitment = await deposit(secretKey);
    const leafIndex = (await contract.getAnonymitySetSize()) - 1n;
    const [pathElements, pathIndices] =
      await contract.getMerkleProof(leafIndex);
    const root: string = await contract.merkleRoot();
    const recipient = freshRecipient();

    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      {
        secretKey: secretKey.toString(),
        ticketIndex: '1',
        merklePathElements: pathElements.map((e: string) =>
          BigInt(e).toString(),
        ),
        merklePathIndices: pathIndices.map((i: bigint) => i.toString()),
        signalX: '42',
        merkleRootExpected: BigInt(root).toString(),
        recipient: BigInt(recipient).toString(),
      },
      'circuits/build/withdrawal_js/withdrawal.wasm',
      'circuits/build/withdrawal.zkey',
    );
    const contractProof = [
      proof.pi_a[0],
      proof.pi_a[1],
      proof.pi_b[0][1],
      proof.pi_b[0][0],
      proof.pi_b[1][1],
      proof.pi_b[1][0],
      proof.pi_c[0],
      proof.pi_c[1],
    ];

    await (
      await contract.withdraw(
        bytes32(idCommitment),
        recipient,
        contractProof,
        publicSignals,
      )
    ).wait();

    expect(await provider.getBalance(recipient)).toBe(DEPOSIT);
    expect((await contract.getDeposit(bytes32(idCommitment))).active).toBe(
      false,
    );
  }, 120000);

  it('redeems a real refund proof once, and rejects a second redemption', async () => {
    const secretKey = 0x5ec12e7002n;
    const ticketIndex = 1n;
    const signalX = 4242n;
    const idCommitment = await deposit(secretKey);
    const { nullifier } = await prover.generateRLNSignal(
      secretKey,
      ticketIndex,
      signalX,
    );
    const ticket = await refundSigner.signRefund({
      idCommitment: idCommitment.toString(),
      nullifier: nullifier.toString(),
      value: ethers.parseEther('0.005').toString(),
      timestamp: Date.now(),
    });
    const recipient = freshRecipient();

    const { proof, publicSignals } = await prover.generateRefundRedemptionProof(
      {
        secretKey,
        ticketIndex,
        signalX,
        refundValue: BigInt(ticket.value),
        refundTimestamp: ticket.timestamp,
        refundSignature: ticket.signature,
        serverPublicKey: await refundSigner.getPublicKey(),
        recipient,
      },
    );
    const args = [
      bytes32(idCommitment),
      bytes32(nullifier),
      ticket.value,
      recipient,
      proof,
      publicSignals,
    ];

    await (await contract.redeemRefund(...args)).wait();
    expect(await provider.getBalance(recipient)).toBe(BigInt(ticket.value));

    await expect(
      contract.redeemRefund.staticCall(...args),
    ).rejects.toMatchObject({
      revert: { name: 'RefundAlreadyRedeemed' },
    });
  }, 120000);

  it('slashes a double spend with a real slashing proof', async () => {
    const secretKey = 0x5ec12e7003n;
    const ticketIndex = 1n;
    const idCommitment = await deposit(secretKey);
    const signal = async (x: bigint) => ({
      x,
      y: (await prover.generateRLNSignal(secretKey, ticketIndex, x)).signalY,
    });
    const signal1 = await signal(111n);
    const signal2 = await signal(222n);
    const { nullifier } = await prover.generateRLNSignal(
      secretKey,
      ticketIndex,
      signal1.x,
    );

    const { proof, publicSignals } = await prover.generateDoubleSpendProof({
      secretKey,
      ticketIndex,
      signal1,
      signal2,
    });
    const { rlnStake } = await contract.getDeposit(bytes32(idCommitment));
    const balanceBefore = await provider.getBalance(slasher.address);

    const receipt = await (
      await (contract.connect(slasher) as ethers.Contract).slashDoubleSpend(
        bytes32(secretKey),
        bytes32(nullifier),
        bytes32(idCommitment),
        proof,
        publicSignals,
      )
    ).wait();

    const gas = receipt.gasUsed * receipt.gasPrice;
    expect(await provider.getBalance(slasher.address)).toBe(
      balanceBefore + rlnStake - gas,
    );
    expect((await contract.getDeposit(bytes32(idCommitment))).active).toBe(
      false,
    );
  }, 120000);
});
