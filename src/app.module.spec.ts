import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';
import { SecretsService } from './config/secrets.service';
import { AttestationController } from './attestation/attestation.controller';
import { HealthController } from './health/health.controller';
import { AuthController } from './auth/auth.controller';
import { SiweService } from './auth/siwe.service';

describe('AppModule', () => {
  it('should compile the module', async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    expect(module).toBeDefined();
  });

  it('should have all controllers registered', async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    expect(module.get(AttestationController)).toBeDefined();
    expect(module.get(HealthController)).toBeDefined();
    expect(module.get(AuthController)).toBeDefined();
  });

  it('should have all providers registered', async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    expect(module.get(SecretsService)).toBeDefined();
    expect(module.get(SiweService)).toBeDefined();
  });
});
