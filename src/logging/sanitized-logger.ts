import { LoggerService } from '@nestjs/common';

/**
 * Sanitized logger for use in TEE environments.
 *
 * In production (TEE), only emit framework-level structural messages.
 * Never emit request bodies, user data, stack traces, or secret values.
 *
 * This prevents sensitive data from leaking through logs that might be
 * observable by the host operator or external monitoring systems.
 */
export class SanitizedLogger implements LoggerService {
  private readonly SAFE_PREFIXES = [
    'NestFactory',
    'InstanceLoader',
    'RoutesResolver',
    'RouterExplorer',
    'NestApplication',
  ];

  /**
   * Logs informational messages, but only if they come from safe contexts.
   * @param message The log message
   * @param context The context (usually the class name)
   */
  log(message: string, context?: string): void {
    if (this.isSafe(context)) {
      process.stdout.write(`[LOG] ${context}: ${message}\n`);
    }
  }

  /**
   * Logs error messages from safe contexts, without stack traces.
   * Stack traces can contain variable values and internal state.
   * @param message The error message
   * @param _trace The stack trace (ignored for security)
   * @param context The context (usually the class name)
   */
  error(message: string, _trace?: string, context?: string): void {
    if (this.isSafe(context)) {
      // Never emit stack traces — they can contain variable values
      process.stdout.write(`[ERR] ${context}: ${message?.split('\n')[0]}\n`);
    }
  }

  /**
   * Logs warning messages, but only if they come from safe contexts.
   * @param message The warning message
   * @param context The context (usually the class name)
   */
  warn(message: string, context?: string): void {
    if (this.isSafe(context)) {
      process.stdout.write(`[WARN] ${context}: ${message}\n`);
    }
  }

  /**
   * Debug logging is completely suppressed in production TEE environments.
   */
  debug(): void {
    /* suppress in production */
  }

  /**
   * Verbose logging is completely suppressed in production TEE environments.
   */
  verbose(): void {
    /* suppress in production */
  }

  /**
   * Determines if a log context is safe to emit.
   * Only framework-level contexts are considered safe.
   * @param context The log context to check
   * @returns True if the context is safe to log
   */
  private isSafe(context?: string): boolean {
    return this.SAFE_PREFIXES.some((p) => context?.startsWith(p));
  }
}
