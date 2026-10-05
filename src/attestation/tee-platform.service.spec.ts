import { Test, TestingModule } from '@nestjs/testing';
import { TeePlatformService } from './tee-platform.service';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { DstackClient } from '@phala/dstack-sdk';

jest.mock('fs');
jest.mock('child_process');
jest.mock('@phala/dstack-sdk');

describe('TeePlatformService', () => {
  let service: TeePlatformService;

  beforeEach(() => {
    jest.clearAllMocks();
    // Default: no TEE devices exist
    (fs.existsSync as jest.Mock).mockReturnValue(false);
  });

  describe('platform detection', () => {
    it('should detect AMD SEV-SNP platform', async () => {
      (fs.existsSync as jest.Mock).mockImplementation((path: string) => {
        return path === '/dev/sev-guest';
      });

      const module: TestingModule = await Test.createTestingModule({
        providers: [TeePlatformService],
      }).compile();

      service = module.get<TeePlatformService>(TeePlatformService);

      expect(service.getPlatform()).toBe('amd-sev-snp');
      expect(service.isInTee()).toBe(true);
    });

    it('should detect Intel TDX platform', async () => {
      (fs.existsSync as jest.Mock).mockImplementation((path: string) => {
        return path === '/dev/tdx-guest';
      });

      const module: TestingModule = await Test.createTestingModule({
        providers: [TeePlatformService],
      }).compile();

      service = module.get<TeePlatformService>(TeePlatformService);

      expect(service.getPlatform()).toBe('intel-tdx');
      expect(service.isInTee()).toBe(true);
    });

    it('should detect AWS Nitro platform', async () => {
      (fs.existsSync as jest.Mock).mockImplementation((path: string) => {
        return path === '/dev/nsm';
      });

      const module: TestingModule = await Test.createTestingModule({
        providers: [TeePlatformService],
      }).compile();

      service = module.get<TeePlatformService>(TeePlatformService);

      expect(service.getPlatform()).toBe('aws-nitro');
      expect(service.isInTee()).toBe(true);
    });

    it('should default to none when no TEE detected', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);

      const module: TestingModule = await Test.createTestingModule({
        providers: [TeePlatformService],
      }).compile();

      service = module.get<TeePlatformService>(TeePlatformService);

      expect(service.getPlatform()).toBe('none');
      expect(service.isInTee()).toBe(false);
    });
  });

  describe('generateAttestationReport', () => {
    beforeEach(async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);

      const module: TestingModule = await Test.createTestingModule({
        providers: [TeePlatformService],
      }).compile();

      service = module.get<TeePlatformService>(TeePlatformService);
    });

    it('should generate mock attestation for none platform', async () => {
      const result = await service.generateAttestationReport();

      expect(result.platform).toBe('none');
      expect(result.report).toBeDefined();
      expect(result.measurement).toBe('MOCK_MEASUREMENT_NOT_SECURE');
      expect(result.timestamp).toBeDefined();

      // Verify the report contains warning
      const decoded = JSON.parse(
        Buffer.from(result.report, 'base64').toString(),
      ) as { warning: string };
      expect(decoded.warning).toBe('MOCK_ATTESTATION_FOR_DEVELOPMENT_ONLY');
    });

    it('should include timestamp in mock attestation', async () => {
      const result = await service.generateAttestationReport();

      expect(result.timestamp).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );
    });

    it('should accept optional user data parameter', async () => {
      const userData = Buffer.from('test-user-data');
      const result = await service.generateAttestationReport(userData);

      expect(result).toBeDefined();
      expect(result.platform).toBe('none');
    });
  });

  describe('getPlatform', () => {
    it('should return the detected platform', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);

      const module: TestingModule = await Test.createTestingModule({
        providers: [TeePlatformService],
      }).compile();

      service = module.get<TeePlatformService>(TeePlatformService);

      expect(service.getPlatform()).toBe('none');
    });
  });

  describe('isInTee', () => {
    it('should return false when platform is none', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);

      const module: TestingModule = await Test.createTestingModule({
        providers: [TeePlatformService],
      }).compile();

      service = module.get<TeePlatformService>(TeePlatformService);

      expect(service.isInTee()).toBe(false);
    });

    it('should return true when platform is detected', async () => {
      (fs.existsSync as jest.Mock).mockImplementation((path: string) => {
        return path === '/dev/sev-guest';
      });

      const module: TestingModule = await Test.createTestingModule({
        providers: [TeePlatformService],
      }).compile();

      service = module.get<TeePlatformService>(TeePlatformService);

      expect(service.isInTee()).toBe(true);
    });
  });

  describe('SEV-SNP attestation', () => {
    beforeEach(async () => {
      (fs.existsSync as jest.Mock).mockImplementation((path: string) => {
        return path === '/dev/sev-guest';
      });

      const module: TestingModule = await Test.createTestingModule({
        providers: [TeePlatformService],
      }).compile();

      service = module.get<TeePlatformService>(TeePlatformService);
    });

    it('should generate SEV-SNP attestation successfully', async () => {
      const mockReport = Buffer.from('mock-sev-report'.padEnd(48, '0'));
      (execSync as jest.MockedFunction<typeof execSync>).mockReturnValue(
        Buffer.from(''),
      );
      (fs.readFileSync as jest.Mock).mockReturnValue(mockReport);
      (fs.unlinkSync as jest.Mock).mockReturnValue(undefined);

      const result = await service.generateAttestationReport();

      expect(result.platform).toBe('amd-sev-snp');
      expect(result.report).toBe(mockReport.toString('base64'));
      expect(result.measurement).toBe(
        mockReport.subarray(0, 48).toString('hex'),
      );
      expect(execSync).toHaveBeenCalledWith(
        'snpguest report /tmp/sev-attestation.bin',
        {
          stdio: 'pipe',
        },
      );
    });

    it('should fallback to alternative SEV tool when snpguest fails', async () => {
      const mockReport = Buffer.from('mock-sev-report'.padEnd(48, '0'));
      (execSync as jest.MockedFunction<typeof execSync>)
        .mockImplementationOnce(() => {
          throw new Error('snpguest not found');
        })
        .mockReturnValueOnce(Buffer.from(''));
      (fs.readFileSync as jest.Mock).mockReturnValue(mockReport);
      (fs.unlinkSync as jest.Mock).mockReturnValue(undefined);

      const result = await service.generateAttestationReport();

      expect(result.platform).toBe('amd-sev-snp');
      expect(execSync).toHaveBeenCalledWith(
        'sev-guest-get-report /tmp/sev-attestation.bin',
        { stdio: 'pipe' },
      );
    });

    it('should throw error when SEV-SNP attestation fails', async () => {
      (execSync as jest.MockedFunction<typeof execSync>).mockImplementation(
        () => {
          throw new Error('Command failed');
        },
      );

      await expect(service.generateAttestationReport()).rejects.toThrow(
        'SEV-SNP attestation generation failed',
      );
    });
  });

  describe('TDX attestation', () => {
    beforeEach(async () => {
      (fs.existsSync as jest.Mock).mockImplementation((path: string) => {
        // Return false for Phala sockets, true for TDX device
        if (path === '/var/run/dstack.sock') {
          return false;
        }
        return path === '/dev/tdx-guest';
      });

      const module: TestingModule = await Test.createTestingModule({
        providers: [TeePlatformService],
      }).compile();

      service = module.get<TeePlatformService>(TeePlatformService);
    });

    it('should generate TDX attestation successfully', async () => {
      const mockReport = Buffer.from('mock-tdx-report'.padEnd(48, '0'));
      (execSync as jest.MockedFunction<typeof execSync>).mockReturnValue(
        Buffer.from(''),
      );
      (fs.readFileSync as jest.Mock).mockReturnValue(mockReport);
      (fs.writeFileSync as jest.Mock).mockReturnValue(undefined);
      (fs.unlinkSync as jest.Mock).mockReturnValue(undefined);
      (fs.existsSync as jest.Mock).mockImplementation((path: string) => {
        // Return false for Phala sockets, true for everything else in TDX tests
        if (path === '/var/run/dstack.sock') {
          return false;
        }
        return true;
      });

      const result = await service.generateAttestationReport();

      expect(result.platform).toBe('intel-tdx');
      expect(result.report).toBe(mockReport.toString('base64'));
      expect(result.measurement).toBe(
        mockReport.subarray(0, 48).toString('hex'),
      );
    });

    it('should handle TDX attestation with user data', async () => {
      const userData = Buffer.from('test-data');
      const mockReport = Buffer.from('mock-tdx-report'.padEnd(48, '0'));
      (execSync as jest.MockedFunction<typeof execSync>).mockReturnValue(
        Buffer.from(''),
      );
      (fs.readFileSync as jest.Mock).mockReturnValue(mockReport);
      (fs.writeFileSync as jest.Mock).mockReturnValue(undefined);
      (fs.unlinkSync as jest.Mock).mockReturnValue(undefined);
      (fs.existsSync as jest.Mock).mockImplementation((path: string) => {
        // Return false for Phala sockets, true for everything else in TDX tests
        if (path === '/var/run/dstack.sock') {
          return false;
        }
        return true;
      });

      const result = await service.generateAttestationReport(userData);

      expect(result.platform).toBe('intel-tdx');
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        '/tmp/tdx-report-data.bin',
        userData,
      );
    });

    it('should fallback to reading /dev/tdx-guest directly when tdx-attest fails', async () => {
      const mockReport = Buffer.from('mock-tdx-report'.padEnd(48, '0'));
      (execSync as jest.MockedFunction<typeof execSync>).mockImplementation(
        () => {
          throw new Error('tdx-attest not found');
        },
      );
      (fs.readFileSync as jest.Mock).mockReturnValue(mockReport);
      (fs.writeFileSync as jest.Mock).mockReturnValue(undefined);
      (fs.unlinkSync as jest.Mock).mockReturnValue(undefined);
      (fs.existsSync as jest.Mock).mockReturnValue(false);

      const result = await service.generateAttestationReport();

      expect(result.platform).toBe('intel-tdx');
      expect(fs.readFileSync).toHaveBeenCalledWith('/dev/tdx-guest');
    });

    it('should throw error when TDX attestation fails', async () => {
      (execSync as jest.MockedFunction<typeof execSync>).mockImplementation(
        () => {
          throw new Error('Command failed');
        },
      );
      (fs.readFileSync as jest.Mock).mockImplementation(() => {
        throw new Error('File not found');
      });

      await expect(service.generateAttestationReport()).rejects.toThrow(
        'TDX attestation generation failed',
      );
    });
  });

  describe('Nitro attestation', () => {
    beforeEach(async () => {
      (fs.existsSync as jest.Mock).mockImplementation((path: string) => {
        return path === '/dev/nsm';
      });

      const module: TestingModule = await Test.createTestingModule({
        providers: [TeePlatformService],
      }).compile();

      service = module.get<TeePlatformService>(TeePlatformService);
    });

    it('should generate Nitro attestation successfully', async () => {
      const mockAttestation = Buffer.from(
        JSON.stringify({
          moduleId: 'i-test',
          timestamp: Date.now(),
          pcrs: {},
        }),
      );
      (execSync as jest.MockedFunction<typeof execSync>).mockReturnValue(
        Buffer.from('PCR0VALUE'),
      );
      (fs.readFileSync as jest.Mock).mockReturnValue(mockAttestation);
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.unlinkSync as jest.Mock).mockReturnValue(undefined);

      const result = await service.generateAttestationReport();

      expect(result.platform).toBe('aws-nitro');
      expect(result.report).toBe(mockAttestation.toString('base64'));
      expect(result.measurement).toBe('PCR0_MEASUREMENT_PLACEHOLDER');
    });

    it('should generate Nitro attestation with user data', async () => {
      const userData = Buffer.from('nonce-data');
      const mockAttestation = Buffer.from(JSON.stringify({ nonce: 'test' }));
      (execSync as jest.MockedFunction<typeof execSync>).mockReturnValue(
        Buffer.from('PCR0VALUE'),
      );
      (fs.readFileSync as jest.Mock).mockReturnValue(mockAttestation);
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.unlinkSync as jest.Mock).mockReturnValue(undefined);

      const result = await service.generateAttestationReport(userData);

      expect(result.platform).toBe('aws-nitro');
    });

    it('should create mock attestation when file does not exist', async () => {
      (execSync as jest.MockedFunction<typeof execSync>).mockReturnValue(
        Buffer.from('PCR0VALUE'),
      );
      (fs.readFileSync as jest.Mock).mockImplementation(() => {
        throw new Error('File not found');
      });
      (fs.existsSync as jest.Mock).mockReturnValue(false);

      const result = await service.generateAttestationReport();

      expect(result.platform).toBe('aws-nitro');
      expect(result.measurement).toBe('PCR0_MEASUREMENT_PLACEHOLDER');
    });

    it('should throw error when Nitro attestation fails', async () => {
      (execSync as jest.MockedFunction<typeof execSync>).mockImplementation(
        () => {
          throw new Error('Command failed');
        },
      );

      await expect(service.generateAttestationReport()).rejects.toThrow(
        'Nitro attestation generation failed',
      );
    });
  });

  describe('platform detection edge cases', () => {
    it('should detect AMD SEV via /dev/sev', async () => {
      (fs.existsSync as jest.Mock).mockImplementation((path: string) => {
        return path === '/dev/sev';
      });

      const module: TestingModule = await Test.createTestingModule({
        providers: [TeePlatformService],
      }).compile();

      service = module.get<TeePlatformService>(TeePlatformService);

      expect(service.getPlatform()).toBe('amd-sev-snp');
    });

    it('should detect Intel TDX via /dev/tdx_guest', async () => {
      (fs.existsSync as jest.Mock).mockImplementation((path: string) => {
        return path === '/dev/tdx_guest';
      });

      const module: TestingModule = await Test.createTestingModule({
        providers: [TeePlatformService],
      }).compile();

      service = module.get<TeePlatformService>(TeePlatformService);

      expect(service.getPlatform()).toBe('intel-tdx');
    });

    it('should detect Intel TDX via /sys/firmware/tdx_seam', async () => {
      (fs.existsSync as jest.Mock).mockImplementation((path: string) => {
        return path === '/sys/firmware/tdx_seam';
      });

      const module: TestingModule = await Test.createTestingModule({
        providers: [TeePlatformService],
      }).compile();

      service = module.get<TeePlatformService>(TeePlatformService);

      expect(service.getPlatform()).toBe('intel-tdx');
    });

    it('should detect Phala environment via dstack.sock', async () => {
      (fs.existsSync as jest.Mock).mockImplementation((path: string) => {
        return path === '/var/run/dstack.sock';
      });

      const module: TestingModule = await Test.createTestingModule({
        providers: [TeePlatformService],
      }).compile();

      service = module.get<TeePlatformService>(TeePlatformService);

      expect(service.getPlatform()).toBe('intel-tdx');
    });

    it('ignores the legacy tappd.sock', async () => {
      (fs.existsSync as jest.Mock).mockImplementation((path: string) => {
        return path === '/var/run/tappd.sock';
      });

      const module: TestingModule = await Test.createTestingModule({
        providers: [TeePlatformService],
      }).compile();

      service = module.get<TeePlatformService>(TeePlatformService);

      expect(service.getPlatform()).not.toBe('intel-tdx');
    });
  });

  describe('Phala TDX attestation', () => {
    beforeEach(async () => {
      (fs.existsSync as jest.Mock).mockImplementation((path: string) => {
        return path === '/var/run/dstack.sock';
      });

      const module: TestingModule = await Test.createTestingModule({
        providers: [TeePlatformService],
      }).compile();

      service = module.get<TeePlatformService>(TeePlatformService);
    });

    it('should generate Phala TDX attestation successfully', async () => {
      const mockQuote = '0x' + 'ab'.repeat(160); // Mock hex quote
      const mockGetQuote = jest.fn().mockResolvedValue({ quote: mockQuote });

      // Mock DstackClient constructor
      (
        DstackClient as jest.MockedClass<typeof DstackClient>
      ).mockImplementation(() => {
        return {
          getQuote: mockGetQuote,
        } as unknown as DstackClient;
      });

      const result = await service.generateAttestationReport();

      expect(result.platform).toBe('intel-tdx');
      expect(result.report).toBeDefined();
      expect(result.measurement).toBeDefined();
      expect(mockGetQuote).toHaveBeenCalled();
    });

    it('should handle Phala TDX attestation with user data', async () => {
      const userData = Buffer.from('test-data'.padEnd(64, '0'));
      const mockQuote = '0x' + 'ab'.repeat(160);
      const mockGetQuote = jest.fn().mockResolvedValue({ quote: mockQuote });

      (
        DstackClient as jest.MockedClass<typeof DstackClient>
      ).mockImplementation(() => {
        return {
          getQuote: mockGetQuote,
        } as unknown as DstackClient;
      });

      const result = await service.generateAttestationReport(userData);

      expect(result.platform).toBe('intel-tdx');
      expect(mockGetQuote).toHaveBeenCalledWith(userData.subarray(0, 64));
    });

    it('should truncate user data larger than 64 bytes for Phala', async () => {
      const userData = Buffer.from('test-data'.repeat(20)); // > 64 bytes
      const mockQuote = '0x' + 'ab'.repeat(160);
      const mockGetQuote = jest.fn().mockResolvedValue({ quote: mockQuote });

      (
        DstackClient as jest.MockedClass<typeof DstackClient>
      ).mockImplementation(() => {
        return {
          getQuote: mockGetQuote,
        } as unknown as DstackClient;
      });

      const result = await service.generateAttestationReport(userData);

      expect(result.platform).toBe('intel-tdx');
      expect(mockGetQuote).toHaveBeenCalledWith(userData.subarray(0, 64));
    });

    it('should use timestamp when no user data provided for Phala', async () => {
      const mockQuote = '0x' + 'ab'.repeat(160);
      const mockGetQuote = jest.fn().mockResolvedValue({ quote: mockQuote });

      (
        DstackClient as jest.MockedClass<typeof DstackClient>
      ).mockImplementation(() => {
        return {
          getQuote: mockGetQuote,
        } as unknown as DstackClient;
      });

      const result = await service.generateAttestationReport();

      expect(result.platform).toBe('intel-tdx');
      expect(mockGetQuote).toHaveBeenCalled();
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const callArg = mockGetQuote.mock.calls[0][0] as Buffer;
      expect(callArg).toBeInstanceOf(Buffer);
      expect(callArg.length).toBeLessThanOrEqual(64);
    });

    it('should handle quote without 0x prefix', async () => {
      const mockQuote = 'ab'.repeat(160); // Without 0x prefix
      const mockGetQuote = jest.fn().mockResolvedValue({ quote: mockQuote });

      (
        DstackClient as jest.MockedClass<typeof DstackClient>
      ).mockImplementation(() => {
        return {
          getQuote: mockGetQuote,
        } as unknown as DstackClient;
      });

      const result = await service.generateAttestationReport();

      expect(result.platform).toBe('intel-tdx');
      expect(result.report).toBeDefined();
    });

    it('should throw error when Phala TDX attestation fails', async () => {
      const mockGetQuote = jest
        .fn()
        .mockRejectedValue(new Error('Connection failed'));

      (
        DstackClient as jest.MockedClass<typeof DstackClient>
      ).mockImplementation(() => {
        return {
          getQuote: mockGetQuote,
        } as unknown as DstackClient;
      });

      await expect(service.generateAttestationReport()).rejects.toThrow(
        'Phala TDX attestation generation failed',
      );
    });

    it('should handle non-Error rejection in Phala attestation', async () => {
      const mockGetQuote = jest.fn().mockRejectedValue('Connection failed');

      (
        DstackClient as jest.MockedClass<typeof DstackClient>
      ).mockImplementation(() => {
        return {
          getQuote: mockGetQuote,
        } as unknown as DstackClient;
      });

      await expect(service.generateAttestationReport()).rejects.toThrow(
        'Phala TDX attestation generation failed',
      );
    });

    it('should log error silently in test environment when Phala TDX attestation fails', async () => {
      const mockGetQuote = jest
        .fn()
        .mockRejectedValue(new Error('Connection failed'));

      (
        DstackClient as jest.MockedClass<typeof DstackClient>
      ).mockImplementation(() => {
        return {
          getQuote: mockGetQuote,
        } as unknown as DstackClient;
      });

      // Should throw error but not log in test environment
      await expect(service.generateAttestationReport()).rejects.toThrow(
        'Phala TDX attestation generation failed',
      );
    });
  });

  describe('error handling edge cases', () => {
    it('should handle non-Error exceptions in SEV-SNP attestation', async () => {
      (fs.existsSync as jest.Mock).mockImplementation((path: string) => {
        return path === '/dev/sev-guest';
      });

      const module: TestingModule = await Test.createTestingModule({
        providers: [TeePlatformService],
      }).compile();

      service = module.get<TeePlatformService>(TeePlatformService);

      (execSync as jest.MockedFunction<typeof execSync>).mockImplementation(
        () => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw 'String error'; // Non-Error exception
        },
      );

      await expect(service.generateAttestationReport()).rejects.toThrow(
        'SEV-SNP attestation generation failed',
      );
    });

    it('should handle non-Error exceptions in TDX attestation', async () => {
      (fs.existsSync as jest.Mock).mockImplementation((path: string) => {
        if (path === '/var/run/dstack.sock') {
          return false;
        }
        return path === '/dev/tdx-guest';
      });

      const module: TestingModule = await Test.createTestingModule({
        providers: [TeePlatformService],
      }).compile();

      service = module.get<TeePlatformService>(TeePlatformService);

      (execSync as jest.MockedFunction<typeof execSync>).mockImplementation(
        () => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw 'String error';
        },
      );
      (fs.readFileSync as jest.Mock).mockImplementation(() => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'File error';
      });

      await expect(service.generateAttestationReport()).rejects.toThrow(
        'TDX attestation generation failed',
      );
    });

    it('should handle non-Error exceptions in Nitro attestation', async () => {
      (fs.existsSync as jest.Mock).mockImplementation((path: string) => {
        return path === '/dev/nsm';
      });

      const module: TestingModule = await Test.createTestingModule({
        providers: [TeePlatformService],
      }).compile();

      service = module.get<TeePlatformService>(TeePlatformService);

      (execSync as jest.MockedFunction<typeof execSync>).mockImplementation(
        () => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw 'String error';
        },
      );

      await expect(service.generateAttestationReport()).rejects.toThrow(
        'Nitro attestation generation failed',
      );
    });
  });

  describe('file cleanup edge cases', () => {
    it('should handle cleanup when report data file does not exist in TDX', async () => {
      (fs.existsSync as jest.Mock).mockImplementation((path: string) => {
        if (path === '/var/run/dstack.sock') {
          return false;
        }
        if (path === '/tmp/tdx-report-data.bin') {
          return false;
        }
        return path === '/dev/tdx-guest';
      });

      const module: TestingModule = await Test.createTestingModule({
        providers: [TeePlatformService],
      }).compile();

      service = module.get<TeePlatformService>(TeePlatformService);

      const mockReport = Buffer.from('mock-tdx-report'.padEnd(48, '0'));
      (execSync as jest.MockedFunction<typeof execSync>).mockReturnValue(
        Buffer.from(''),
      );
      (fs.readFileSync as jest.Mock).mockReturnValue(mockReport);
      (fs.writeFileSync as jest.Mock).mockReturnValue(undefined);
      (fs.unlinkSync as jest.Mock).mockReturnValue(undefined);

      const result = await service.generateAttestationReport();

      expect(result.platform).toBe('intel-tdx');
      // Should not throw error even if report data file doesn't exist
    });

    it('should clean up attestation file in Nitro when it exists', async () => {
      (fs.existsSync as jest.Mock).mockImplementation((path: string) => {
        if (path === '/dev/nsm') return true;
        if (path === '/tmp/nitro-attestation.cbor') return true;
        return false;
      });

      const module: TestingModule = await Test.createTestingModule({
        providers: [TeePlatformService],
      }).compile();

      service = module.get<TeePlatformService>(TeePlatformService);

      const mockAttestation = Buffer.from(JSON.stringify({ test: 'data' }));
      (execSync as jest.MockedFunction<typeof execSync>).mockReturnValue(
        Buffer.from('PCR0'),
      );
      (fs.readFileSync as jest.Mock).mockReturnValue(mockAttestation);
      (fs.unlinkSync as jest.Mock).mockReturnValue(undefined);

      await service.generateAttestationReport();

      expect(fs.unlinkSync).toHaveBeenCalledWith('/tmp/nitro-attestation.cbor');
    });
  });
});
