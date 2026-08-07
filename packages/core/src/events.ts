export type ToolId = 'gatling' | 'k6' | 'jmeter' | 'locust' | 'artillery' | (string & {});
export type MetricScope = 'run' | 'scenario' | 'group' | 'request';
export type MetricFamily = 'response_time' | 'latency' | 'group_cumulated' | 'group_duration';

export interface MetaEvent {
  type: 'meta';
  simulation: string;
  toolVersion: string;
  startedAtMs: number;
  description?: string;
}

/** startMs and endMs are both retained: FR-STAT-7 needs each edge independently. */
export interface RequestEvent {
  type: 'request';
  name: string;
  groups: string[];
  scenario?: string;
  userId: string;
  startMs: number;
  endMs: number;
  firstByteMs?: number;
  ok: boolean;
  message?: string;
}

export interface UserEvent {
  type: 'user';
  scenario: string;
  userId: string;
  kind: 'start' | 'end';
  tsMs: number;
}

/** cumulatedResponseTimeMs is carried explicitly — it diverges from (endMs - startMs)
 *  whenever requests inside the group overlap, and Gatling reports both. */
export interface GroupEvent {
  type: 'group';
  groups: string[];
  userId: string;
  startMs: number;
  endMs: number;
  cumulatedResponseTimeMs: number;
  ok: boolean;
}

export type CanonicalEvent = MetaEvent | RequestEvent | UserEvent | GroupEvent;
