import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { AiAnalysisContentSchema } from '@perfportal/contracts';
import type { AiConfig } from '@perfportal/core';
import type { RunFacts } from '@perfportal/insight';
import { z } from 'zod';
import { userMessage } from './prompt.js';

/**
 * ═══ ONE INTERFACE, TWO PROVIDERS ═══
 * (docs/superpowers/specs/2026-11-02-ai-run-analysis-design.md, Constraints)
 *
 * `generate` returns the model's answer as parsed JSON and NOTHING ELSE about
 * it: the caller validates it with `AiAnalysisContentSchema` and checks its
 * numbers, so the rest of the pipeline cannot tell which provider ran. A
 * provider never validates the shape itself — a refused answer has to reach
 * the caller as a value, so the caller can name what was wrong in its one
 * retry, rather than as an exception that has already thrown the answer away.
 *
 * It throws in exactly two ways the caller distinguishes: `RefusedError` when
 * the model declined, and anything `isTransientProviderError` recognises when
 * the provider could not be reached or was overloaded. Every other throw is
 * recorded at once and never retried: a request the provider refused (a bad
 * key, a model it does not have), which no retry fixes, and a call cut off at
 * `TIMEOUT_MS`, which the provider may well have finished and billed.
 */
export interface AnalysisProvider {
  readonly name: string;
  readonly model: string;
  generate(req: { system: string; facts: RunFacts; feedback: string | null }): Promise<unknown>;
}

/** The model declined to answer (a policy decline), on every model it was tried on. */
export class RefusedError extends Error {
  constructor(readonly category: string | null) {
    super(`the model declined to write the analysis${category === null ? '' : ` (${category})`}`);
    this.name = 'RefusedError';
  }
}

/** A non-2xx answer from an OpenAI-compatible endpoint. */
export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`the AI provider answered ${String(status)}: ${body.slice(0, 300)}`);
    this.name = 'ProviderHttpError';
  }
}

/**
 * The output budget. Non-streaming, so it stays under the SDK's HTTP timeout
 * (the claude-api skill's default for a non-streamed request); the answer
 * itself is a few kilobytes at most — six bullets of 400 characters in each
 * of six lists — so this is room for thinking, not for text.
 */
const MAX_TOKENS = 16_000;

/**
 * ═══ HOW LONG ONE CALL MAY TAKE, AND WHY A CALL CUT OFF IS NOT RETRIED ═══
 *
 * Five minutes: a non-streamed answer with adaptive thinking can take minutes,
 * and a call cut off part-way has already been paid for — the provider goes
 * on generating and bills the tokens whether or not anybody is still waiting.
 * So a timeout is NOT transient (`isTransientProviderError`): it is recorded
 * as `provider_error` at once, and a second paid call is never made in the
 * hope the first was slow by chance.
 *
 * DEPLOYMENT.md states this, and `infra/docker-compose.yml`'s worker
 * `stop_grace_period` (11m) covers the two calls one attempt can make (the
 * second only when the first answer failed its check) plus a margin.
 */
export const TIMEOUT_MS = 300_000;

/**
 * The models that take the server-side refusal fallback, per the claude-api
 * skill ("When you write claude-fable-5-1, claude-opus-5-5, claude-opus-5, or
 * claude-sonnet-5-5 code, include the server-side fallbacks parameter"). The
 * `"default"` form, which routes a decline by its category to the model
 * Anthropic recommends for it, so this list never has to name a fallback
 * model. Any other model is sent no `fallbacks`: Claude Haiku 5.5 has none,
 * and a model named here by mistake would answer the array form with a 400.
 */
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/**
 * The SDK's JSON schema for the output, from `zodOutputFormat`, with a parse
 * that never throws. `zodOutputFormat`'s own parse validates against the zod
 * schema and THROWS on any failure, which would lose the answer the caller
 * needs to quote back in its retry; this one hands back whatever JSON (or, if
 * the text is not JSON, the text) the model wrote.
 *
 * The schema the API sees is the SDK's `transformJSONSchema` of
 * `z.toJSONSchema(...)`: structured outputs refuse `minLength`, `maxLength`
 * and `maxItems` (and any `minItems` other than 0 or 1), and the SDK moves
 * each into the property's description instead (measured on SDK 1.3.0:
 * `{"type":"string","description":"{minLength: 1, maxLength: 400}"}`). The
 * bounds still bind, because the caller's `safeParse` enforces them.
 */
const ANALYSIS_FORMAT = {
  ...zodOutputFormat(AiAnalysisContentSchema),
  parse: (content: string): unknown => {
    try {
      return JSON.parse(content) as unknown;
    } catch {
      return content;
    }
  },
};

export class AnthropicProvider implements AnalysisProvider {
  readonly name = 'anthropic';
  readonly model: string;
  readonly #client: Anthropic;

