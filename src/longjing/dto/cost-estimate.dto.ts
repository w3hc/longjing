import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  Min,
} from 'class-validator';

export class CostEstimateRequestDto {
  @ApiProperty({ description: 'Provider ID', example: 'claude' })
  @IsString()
  @IsNotEmpty()
  provider: string;

  @ApiPropertyOptional({ description: 'API endpoint', example: '/v1/messages' })
  @IsString()
  @IsOptional()
  endpoint?: string;

  @ApiProperty({ description: 'Estimated units', example: 1000 })
  @IsNumber()
  @Min(1)
  estimatedUnits: number;

  @ApiPropertyOptional({ description: 'Unit type', example: 'tokens' })
  @IsString()
  @IsOptional()
  unitType?: string;

  @ApiPropertyOptional({ description: 'Provider-specific estimation hints' })
  @IsOptional()
  metadata?: Record<string, any>;
}

export class CostEstimateResponseDto {
  @ApiProperty({ description: 'Provider ID' })
  provider: string;

  @ApiPropertyOptional({ description: 'API endpoint' })
  endpoint?: string;

  @ApiProperty({ description: 'Estimated cost in USD' })
  estimatedCostUSD: number;

  @ApiProperty({ description: 'Estimated cost in wei' })
  estimatedCostWei: string;

  @ApiProperty({
    description: 'Recommended deposit in wei (with safety margin)',
  })
  recommendedDepositWei: string;

  @ApiPropertyOptional({ description: 'Cost breakdown' })
  breakdown?: {
    baseCostUSD: number;
    safetyMarginUSD: number;
    currentEthRateUSD: number;
  };

  @ApiProperty({ description: 'Confidence level (0-1)' })
  confidence: number;

  @ApiProperty({ description: 'Pricing model used' })
  pricingModel: string;

  @ApiProperty({ description: 'Timestamp' })
  timestamp: Date;
}
