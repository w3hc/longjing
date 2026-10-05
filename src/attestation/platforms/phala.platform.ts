/**
 * Phala Network Platform Adapter
 *
 * Uses @phala/dstack-sdk to generate TDX quotes via dstack.sock
 */

import { Injectable, Logger } from '@nestjs/common';
import { DstackClient } from '@phala/dstack-sdk';
import * as fs from 'fs';
import { ITeePlatform } from './platform.interface';
import { AttestationQuote } from '../attestation.types';

// TDX quote v4: 48-byte header, then the TD report body, whose report_data
// is 64 bytes at offset 520
const TDX_REPORT_DATA_OFFSET = 48 + 520;
const TDX_REPORT_DATA_LENGTH = 64;

/**
 * Reads the report_data a TDX quote attests to.
 */
export function tdxQuoteReportData(quote: Buffer): Buffer {
  const end = TDX_REPORT_DATA_OFFSET + TDX_REPORT_DATA_LENGTH;
  if (quote.length < end) {
    throw new Error(`TDX quote too short: ${quote.length} bytes`);
  }
  return quote.subarray(TDX_REPORT_DATA_OFFSET, end);
}

@Injectable()
export class PhalaPlatform implements ITeePlatform {
  readonly name = 'phala' as const;
  private readonly logger = new Logger(PhalaPlatform.name);
  private client: DstackClient | null = null;

  async isAvailable(): Promise<boolean> {
    if (!fs.existsSync('/var/run/dstack.sock')) {
      return false;
    }

    try {
      this.client = new DstackClient();
      await this.client.info();
      return true;
    } catch (error) {
      if (process.env.NODE_ENV !== 'test') {
        this.logger.debug(
          `Phala dstack.sock exists but connection failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return false;
    }
  }

  async generateQuote(reportData: Buffer): Promise<AttestationQuote> {
    if (!this.client) {
      this.client = new DstackClient();
    }

    try {
      // Phala's getQuote accepts up to 64 bytes
      const reportDataHex = reportData.subarray(0, 64).toString('hex');

      // Get TDX quote from Phala
      const result = await this.client.getQuote(
        Buffer.from(reportDataHex, 'hex'),
      );

      // Parse the quote response
      const quoteHex = result.quote.startsWith('0x')
        ? result.quote.slice(2)
        : result.quote;
      const quoteBuffer = Buffer.from(quoteHex, 'hex');

      // Extract MRTD from TDX quote (offset 112, 48 bytes)
      // TDX quote structure: https://download.01.org/intel-sgx/latest/dcap-latest/linux/docs/Intel_TDX_DCAP_Quoting_Library_API.pdf
      const measurement = quoteBuffer.subarray(112, 160).toString('hex');

      return {
        platform: this.name,
        quote: quoteBuffer.toString('base64'),
        reportData: reportData.toString('hex'),
        measurement,
        eventLog: result.event_log,
        timestamp: new Date().toISOString(),
        raw: result,
      };
    } catch (error) {
      if (process.env.NODE_ENV !== 'test') {
        this.logger.error(
          `Failed to generate Phala TDX quote: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      throw new Error('Phala TDX attestation generation failed', {
        cause: error,
      });
    }
  }
}