  /**
   * `baseURL` is a test seam: the provider tests point it at a local stub.
   * In production it is left out, and the SDK reads `ANTHROPIC_BASE_URL` or
   * calls the Claude API.
   *
   * `maxRetries: 0` because the queue already retries (three attempts,
   * exponential from ten seconds): the SDK's own two retries on top would make
   * a provider outage nine calls a run, and a timed-out generation retried
   * inside one attempt would be paid for twice — which is exactly what
   * `isTransientProviderError` refuses to do across attempts too.
   */
  constructor(config: Extract<AiConfig, { provider: 'anthropic' }>, clientOptions: { baseURL?: string } = {}) {
    this.model = config.model;
    this.#client = new Anthropic({
      apiKey: config.apiKey,
      timeout: TIMEOUT_MS,
      maxRetries: 0,
      baseURL: clientOptions.baseURL,
    });
  }

  async generate(req: { system: string; facts: RunFacts; feedback: string | null }): Promise<unknown> {
    const fallback = FALLBACK_MODELS.has(this.model);
    const response = await this.#client.beta.messages.parse({
      model: this.model,
      max_tokens: MAX_TOKENS,
      // Adaptive is Opus 5.5's only thinking mode, and medium effort its
      // default, written out so a model whose default differs runs the same way.
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium', format: ANALYSIS_FORMAT },
      system: req.system,
      messages: [{ role: 'user', content: userMessage(req.facts, req.feedback) }],
      betas: fallback ? [FALLBACK_BETA] : undefined,
      fallbacks: fallback ? 'default' : undefined,
    });

    // A refusal is an HTTP 200; the content of a refused answer is not an
    // analysis, so it is checked before anything is read. With the fallback on,
    // this is the WHOLE chain having declined.
    if (response.stop_reason === 'refusal') {
      throw new RefusedError(response.stop_details?.category ?? null);
    }

    // With the fallback on, a model that declined mid-answer leaves its partial
    // text BEFORE a `fallback` block, and the model that took over writes after
    // it — so the answer is the text after the last switch, never the SDK's
    // `parsed_output`, which is the FIRST text block's.
    const lastSwitch = response.content.map((b) => b.type).lastIndexOf('fallback');
    const text = response.content
      .slice(lastSwitch + 1)
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('');
    return ANALYSIS_FORMAT.parse(text);
  }
}

/**
 * The JSON schema an OpenAI-compatible endpoint is asked to fill, in strict
 * mode. `z.toJSONSchema` gives every `.strict()` object `additionalProperties:
 * false` and every field `required`, which strict mode demands. OpenAI's
 * structured-outputs guide lists `pattern` and `format` as the string
 * keywords it supports and `minLength`/`maxLength` as unsupported for
 * fine-tuned models, so both are dropped, as is `$schema`, which strict mode
 * does not describe; `minItems`/`maxItems` are listed as supported and kept.
 * The bounds still bind: the caller's `safeParse` enforces every one.
 */
export function strictJsonSchema(): Record<string, unknown> {
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (node === null || typeof node !== 'object') return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === 'minLength' || key === 'maxLength' || key === '$schema') continue;
      out[key] = strip(value);
    }
    return out;
  };
  return strip(z.toJSONSchema(AiAnalysisContentSchema)) as Record<string, unknown>;
}

/**
 * `refusal` is how a structured-outputs answer says the model declined: a
 * string, with `content` null. Optional, because a server that does not
 * implement it sends no such field at all.
 */
const OpenAiAnswerSchema = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string().nullable(), refusal: z.string().nullable().optional() }) }))
    .min(1),
});

/**
 * Any server speaking the OpenAI chat-completions API: a self-hosted model, a
 * gateway. A plain `fetch`, because the only thing used is one POST and its
 * JSON answer, and an SDK for another vendor would be a dependency carried for
 * a deployment that may never configure it.
 */
export class OpenAiCompatibleProvider implements AnalysisProvider {
  readonly name = 'openai-compatible';
  readonly model: string;
  readonly #baseUrl: string;
  readonly #apiKey: string | null;

  constructor(config: Extract<AiConfig, { provider: 'openai-compatible' }>) {
    this.model = config.model;
    this.#baseUrl = config.baseUrl;
    this.#apiKey = config.apiKey;
  }

