import { describe, expect, it } from 'vitest';
import { aiUnavailableReason, type AiEligibility } from '../src/index.js';

/** A run the analysis may be written for: finished, measured, exact, not mismatched. */
const ELIGIBLE: AiEligibility = {
  orgId: '00000000-0000-0000-0000-000000000001',
  status: 'complete',
  hasStats: true,
  notExact: false,
  verificationStatus: 'verified',
  ingestedAt: new Date('2026-08-07T10:01:00Z'),
  recomputedAt: null,
};
const ON = { configured: true, orgEnabled: true };

describe('aiUnavailableReason', () => {
  it('answers null for a finished, measured, exact run with the feature on', () => {
    expect(aiUnavailableReason(ELIGIBLE, ON)).toBeNull();
    expect(aiUnavailableReason({ ...ELIGIBLE, status: 'incomplete' }, ON)).toBeNull();
    expect(aiUnavailableReason({ ...ELIGIBLE, verificationStatus: null }, ON)).toBeNull();
  });

  it.each(['pending', 'parsing', 'running'])('reads a %s run as not_terminal', (status) => {
    expect(aiUnavailableReason({ ...ELIGIBLE, status }, ON)).toBe('not_terminal');
  });

  it('reads a failed ingest, and a finished run with nothing measured, as no_statistics', () => {
    expect(aiUnavailableReason({ ...ELIGIBLE, status: 'failed' }, ON)).toBe('no_statistics');
    expect(aiUnavailableReason({ ...ELIGIBLE, hasStats: false }, ON)).toBe('no_statistics');
  });

  it('reads estimated statistics and a verification mismatch by their own reasons', () => {
    expect(aiUnavailableReason({ ...ELIGIBLE, notExact: true }, ON)).toBe('estimated');
    expect(aiUnavailableReason({ ...ELIGIBLE, verificationStatus: 'mismatch' }, ON)).toBe('verification_mismatch');
  });

  /** Each reason wins over every one after it, in AI_UNAVAILABLE_REASONS' order. */
  it('answers in the precedence the API states', () => {
    const worst: AiEligibility = { ...ELIGIBLE, status: 'running', hasStats: false, notExact: true, verificationStatus: 'mismatch' };
    expect(aiUnavailableReason(worst, { configured: false, orgEnabled: false })).toBe('not_configured');
    expect(aiUnavailableReason(worst, { configured: true, orgEnabled: false })).toBe('org_disabled');
    expect(aiUnavailableReason(worst, ON)).toBe('not_terminal');
    expect(aiUnavailableReason({ ...worst, status: 'complete' }, ON)).toBe('no_statistics');
    expect(aiUnavailableReason({ ...worst, status: 'complete', hasStats: true }, ON)).toBe('estimated');
    expect(aiUnavailableReason({ ...worst, status: 'complete', hasStats: true, notExact: false }, ON)).toBe(
      'verification_mismatch',
    );
  });
});
