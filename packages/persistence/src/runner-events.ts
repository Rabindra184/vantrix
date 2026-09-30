/**
 * ═══ THE WORDS A RUNNER RUN'S LOGS TAB IS WRITTEN IN ═══
 * (docs/superpowers/specs/2026-09-29-run-logs-design.md)
 *
 * Pure, so the API's two queue writers (`createQueued` and `retry`) build the
 * same three messages from one definition, and so the runner's writer caps a
 * message by the same rule the API's do.
 */

/** Every event message is at most this long; the excess becomes `…`. */
export const EVENT_MESSAGE_MAX = 2000;

export function capEventMessage(message: string): string {
  return message.length <= EVENT_MESSAGE_MAX
    ? message
    : `${message.slice(0, EVENT_MESSAGE_MAX - 1)}…`;
}

/**
 * An artifact's size the way Gatling Enterprise printed a package's on
 * 2026-09-29 (`1.8 MiB`): IEC units, one decimal, whole bytes below a KiB.
 */
export function formatPackageSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/**
 * What the API writes when a runner job is queued, and again when one is
 * retried — Gatling Enterprise's first three lines, in its words. They name
 * the simulation class and the artifact's own name and size, and NO other job
 * parameter: never the Java options, a system property or the storage key.
 */
export function queuedEventMessages(artifact: {
  readonly simulationClass: string;
  readonly name: string;
  readonly bytes: number;
}): readonly [string, string, string] {
  return [
    'Start requested.',
    capEventMessage(`Starting the simulation: '${artifact.simulationClass}'`),
    capEventMessage(`Using package: '${artifact.name}' (${formatPackageSize(artifact.bytes)})`),
  ];
}
