import {
  IsString,
  IsNotEmpty,
  IsOptional,
  ValidateNested,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';

/**
 * Request DTO for generating withdrawal proof
 */
export class GenerateWithdrawalProofDto {
  @ApiProperty({
    description: 'Secret key (as hex string)',
    example: '0x1234567890abcdef...',
  })
  @IsString()
  @IsNotEmpty()
  secretKey!: string;

  @ApiProperty({
    description: 'Ticket index (as hex string)',
    example: '0x01',
  })
  @IsString()
  @IsNotEmpty()
  ticketIndex!: string;

  @ApiProperty({
    description: 'RLN signal X value (as hex string)',
    example: '0xabcdef...',
  })
  @IsString()
  @IsNotEmpty()
  signalX!: string;
}

/**
 * Request DTO for generating refund redemption proof
 */
export class GenerateRefundProofDto {
  @ApiProperty({
    description: 'Secret key (as hex string)',
    example: '0x1234567890abcdef...',
  })
  @IsString()
  @IsNotEmpty()
  secretKey!: string;

  @ApiProperty({
    description: 'Ticket index (as hex string)',
    example: '0x01',
  })
  @IsString()
  @IsNotEmpty()
  ticketIndex!: string;

  @ApiProperty({
    description: 'RLN signal X value (as hex string)',
    example: '0xabcdef...',
  })
  @IsString()
  @IsNotEmpty()
  signalX!: string;

  @ApiProperty({
    description: 'Recipient Ethereum address (for front-running protection)',
    example: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  })
  @IsString()
  @IsNotEmpty()
  recipient!: string;

  @ApiProperty({
    description: 'Identity commitment (optional, for validation)',
    example: '0x...',
    required: false,
  })
  @IsString()
  @IsOptional()
  idCommitment?: string;

  @ApiProperty({
    description: 'Nullifier to redeem (optional, for validation)',
    example: '0x...',
    required: false,
  })
  @IsString()
  @IsOptional()
  nullifier?: string;
}

/**
 * Signal DTO for double-spend slashing
 */
class RLNSignalDto {
  @ApiProperty({
    description: 'Signal X value (as hex string)',
    example: '0xabcdef...',
  })
  @IsString()
  @IsNotEmpty()
  x!: string;

  @ApiProperty({
    description: 'Signal Y value (as hex string)',
    example: '0x123456...',
  })
  @IsString()
  @IsNotEmpty()
  y!: string;
}

/**
 * Request DTO for generating double-spend slashing proof
 */
export class GenerateSlashingProofDto {
  @ApiProperty({
    description: 'Secret key extracted from double-spend (as hex string)',
    example: '0x1234567890abcdef...',
  })
  @IsString()
  @IsNotEmpty()
  secretKey!: string;

  @ApiProperty({
    description: 'Ticket index (as hex string)',
    example: '0x01',
  })
  @IsString()
  @IsNotEmpty()
  ticketIndex!: string;

  @ApiProperty({
    description: 'First RLN signal',
    type: RLNSignalDto,
  })
  @ValidateNested()
  @Type(() => RLNSignalDto)
  signal1!: RLNSignalDto;

  @ApiProperty({
    description: 'Second RLN signal (with different x value)',
    type: RLNSignalDto,
  })
  @ValidateNested()
  @Type(() => RLNSignalDto)
  signal2!: RLNSignalDto;
}

/**
 * Response DTO for proof generation
 */
export class ProofResponseDto {
  @ApiProperty({
    description: 'Groth16 proof formatted for contract submission',
    example: [
      '0x1234...',
      '0x5678...',
      '0x9abc...',
      '0xdef0...',
      '0x1111...',
      '0x2222...',
      '0x3333...',
      '0x4444...',
    ],
  })
  proof!: string[];

  @ApiProperty({
    description: 'Public signals for verification',
    example: ['0x...', '0x...', '0x...', '0x...', '0x...'],
  })
  publicSignals!: string[];

  @ApiProperty({
    description: 'Additional metadata',
    example: {
      idCommitment: '0x...',
      nullifier: '0x...',
      timestamp: 1234567890,
    },
  })
  metadata?: Record<string, any>;
}
