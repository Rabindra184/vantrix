import type { AiAnalysisContent } from '@perfportal/contracts';
import type { Fact, RunFacts } from './facts.js';

/**
 * ═══ EVERY NUMBER IN AN ANALYSIS IS ONE OF THE RUN'S FACTS ═══
 *
 * The guarantee the AI analysis rests on. Gatling Enterprise's own analysis
 * wrote "172 Place Order failures plus 170 401s" — 342, a sum no page shows,
 * offered as the cause of a run with 289 KO — and "2.38s" for a p99 of
 * 2,383 ms. Both are refused here; a figure copied as the facts write it is
 * not. The model is told to cite facts and never to do arithmetic, and this is
 * what holds it to that.
 *
 * A token is a run of digits with `,` grouping and an optional decimal part.
 * It passes when ANY of these holds:
 *
 * (a) AS A VALUE — with `,` removed, it equals some fact's `value` exactly, or
 *     that value rounded to 0, 1 or 2 decimals. So `1,724` and `1724` both
 *     match 1724, and `16.76`, `16.8` and `17` all match 16.7633…%. Rounding
 *     is the only transformation allowed: `2.38` is not a rounding of 2383,
 *     it is a unit conversion, and conversions are where GE went wrong.
 * (b) INSIDE A FACT'S WORDS — it lies wholly inside a span of the string that
 *     equals, verbatim, some fact's `display`, `text` or `label`. That passes
 *     the digits in a request name (`Get Product 2`), an error message
 *     (`found 401`), an assertion expression, a duration (`1h 2m 3s`) and an
 *     elapsed clock (`00:01:28`); the same digits outside that span trace to
 *     nothing and are refused.
 * (c) AS A PERCENTILE RANK — `p95` / `P95`, not glued to a word, whose rank
 *     names a `run.p*` fact.
 *
 * ═══ AN ASSERTION'S DISPLAY IS TWO PARTS ═══
 *
 * An assertion fact displays `<outcome> · <actual>` ("failed · 812 ms"), and a
 * platform assertion has no `value`: its actual exists only in that display.
 * Nobody writes the middle dot, so each ` · `-separated part of a display is a
 * span too — "failed at 812 ms" passes, "failed at 812" does not.
 *
 * A trailing `,` is the sentence's, not the number's ("Of 1,724, 289 failed"),
 * and is dropped before any rule reads the token.
 */

/** One number the way the facts can write it: grouped, with an optional decimal part. */
const TOKEN = /\d[\d,]*(?:\.\d+)?/g;

/** How many decimals a fact's value may be rounded to and still be that fact. */
const ROUNDINGS = [0, 1, 2] as const;

/** What separates an assertion display's outcome from its actual (`facts.ts`). */
const DISPLAY_PART = ' · ';

/** Every string the model wrote, in the order the page shows them. */
function strings(content: AiAnalysisContent): string[] {
  const { health, insights, recommendations } = content;
  return [
    health.headline,
    ...health.bullets,
    insights.headline,
    ...insights.errors,
    ...insights.assertions,
    ...insights.injectionProfile,
    ...insights.responseTimes,
    recommendations.headline,
    ...recommendations.bullets,
  ];
}

/** Every number a fact's value may be written as: itself, and rounded to 0, 1 or 2 decimals. */
function valueForms(facts: Fact[]): Set<number> {
  const forms = new Set<number>();
  for (const f of facts) {
    if (f.value === null || !Number.isFinite(f.value)) continue;
    forms.add(f.value);
    for (const d of ROUNDINGS) forms.add(Number(f.value.toFixed(d)));
  }
  return forms;
}

/**
 * The strings a token may sit inside; only one carrying a digit can matter. A
 * display with no ` · ` splits into itself, and no token can straddle the
 * separator, so the parts cover the whole display too.
 */
function spanStrings(facts: Fact[]): string[] {
  const out = new Set<string>();
  for (const f of facts) {
    for (const s of [...f.display.split(DISPLAY_PART), f.text, f.label]) {
      if (s !== null && /\d/.test(s)) out.add(s);
    }
  }
  return [...out];
}

/** Every [start, end) range of `line` equal to one of `spans`, overlapping occurrences included. */
function coveredRanges(line: string, spans: string[]): [number, number][] {
  const ranges: [number, number][] = [];
  for (const s of spans) {
    for (let at = line.indexOf(s); at !== -1; at = line.indexOf(s, at + 1)) ranges.push([at, at + s.length]);
  }
  return ranges;
}

/** The ranks the facts state a run percentile for: `run.p95` gives `95`. */
function percentileRanks(facts: Fact[]): Set<string> {
  const ranks = new Set<string>();
  for (const f of facts) {
    const m = /^run\.p(\d+)$/.exec(f.id);
    if (m?.[1] !== undefined) ranks.add(m[1]);
  }
  return ranks;
}

/** Whether the token at `start` is written as a rank: `p` or `P` right before it, and no letter or digit before that. */
function isRankPrefixed(line: string, start: number): boolean {
  const p = line[start - 1];
  if (p !== 'p' && p !== 'P') return false;
  const before = line[start - 2];
  return before === undefined || !/[A-Za-z0-9]/.test(before);
}

/**
 * The numeric tokens in `content`, as written, that trace to none of `facts`:
 * each once, in the order it first appears. Empty means every number is a fact.
 */
export function checkNumbers(content: AiAnalysisContent, facts: RunFacts): string[] {
  const values = valueForms(facts.facts);
  const spans = spanStrings(facts.facts);
  const ranks = percentileRanks(facts.facts);
  const refused = new Set<string>();

  for (const line of strings(content)) {
    const ranges = coveredRanges(line, spans);
    for (const m of line.matchAll(TOKEN)) {
      const token = m[0].replace(/,+$/, '');
      const start = m.index;
      const end = start + token.length;

      if (values.has(Number(token.replaceAll(',', '')))) continue;
      if (ranges.some(([s, e]) => s <= start && end <= e)) continue;
      if (isRankPrefixed(line, start) && ranks.has(token)) continue;
      refused.add(token);
    }
  }
  return [...refused];
}
