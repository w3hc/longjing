import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { SecretsService } from './config/secrets.service';
import { AttestationModule } from './attestation/attestation.module';
import { HealthController } from './health/health.controller';
import { validateEnvironment } from './config/env.validation';
import { AuthModule } from './auth/auth.module';
import { LongjingModule } from './longjing/longjing.module';
import { ThrottlerMetadataGuard } from './guards/throttler-metadata-guard';
import { RequestFingerprintThrottler } from './guards/request-fingerprint-throttler.guard';
import { TimingProtectionInterceptor } from './interceptors/timing-protection.interceptor';
import { MetadataSanitizerInterceptor } from './interceptors/metadata-sanitizer.interceptor';
import { RequestSanitizerMiddleware } from './middleware/request-sanitizer.middleware';

@Module({
  imports: [
    // Environment variable validation
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnvironment,
    }),
    // Hybrid rate limiting:
    // 1. Request fingerprint-based (privacy-preserving)
    // 2. Per-nullifier (in LongjingService via NullifierStoreService)
    ThrottlerModule.forRoot([
      {
        ttl: 60000, // 60 seconds
        // Higher limit in development for testing, lower in production
        limit: process.env.NODE_ENV === 'production' ? 10 : 100,
      },
    ]),
    AttestationModule,
    AuthModule,
    LongjingModule,
  ],
  controllers: [HealthController],
  providers: [
    SecretsService,
    // Hybrid rate limiting with privacy protection
    {
      provide: APP_GUARD,
      useClass: RequestFingerprintThrottler, // Request content-based rate limiting
    },
    {
      provide: APP_GUARD,
      useClass: ThrottlerMetadataGuard, // Metadata protection for rate limiting
    },
    // Global metadata leakage protection
    {
      provide: APP_INTERCEPTOR,
      useClass: TimingProtectionInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: MetadataSanitizerInterceptor,
    },
  ],
  exports: [SecretsService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Apply request sanitization to all routes
    consumer.apply(RequestSanitizerMiddleware).forRoutes('*');
  }
}
