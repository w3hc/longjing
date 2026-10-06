import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { LongjingRequestDto, MAX_PROOF_LENGTH } from './api-request.dto';
import { GenerateSlashingProofDto } from './proof-generation.dto';

describe('request DTO shape checks', () => {
  const validRequest = {
    payload: 'hello',
    nullifier: '0x' + 'ab'.repeat(32),
    signal: { x: '0x1f', y: '-12345' },
    proof: '{"protocol":"groth16"}',
    maxCost: '1000000000000000',
    merkleRoot: '0x' + '01'.repeat(32),
    initialDeposit: '200000000000000000',
    ticketIndex: '0',
    idCommitment: 'deadbeef',
    idCommitmentExpected: 'deadbeef',
  };

  const errorsFor = async (body: object) =>
    validate(plainToInstance(LongjingRequestDto, body));

  it('accepts hex, bare hex and decimal field elements', async () => {
    expect(await errorsFor(validRequest)).toHaveLength(0);
  });

  it.each([
    ['nullifier', 'not-a-number'],
    ['nullifier', '0x' + 'f'.repeat(65)],
    ['merkleRoot', '1'.repeat(79)],
    ['maxCost', '1.5'],
    ['ticketIndex', ''],
  ])('rejects malformed %s %j', async (field, value) => {
    const errors = await errorsFor({ ...validRequest, [field]: value });
    expect(errors.map((e) => e.property)).toContain(field);
  });

  it('accepts a priced model', async () => {
    expect(
      await errorsFor({ ...validRequest, model: 'claude-haiku-4-5' }),
    ).toHaveLength(0);
  });

  it('rejects a model with no pricing', async () => {
    const errors = await errorsFor({
      ...validRequest,
      model: 'claude-3-opus-20240229',
    });
    expect(errors.map((e) => e.property)).toContain('model');
  });

  it('rejects a malformed signal', async () => {
    const errors = await errorsFor({
      ...validRequest,
      signal: { x: 'zz', y: '1' },
    });
    expect(errors.map((e) => e.property)).toContain('signal');
  });

  it('rejects an oversized proof', async () => {
    const errors = await errorsFor({
      ...validRequest,
      proof: 'a'.repeat(MAX_PROOF_LENGTH + 1),
    });
    expect(errors.map((e) => e.property)).toContain('proof');
  });

  it('rejects malformed slashing inputs', async () => {
    const errors = await validate(
      plainToInstance(GenerateSlashingProofDto, {
        secretKey: 'secret',
        ticketIndex: '0x01',
        signal1: { x: '0x1', y: '0x2' },
        signal2: { x: '0x3', y: '0x4' },
      }),
    );
    expect(errors.map((e) => e.property)).toEqual(['secretKey']);
  });
});