  async generate(req: { system: string; facts: RunFacts; feedback: string | null }): Promise<unknown> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    // Only when a key is configured: a model on the local network may take
    // none, and some refuse a bearer header they were not set up to expect.
    if (this.#apiKey !== null) headers.authorization = `Bearer ${this.#apiKey}`;

    const res = await fetch(`${this.#baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: userMessage(req.facts, req.feedback) },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'run_analysis', strict: true, schema: strictJsonSchema() },
        },
      }),
    });
    const body = await res.text();
    if (!res.ok) throw new ProviderHttpError(res.status, body);

    let parsed: unknown;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      throw new ProviderHttpError(res.status, body);
    }
    const answer = OpenAiAnswerSchema.safeParse(parsed);
    // A 200 that is not a chat completion is the server misbehaving, not the
    // model writing a bad analysis: nothing came back to quote in a retry.
    if (!answer.success) throw new ProviderHttpError(res.status, body);
    const message = answer.data.choices[0]?.message;
    // A decline, not a bad analysis: read as content it would be an empty
    // string, refused by the schema and asked again — a paid call to a model
    // that has already said no. No category: the field is the model's prose,
    // and nothing here classifies it.
    if (typeof message?.refusal === 'string' && message.refusal.trim() !== '') throw new RefusedError(null);
    const content = message?.content ?? '';
    try {
      return JSON.parse(content) as unknown;
    } catch {
      return content;
    }
  }
}

export function providerFor(config: AiConfig): AnalysisProvider {
  return config.provider === 'anthropic' ? new AnthropicProvider(config) : new OpenAiCompatibleProvider(config);
}

/**
 * Whether a provider failure is worth another attempt — another PAID attempt,
 * so only where the first cannot have been billed or the provider asked us to
 * come back:
 *
 * - a connection that never reached the provider (refused, reset, DNS): the
 *   Anthropic SDK's `APIConnectionError`, or fetch's own network failure, a
 *   `TypeError` "fetch failed" carrying the socket error as its `cause`;
 * - 408 (the provider timed the request out on its side), 429 (rate limited),
 *   and any 5xx (it failed on its own side).
 *
 * NOT transient, and recorded at once:
 *
 * - a call this client cut off at `TIMEOUT_MS` — the SDK's
 *   `APIConnectionTimeoutError` (checked BEFORE `APIConnectionError`, which it
 *   extends), fetch's `TimeoutError` from `AbortSignal.timeout`, and an
 *   `AbortError` (nothing else here aborts a call). The provider may have
 *   finished it, and it has billed it either way;
 * - a call undici cut off at ITS OWN timeout (`isUndiciCutOff`), which is the
 *   same thing reached from underneath: the same request, already sent;
 * - any other 4xx: the request itself refused — a bad key, an unknown model —
 *   and the same request will be refused again;
 * - any other error, a bare `TypeError` included: a `TypeError` that is not
 *   fetch's network failure is a bug, which a retry repeats.
 */
export function isTransientProviderError(err: unknown): boolean {
  if (err instanceof Anthropic.APIConnectionTimeoutError) return false;
  // Before both connection-failure checks below: undici's cut-off arrives as
  // fetch's "fetch failed", or as the SDK's APIConnectionError wrapping it,
  // and either would otherwise read as a connection that never got through.
  if (isUndiciCutOff(err)) return false;
  if (err instanceof Anthropic.APIConnectionError) return true;
  // A status-less APIError that is not a connection failure is the SDK's
  // `APIUserAbortError`: nothing here aborts a call but the timeout.
  if (err instanceof Anthropic.APIError) return err.status !== undefined && isRetryableStatus(err.status);
  if (err instanceof ProviderHttpError) return isRetryableStatus(err.status);
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return false;
  return err instanceof TypeError && err.message === 'fetch failed' && err.cause !== undefined;
}

/**
 * ═══ UNDICI HAS A FIVE-MINUTE TIMEOUT OF ITS OWN, AND IT IS THIS ONE ═══
 *
 * Node's fetch is undici, whose default `headersTimeout` and `bodyTimeout`
 * are both 300 000 ms — exactly `TIMEOUT_MS`. Whichever timer fires first
 * ends the call, so a slow answer is as likely to be cut off by undici as by
 * `AbortSignal.timeout` or the SDK. Undici's arrives as `TypeError("fetch
 * failed")` whose `cause` carries `code: 'UND_ERR_HEADERS_TIMEOUT'` or
 * `'UND_ERR_BODY_TIMEOUT'` — exactly the shape of a connection that never got
 * through, and read as one it would be retried: a second paid call for a
 * request the provider already received.
 *
 * The SDK path is covered today by the SDK, not by this: SDK 1.3.0 tests a
 * fetch failure's text against `/timed? ?out/i` and throws its own
 * `APIConnectionTimeoutError` for "Headers Timeout Error" (measured, with an
 * undici `Agent` at a 100 ms `headersTimeout`). That is a heuristic over a
 * message; anything else it wraps in a plain `APIConnectionError` with the
 * TypeError as `cause`, so the code would sit two causes down. So the chain
 * is walked for those two codes, a bounded number of links (a cause cycle
 * must not hang the classifier).
 */
const UNDICI_CUT_OFF_CODES = new Set(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);

function isUndiciCutOff(err: unknown): boolean {
  let node: unknown = err;
  for (let depth = 0; depth < 8 && node instanceof Error; depth += 1) {
    const code = (node as { code?: unknown }).code;
    if (typeof code === 'string' && UNDICI_CUT_OFF_CODES.has(code)) return true;
    node = node.cause;
  }
  return false;
}

/** 408, 429 and 5xx: the provider timed out on its own side, rate-limited the call, or failed. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}
