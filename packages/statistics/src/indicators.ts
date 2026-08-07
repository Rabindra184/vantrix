export interface IndicatorBands { under: number; between: number; over: number; failed: number; }

export class IndicatorCounter {
  #lower: number; #higher: number;
  #b: IndicatorBands = { under: 0, between: 0, over: 0, failed: 0 };

  constructor(opts: { lowerMs: number; higherMs: number }) {
    this.#lower = opts.lowerMs; this.#higher = opts.higherMs;
  }
  add(durationMs: number, ok: boolean): void {
    if (!ok) { this.#b.failed++; return; }
    if (durationMs < this.#lower) this.#b.under++;
    else if (durationMs < this.#higher) this.#b.between++;
    else this.#b.over++;
  }
  bands(): IndicatorBands { return { ...this.#b }; }
}

/** Warm-up requests stay in the time series but are excluded from summary stats (PRD 7.4). */
export function isWarmup(tsMs: number, runStartMs: number, warmupMs: number): boolean {
  return warmupMs > 0 && tsMs - runStartMs < warmupMs;
}
