import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UsageDto {
  // Fixed: Quantized cost classes instead of exact values
  // This prevents linking requests based on fine-grained token/cost metadata

  @ApiProperty({
    description:
      'Quantized unit class (prevents linkability via exact token counts)',
    enum: ['tiny', 'small', 'medium', 'large', 'xlarge'],
  })
  unitClass: 'tiny' | 'small' | 'medium' | 'large' | 'xlarge';

  @ApiProperty({
    description: 'Unit type',
    enum: [
      'tokens',
      'calls',
      'bytes',
      'seconds',
      'images',
      'credits',
      'custom',
    ],
  })
  unitType:
    'tokens' | 'calls' | 'bytes' | 'seconds' | 'images' | 'credits' | 'custom';

  @ApiProperty({
    description:
      'Quantized cost class (prevents linkability via exact cost tracking)',
    enum: ['micro', 'small', 'medium', 'large', 'xlarge'],
  })
  costClass: 'micro' | 'small' | 'medium' | 'large' | 'xlarge';

  // Metadata
  @ApiPropertyOptional({ description: 'Provider ID' })
  provider?: string;

  @ApiPropertyOptional({ description: 'API endpoint' })
  endpoint?: string;

  @ApiPropertyOptional({ description: 'Timestamp' })
  timestamp?: Date;

  // REMOVED fields for privacy:
  // - units: exact token count (linkable)
  // - costUSD: exact cost (linkable)
  // - breakdown: input/output token breakdown (linkable)
  // - inputTokens/outputTokens: deprecated and linkable

  // Internal-only fields (not exposed in API response)
  // Used for actual billing calculation
  @ApiPropertyOptional({
    description: 'Internal: actual units for billing (not returned to client)',
  })
  _internalUnits?: number;

  @ApiPropertyOptional({
    description: 'Internal: actual cost for billing (not returned to client)',
  })
  _internalCostUSD?: number;

  @ApiPropertyOptional({
    description: 'Internal: input tokens for billing (not returned to client)',
  })
  _internalInputTokens?: number;

  @ApiPropertyOptional({
    description: 'Internal: output tokens for billing (not returned to client)',
  })
  _internalOutputTokens?: number;
}

export class RefundTicketDto {
  @ApiProperty({ description: 'Nullifier this refund is for' })
  nullifier: string;

  @ApiProperty({ description: 'Refund value in wei' })
  value: string;

  @ApiProperty({ description: 'Timestamp when refund was issued' })
  timestamp: number;

  @ApiProperty({ description: 'Server signature (EdDSA)' })
  signature: {
    R8x: string;
    R8y: string;
    S: string;
  };
}

export class LongjingResponseDto {
  @ApiProperty({ description: 'External API response content' })
  response: string;

  @ApiProperty({ description: 'Actual cost in wei' })
  actualCost: string;

  @ApiProperty({ description: 'Signed refund ticket', type: RefundTicketDto })
  refundTicket: RefundTicketDto;

  @ApiProperty({
    description: 'Usage metrics (example: token counts)',
    type: UsageDto,
  })
  usage: UsageDto;
}
