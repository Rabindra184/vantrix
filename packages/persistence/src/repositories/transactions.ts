/**
 * Prisma's budget for an interactive transaction that BEGINS by taking a lock
 * that is meant to queue: `PackageRepository.addVersion` behind another upload
 * or a delete, `PackageRepository.delete` behind a start holding the package
 * row FOR SHARE, and `UserRepository.withAdminLock` behind another admin
 * change. The budget runs from BEGIN, so every second parked on that lock is
 * spent from it, and the defaults (5 s to run, 2 s to get a connection) turn a
 * queue behind a slow holder into P2028 "transaction already closed" for a
 * caller that did nothing wrong. No `lock_timeout` is configured anywhere, so
 * this 30 s is the only ceiling there is: a wait that long means a holder is
 * stuck, and failing at 30 s is the intended outcome — not a reason for the
 * defaults to abandon, after five seconds, a queue that would have cleared.
 *
 * Internal to this package: not exported from its index.
 */
export const LOCK_WAITING_TX = { maxWait: 10_000, timeout: 30_000 } as const;
