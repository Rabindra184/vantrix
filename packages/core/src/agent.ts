/**
 * The PerfPortal Gatling agent's file (`clients/gatling-agent`): newline-delimited JSON, one
 * record a line, opened by a `header` line naming this format. The decoder in
 * `@perfportal/plugin-gatling` refuses a file whose header names any other.
 *
 * Bumped only when a line changes MEANING; a new record type or a new field is not a bump,
 * because the decoder skips a record type it does not know and ignores fields it does not read.
 */
export const AGENT_FILE_FORMAT = 'perfportal-agent/1';

/**
 * The name an uploaded results bundle carries the agent's file under, beside
 * `simulation.log`.
 */
export const AGENT_BUNDLE_FILE = 'perfportal-agent.ndjson';
