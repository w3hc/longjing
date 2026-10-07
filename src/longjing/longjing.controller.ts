import {
  Controller,
  Post,
  Get,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { LongjingService } from './longjing.service';
import { LongjingRequestDto } from './dto/api-request.dto';
import { LongjingResponseDto } from './dto/api-response.dto';
import { CostEstimationService } from './cost-estimation.service';
import {
  CostEstimateRequestDto,
  CostEstimateResponseDto,
} from './dto/cost-estimate.dto';

@ApiTags('App')
@Controller('longjing')
export class LongjingController {
  constructor(
    private readonly longjingService: LongjingService,
    private readonly costEstimationService: CostEstimationService,
  ) {}

  @Post('request')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Submit anonymous API request with ZK proof',
    description:
      'Submit an external API request with zero-knowledge proof of solvency. ' +
      'Requires valid ZK proof and unique nullifier. Returns API response and signed refund ticket. ' +
      '(Example implementation: Claude API)',
  })
  @ApiResponse({
    status: 200,
    description: 'Request processed successfully',
    type: LongjingResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid ZK proof',
  })
  @ApiResponse({
    status: 403,
    description: 'Double-spend detected or nullifier already used',
  })
  async handleRequest(
    @Body() request: LongjingRequestDto,
  ): Promise<LongjingResponseDto> {
    return this.longjingService.handleRequest(request);
  }

  @Get('server-pubkey')
  @ApiOperation({
    summary: 'Get server public key',
    description:
      'Returns the server EdDSA public key for verifying refund ticket signatures',
  })
  @ApiResponse({
    status: 200,
    description: 'Server public key',
    schema: {
      type: 'object',
      properties: {
        x: { type: 'string', description: 'Public key x coordinate' },
        y: { type: 'string', description: 'Public key y coordinate' },
      },
    },
  })
  async getServerPublicKey(): Promise<{ x: string; y: string }> {
    return this.longjingService.getServerPublicKey();
  }

  @Post('estimate-cost')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Estimate cost for API request',
    description:
      'Get cost estimate for an API request to help plan deposit amounts. ' +
      'Returns estimated cost in USD and wei, plus recommended deposit with safety margin.',
  })
  @ApiResponse({
    status: 200,
    description: 'Cost estimate calculated successfully',
    type: CostEstimateResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Provider not found',
  })
  async estimateCost(
    @Body() request: CostEstimateRequestDto,
  ): Promise<CostEstimateResponseDto> {
    return this.costEstimationService.estimateCost(request);
  }
}
