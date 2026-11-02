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
 * A token is a run of digits with `,` grouping and an optional decimal part,
 * or one of the two compound shapes below. It passes when ANY of these holds:
 *
 * (a) AS A VALUE — with `,` removed, it equals some fact's `value` exactly, or
 *     that value rounded to 0, 1 or 2 decimals. So `1,724` and `1724` both
 *     match 1724, and `16.76`, `16.8` and `17` all match 16.7633…%. Rounding
 *     is the only transformation allowed: `2.38` is not a rounding of 2383,
 *     it is a unit conversion, and conversions are where GE went wrong. A
 *     leading zero (`01`, `007`) is no way any fact writes a number, so such
 *     a token never passes as a value.
 * (b) INSIDE A FACT'S WORDS — it lies wholly inside a span of the string that
 *     equals, verbatim, some fact's `display`, `text` or `label`. That passes
 *     the digits in a request name (`Get Product 2`), an error message
 *     (`found 401`), an assertion expression, a duration (`1h 2m 3s`) and an
 *     elapsed clock (`00:01:28`); the same digits outside that span trace to
 *     nothing and are refused.
 * (c) AS A PERCENTILE RANK — `p95` / `P95`, not glued to a word, or the
 *     ordinal `95th percentile` (`1st`, `2nd`, `3rd` as English writes them),
 *     whose rank names a `run.p*` fact.
 *
 * ═══ A NUMBER WRITTEN AS A WORD IS STILL A NUMBER ═══
 *
 * "nearly three hundred failures", "twice as slow" and "half the requests" are
 * claims a fact must carry, and no digit in them is there to check. So a
 * cardinal number word (zero to twenty, the tens, hundred, thousand, million,
 * dozen, and their plurals) and a multiplier or fraction word (twice, thrice,
 * double, triple, half, quarter, "a third") are refused, each by the word
 * as written, so the retry names it. The model is told to write every number
 * in digits. An ORDINAL ("the second request", "first") is not a quantity and
 * passes, and so does a bare "third"; "a third" or "two thirds" is a fraction
 * and does not. A word that sits inside a fact's verbatim words (rule b) — a
 * request called "Add one item", an error message saying "half" — passes,
 * exactly as digits there do. "double-" before another word ("double-check")
 * is a verb, not a multiplier.
 *
 * ═══ AN ASSERTION'S DISPLAY IS TWO PARTS ═══
 *
 * An assertion fact displays `<outcome> · <actual>` ("failed · 812 ms"), and a
 * platform assertion has no `value`: its actual exists only in that display.
 * Nobody writes the middle dot, so each ` · `-separated part of a display is a
 * span too — "failed at 812 ms" passes, "failed at 812" does not.
 *
 * ═══ A CLOCK OR A DURATION IS ONE NUMBER ═══
 *
 * An elapsed clock (`00:01:28`, any `\d+:\d+…`) and a duration in the shape
 * `formatDuration` writes (`91s`, `1m 28s`, `1h 2m 3s`) are each ONE token,
 * and only rule (b) can pass one. Read part by part they would pass by
 * coincidence: on GE's run 0, 1 and 28 are all facts, so an invented
 * `00:01:00` or `1m 28s` read as 0, 1 and 28 would sail through. A unit glued
 * to a plain number is not a duration — `321ms` is `321` and then `ms` — and
 * a decimal one (`2.38s`) is a shape `formatDuration` never writes, so it
 * stays a plain number for rule (a) to refuse. A plural status code
 * (`401s`) has a duration's shape too and is read as one; that costs nothing,
 * because a status code is never a fact's value — it passes only inside the
 * error message that carries it, exactly as before.
 *
 * A trailing `,` is the sentence's, not the number's ("Of 1,724, 289 failed"),
 * and is dropped before any rule reads the token.
 */

/** An elapsed clock: `00:01:28`, or any run of digit groups joined by `:`. */
const CLOCK = String.raw`\d+(?::\d+)+`;

/** One part of a duration, `28s`: whole units only, and not the start of a word (`ms`, `hours`). */
const DURATION_PART = String.raw`\d+[hms](?![A-Za-z])`;

