const ENGINE_KEYS = [
  'warmupMs',
  'percentiles',
  'maxEndpoints',
  'maxBucketsRun',
  'maxBucketsEndpoint',
] as const;

export function engineOptionsFrom(settings: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ENGINE_KEYS) {
    const value = settings[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}
