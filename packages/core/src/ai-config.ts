/**
 * ═══ THE AI PROVIDER, READ FROM THE ENVIRONMENT ═══
 * (docs/superpowers/specs/2026-11-02-ai-run-analysis-design.md, Constraints)
 *
 * AI run analysis sends a run's figures to a model, so it is off unless the
 * deployment opts in by naming a provider. Two are supported:
 *
 * - `anthropic` — Claude through the official SDK. `ANTHROPIC_API_KEY` is
 *   required; `AI_MODEL` is optional and defaults to `DEFAULT_ANTHROPIC_MODEL`.
 * - `openai-compatible` — any endpoint speaking the OpenAI chat API (a
 *   self-hosted model, a gateway). `AI_BASE_URL` and `AI_MODEL` are required,
 *   because there is no default that could be right for somebody else's
 *   server; `AI_API_KEY` is optional, since a model on the local network may
 *   take none.
 *
 * ONE definition, read by two processes: the API decides whether to offer the
 * feature and states the provider on Administration, and the worker calls the
 * provider. Two copies could let the page offer what the worker cannot do.
 */

/** The model `anthropic` uses when `AI_MODEL` is not set. */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';

export const AI_PROVIDERS = ['anthropic', 'openai-compatible'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export type AiConfig =
  | { provider: 'anthropic'; model: string; apiKey: string }
  | { provider: 'openai-compatible'; model: string; baseUrl: string; apiKey: string | null };

/**
 * Reads `AI_PROVIDER` and its companions: null when `AI_PROVIDER` is unset or
 * blank, the feature off. Blank means unset for EVERY variable here — compose
 * passes an unset variable as an EMPTY string, and a value of spaces is a
 * value nobody meant — and each value is trimmed.
 *
 * A provider named without what it needs THROWS, naming the missing or invalid
 * variable, so the process refuses to start (the `parseRawLogRetentionDays`
 * precedent) rather than offering a feature that fails on a reader's first
 * click. A provider this product does not know is refused, naming it, rather
 * than read as off: a typo in `AI_PROVIDER` should not quietly disable what
 * the operator meant to turn on.
 *
 * `baseUrl` has its trailing `/` stripped, so a caller appends
 * `/chat/completions` without producing `//`.
 */
export function parseAiConfig(env: Record<string, string | undefined>): AiConfig | null {
  const read = (name: string): string | null => {
    const text = env[name]?.trim() ?? '';
    return text === '' ? null : text;
  };

  const provider = read('AI_PROVIDER');
  if (provider === null) return null;

  if (provider === 'anthropic') {
    const apiKey = read('ANTHROPIC_API_KEY');
    if (apiKey === null) {
      throw new Error('AI_PROVIDER is "anthropic", so ANTHROPIC_API_KEY must be set; it is unset or blank');
    }
    return { provider, model: read('AI_MODEL') ?? DEFAULT_ANTHROPIC_MODEL, apiKey };
  }

  if (provider === 'openai-compatible') {
    const model = read('AI_MODEL');
    if (model === null) {
      throw new Error(
        'AI_PROVIDER is "openai-compatible", so AI_MODEL must name the model to call; it is unset or blank',
      );
    }
    const baseUrl = read('AI_BASE_URL');
    if (baseUrl === null) {
      throw new Error(
        'AI_PROVIDER is "openai-compatible", so AI_BASE_URL must be set to the endpoint (such as http://llm.internal/v1); it is unset or blank',
      );
    }
    if (!isHttpUrl(baseUrl)) {
      throw new Error(`AI_BASE_URL must be an http:// or https:// URL; got "${baseUrl}"`);
    }
    return { provider, model, baseUrl: baseUrl.replace(/\/+$/, ''), apiKey: read('AI_API_KEY') };
  }

  throw new Error(`AI_PROVIDER must be one of ${AI_PROVIDERS.join(', ')}, or unset to turn AI off; got "${provider}"`);
}

function isHttpUrl(text: string): boolean {
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
