// Single source of Claude pricing, in USD per million tokens
export const CLAUDE_PRICING = {
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
} as const;

export type ClaudeModel = keyof typeof CLAUDE_PRICING;

export const CLAUDE_MODELS = Object.keys(CLAUDE_PRICING) as ClaudeModel[];

export const DEFAULT_CLAUDE_MODEL: ClaudeModel = 'claude-fable-5-1';

// Upper bound on output tokens for a single request
export const MAX_OUTPUT_TOKENS = 4096;

export function isClaudeModel(model: string): model is ClaudeModel {
  return Object.prototype.hasOwnProperty.call(CLAUDE_PRICING, model);
}

export function claudeCostUSD(
  model: ClaudeModel,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = CLAUDE_PRICING[model];
  return (
    (inputTokens / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output
  );
}
