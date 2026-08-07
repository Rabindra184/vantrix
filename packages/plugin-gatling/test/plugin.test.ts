import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BundleIndex, BundleSource } from '@perfportal/core';
import { describe, expect, it } from 'vitest';
import { GatlingPlugin } from '../src/plugin.js';

const LOG = fileURLToPath(
  new URL('../../../fixtures/gatling-3.15.1.2/reference-report/simulation.log', import.meta.url),
);

function sourceFrom(files: Record<string, Uint8Array>): BundleSource {
  const index: BundleIndex = {
    files: Object.keys(files),
    head: async (path, bytes) => {
      const f = files[path];
      if (!f) throw new Error(`no such file ${path}`);
      return f.subarray(0, bytes);
    },
  };
  return {
    index,
    read: async (path) => {
      const f = files[path];
      if (!f) throw new Error(`no such file ${path}`);
      return f;
    },
  };
}

const realLog = new Uint8Array(readFileSync(LOG));

describe('GatlingPlugin.detect', () => {
  it('matches the reference bundle and reports its version', async () => {
    const r = await new GatlingPlugin().detect(sourceFrom({ 'simulation.log': realLog }).index);
    expect(r.matched).toBe(true);
    expect(r.toolVersion).toBe('3.15.1');
  });

  it('finds simulation.log in a nested directory', async () => {
    const r = await new GatlingPlugin().detect(
      sourceFrom({ 'paritysimulation-20260807/simulation.log': realLog }).index,
    );
    expect(r.matched).toBe(true);
  });

  it('does not match a bundle with no simulation.log, and says what it wanted', async () => {
    const r = await new GatlingPlugin().detect(sourceFrom({ 'index.html': new Uint8Array([1]) }).index);
    expect(r.matched).toBe(false);
    expect(r.reason).toContain('simulation.log');
  });

  it('does not match when the first byte is not a Run record', async () => {
    const notGatling = new Uint8Array(realLog);
    notGatling[0] = 9;
    const r = await new GatlingPlugin().detect(sourceFrom({ 'simulation.log': notGatling }).index);
    expect(r.matched).toBe(false);
  });

  it('rejects an unsupported major rather than guessing at the layout', async () => {
    // Rewrite the length-prefixed version string "3.15.1" as "9.99.9" in place.
    const other = new Uint8Array(realLog);
    const buf = Buffer.from(other.buffer, other.byteOffset, other.byteLength);
    buf.write('9.99.9', 5, 'latin1');
    const r = await new GatlingPlugin().detect(sourceFrom({ 'simulation.log': other }).index);
    expect(r.matched).toBe(false);
    expect(r.reason).toContain('9.99.9');
  });
});

describe('GatlingPlugin.parse', () => {
  it('yields the fixture record counts through the async contract', async () => {
    const plugin = new GatlingPlugin();
    let requests = 0;
    let users = 0;
    let groups = 0;
    let meta = 0;
    for await (const e of plugin.parse(sourceFrom({ 'simulation.log': realLog }))) {
      if (e.type === 'request') requests++;
      else if (e.type === 'user') users++;
      else if (e.type === 'group') groups++;
      else meta++;
    }
    expect({ meta, requests, users, groups }).toEqual({ meta: 1, requests: 895, users: 490, groups: 405 });
  });

  it('raises a structured, remediable error when simulation.log is absent', async () => {
    const plugin = new GatlingPlugin();
    const iterate = async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- drain-only loop; only completion/throw matters
      for await (const _ of plugin.parse(sourceFrom({ 'index.html': new Uint8Array([1]) }))) {
        /* drain */
      }
    };
    await expect(iterate()).rejects.toMatchObject({
      code: 'LOG_NOT_FOUND',
      remediation: expect.stringMatching(/.+/),
    });
  });
});

describe('GatlingPlugin.capabilities', () => {
  it('declares what the binary log actually carries', () => {
    expect(new GatlingPlugin().capabilities()).toEqual({
      latency: false,
      groups: true,
      scenarios: true,
      sessionEvents: true,
      nativeAssertions: true,
      errorMessages: true,
    });
  });
});
