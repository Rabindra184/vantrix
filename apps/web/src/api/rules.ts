import {
  SlaRuleListResponseSchema,
  SlaRuleSchema,
  type CreateSlaRuleRequest,
  type SlaRule,
  type SlaRuleListResponse,
  type UpdateSlaRuleRequest,
} from '@perfportal/contracts';
import { apiFetch } from './fetch.js';

/**
 * A function rather than a bare array, because the key is parameterised by
 * project — the same distinction `projects.ts` documents between
 * `projectsQueryKey` (org-wide, a constant) and a per-project key.
 */
export const projectRulesQueryKey = (slug: string, testSlug: string | null = null) =>
  ['project-rules', slug, testSlug] as const;

/**
 * A project's rules, or — with `testSlug` — the rules that JUDGE that test.
 *
 * ═══ THE SECOND FORM IS A UNION, NOT A NARROWING ═══
 *
 * `?test=` asks the server for that test's own rules PLUS the project-wide
 * ones, because "what gates this test" is the question, and a project-wide
 * error-rate floor gates it just as much as a rule with its name on. That is
 * also why the two forms need DIFFERENT query keys rather than one: they are
 * different answers, and sharing a key would serve one as the other the moment
 * a reader moved between a test page and project setup.
 */
export function fetchProjectRules(
  slug: string,
  testSlug: string | null = null,
): Promise<SlaRuleListResponse> {
  const path = `/v1/projects/${encodeURIComponent(slug)}/rules`;
  return apiFetch(
    SlaRuleListResponseSchema,
    testSlug === null ? path : `${path}?test=${encodeURIComponent(testSlug)}`,
  );
}

export function createProjectRule(slug: string, body: CreateSlaRuleRequest): Promise<SlaRule> {
  return apiFetch(SlaRuleSchema, `/v1/projects/${encodeURIComponent(slug)}/rules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function updateProjectRule(
  slug: string,
  ruleId: string,
  body: UpdateSlaRuleRequest,
): Promise<SlaRule> {
  return apiFetch(
    SlaRuleSchema,
    `/v1/projects/${encodeURIComponent(slug)}/rules/${encodeURIComponent(ruleId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
}

export function deleteProjectRule(slug: string, ruleId: string): Promise<SlaRule> {
  return apiFetch(
    SlaRuleSchema,
    `/v1/projects/${encodeURIComponent(slug)}/rules/${encodeURIComponent(ruleId)}`,
    { method: 'DELETE' },
  );
}
