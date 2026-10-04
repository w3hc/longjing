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
import {
  GenerateWithdrawalProofDto,
  GenerateRefundProofDto,
  GenerateSlashingProofDto,
  ProofResponseDto,
} from './dto/proof-generation.dto';
import { RefundSignerService } from './refund-signer.service';

@ApiTags('App')
@Controller('longjing')
export class LongjingController {
  constructor(
    private readonly longjingService: LongjingService,
    private readonly blockchainService: BlockchainService,
    private readonly nullifierStore: NullifierStoreService,
    private readonly costEstimationService: CostEstimationService,
    private readonly proofGenService: ProofGenService,
    private readonly refundSignerService: RefundSignerService,
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

    // Convert proof and publicSignals from hex strings to numbers/bigints
    const proof = request.proof.map((p) => Number(BigInt(p)));
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

  @Post('proofs/withdrawal')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Generate ZK proof for withdrawal',
    description:
      'Generate a Groth16 zero-knowledge proof for withdrawing funds. ' +
      'The proof demonstrates knowledge of the secret key without revealing it.',
  })
  @ApiResponse({
    status: 200,
    description: 'Withdrawal proof generated successfully',
    type: ProofResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid input parameters',
  })
  async generateWithdrawalProof(
    @Body() body: GenerateWithdrawalProofDto,
  ): Promise<ProofResponseDto> {
    const secretKey = BigInt(body.secretKey);
    const ticketIndex = BigInt(body.ticketIndex);
    const signalX = BigInt(body.signalX);

    const { proof, publicSignals } =
      await this.proofGenService.generateWithdrawalProof({
        secretKey,
        ticketIndex,
        signalX,
      });

    const idCommitment =
      await this.proofGenService.generateIdCommitment(secretKey);
    const { nullifier } = await this.proofGenService.generateRLNSignal(
      secretKey,
      ticketIndex,
      signalX,
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

  @Post('proofs/refund')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Generate ZK proof for refund redemption',
    description:
      'Generate a Groth16 zero-knowledge proof for redeeming refund tickets. ' +
      'The proof verifies EdDSA signatures without revealing signature details.',
  })
  @ApiResponse({
    status: 200,
    description: 'Refund proof generated successfully',
    type: ProofResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid input parameters',
  })
  async generateRefundProof(
    @Body() body: GenerateRefundProofDto,
  ): Promise<ProofResponseDto> {
    const secretKey = BigInt(body.secretKey);
    const ticketIndex = BigInt(body.ticketIndex);
    const signalX = BigInt(body.signalX);
    const recipient = body.recipient; // recipient binding

    // Calculate identity commitment and nullifier
    const idCommitment =
      await this.proofGenService.generateIdCommitment(secretKey);
    const { nullifier } = await this.proofGenService.generateRLNSignal(
      secretKey,
      ticketIndex,
      signalX,
    );

    // Generate mock refund ticket for testing/development
    const refundValue = BigInt(1000000); // 1M wei mock refund
    const refundTimestamp = Math.floor(Date.now() / 1000);

    const refundTicket = await this.refundSignerService.signRefund({
      idCommitment: '0x' + idCommitment.toString(16),
      nullifier: '0x' + nullifier.toString(16),
      value: refundValue.toString(),
      timestamp: refundTimestamp,
    });

    // Get server's public key
    const serverPublicKey = await this.refundSignerService.getPublicKey();

    // Generate proof with the signed refund ticket
    const { proof, publicSignals } =
      await this.proofGenService.generateRefundRedemptionProof({
        secretKey,
        ticketIndex,
        signalX,
        refundValue,
        refundTimestamp,
        refundSignature: refundTicket.signature,
        serverPublicKey,
        recipient, // bind recipient to proof
      });

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
  async generateSlashingProof(
    @Body() body: GenerateSlashingProofDto,
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
        secretKey: '0x' + secretKey.toString(16),
        timestamp: Date.now(),
      },
    };
  }
}
