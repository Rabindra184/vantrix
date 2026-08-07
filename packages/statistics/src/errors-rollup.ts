export class ErrorRollup {
  #counts = new Map<string, number>();

  add(message: string): void {
    this.#counts.set(message, (this.#counts.get(message) ?? 0) + 1);
  }

  /** Retains the top `limit` messages; the remainder collapses into one `other` row. */
  top(limit = 200): { message: string; count: number }[] {
    const sorted = [...this.#counts.entries()]
      .map(([message, count]) => ({ message, count }))
      .sort((a, b) => b.count - a.count || a.message.localeCompare(b.message));
    if (sorted.length <= limit) return sorted;
    const kept = sorted.slice(0, limit);
    const other = sorted.slice(limit).reduce((n, e) => n + e.count, 0);
    return [...kept, { message: 'other', count: other }];
  }
}
