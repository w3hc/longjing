import { Injectable, ExecutionContext } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerException } from '@nestjs/throttler';
import { createHash } from 'crypto';

/**
 * Request fingerprint-based throttler guard
 *
 * Instead of using IP addresses (which are anonymized for privacy),
 * this guard creates a fingerprint from the request body content and time window.
 * This prevents rapid repeated submissions of identical requests.
 *
 * It is the only global throttler: an IP-keyed one would put every client in
 * a single bucket, since RequestSanitizerMiddleware pins req.ip to 0.0.0.0.
 *
 * It also hides rate limiting metadata (X-RateLimit-*, Retry-After), which
 * would reveal how many requests a bucket has seen and when it resets.
 *
 * Note: This works alongside per-nullifier rate limiting in NullifierStoreService.
 */
@Injectable()
export class RequestFingerprintThrottler extends ThrottlerGuard {
  private static readonly RATE_LIMIT_HEADERS = [
    'X-RateLimit-Limit',
    'X-RateLimit-Remaining',
    'X-RateLimit-Reset',
    'Retry-After',
    'X-Retry-After',
    'RateLimit-Limit',
    'RateLimit-Remaining',
    'RateLimit-Reset',
  ];

  /**
   * Strip rate limit headers whether the request passes or is throttled
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      return await super.canActivate(context);
    } finally {
      const response = context.switchToHttp().getResponse<{
        removeHeader: (name: string) => void;
      }>();
      RequestFingerprintThrottler.RATE_LIMIT_HEADERS.forEach((header) => {
        response.removeHeader(header);
      });
    }
  }

  /**
   * Generate a unique tracker for rate limiting based on request content
   * Uses a hash of the request body + time window for privacy-preserving rate limiting
   */
  protected getTracker(req: Record<string, any>): Promise<string> {
    // Create fingerprint from request body
    const body = JSON.stringify(req.body || {});

    // Add time window to allow same request after window expires
    // Using 1-minute windows to align with rate limit TTL
    const timeWindow = Math.floor(Date.now() / 60000);

    // Hash the fingerprint to prevent storing raw request data
    const fingerprint = createHash('sha256')
      .update(body + timeWindow.toString())
      .digest('hex');

    return Promise.resolve(fingerprint);
  }

  /**
   * Generic message that doesn't reveal rate limit details
   */
  protected throwThrottlingException(): Promise<void> {
    throw new ThrottlerException('Request temporarily unavailable');
  }
}
