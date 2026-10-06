import type { ActivityResponse } from '@perfportal/contracts';

type Day = ActivityResponse['days'][number];

/**
 * ═══ THE LAST SEVEN DAYS, AT A GLANCE (home page) ═══
 *
 * Seven columns, oldest to newest, one per local calendar day. A bar's height
 * is its day's share of the BUSIEST day's runs, so the tallest bar is always
 * full and a quiet week still has a shape; stacked inside it, bottom-up, are
 * the runs that finished well, the runs that need attention, and — in a third,
 * neutral colour — whatever is still in flight. The last is there so that a
 * bar's height is always its day's `total` and the colours always add up to it:
 * a bar that left the in-flight runs out would be shorter than the number it
 * claims.
 *
 * A day with no runs is HATCHED, not drawn as a zero-height bar. An empty
 * column and a column the page failed to draw look identical, and the hatch is
 * what says the first.
 *
 * ═══ THE NUMBERS ARE TEXT, AND THE BARS ARE NOT ═══
 *
 * A bar is a picture and carries no information to a screen reader, so every
 * column holds one sentence — `Tue, 6 Oct: 4 runs, 4 successful, 0 need
 * attention.` — visually hidden, and everything drawn is `aria-hidden` so the
 * column is read once. The same numbers appear in a box on hover for a
 * sighted reader with a pointer; the spec rules out a `title` ALONE, which no
 * keyboard, touch screen or screen reader reaches, so there is none.
 *
 * NOTHING IN IT IS FOCUSABLE. The bars are data, not controls, and a tab stop
 * on seven of them would be seven places a keyboard reader lands to be told
 * something the sentences already said.
 *
 * COLOURS ARE THE STATUS TOKENS, INLINE, and the text palette rather than the
 * chart-fill one: the bars are the only thing the figure shows, and
 * `--color-status-*` is gated for contrast against the card where
 * `--chart-status-*` is not. `routes/marks.tsx` and `Badge` read the same
 * values, so a failed run is the same red here as on its own row.
 *
 * The column label is the weekday, day and month in the VIEWER'S locale and
 * formatted in UTC from noon of the API's date: the date is already the
 * viewer's local calendar day, so the label has to name that day and not
 * shift it again by the zone it is printed in. Noon is the one hour no zone
 * offset can move across midnight.
 */

const PASSED = 'var(--color-status-passed)';
const FAILED = 'var(--color-status-failed)';
const NEUTRAL = 'var(--color-status-not-applicable)';

/**
 * The hatch over `--color-border`, the card's own line colour. Inline because a
 * gradient with a variable inside is not something a utility spells, and
 * `--color-border` because that is the runtime token — the Tailwind alias
 * `border-default` is a name only the utility knows.
 */
const HATCH = 'repeating-linear-gradient(135deg, var(--color-border) 0 2px, transparent 2px 7px)';

const dayLabel = (date: string): string =>
  new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(`${date}T12:00:00Z`));

const runs = (n: number): string => `${n} ${n === 1 ? 'run' : 'runs'}`;
const needs = (n: number): string => `${n} ${n === 1 ? 'needs' : 'need'} attention`;

/** The sentence a screen reader gets for one column. */
function sentence(day: Day, label: string): string {
  if (day.total === 0) return `${label}: no runs.`;
  return `${label}: ${runs(day.total)}, ${day.successful} successful, ${needs(day.needsAttention)}.`;
}

export default function Glance({ days }: { readonly days: ActivityResponse['days'] }) {
  // Zero when the whole week is empty, which divides nothing: an empty day
  // draws no bar, so the quotient below is only ever taken where `total > 0`
  // and therefore where this is too.
  const busiest = Math.max(0, ...days.map((d) => d.total));

  return (
    <figure aria-label="Runs per day" className="flex w-full min-w-0 flex-col">
      {/* `role="list"`: Tailwind's reset takes the bullets off, and Safari then
          stops announcing a bulletless list as one. */}
      <ul role="list" className="grid grid-cols-7 gap-1.5">
        {days.map((day) => {
          const label = dayLabel(day.date);
          const inFlight = day.total - day.successful - day.needsAttention;
          const segments = [
            { kind: 'successful', n: day.successful, colour: PASSED },
            { kind: 'attention', n: day.needsAttention, colour: FAILED },
            { kind: 'in-flight', n: inFlight, colour: NEUTRAL },
          ].filter((s) => s.n > 0);

          return (
            <li
              key={day.date}
              data-testid={`glance-day-${day.date}`}
              className="group relative flex min-w-0 flex-col gap-1.5"
            >
              <span className="sr-only">{sentence(day, label)}</span>

              <div aria-hidden="true" className="flex h-28 items-end">
                {day.total === 0 ? (
                  <div
                    data-testid={`glance-empty-${day.date}`}
                    className="h-full w-full rounded-sm"
                    style={{ backgroundImage: HATCH }}
                  />
                ) : (
                  <div
                    data-testid={`glance-bar-${day.date}`}
                    // `flex-col-reverse`: the first segment is the bottom of the
                    // stack, so the order below is the order a reader sees
                    // bottom-up — what finished well, then what did not.
                    className="flex w-full flex-col-reverse overflow-hidden rounded-sm"
                    style={{ height: `${(day.total / busiest) * 100}%` }}
                  >
                    {segments.map((s) => (
                      <div
                        key={s.kind}
                        data-segment={s.kind}
                        style={{ height: `${(s.n / day.total) * 100}%`, background: s.colour }}
                      />
                    ))}
                  </div>
                )}
              </div>

              <span
                aria-hidden="true"
                className="text-center text-[0.6875rem] leading-tight text-muted wrap-anywhere"
              >
                {label}
              </span>

              {/* On hover only — see the docstring on why never a `title`.
                  `pointer-events-none` so the box cannot steal the hover that
                  opened it and flicker. */}
              <div
                aria-hidden="true"
                data-testid={`glance-hover-${day.date}`}
                className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden min-w-max -translate-x-1/2 rounded-md border border-default bg-surface px-2 py-1.5 text-[0.75rem] leading-snug text-primary shadow-raised group-hover:block"
              >
                <p className="font-medium">{label}</p>
                {day.total === 0 ? (
                  <p className="text-muted">No runs</p>
                ) : (
                  <>
                    <p>{runs(day.total)}</p>
                    <p>{day.successful} successful</p>
                    <p>{needs(day.needsAttention)}</p>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </figure>
  );
}
