import {
  IsString,
  IsNotEmpty,
  IsObject,
  ValidateNested,
  IsOptional,
  IsIn,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { IsFieldElement } from './field-element';
import { CLAUDE_MODELS } from '../../pricing/claude-pricing';

// A snarkjs Groth16 proof serializes to about 800 characters
export const MAX_PROOF_LENGTH = 4096;
// Matches the default Express JSON body limit (100 kB)
export const MAX_PAYLOAD_LENGTH = 100_000;

export class RlnSignalDto {
  @ApiProperty({ description: 'RLN signal x value' })
  @IsFieldElement()
  x: string;

  @ApiProperty({ description: 'RLN signal y value' })
  @IsFieldElement()
  y: string;
}

export class AccumulatorDto {
  @ApiProperty({ description: 'Baby Jubjub x coordinate' })
  @IsFieldElement()
  x: string;

  @ApiProperty({ description: 'Baby Jubjub y coordinate' })
  @IsFieldElement()
  y: string;
}

/**
 * A request as docs/SETTLEMENT.md defines it: nothing in it identifies the
 * note, its deposit or its index
 */
export class LongjingRequestDto {
  @ApiProperty({ description: 'Request payload for external API service' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_PAYLOAD_LENGTH)
  payload: string;

  @ApiProperty({
    description:
      'Fresh nonce ρ in the field, so that x = Poseidon(SHA-256(payload) mod p, ρ) reveals nothing about the payload',
  })
  @IsFieldElement()
  nonce: string;

  @ApiProperty({ description: 'RLN nullifier N (prevents double-spend)' })
  @IsFieldElement()
  nullifier: string;

  @ApiProperty({
    description: 'RLN signal (x, y), which reveals k if N is reused',
    type: RlnSignalDto,
  })
  @IsObject()
  @ValidateNested()
  @Type(() => RlnSignalDto)
  signal: RlnSignalDto;

  @ApiProperty({ description: 'Groth16 proof of request.circom, as JSON' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_PROOF_LENGTH)
  proof: string;

  @ApiProperty({ description: 'A recent Merkle root of the contract' })
  @IsFieldElement()
  merkleRoot: string;

  @ApiProperty({
    description:
      'A_pub, the re-randomized accumulator the proof outputs, which the server adds the refund to',
    type: AccumulatorDto,
  })
  @IsObject()
  @ValidateNested()
  @Type(() => AccumulatorDto)
  accumulator: AccumulatorDto;

  @ApiProperty({
    description: 'Model/service variant to use',
    enum: CLAUDE_MODELS,
    required: false,
  })
  @IsOptional()
  @IsIn(CLAUDE_MODELS)
  model?: string;
}
