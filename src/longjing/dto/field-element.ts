import { applyDecorators } from '@nestjs/common';
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

/**
 * A BN254 field element as 0x-prefixed or bare hex (up to 64 digits), or
 * decimal (up to 78 digits, optionally negative for signal y).
 *
 * Checked by the ValidationPipe, so malformed requests are rejected before any
 * RPC round-trip or Groth16 work.
 */
export const FIELD_ELEMENT_PATTERN =
  /^(?:(?:0x)?[0-9a-fA-F]{1,64}|-?\d{1,78})$/;

export function IsFieldElement(): PropertyDecorator {
  return applyDecorators(
    IsString(),
    IsNotEmpty(),
    MaxLength(80),
    Matches(FIELD_ELEMENT_PATTERN, {
      message: '$property must be a field element (hex or decimal)',
    }),
  );
}
