import {
  CLAUDE_MODELS,
  DEFAULT_CLAUDE_MODEL,
} from '../../pricing/claude-pricing';

export type { ClaudeModel } from '../../pricing/claude-pricing';

/**
 * Claude provider configuration
 */
export const CLAUDE_CONFIG = {
  /**
   * Default model to use when not specified
   */
  DEFAULT_MODEL: DEFAULT_CLAUDE_MODEL,

  /**
   * Supported Claude models: exactly the priced ones
   */
  SUPPORTED_MODELS: CLAUDE_MODELS,

  /**
   * Default request parameters
   */
  DEFAULTS: {
    maxTokens: 8192,
    temperature: 1.0,
    timeout: 120000, // 2 minutes
    retries: 2,
  },

  /**
   * Rate limits (per provider account)
   */
  RATE_LIMITS: {
    requestsPerMinute: 50,
    requestsPerDay: 1000,
    concurrentRequests: 5,
  },
};
