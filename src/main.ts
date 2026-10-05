// SPDX-License-Identifier: LGPL-3.0
// Copyright (C) 2026 Julien Béranger and the W3HC

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { SanitizedLogger } from './logging/sanitized-logger';
import { TeeExceptionFilter } from './filters/tee-exception.filter';
import { ProofVerifierService } from './longjing/proof-verifier.service';
import { loadTlsMaterial } from './tls/tee-tls';
import { assertNoKeyMaterialInEnv } from './keys/key-policy';

async function bootstrap() {
  const isProd = process.env.NODE_ENV === 'production';

  // Before TLS loads, since TLS_KEY_PATH / TLS_CERT_PATH are key material
  assertNoKeyMaterialInEnv();

  // TLS terminates INSIDE the TEE:
  // - dev: self-signed certs from ./secrets
  // - prod: key derived in-enclave via dstack KMS (or operator-provisioned
  //   enclave storage), failing closed if neither is available.
  // The served certificate is bound into the attestation report_data so
  // clients can verify the TLS endpoint is the attested enclave.
  const { httpsOptions, source: tlsSource } = await loadTlsMaterial(isProd);

  const app = await NestFactory.create(AppModule, {
    httpsOptions,
    logger: isProd ? new SanitizedLogger() : undefined,
  });

  // CRITICAL: Validate proof verification is ready for production
  if (isProd) {
    const proofVerifierService =
      app.get<ProofVerifierService>(ProofVerifierService);

    if (!proofVerifierService.isProductionReady()) {
      throw new Error(
        'FATAL: Cannot start in production mode without real proof verification. ' +
          'Configure circuit artifacts (verification key) before deploying.',
      );
    }

    console.log('✓ Proof verification configured for production');
  }

  // Security headers - protects against common web vulnerabilities
  // Enhanced configuration to minimize metadata leakage
  app.use(
    helmet({
      // Hide powered-by header
      hidePoweredBy: true,
      // Strict content type to prevent MIME sniffing
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"], // For Swagger UI
          imgSrc: ["'self'", 'data:'],
        },
      },
      // Remove server fingerprinting headers
      hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true,
      },
      // Additional protections
      frameguard: { action: 'deny' },
      xssFilter: true,
      ieNoOpen: true,
      noSniff: true,
    }),
  );

  // CORS configuration - restrict to trusted origins in production
  app.enableCors({
    origin: isProd ? false : '*', // Disable CORS in production by default
    credentials: true,
  });

  // Global validation pipe - validates all incoming requests
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // Strip properties that don't have decorators
      forbidNonWhitelisted: true, // Throw error if non-whitelisted properties exist
      transform: true, // Transform payloads to DTO instances
    }),
  );

  // Global exception filter - sanitizes all error responses
  app.useGlobalFilters(new TeeExceptionFilter());

  // Swagger API documentation setup
  const config = new DocumentBuilder()
    .setTitle('Longjing')
    .setDescription('API documentation for Longjing')
    .setVersion('0.4.0')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('', app, document);

  // Graceful shutdown handling
  app.enableShutdownHooks();

  const port = 3000;
  await app.listen(port);

  // Log startup only in dev mode (production logger filters this out)
  const protocol = httpsOptions ? 'https' : 'http';
  console.log(
    `Application is running on: ${protocol}://localhost:${port} (TLS source: ${tlsSource})`,
  );
}

void bootstrap();
