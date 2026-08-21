/**
 * Redis pub/sub channel names shared by every publisher (the API's
 * `LiveNotifier`, the on-prem runner's own notifier) and subscriber (the
 * worker's `LiveFoldOwner`) of live-run signals. One copy so a renamed
 * channel on one side cannot silently stop being heard on the other.
 */
export const LIVE_CHANNELS = {
  opened: 'live:opened',
  advance: 'live:advance',
  closed: 'live:closed',
} as const;