/** A duration as `formatDuration` writes it: `91s`, `1m 28s`, `1h 2m 3s`. */
const DURATION = String.raw`${DURATION_PART}(?: ${DURATION_PART})*`;

/** One number the way the facts can write it: grouped, with an optional decimal part. */
const NUMBER = String.raw`\d[\d,]*(?:\.\d+)?`;

/**
 * Every token, compound shapes first so neither is read as its parts. Nothing
 * else is needed to keep a compound token from passing as a value: `Number`
 * reads `00:01:00` and `1m 28s` as NaN, which no fact's value equals.
 */
const TOKEN = new RegExp(`${CLOCK}|${DURATION}|${NUMBER}`, 'g');

/**
 * A number written as a word: cardinals, the tens, the large units and their
 * plurals, and the multipliers and fractions. Matched as whole words, case
 * folded; `double` followed by a hyphen is the verb "double-check".
 */
const NUMBER_WORD = new RegExp(
  String.raw`\b(?:` +
    [
      // First, so "one third" is refused whole rather than as "one".
      String.raw`(?:a|one)\s+third`,
      'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
      'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen',
      'nineteen', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety',
      'tens', 'hundreds?', 'thousands?', 'millions?', 'billions?', 'dozens?',
      'twice', 'thrice', 'double(?!-)', 'doubled', 'triple', 'tripled', 'quadruple', 'quadrupled',
      'half', 'halves', 'halved', 'quarters?', 'thirds',
    ].join('|') +
    String.raw`)\b`,
  'gi',
);

/** The same words, unanchored and stateless, for asking whether a string holds one. */
const HAS_NUMBER_WORD = new RegExp(NUMBER_WORD.source, 'i');

/** How many decimals a fact's value may be rounded to and still be that fact. */
const ROUNDINGS = [0, 1, 2] as const;

/** What separates an assertion display's outcome from its actual (`facts.ts`). */
const DISPLAY_PART = ' · ';

/**
 * Every string the model wrote, in the order the content holds them. Collected
 * by walking the value rather than by naming its fields, so a field the
 * content gains later is checked without anybody remembering to list it.
 */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value !== null && typeof value === 'object') for (const v of Object.values(value)) strings(v, out);
  return out;
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
 * The strings a token may sit inside; only one carrying a digit or a number
 * word can matter. A display with no ` · ` splits into itself, and no token
 * can straddle the separator, so the parts cover the whole display too.
 */
function spanStrings(facts: Fact[]): string[] {
  const out = new Set<string>();
  for (const f of facts) {
    for (const s of [...f.display.split(DISPLAY_PART), f.text, f.label]) {
      if (s !== null && (/\d/.test(s) || HAS_NUMBER_WORD.test(s))) out.add(s);
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

/**
 * Whether the token at [start, end) is written as a rank: `p` or `P` right
 * before it with no letter or digit before that (`p95`), or an ordinal suffix
 * and the word "percentile" right after it (`95th percentile`).
 */
function isRank(line: string, start: number, end: number): boolean {
  if (/^(?:st|nd|rd|th)\s+percentile\b/i.test(line.slice(end))) return true;
  const p = line[start - 1];
  if (p !== 'p' && p !== 'P') return false;
  const before = line[start - 2];
  return before === undefined || !/[A-Za-z0-9]/.test(before);
}

/**
 * The numeric tokens in `content`, as written, that trace to none of `facts`,
 * and every number written as a word outside a fact's own words: each once,
 * digits in the order they first appear in a string and then that string's
 * words. Empty means every number is a fact.
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

      if (ranges.some(([s, e]) => s <= start && end <= e)) continue;
      const bare = token.replaceAll(',', '');
      if (!/^0\d/.test(bare) && values.has(Number(bare))) continue;
      if (isRank(line, start, end) && ranks.has(token)) continue;
      refused.add(token);
    }
    for (const m of line.matchAll(NUMBER_WORD)) {
      const start = m.index;
      const end = start + m[0].length;
      if (ranges.some(([s, e]) => s <= start && end <= e)) continue;
      refused.add(m[0]);
    }
  }
  return [...refused];
}
