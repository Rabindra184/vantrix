import { ingestError, type BundleIndex, type PerfPlugin } from '@perfportal/core';
import { GatlingPlugin } from '@perfportal/plugin-gatling';

export const PLUGINS: readonly PerfPlugin[] = [new GatlingPlugin()];

/**
 * Exactly one plugin must claim a bundle. Zero is an unsupported bundle; more
 * than one is ambiguous, and guessing which is right would silently pick an
 * interpretation of the data.
 */
export async function selectPlugin(
  index: BundleIndex,
): Promise<{ plugin: PerfPlugin; toolVersion: string | null }> {
  const matches: { plugin: PerfPlugin; toolVersion: string | null }[] = [];
  const reasons: string[] = [];

  for (const plugin of PLUGINS) {
    const result = await plugin.detect(index);
    if (result.matched) matches.push({ plugin, toolVersion: result.toolVersion ?? null });
    else if (result.reason) reasons.push(`${plugin.id}: ${result.reason}`);
  }

  const first = matches[0];
  if (!first) {
    throw ingestError('TOOL_UNKNOWN', {
      message: 'No installed plugin recognises this bundle.',
      remediation:
        'Upload the whole results directory produced by a supported tool. Supported today: Gatling 3.x.',
      detail: { reasons, files: index.files.slice(0, 20) },
    });
  }
  if (matches.length > 1) {
    throw ingestError('TOOL_AMBIGUOUS', {
      message: `More than one plugin claimed this bundle: ${matches.map((m) => m.plugin.id).join(', ')}.`,
      remediation:
        'Upload the results of a single tool run. A bundle containing output from two tools cannot be interpreted unambiguously.',
    });
  }
  return first;
}
