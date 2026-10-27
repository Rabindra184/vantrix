import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentConnectionsResponseSchema,
  AgentDnsResponseSchema,
  AgentInjectorsResponseSchema,
  AgentStatusResponseSchema,
  AgentSummaryResponseSchema,
} from '@perfportal/contracts';
import type { Window } from '@perfportal/contracts';
import fixture from './fixtures/agent-run.json';
import {
  agentConnectionsQuery,
  agentDnsQuery,
  agentInjectorsQuery,
  agentStatusQuery,
  agentSummaryQuery,
} from '../src/api/agent';
import { agentConnectionsPath, agentDnsPath } from '../src/api/metricPaths';

/**
 * The agent reads, below the Report's Connections, DNS and Load generators
 * sections.
 *
 * The two filtered endpoints take a value that is a URL-hostile string by
 * construction — a remote is `host/ip:port`, so it carries a `/` and a `:` —
 * and `*`, which the server reads as "every remote together" and which a
 * client must therefore never send as a literal filter. These pin both, and
 * that the filter is part of the query key: two remotes cached under one key
 * under `staleTime: Infinity` would serve one remote's figures for the other,
 * for ever.
 */

const ID = 'r';
const WINDOW: Window = { fromMs: 1000, toMs: 5000, bucketWidthMs: 1000 };

describe('the agent path builders', () => {
  it('omits remote entirely for every remote together', () => {
    expect(agentConnectionsPath(ID, '*')).not.toContain('remote=');
    expect(agentConnectionsPath(ID, '*')).toBe('/v1/runs/r/agent/connections');
  });

  it('encodes a remote, whose / and : are part of its value', () => {
    expect(agentConnectionsPath(ID, 'a/1.2.3.4:443')).toContain('remote=a%2F1.2.3.4%3A443');
  });

  it('joins the window once, after the filter, with no second ?', () => {
    for (const url of [
      agentConnectionsPath(ID, 'a/1.2.3.4:443', WINDOW),
      agentDnsPath(ID, 'localhost', WINDOW),
    ]) {
      expect(url, url).toContain('&from=1000&to=5000');
      expect((url.match(/\?/g) ?? []).length, url).toBe(1);
    }
  });

  it('still joins the window with ? when the filter is every remote or hostname', () => {
    expect(agentConnectionsPath(ID, '*', WINDOW)).toBe('/v1/runs/r/agent/connections?from=1000&to=5000');
    expect(agentDnsPath(ID, '*', WINDOW)).toBe('/v1/runs/r/agent/dns?from=1000&to=5000');
  });

  it('encodes a hostname the same way and omits it for *', () => {
    expect(agentDnsPath(ID, 'a b')).toContain('hostname=a%20b');
    expect(agentDnsPath(ID, '*')).not.toContain('hostname=');
  });
});

describe('the agent query factories', () => {
  it('keys two connections reads that differ only in remote apart', () => {
    const a = agentConnectionsQuery(ID, 'a/1.2.3.4:443', null).queryKey;
    const b = agentConnectionsQuery(ID, 'b/1.2.3.4:443', null).queryKey;
    expect(a).not.toEqual(b);
  });

  it('keys two dns reads that differ only in hostname apart', () => {
    expect(agentDnsQuery(ID, 'a', null).queryKey).not.toEqual(agentDnsQuery(ID, 'b', null).queryKey);
  });

  it('keys a windowed read apart from the whole run, on every windowed factory', () => {
    const pairs = [
      [agentConnectionsQuery(ID, '*', null), agentConnectionsQuery(ID, '*', WINDOW)],
      [agentDnsQuery(ID, '*', null), agentDnsQuery(ID, '*', WINDOW)],
      [agentInjectorsQuery(ID, null), agentInjectorsQuery(ID, WINDOW)],
      [agentStatusQuery(ID, null), agentStatusQuery(ID, WINDOW)],
    ] as const;
    for (const [whole, windowed] of pairs) {
      expect(whole.queryKey).not.toEqual(windowed.queryKey);
    }
  });

  it('caches every agent read for ever, because a finished run\'s figures are fixed', () => {
    for (const q of [
      agentSummaryQuery(ID),
      agentConnectionsQuery(ID, '*', null),
      agentDnsQuery(ID, '*', null),
      agentInjectorsQuery(ID, null),
      agentStatusQuery(ID, null),
    ]) {
      expect(q.staleTime).toBe(Infinity);
    }
  });

  describe('asks for the path its builder spells', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('fetches each factory\'s own URL', async () => {
      const seen: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          seen.push(url);
          // Any 4xx is enough: the URL is the claim, and a refusal avoids
          // having to build five valid bodies here.
          return new Response(JSON.stringify({ status: 404, code: 'NOT_FOUND', title: 'x', detail: 'x', remediation: 'x' }), {
            status: 404,
            headers: { 'Content-Type': 'application/problem+json' },
          });
        }),
      );
      const queries = [
        agentSummaryQuery(ID),
        agentConnectionsQuery(ID, 'a/1.2.3.4:443', WINDOW),
        agentDnsQuery(ID, 'localhost', null),
        agentInjectorsQuery(ID, WINDOW),
        agentStatusQuery(ID, null),
      ];
      for (const q of queries) await q.queryFn().catch(() => undefined);
      expect(seen).toEqual([
        '/v1/runs/r/agent',
        '/v1/runs/r/agent/connections?remote=a%2F1.2.3.4%3A443&from=1000&to=5000',
        '/v1/runs/r/agent/dns?hostname=localhost',
        '/v1/runs/r/agent/injectors?from=1000&to=5000',
        '/v1/runs/r/agent/status',
      ]);
    });
  });
});

/**
 * THE CAPTURED FIXTURE IS THE CONTRACT'S SHAPE, AND THE RUN IT DESCRIBES IS
 * THE ONE ITS CONSUMERS NEED. Tasks 2-4's transforms are tested against
 * `fixtures/agent-run.json`; a re-capture against a drifted contract, or one
 * that recorded a macOS run or no agent at all, would turn every one of those
 * tests into a test of something else while staying green. The capture script
 * refuses to write such a file; this is the same claim, held by the suite.
 */
describe('the captured agent fixture', () => {
  it('parses, payload by payload, with the schema the browser parses it with', () => {
    AgentSummaryResponseSchema.parse(fixture.summary);
    AgentConnectionsResponseSchema.parse(fixture.connections);
    for (const payload of Object.values(fixture.connectionsByRemote)) AgentConnectionsResponseSchema.parse(payload);
    AgentDnsResponseSchema.parse(fixture.dns);
    AgentInjectorsResponseSchema.parse(fixture.injectors);
    AgentStatusResponseSchema.parse(fixture.status);
  });

  it('describes a Linux run with both collectors on and more than one remote', () => {
    const summary = AgentSummaryResponseSchema.parse(fixture.summary);
    expect(summary.header?.collects).toEqual({ http: true, machine: true });
    expect(summary.remotes.length).toBeGreaterThanOrEqual(2);
    expect(Object.keys(fixture.connectionsByRemote).sort()).toEqual([...summary.remotes].sort());
    for (const [remote, payload] of Object.entries(fixture.connectionsByRemote)) {
      expect(AgentConnectionsResponseSchema.parse(payload).remote, remote).toBe(remote);
    }
  });
});
