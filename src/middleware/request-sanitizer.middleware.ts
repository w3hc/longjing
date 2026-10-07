import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

/**
 * Request sanitizer middleware for TEE environments
 *
 * Strips identifying metadata from incoming requests to prevent:
 * - Request correlation attacks
 * - Client fingerprinting via User-Agent
 * - Referer-based tracking
 * - IP-based correlation (in combination with network-level protections)
 *
 * This middleware runs early in the request pipeline to ensure
 * no downstream code can access potentially identifying metadata.
 */
@Injectable()
export class RequestSanitizerMiddleware implements NestMiddleware {
  // Request headers that should be stripped or sanitized
  private readonly IDENTIFYING_HEADERS = [
    'user-agent',
    'referer',
    'referrer',
    'origin',
    'x-forwarded-for',
    'x-real-ip',
    'x-client-ip',
    'cf-connecting-ip',
    'true-client-ip',
    'x-forwarded-proto',
    'x-forwarded-host',
    'forwarded',
    'via',
    'accept-language',
    'accept-encoding',
    'accept-charset',
    'dnt', // Do Not Track
    'sec-ch-ua', // Client Hints
    'sec-ch-ua-mobile',
    'sec-ch-ua-platform',
    'sec-fetch-site',
    'sec-fetch-mode',
    'sec-fetch-dest',
  ];

  use(req: Request, res: Response, next: NextFunction): void {
    // Strip all identifying headers from the request
    this.IDENTIFYING_HEADERS.forEach((header) => {
      delete req.headers[header];
    });

    // Prevent IP address leakage
    // Note: This only affects the Express request object
    // Network-level IP anonymization should also be implemented
    Object.defineProperty(req, 'ip', {
      get: () => '0.0.0.0',
      configurable: false,
    });

    Object.defineProperty(req, 'ips', {
      get: () => [],
      configurable: false,
    });

    // Remove socket information that could be used for correlation. A
    // kept-alive socket carries several requests and is already anonymized
    // after the first, and redefining a non-configurable property throws.
    const socket = req.socket as object | undefined;
    if (
      socket &&
      Object.getOwnPropertyDescriptor(socket, 'remoteAddress')?.configurable !==
        false
    ) {
      Object.defineProperty(socket, 'remoteAddress', {
        get: () => '0.0.0.0',
        configurable: false,
      });

      Object.defineProperty(socket, 'remotePort', {
        get: () => 0,
        configurable: false,
      });
    }

    next();
  }
}
