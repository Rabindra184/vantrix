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
export const projectRulesQueryKey = (slug: string) => ['project-rules', slug] as const;

export function fetchProjectRules(slug: string): Promise<SlaRuleListResponse> {
  return apiFetch(SlaRuleListResponseSchema, `/v1/projects/${encodeURIComponent(slug)}/rules`);
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
