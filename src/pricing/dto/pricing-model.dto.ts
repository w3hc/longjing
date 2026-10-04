import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsArray,
  IsNumber,
  IsEnum,
  IsDate,
} from 'class-validator';
import { Type } from 'class-transformer';

export type PricingType =
  'per-token' | 'per-call' | 'per-unit' | 'tiered' | 'composite';

export class PricingRate {
  @IsEnum(['per-token', 'per-call', 'per-unit', 'tiered', 'composite'])
  type: PricingType;

  @IsNumber()
  rate: number; // USD per unit

  @IsOptional()
  @IsString()
  unit?: string; // 'input_token' | 'output_token' | 'call' | 'image' | ...

  @IsOptional()
  @IsArray()
  tiers?: Array<{
    from: number;
    to?: number; // undefined = infinity
    rate: number;
  }>;
}

export class PricingModel {
  @IsString()
  @IsNotEmpty()
  providerId: string;

  @IsOptional()
  @IsString()
  endpoint?: string;

  @IsEnum(['per-token', 'per-call', 'per-unit', 'tiered', 'composite'])
  pricingType: PricingType;

  @IsArray()
  @Type(() => PricingRate)
  rates: PricingRate[];

  @IsString()
  currency: string;

  @IsDate()
  @Type(() => Date)
  effectiveFrom: Date;

  @IsOptional()
  @IsDate()
  @Type(() => Date)
  effectiveUntil?: Date;
}

export class UpdatePricingDto {
  @IsNotEmpty()
  model: PricingModel;

  @IsString()
  @IsNotEmpty()
  changedBy: string;

  @IsString()
  @IsNotEmpty()
  reason: string;
}

export interface PricingHistory {
  id: number;
  providerId: string;
  endpoint?: string;
  oldRates?: string;
  newRates: string;
  changedBy: string;
  changedAt: Date;
  reason: string;
}
