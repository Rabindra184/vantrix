import {
  AgentConnectionsResponseSchema,
  AgentDnsResponseSchema,
  AgentInjectorsResponseSchema,
  AgentStatusResponseSchema,
  AgentSummaryResponseSchema,
} from '@perfportal/contracts';
import type { Window } from '@perfportal/contracts';
import { apiFetch } from './fetch';
import {
  agentConnectionsPath,
  agentDnsPath,
  agentInjectorsPath,
  agentStatusPath,
  agentSummaryPath,
} from './metricPaths';

/**
 * The five reads behind the Report's Connections, DNS and Load generators
 * sections — the run's agent file, as PR 2's `/v1/runs/:id/agent*` serves it.
 *
 * Each is `metrics.ts`'s `telemetryQuery` shape, for its reasons: a finished
 * run's agent figures are fixed at ingest, so `staleTime: Infinity`; and
 * everything that changes the ANSWER is in the key — the window, and for the
 * two filtered reads the remote or hostname. A key missing the filter would
 * serve one remote's figures for every other under that infinite staleness.
 *
 * Like every factory in `metrics.ts`, these answer 200 or an error and never a
 * run body at 202, so a caller must not enable one for a non-terminal run.
 *
 * `window` is REQUIRED, with no default: a caller that forgot it would read the
 * whole run under a brushed window, and the chart would say nothing of it.
 * `null` is the whole run, said on purpose.
 */

const windowKey = (window: Window | null) => [window?.fromMs ?? null, window?.toMs ?? null] as const;

export const agentSummaryQuery = (id: string) => ({
  queryKey: ['run', id, 'agent'] as const,
  queryFn: () => apiFetch(AgentSummaryResponseSchema, agentSummaryPath(id)),
  staleTime: Infinity,
});

export const agentConnectionsQuery = (id: string, remote: string, window: Window | null) => ({
  queryKey: ['run', id, 'agent', 'connections', remote, ...windowKey(window)] as const,
  queryFn: () => apiFetch(AgentConnectionsResponseSchema, agentConnectionsPath(id, remote, window)),
  staleTime: Infinity,
});

export const agentDnsQuery = (id: string, hostname: string, window: Window | null) => ({
  queryKey: ['run', id, 'agent', 'dns', hostname, ...windowKey(window)] as const,
  queryFn: () => apiFetch(AgentDnsResponseSchema, agentDnsPath(id, hostname, window)),
  staleTime: Infinity,
});

export const agentInjectorsQuery = (id: string, window: Window | null) => ({
  queryKey: ['run', id, 'agent', 'injectors', ...windowKey(window)] as const,
  queryFn: () => apiFetch(AgentInjectorsResponseSchema, agentInjectorsPath(id, window)),
  staleTime: Infinity,
});

export const agentStatusQuery = (id: string, window: Window | null) => ({
  queryKey: ['run', id, 'agent', 'status', ...windowKey(window)] as const,
  queryFn: () => apiFetch(AgentStatusResponseSchema, agentStatusPath(id, window)),
  staleTime: Infinity,
});
