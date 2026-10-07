import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { LongjingRequestDto, MAX_PROOF_LENGTH } from './api-request.dto';

describe('request DTO shape checks', () => {
  const validRequest = {
    payload: 'hello',
    nonce: '0x2a',
    nullifier: '0x' + 'ab'.repeat(32),
    signal: { x: '0x1f', y: '-12345' },
    proof: '{"protocol":"groth16"}',
    merkleRoot: '0x' + '01'.repeat(32),
    accumulator: { x: 'deadbeef', y: '12345' },
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
    ['nonce', '1.5'],
    ['nonce', ''],
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

  it('rejects a malformed accumulator', async () => {
    const errors = await errorsFor({
      ...validRequest,
      accumulator: { x: '1' },
    });
    expect(errors.map((e) => e.property)).toContain('accumulator');
  });

  it('carries nothing that identifies the note', () => {
    const keys = Object.keys(plainToInstance(LongjingRequestDto, validRequest));
    for (const field of [
      'idCommitment',
      'initialDeposit',
      'ticketIndex',
      'maxCost',
    ]) {
      expect(keys).not.toContain(field);
    }
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
});
