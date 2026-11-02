import { describe, expect, it } from 'vitest';
import { AI_ANALYSIS_QUEUE, INGEST_QUEUE, parseAiConfig } from '../src/index.js';

/**
 * The API and the worker both read the AI provider from the environment, and
 * a provider named without what it needs must stop the process at startup
 * naming the missing variable — not fail on a reader's first click. Blank is
 * unset throughout, because compose passes an unset variable as an EMPTY
 * string.
 */
describe('parseAiConfig', () => {
  it('answers null for a blank provider', () => {
    expect(parseAiConfig({})).toBeNull();
    expect(parseAiConfig({ AI_PROVIDER: '' })).toBeNull();
    // A key left behind with no provider is not a provider.
    expect(parseAiConfig({ AI_PROVIDER: '', ANTHROPIC_API_KEY: 'sk-ant-x' })).toBeNull();
  });

  it('defaults the anthropic model to claude-opus-5-5', () => {
    expect(parseAiConfig({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-x' })).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      apiKey: 'sk-ant-x',
    });
    expect(
      parseAiConfig({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-x', AI_MODEL: 'claude-sonnet-5' })?.model,
    ).toBe('claude-sonnet-5');
  });

  it('throws naming ANTHROPIC_API_KEY when it is missing', () => {
    expect(() => parseAiConfig({ AI_PROVIDER: 'anthropic' })).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('throws naming AI_MODEL for openai-compatible without one', () => {
    expect(() => parseAiConfig({ AI_PROVIDER: 'openai-compatible', AI_BASE_URL: 'http://llm.internal/v1' })).toThrow(
      /AI_MODEL/,
    );
  });

  it('throws naming AI_BASE_URL', () => {
    expect(() => parseAiConfig({ AI_PROVIDER: 'openai-compatible', AI_MODEL: 'llama-4' })).toThrow(/AI_BASE_URL/);
    expect(() =>
      parseAiConfig({ AI_PROVIDER: 'openai-compatible', AI_MODEL: 'llama-4', AI_BASE_URL: 'llm.internal/v1' }),
    ).toThrow(/AI_BASE_URL/);
  });

  it('reads an openai-compatible endpoint, its trailing slash stripped and its key optional', () => {
    expect(
      parseAiConfig({ AI_PROVIDER: 'openai-compatible', AI_MODEL: 'llama-4', AI_BASE_URL: 'http://llm.internal/v1/' }),
    ).toEqual({ provider: 'openai-compatible', model: 'llama-4', baseUrl: 'http://llm.internal/v1', apiKey: null });
    expect(
      parseAiConfig({
        AI_PROVIDER: 'openai-compatible',
        AI_MODEL: 'llama-4',
        AI_BASE_URL: 'https://llm.internal/v1',
        AI_API_KEY: 'k',
      })?.apiKey,
    ).toBe('k');
  });

  it('refuses an unknown provider, naming it', () => {
    expect(() => parseAiConfig({ AI_PROVIDER: 'gemini' })).toThrow(/AI_PROVIDER.*"gemini"/);
  });

  it('treats whitespace as unset', () => {
    expect(parseAiConfig({ AI_PROVIDER: '   ' })).toBeNull();
    expect(() => parseAiConfig({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: '  ' })).toThrow(/ANTHROPIC_API_KEY/);
    expect(parseAiConfig({ AI_PROVIDER: ' anthropic ', ANTHROPIC_API_KEY: ' sk-ant-x ', AI_MODEL: '  ' })).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      apiKey: 'sk-ant-x',
    });
    expect(
      parseAiConfig({
        AI_PROVIDER: 'openai-compatible',
        AI_MODEL: 'llama-4',
        AI_BASE_URL: 'http://llm.internal/v1',
        AI_API_KEY: ' ',
      })?.apiKey,
    ).toBeNull();
  });
});

describe('AI_ANALYSIS_QUEUE', () => {
  it('is its own queue, beside ingest', () => {
    expect(AI_ANALYSIS_QUEUE).toBe('ai-analysis');
    expect(AI_ANALYSIS_QUEUE).not.toBe(INGEST_QUEUE);
  });
});
