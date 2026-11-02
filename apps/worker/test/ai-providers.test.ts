import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Anthropic from '@anthropic-ai/sdk';
import type { RunFacts } from '@perfportal/insight';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AnthropicProvider,
  isTransientProviderError,
  OpenAiCompatibleProvider,
  ProviderHttpError,
  RefusedError,
  strictJsonSchema,
  TIMEOUT_MS,
} from '../src/ai/providers.js';

/** One request a stub received: what a provider actually sent. */
interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

let server: http.Server | null = null;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

/**
 * A provider stand-in on 127.0.0.1 — named, never the wildcard: the loopback
 * guard refuses `listen(0)` without a host (apps/api/test/support/loopback-guard.ts).
 */
async function stub(answer: (seen: Seen) => { status?: number; json: unknown }): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const s: Seen = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: JSON.parse(raw) as Record<string, unknown> };
      seen.push(s);
      const { status = 200, json } = answer(s);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${String(port)}`, seen };
}

const FACTS: RunFacts = {
  version: 1,
  facts: [{ id: 'run.requests', label: 'Requests', display: '895', value: 895, text: null }],
};

const CONTENT = {
  health: { headline: 'The run made 895 requests.', bullets: ['It made 895 requests.'] },
  insights: { headline: 'Nothing failed.', errors: [], assertions: [], injectionProfile: [], responseTimes: [] },
  recommendations: { headline: 'Keep it.', bullets: ['Run it again.'] },
};

const REQ = { system: 'the rules', facts: FACTS, feedback: null };

/** A Messages API answer, as the Claude API would send it. */
function message(content: unknown[], stop_reason = 'end_turn', stop_details: unknown = null): unknown {
  return {
    id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content,
    stop_reason, stop_sequence: null, stop_details, usage: { input_tokens: 10, output_tokens: 20 },
  };
}

/** Every key anywhere in a JSON value. */
function keysOf(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(keysOf);
  if (node === null || typeof node !== 'object') return [];
  return Object.entries(node).flatMap(([k, v]) => [k, ...keysOf(v)]);
}

describe('OpenAiCompatibleProvider', () => {
  it('openai-compatible sends the schema and returns parsed JSON', async () => {
    const { url, seen } = await stub(() => ({ json: { choices: [{ message: { content: JSON.stringify(CONTENT) } }] } }));
    const provider = new OpenAiCompatibleProvider({ provider: 'openai-compatible', model: 'llama', baseUrl: `${url}/v1`, apiKey: 'k-1' });

    expect(await provider.generate(REQ)).toEqual(CONTENT);

    expect(seen).toHaveLength(1);
    const [req] = seen;
    expect(req!.method).toBe('POST');
    expect(req!.url).toBe('/v1/chat/completions');
    expect(req!.headers.authorization).toBe('Bearer k-1');
    expect(req!.body.model).toBe('llama');
    expect(req!.body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'run_analysis', strict: true, schema: strictJsonSchema() },
    });
    const messages = req!.body.messages as { role: string; content: string }[];
    expect(messages[0]).toEqual({ role: 'system', content: 'the rules' });
    expect(messages[1]!.content).toContain('"display":"895"');
    // Strict mode documents no string-length keywords; the array bounds it does document are kept.
    const keys = keysOf(strictJsonSchema());
    expect(keys).not.toContain('minLength');
    expect(keys).not.toContain('maxLength');
    expect(keys).not.toContain('$schema');
    expect(keys).toContain('maxItems');
    expect(keys).toContain('additionalProperties');
  });

  it('omits Authorization without a key', async () => {
    const { url, seen } = await stub(() => ({ json: { choices: [{ message: { content: JSON.stringify(CONTENT) } }] } }));
    const provider = new OpenAiCompatibleProvider({ provider: 'openai-compatible', model: 'llama', baseUrl: url, apiKey: null });

    await provider.generate(REQ);

    expect(seen[0]!.headers.authorization).toBeUndefined();
  });

  it('throws RefusedError for a structured-outputs refusal, rather than handing back an empty answer', async () => {
    const { url, seen } = await stub(() => ({
      json: { choices: [{ message: { content: null, refusal: 'I can’t help with that.' } }] },
    }));
    const provider = new OpenAiCompatibleProvider({ provider: 'openai-compatible', model: 'llama', baseUrl: url, apiKey: null });

    const err = await provider.generate(REQ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RefusedError);
    expect((err as RefusedError).category).toBeNull();
    expect(seen).toHaveLength(1);
  });

  it('reads an answer whose refusal field is null or empty as the answer', async () => {
    for (const refusal of [null, '', '  ']) {
      const { url } = await stub(() => ({ json: { choices: [{ message: { content: JSON.stringify(CONTENT), refusal } }] } }));
      const provider = new OpenAiCompatibleProvider({ provider: 'openai-compatible', model: 'llama', baseUrl: url, apiKey: null });
      expect(await provider.generate(REQ)).toEqual(CONTENT);
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  it('throws a transient error for a 503 and a lasting one for a 401', async () => {
    let status = 503;
    const { url } = await stub(() => ({ status, json: { error: 'no' } }));
    const provider = new OpenAiCompatibleProvider({ provider: 'openai-compatible', model: 'llama', baseUrl: url, apiKey: null });

    const overloaded = await provider.generate(REQ).catch((e: unknown) => e);
    expect(overloaded).toBeInstanceOf(ProviderHttpError);
    expect(isTransientProviderError(overloaded)).toBe(true);

    status = 401;
    expect(isTransientProviderError(await provider.generate(REQ).catch((e: unknown) => e))).toBe(false);
  });
});

describe('AnthropicProvider', () => {
  it('anthropic provider reaches the stub through baseURL and returns parsed output', async () => {
    const { url, seen } = await stub(() => ({ json: message([{ type: 'text', text: JSON.stringify(CONTENT) }]) }));
    const provider = new AnthropicProvider(
      { provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-test' },
      { baseURL: url },
    );

    expect(await provider.generate(REQ)).toEqual(CONTENT);

    expect(seen).toHaveLength(1);
    const [req] = seen;
    expect(req!.url).toMatch(/^\/v1\/messages/);
    // SDK 1.3.0 sends the key as a bearer token.
    expect(req!.headers.authorization).toBe('Bearer sk-test');
    expect(req!.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
    expect(req!.body).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium', format: { type: 'json_schema' } },
      system: 'the rules',
      fallbacks: 'default',
    });
    const messages = req!.body.messages as { role: string; content: string }[];
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toContain('"display":"895"');
  });

  it('throws RefusedError on a refusal stop reason', async () => {
    const { url } = await stub(() => ({
      json: message([], 'refusal', { type: 'refusal', category: 'cyber', explanation: 'declined' }),
    }));
    const provider = new AnthropicProvider({ provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'k' }, { baseURL: url });

    const err = await provider.generate(REQ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RefusedError);
    expect((err as RefusedError).category).toBe('cyber');
  });

  it('reads the answer the fallback model wrote, not the declined partial before it', async () => {
    const { url } = await stub(() => ({
      json: message([
        { type: 'text', text: '{"health":' },
        { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-4-8' } },
        { type: 'text', text: JSON.stringify(CONTENT) },
      ]),
    }));
    const provider = new AnthropicProvider({ provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'k' }, { baseURL: url });

    expect(await provider.generate(REQ)).toEqual(CONTENT);
  });

  it('sends no fallback to a model that has none', async () => {
    const { url, seen } = await stub(() => ({ json: message([{ type: 'text', text: JSON.stringify(CONTENT) }]) }));
    const provider = new AnthropicProvider({ provider: 'anthropic', model: 'claude-haiku-5-5', apiKey: 'k' }, { baseURL: url });

    await provider.generate(REQ);

    expect(seen[0]!.body).not.toHaveProperty('fallbacks');
    // The SDK adds its own structured-outputs beta to every parse; the fallback's must not be there.
    expect(String(seen[0]!.headers['anthropic-beta'])).not.toContain('server-side-fallback');
  });

  it('hands back an answer that is not JSON, for the caller to refuse', async () => {
    const { url } = await stub(() => ({ json: message([{ type: 'text', text: 'not json' }]) }));
    const provider = new AnthropicProvider({ provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'k' }, { baseURL: url });

    expect(await provider.generate(REQ)).toBe('not json');
  });
});

/** A server that accepts a request and never answers: what a call that outlasts its timeout meets. */
async function hang(): Promise<string> {
  server = http.createServer(() => undefined);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(port)}`;
}

