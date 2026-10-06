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
import {
  LongjingRequestDto,
  RedeemRefundRequestDto,
} from './dto/api-request.dto';
import { LongjingResponseDto } from './dto/api-response.dto';
import { BlockchainService } from './blockchain.service';
import { NullifierStoreService } from './nullifier-store.service';
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
    private readonly blockchainService: BlockchainService,
    private readonly nullifierStore: NullifierStoreService,
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

  @Post('redeem-refund')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Redeem a signed refund ticket',
    description:
      'Submit a signed refund ticket obtained from an API response to claim the refund onchain. ' +
      'The refund will be transferred to the specified recipient address.',
  })
  @ApiResponse({
    status: 200,
    description: 'Refund redeemed successfully',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        transactionHash: {
          type: 'string',
          description: 'Transaction hash of the refund redemption',
        },
        message: { type: 'string' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid refund ticket or signature',
  })
  @ApiResponse({
    status: 403,
    description: 'Refund already redeemed or nullifier slashed',
  })
  @ApiResponse({
    status: 503,
    description: 'Blockchain service not available',
  })
  async redeemRefund(
    @Body() request: RedeemRefundRequestDto,
  ): Promise<{ success: boolean; transactionHash: string; message: string }> {
    if (!this.blockchainService.isAvailable()) {
      throw new Error('Blockchain service not available');
    }

    // Check if already redeemed
    const isRedeemed = await this.blockchainService.isRefundRedeemed(
      request.nullifier,
    );
    if (isRedeemed) {
      throw new Error('Refund already redeemed');
    }

    // Proof elements are 254-bit field elements, so they stay bigints
    const proof = request.proof.map((p) => BigInt(p));
    const publicSignals = request.publicSignals.map((s) => BigInt(s));

    const txHash = await this.blockchainService.redeemRefund({
      idCommitment: request.idCommitment,
      nullifier: request.nullifier,
      refundValue: request.value,
      recipient: request.recipient,
      proof,
      publicSignals,
    });

    // Track the redemption in our local store
    this.nullifierStore.markRefundRedeemed(request.nullifier, {
      idCommitment: request.idCommitment,
      value: request.value,
      timestamp: Date.now(),
      recipient: request.recipient,
      txHash,
    });

    return {
      success: true,
      transactionHash: txHash,
      message: `Refund of ${request.value} wei redeemed successfully`,
    };
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
