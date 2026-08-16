export interface ErrorTally {
  /**
   * `null` is the FOLDED REMAINDER — every message outside the top `limit`,
   * summed. It is not a message that failed to load, and it is deliberately
   * not the string `'other'`.
   *
   * ═══ WHY A NULL AND NOT A SENTINEL STRING ═══
   *
   * This used to return `{ message: 'other' }`, appended unconditionally after
   * the top slice. A run with more than `limit` distinct messages, one of them
   * really called "other" and frequent enough to be kept, produced TWO entries
   * with that message — and `run_error`'s
   * `UNIQUE (run_id, scope, name, message)` turned that into an aborted
   * transaction. The whole run was lost, not one mislabelled row.
   *
   * A sentinel string cannot fix that, because any string a load test can emit
   * is a string a load test can emit. The remainder is a different KIND of row,
   * so it gets a different value in the type rather than a reserved word in the
   * data — persisted as the `is_other` column, and rendered as "Other errors".
   */
  message: string | null;
  count: number;
}

export class ErrorRollup {
  #counts = new Map<string, number>();

  add(message: string): void {
    this.#counts.set(message, (this.#counts.get(message) ?? 0) + 1);
  }

  /** Retains the top `limit` messages; the remainder collapses into one row. */
  top(limit = 200): ErrorTally[] {
    const sorted: ErrorTally[] = [...this.#counts.entries()]
      .map(([message, count]) => ({ message, count }))
      .sort((a, b) => b.count - a.count || (a.message ?? '').localeCompare(b.message ?? ''));
    if (sorted.length <= limit) return sorted;
    const kept = sorted.slice(0, limit);
    const other = sorted.slice(limit).reduce((n, e) => n + e.count, 0);
    return [...kept, { message: null, count: other }];
  }
}