/** A port nothing listens on: a connection that never reached a provider. */
async function closedPort(): Promise<string> {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return `http://127.0.0.1:${String(port)}`;
}

describe('isTransientProviderError', () => {
  it('gives one call five minutes', () => {
    expect(TIMEOUT_MS).toBe(300_000);
  });

  it('never retries a call this client cut off, because the provider may have billed it', async () => {
    // The errors as the two clients really throw them, from a server that never answers.
    const url = await hang();
    const sdk = new Anthropic({ apiKey: 'k', baseURL: url, timeout: 50, maxRetries: 0 });
    const sdkTimeout = await sdk.messages
      .create({ model: 'claude-opus-5-5', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] })
      .catch((e: unknown) => e);
    expect(sdkTimeout).toBeInstanceOf(Anthropic.APIConnectionTimeoutError);
    expect(isTransientProviderError(sdkTimeout)).toBe(false);

    const fetchTimeout = await fetch(url, { signal: AbortSignal.timeout(50) }).catch((e: unknown) => e);
    expect((fetchTimeout as Error).name).toBe('TimeoutError');
    expect(isTransientProviderError(fetchTimeout)).toBe(false);

    expect(isTransientProviderError(new DOMException('aborted', 'AbortError'))).toBe(false);
    expect(isTransientProviderError(new Anthropic.APIUserAbortError())).toBe(false);
  });

  it('retries a connection that never reached the provider', async () => {
    const url = await closedPort();
    const refused = await fetch(url).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(TypeError);
    expect(isTransientProviderError(refused)).toBe(true);

    const sdkRefused = await new Anthropic({ apiKey: 'k', baseURL: url, maxRetries: 0 }).messages
      .create({ model: 'claude-opus-5-5', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] })
      .catch((e: unknown) => e);
    expect(sdkRefused).toBeInstanceOf(Anthropic.APIConnectionError);
    expect(sdkRefused).not.toBeInstanceOf(Anthropic.APIConnectionTimeoutError);
    expect(isTransientProviderError(sdkRefused)).toBe(true);
  });

  it('retries 408, 429 and 5xx, and nothing else the provider answered', () => {
    const headers = new Headers();
    for (const status of [408, 429, 500, 503, 529]) {
      expect(isTransientProviderError(new ProviderHttpError(status, ''))).toBe(true);
      expect(isTransientProviderError(new Anthropic.APIError(status, undefined, 'x', headers))).toBe(true);
    }
    for (const status of [400, 401, 403, 404, 422]) {
      expect(isTransientProviderError(new ProviderHttpError(status, ''))).toBe(false);
      expect(isTransientProviderError(new Anthropic.APIError(status, undefined, 'x', headers))).toBe(false);
    }
  });

  it('never retries a call undici cut off at its own five-minute timeout', () => {
    // undici's own errors, as lib/core/errors.js builds them (undici 6.x); fetch
    // rejects with TypeError("fetch failed") carrying one as its cause —
    // measured with an undici Agent at a 100 ms headersTimeout.
    const undici = (name: string, message: string, code: string): Error =>
      Object.assign(new Error(message), { name, code });
    for (const cause of [
      undici('HeadersTimeoutError', 'Headers Timeout Error', 'UND_ERR_HEADERS_TIMEOUT'),
      undici('BodyTimeoutError', 'Body Timeout Error', 'UND_ERR_BODY_TIMEOUT'),
    ]) {
      const fetchFailed = new TypeError('fetch failed', { cause });
      expect(isTransientProviderError(fetchFailed)).toBe(false);
      // The SDK wraps a fetch failure it does not read as a timeout in an
      // APIConnectionError, so the code sits two causes down.
      expect(isTransientProviderError(new Anthropic.APIConnectionError({ message: 'Connection error.', cause: fetchFailed }))).toBe(false);
    }
    // The control: the same two shapes over a refused socket are still retried.
    const refused = new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    expect(isTransientProviderError(refused)).toBe(true);
    expect(isTransientProviderError(new Anthropic.APIConnectionError({ message: 'Connection error.', cause: refused }))).toBe(true);
  });

  it('does not retry a TypeError that is not fetch’s network failure', () => {
    expect(isTransientProviderError(new TypeError("Cannot read properties of undefined (reading 'choices')"))).toBe(false);
    // The message alone is not enough: fetch's own failure always carries the socket error as its cause.
    expect(isTransientProviderError(new TypeError('fetch failed'))).toBe(false);
    expect(isTransientProviderError(new TypeError('fetch failed', { cause: new Error('ECONNREFUSED') }))).toBe(true);
    expect(isTransientProviderError(new Error('something else'))).toBe(false);
  });
});
