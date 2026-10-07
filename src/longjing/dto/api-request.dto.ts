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

export class LongjingRequestDto {
  @ApiProperty({ description: 'Request payload for external API service' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_PAYLOAD_LENGTH)
  payload: string;

  @ApiProperty({ description: 'RLN nullifier (prevents double-spend)' })
  @IsFieldElement()
  nullifier: string;

  @ApiProperty({
    description: 'RLN signal for slashing detection',
    type: RlnSignalDto,
  })
  @IsObject()
  @ValidateNested()
  @Type(() => RlnSignalDto)
  signal: RlnSignalDto;

  @ApiProperty({ description: 'ZK-SNARK proof (Groth16)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_PROOF_LENGTH)
  proof: string;

  @ApiProperty({ description: 'Maximum cost user is willing to pay (in wei)' })
  @IsFieldElement()
  maxCost: string;

  @ApiProperty({ description: 'Merkle root from on-chain state' })
  @IsFieldElement()
  merkleRoot: string;

  @ApiProperty({ description: 'Initial deposit amount (in wei)' })
  @IsFieldElement()
  initialDeposit: string;

  @ApiProperty({ description: 'Ticket index for this request' })
  @IsFieldElement()
  ticketIndex: string;

  @ApiProperty({ description: 'Identity commitment (Hash of secret key)' })
  @IsFieldElement()
  idCommitment: string;

  @ApiProperty({
    description:
      'Expected identity commitment (public input for circuit constraint)',
  })
  @IsFieldElement()
  idCommitmentExpected: string;

  @ApiProperty({
    description: 'Model/service variant to use',
    enum: CLAUDE_MODELS,
    required: false,
  })
  @IsOptional()
  @IsIn(CLAUDE_MODELS)
  model?: string;
}
