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
import { ProofGenService } from './proof-gen.service';
import { ComputeLimiterService } from './compute-limiter.service';
import {
  GenerateSlashingProofDto,
  ProofResponseDto,
} from './dto/proof-generation.dto';

@ApiTags('App')
@Controller('longjing')
export class LongjingController {
  constructor(
    private readonly longjingService: LongjingService,
    private readonly costEstimationService: CostEstimationService,
    private readonly proofGenService: ProofGenService,
    private readonly computeLimiter: ComputeLimiterService,
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

  @Post('proofs/slashing')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Generate ZK proof for double-spend slashing',
    description:
      'Generate a Groth16 zero-knowledge proof for slashing a double-spender. ' +
      'The proof verifies that a secret key was correctly extracted from two RLN signals.',
  })
  @ApiResponse({
    status: 200,
    description: 'Slashing proof generated successfully',
    type: ProofResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid input parameters or signals do not reveal secret key',
  })
  @ApiResponse({
    status: 503,
    description: 'Too many proofs being generated, retry later',
  })
  async generateSlashingProof(
    @Body() body: GenerateSlashingProofDto,
  ): Promise<ProofResponseDto> {
    return this.computeLimiter.proving.run(() => this.proveSlashing(body));
  }

  private async proveSlashing(
    body: GenerateSlashingProofDto,
  ): Promise<ProofResponseDto> {
    const secretKey = BigInt(body.secretKey);
    const ticketIndex = BigInt(body.ticketIndex);
    const signal1 = {
      x: BigInt(body.signal1.x),
      y: BigInt(body.signal1.y),
    };
    const signal2 = {
      x: BigInt(body.signal2.x),
      y: BigInt(body.signal2.y),
    };

    const { proof, publicSignals } =
      await this.proofGenService.generateDoubleSpendProof({
        secretKey,
        ticketIndex,
        signal1,
        signal2,
      });

    const idCommitment =
      await this.proofGenService.generateIdCommitment(secretKey);
    const { nullifier } = await this.proofGenService.generateRLNSignal(
      secretKey,
      ticketIndex,
      signal1.x,
    );

    return {
      proof: proof.map((p) => '0x' + BigInt(p).toString(16)),
      publicSignals: publicSignals.map((s) => '0x' + BigInt(s).toString(16)),
      metadata: {
        idCommitment: '0x' + idCommitment.toString(16),
        nullifier: '0x' + nullifier.toString(16),
        timestamp: Date.now(),
      },
    };
  }
}
