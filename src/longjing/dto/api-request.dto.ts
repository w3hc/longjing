import {
  IsString,
  IsNotEmpty,
  IsObject,
  ValidateNested,
  IsOptional,
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class RlnSignalDto {
  @ApiProperty({ description: 'RLN signal x value' })
  @IsString()
  @IsNotEmpty()
  x: string;

  @ApiProperty({ description: 'RLN signal y value' })
  @IsString()
  @IsNotEmpty()
  y: string;
}

export class LongjingRequestDto {
  @ApiProperty({ description: 'Request payload for external API service' })
  @IsString()
  @IsNotEmpty()
  payload: string;

  @ApiProperty({ description: 'RLN nullifier (prevents double-spend)' })
  @IsString()
  @IsNotEmpty()
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
  proof: string;

  @ApiProperty({ description: 'Maximum cost user is willing to pay (in wei)' })
  @IsString()
  @IsNotEmpty()
  maxCost: string;

  @ApiProperty({ description: 'Merkle root from on-chain state' })
  @IsString()
  @IsNotEmpty()
  merkleRoot: string;

  @ApiProperty({ description: 'Initial deposit amount (in wei)' })
  @IsString()
  @IsNotEmpty()
  initialDeposit: string;

  @ApiProperty({ description: 'Ticket index for this request' })
  @IsString()
  @IsNotEmpty()
  ticketIndex: string;

  @ApiProperty({ description: 'Identity commitment (Hash of secret key)' })
  @IsString()
  @IsNotEmpty()
  idCommitment: string;

  @ApiProperty({
    description:
      'Expected identity commitment (public input for circuit constraint)',
  })
  @IsString()
  @IsNotEmpty()
  idCommitmentExpected: string;

  @ApiProperty({
    description: 'Model/service variant to use (example: claude-fable-5-1)',
    required: false,
  })
  @IsString()
  @IsOptional()
  model?: string;
}

export class RefundSignatureDto {
  @ApiProperty({ description: 'EdDSA signature R8x component' })
  @IsString()
  @IsNotEmpty()
  R8x: string;

  @ApiProperty({ description: 'EdDSA signature R8y component' })
  @IsString()
  @IsNotEmpty()
  R8y: string;

  @ApiProperty({ description: 'EdDSA signature S component' })
  @IsString()
  @IsNotEmpty()
  S: string;
}

export class RedeemRefundRequestDto {
  @ApiProperty({ description: 'Identity commitment (Hash of secret key)' })
  @IsString()
  @IsNotEmpty()
  idCommitment: string;

  @ApiProperty({ description: 'Nullifier from the API request' })
  @IsString()
  @IsNotEmpty()
  nullifier: string;

  @ApiProperty({ description: 'Refund value in wei' })
  @IsString()
  @IsNotEmpty()
  value: string;

  @ApiProperty({ description: 'Recipient address for the refund' })
  @IsString()
  @IsNotEmpty()
  recipient: string;

  @ApiProperty({
    description: 'Groth16 ZK proof (array of 8 hex strings)',
    type: [String],
    example: [
      '0x...',
      '0x...',
      '0x...',
      '0x...',
      '0x...',
      '0x...',
      '0x...',
      '0x...',
    ],
  })
  @IsArray()
  @ArrayMinSize(8)
  @ArrayMaxSize(8)
  @IsString({ each: true })
  proof: string[];

  @ApiProperty({
    description:
      'Public signals in snarkjs order (array of 8 hex strings): nullifier, signalY, idCommitment, signalX, refundValueClaimed, serverPublicKeyX, serverPublicKeyY, recipient',
    type: [String],
    example: [
      '0x...',
      '0x...',
      '0x...',
      '0x...',
      '0x...',
      '0x...',
      '0x...',
      '0x...',
    ],
  })
  @IsArray()
  @ArrayMinSize(8)
  @ArrayMaxSize(8)
  @IsString({ each: true })
  publicSignals: string[];
}
