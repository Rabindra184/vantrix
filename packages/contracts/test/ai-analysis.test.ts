import { describe, expect, it } from 'vitest';
import {
  AI_UNAVAILABLE_REASONS,
  AiAnalysisContentSchema,
  AiAnalysisResponseSchema,
  AiAnalysisStateSchema,
  OrgSettingsSchema,
  UpdateOrgSettingsRequestSchema,
} from '../src/index.js';

/**
 * ═══ THE AI RUN ANALYSIS CONTRACTS ═══
 * (docs/superpowers/specs/2026-11-02-ai-run-analysis-design.md)
 *
 * `AiAnalysisContentSchema` is two things at once: what the API stores and
 * serves, and the JSON schema the model is asked to fill. So every bound here
 * is also an instruction to the model, and `.strict()` everywhere is what
 * makes a key the model invented a refusal rather than a silent strip.
 * Imported through the package index, so a schema nobody exported fails here.
 */

const CONTENT = {
  health: { headline: 'The run held its SLA.', bullets: ['p95 stayed at 658 ms against an 800 ms gate.'] },
  insights: {
    headline: 'One request carried the tail.',
    errors: [],
    assertions: [],
    injectionProfile: [],
    responseTimes: [],
  },
  recommendations: { headline: 'Look at Search first.', bullets: ['Profile the Search endpoint.'] },
};

describe('AiAnalysisContentSchema', () => {
  /**
   * A run with no errors and no assertions has nothing to say under those
   * headings, and the model must be allowed to say nothing rather than invent
   * a bullet. Health and recommendations are the analysis itself, so each
   * carries at least one.
   */
  it('accepts empty insights arrays but not empty health bullets', () => {
    expect(AiAnalysisContentSchema.safeParse(CONTENT).success).toBe(true);
    expect(
      AiAnalysisContentSchema.safeParse({ ...CONTENT, health: { ...CONTENT.health, bullets: [] } }).success,
    ).toBe(false);
    expect(
      AiAnalysisContentSchema.safeParse({
        ...CONTENT,
        recommendations: { ...CONTENT.recommendations, bullets: [] },
      }).success,
    ).toBe(false);
  });

  it('refuses an unknown key at every level', () => {
    expect(AiAnalysisContentSchema.safeParse({ ...CONTENT, summary: 'x' }).success, 'top').toBe(false);
    expect(
      AiAnalysisContentSchema.safeParse({ ...CONTENT, health: { ...CONTENT.health, score: 9 } }).success,
      'health',
    ).toBe(false);
    expect(
      AiAnalysisContentSchema.safeParse({ ...CONTENT, insights: { ...CONTENT.insights, network: [] } }).success,
      'insights',
    ).toBe(false);
    expect(
      AiAnalysisContentSchema.safeParse({
        ...CONTENT,
        recommendations: { ...CONTENT.recommendations, priority: 'high' },
      }).success,
      'recommendations',
    ).toBe(false);
  });

  it('refuses a 401-character bullet', () => {
    const at = (bullet: string) =>
      AiAnalysisContentSchema.safeParse({ ...CONTENT, health: { ...CONTENT.health, bullets: [bullet] } }).success;
    expect(at('b'.repeat(400))).toBe(true);
    expect(at('b'.repeat(401))).toBe(false);
    // Trimmed before it is measured, so padding cannot carry an empty bullet.
    expect(at('   ')).toBe(false);
  });

  it('bounds the bullet lists at six and the headline at 300 characters', () => {
    const bullets = (n: number) => Array.from({ length: n }, (_, i) => `bullet ${i}`);
    expect(
      AiAnalysisContentSchema.safeParse({ ...CONTENT, health: { ...CONTENT.health, bullets: bullets(6) } }).success,
    ).toBe(true);
    expect(
      AiAnalysisContentSchema.safeParse({ ...CONTENT, health: { ...CONTENT.health, bullets: bullets(7) } }).success,
    ).toBe(false);
    expect(
      AiAnalysisContentSchema.safeParse({ ...CONTENT, insights: { ...CONTENT.insights, errors: bullets(7) } })
        .success,
    ).toBe(false);
    expect(
      AiAnalysisContentSchema.safeParse({ ...CONTENT, health: { ...CONTENT.health, headline: 'h'.repeat(301) } })
        .success,
    ).toBe(false);
  });
});

const READY = {
  available: true,
  state: 'ready',
  content: CONTENT,
  failureReason: null,
  generatedAt: '2026-11-02T10:00:00.000Z',
  model: 'claude-opus-5-5',
  stale: false,
};

describe('AiAnalysisResponseSchema', () => {
  it('parses each unavailable reason and refuses another', () => {
    for (const reason of AI_UNAVAILABLE_REASONS) {
      expect(AiAnalysisResponseSchema.safeParse({ available: false, reason }).success, reason).toBe(true);
    }
    expect(AiAnalysisResponseSchema.safeParse({ available: false, reason: 'quota' }).success).toBe(false);
  });

  /**
   * A ready analysis without its content, or a pending one carrying content,
   * is a response that means two things; the page could only guess which.
   */
  it('carries content exactly when the state is ready', () => {
    expect(AiAnalysisResponseSchema.safeParse(READY).success).toBe(true);
    expect(AiAnalysisResponseSchema.safeParse({ ...READY, content: null }).success).toBe(false);
    expect(AiAnalysisResponseSchema.safeParse({ ...READY, state: 'pending' }).success).toBe(false);
    expect(
      AiAnalysisResponseSchema.safeParse({ ...READY, state: 'pending', content: null, generatedAt: null, model: null })
        .success,
    ).toBe(true);
    expect(
      AiAnalysisResponseSchema.safeParse({
        ...READY,
        state: 'failed',
        content: null,
        failureReason: 'The provider timed out.',
      }).success,
    ).toBe(true);
  });

  it('names the four states and nothing else', () => {
    expect(AiAnalysisStateSchema.options).toEqual(['none', 'pending', 'ready', 'failed']);
  });
});

describe('OrgSettingsSchema', () => {
  it('reads the org switch beside what the deployment configured', () => {
    expect(
      OrgSettingsSchema.parse({
        aiEnabled: true,
        aiProviderConfigured: true,
        aiProvider: 'anthropic',
        aiModel: 'claude-opus-5-5',
      }),
    ).toEqual({ aiEnabled: true, aiProviderConfigured: true, aiProvider: 'anthropic', aiModel: 'claude-opus-5-5' });
    expect(
      OrgSettingsSchema.safeParse({ aiEnabled: false, aiProviderConfigured: false, aiProvider: null, aiModel: null })
        .success,
    ).toBe(true);
    expect(
      OrgSettingsSchema.safeParse({ aiEnabled: false, aiProviderConfigured: true, aiProvider: 'gemini', aiModel: 'x' })
        .success,
    ).toBe(false);
  });

  it('lets an update change the switch and nothing the deployment owns', () => {
    expect(UpdateOrgSettingsRequestSchema.parse({ aiEnabled: true })).toEqual({ aiEnabled: true });
    expect(UpdateOrgSettingsRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateOrgSettingsRequestSchema.safeParse({ aiEnabled: true, aiModel: 'other' }).success).toBe(false);
  });
});
