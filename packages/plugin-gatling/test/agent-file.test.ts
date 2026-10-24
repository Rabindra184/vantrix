import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_FILE_FORMAT } from '@perfportal/core';
import { describe, expect, it } from 'vitest';
import { AgentFileError, decodeAgentFile } from '../src/index.js';

const FIXTURE = readFileSync(
  join(import.meta.dirname, '../../../fixtures/gatling-3.15.1.2/agent-run/agent.ndjson'),
);

/** The fixture README's own figure: 90 request records, one `status` line each. */
const FIXTURE_REQUESTS = 90;

const HEADER =
  '{"t":"header","format":"perfportal-agent/1","agentVersion":"0.1.0","gatlingHttpClient":"3.15.1",' +
  '"gatlingHttp":"3.15.1","java":"21","os":"Mac OS X","host":null,"startedAt":1000,' +
  '"collects":{"http":true,"machine":false},"reasons":{"machine":"not Linux"}}';

const enc = (lines: string[]): Uint8Array => new TextEncoder().encode(lines.join('\n') + '\n');

describe('decodeAgentFile', () => {
  it('decodes the paired real fixture', () => {
    const file = decodeAgentFile(FIXTURE);
    expect(file.header.format).toBe(AGENT_FILE_FORMAT);
    expect(file.header.format).toBe('perfportal-agent/1');
    expect(file.header.collects).toEqual({ http: true, machine: true });
    expect(file.header.host).toBe('loadgen-1');
    expect(file.header.os).toBe('Linux');
    expect(file.malformedLines).toBe(0);
    expect(file.statuses).toHaveLength(FIXTURE_REQUESTS);
    // The README's line counts — every record type reached its own list.
    expect(file.connects).toHaveLength(61);
    expect(file.closes).toHaveLength(61);
    expect(file.dns).toHaveLength(60);
    expect(file.tls).toHaveLength(30);
    expect(file.samples).toHaveLength(6);
    for (const c of file.connects) expect(typeof c.ch).toBe('number');
    expect(file.connects.filter((c) => c.warmup)).toHaveLength(1);
    // absent `warmup` reads as false, not undefined
    expect(file.dns.every((d) => d.warmup === false)).toBe(true);
    expect(file.samples.at(-1)!.final).toBe(true);
    expect(file.samples.slice(0, -1).every((s) => s.final === false)).toBe(true);
    // machine figures present on Linux, keyed as the agent writes them
    const last = file.samples.at(-1)!;
    expect(last.cpu).toHaveLength(8);
    expect(last.states?.['localhost/127.0.0.1:33357']).toEqual({ '6': 30 });
    expect(last.netty).toEqual([83886080, 0]);
    expect(file.error).toBeNull();
    expect(file.capped).toBe(false);
  });

  it('keeps records in file order', () => {
    const file = decodeAgentFile(FIXTURE);
    for (const list of [file.connects, file.closes, file.dns, file.tls, file.statuses, file.samples]) {
      const ats = list.map((r) => r.at);
      // the sampler's lines are written in order; the event lists keep the file's order,
      // which is what this compares against.
      const lines = new TextDecoder()
        .decode(FIXTURE)
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { t: string; at: number });
      const type = list === file.connects ? 'connect' : list === file.closes ? 'close'
        : list === file.dns ? 'dns' : list === file.tls ? 'tls' : list === file.statuses ? 'status' : 's';
      expect(ats).toEqual(lines.filter((l) => l.t === type).map((l) => l.at));
    }
  });

  it('skips a truncated last line and counts it', () => {
    const whole = decodeAgentFile(FIXTURE);
    const cut = decodeAgentFile(FIXTURE.subarray(0, FIXTURE.length - 10));
    expect(cut.malformedLines).toBe(1);
    // the last line is the final sample: it alone is lost
    expect(cut.samples).toHaveLength(whole.samples.length - 1);
    expect(cut.statuses).toHaveLength(whole.statuses.length);
    expect(cut.connects).toEqual(whole.connects);
    expect(cut.closes).toEqual(whole.closes);
  });

  it('refuses a file without a header', () => {
    const noHeader = new TextDecoder().decode(FIXTURE).split('\n').slice(1).join('\n');
    expect(() => decodeAgentFile(new TextEncoder().encode(noHeader))).toThrow(AgentFileError);
    expect(() => decodeAgentFile(new Uint8Array())).toThrow(AgentFileError);
    expect(() => decodeAgentFile(enc(['not json']))).toThrow(AgentFileError);
  });

  it('refuses another format', () => {
    expect(() =>
      decodeAgentFile(enc([HEADER.replace('perfportal-agent/1', 'perfportal-agent/2')])),
    ).toThrow(AgentFileError);
  });

  it('refuses a header that lacks a field it requires', () => {
    expect(() => decodeAgentFile(enc([HEADER.replace('"java":"21",', '')]))).toThrow(
      AgentFileError,
    );
  });

  it('reads a header written before `host` existed as host null', () => {
    const file = decodeAgentFile(enc([HEADER.replace('"host":null,', '')]));
    expect(file.header.host).toBeNull();
    expect(file.header.reasons).toEqual({ machine: 'not Linux' });
  });

  it('skips an unknown record type without counting it', () => {
    const file = decodeAgentFile(
      new TextEncoder().encode(new TextDecoder().decode(FIXTURE) + '{"t":"future","at":1}\n'),
    );
    expect(file.malformedLines).toBe(0);
    expect(file.statuses).toHaveLength(FIXTURE_REQUESTS);
  });

  it('counts a known record type that lacks a field it requires', () => {
    const file = decodeAgentFile(
      enc([
        HEADER,
        '{"t":"connect","at":5,"us":10,"remote":"a/1.2.3.4:80","ok":true}', // no ch
        '{"t":"connect","at":5,"us":10,"remote":"a/1.2.3.4:80","ok":true,"ch":"7"}', // ch a string
        '{"t":"status","at":6,"req":"r"}', // no code
        '[1,2]', // JSON, not an object
        '{"t":"connect","at":5,"us":10,"remote":"a/1.2.3.4:80","ok":false,"ch":7}',
      ]),
    );
    expect(file.malformedLines).toBe(4);
    expect(file.connects).toEqual([
      { at: 5, us: 10, remote: 'a/1.2.3.4:80', ok: false, ch: 7, warmup: false },
    ]);
    expect(file.statuses).toEqual([]);
  });

  it('reads tls without ch as null', () => {
    const file = decodeAgentFile(
      enc([
        HEADER,
        '{"t":"tls","at":5,"us":2000,"remote":"a/1.2.3.4:443","ok":true}',
        '{"t":"tls","at":6,"us":3000,"remote":"a/1.2.3.4:443","ok":false,"ch":4,"warmup":true}',
      ]),
    );
    expect(file.malformedLines).toBe(0);
    expect(file.tls).toEqual([
      { at: 5, us: 2000, remote: 'a/1.2.3.4:443', ok: true, ch: null, warmup: false },
      { at: 6, us: 3000, remote: 'a/1.2.3.4:443', ok: false, ch: 4, warmup: true },
    ]);
  });

  it('reads a sample without machine figures as null', () => {
    const file = decodeAgentFile(
      enc([
        HEADER,
        '{"t":"s","at":7,"gc":{"G1":[1,2]},"heap":[1,2,3],"netty":null,"bytes":{"a/1.2.3.4:80":[10,20]}}',
      ]),
    );
    expect(file.malformedLines).toBe(0);
    expect(file.samples).toEqual([
      {
        at: 7,
        final: false,
        gc: { G1: [1, 2] },
        heap: [1, 2, 3],
        netty: null,
        cpu: null,
        mem: null,
        tcp: null,
        bytes: { 'a/1.2.3.4:80': [10, 20] },
        states: null,
      },
    ]);
  });

  it('keeps an absent states key (no reading) apart from an empty one (a measured zero)', () => {
    const file = decodeAgentFile(
      enc([
        HEADER,
        '{"t":"s","at":7,"gc":{},"heap":[1,2,3],"netty":null,"bytes":{}}',
        '{"t":"s","at":8,"gc":{},"heap":[1,2,3],"netty":null,"bytes":{},"states":{}}',
      ]),
    );
    expect(file.malformedLines).toBe(0);
    expect(file.samples.map((s) => s.states)).toEqual([null, {}]);
  });

  it('keeps a key spelled __proto__ as a key, not a prototype', () => {
    const file = decodeAgentFile(
      enc([
        HEADER,
        '{"t":"s","at":7,"gc":{},"heap":[1,2,3],"netty":null,"bytes":{"__proto__":[1,2]}}',
      ]),
    );
    const bytes = file.samples[0]!.bytes;
    expect(Object.keys(bytes)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(bytes)).toBe(Object.prototype);
  });

  it('counts a sample whose shapes are wrong', () => {
    const file = decodeAgentFile(
      enc([
        HEADER,
        '{"t":"s","at":7,"gc":{},"heap":[1,2],"netty":null,"bytes":{}}', // heap short
        '{"t":"s","at":7,"gc":{},"heap":[1,2,3],"netty":null,"bytes":{},"cpu":[1,2,3]}', // cpu short
        '{"t":"s","at":7,"gc":{"x":[1]},"heap":[1,2,3],"netty":null,"bytes":{}}', // gc pair short
        '{"t":"s","at":7,"gc":{},"heap":[1,2,3],"bytes":{}}', // netty absent
      ]),
    );
    expect(file.malformedLines).toBe(4);
    expect(file.samples).toEqual([]);
  });

  it('reads a capped line', () => {
    const file = decodeAgentFile(enc([HEADER, '{"t":"capped","at":99}']));
    expect(file.capped).toBe(true);
    expect(file.malformedLines).toBe(0);
  });

  it('reads the error line', () => {
    const file = decodeAgentFile(
      enc([HEADER, '{"t":"error","at":42,"where":"dns","message":"java.lang.Boom: no"}']),
    );
    expect(file.error).toEqual({ at: 42, where: 'dns', message: 'java.lang.Boom: no' });
    expect(file.malformedLines).toBe(0);
  });

  it('tolerates a CRLF line ending and blank lines', () => {
    const file = decodeAgentFile(
      new TextEncoder().encode(`${HEADER}\r\n\r\n{"t":"status","at":1,"req":"r","code":200}\r\n`),
    );
    expect(file.malformedLines).toBe(0);
    expect(file.statuses).toEqual([{ at: 1, req: 'r', code: 200 }]);
  });
});
