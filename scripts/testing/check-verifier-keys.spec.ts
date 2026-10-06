import { readFileSync } from 'fs';
import { join } from 'path';
import { trapdoorErrors, VerificationKey } from './check-verifier-keys';

const FIXTURE = 'delta_equals_gamma_verification_key.json';

describe('trapdoorErrors', () => {
  const vk = JSON.parse(
    readFileSync(join(__dirname, 'fixtures', FIXTURE), 'utf8'),
  ) as VerificationKey;

  it('flags a key with delta equal to gamma', () => {
    expect(trapdoorErrors(FIXTURE, vk)).toEqual([
      `${FIXTURE}: vk_delta_2 equals vk_gamma_2, proofs can be forged`,
    ]);
  });

  it('passes a key with a distinct delta', () => {
    expect(
      trapdoorErrors(FIXTURE, { ...vk, vk_delta_2: vk.vk_beta_2 }),
    ).toEqual([]);
  });
});
