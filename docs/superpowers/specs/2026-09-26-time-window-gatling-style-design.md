# Time window, Gatling-style

**Status:** approved 2026-09-26. Two mechanisms were refined while writing
the plan, the provider's anchor and where a step starts from, and both are
stated in place below. Backlog item #1 of the Gatling Enterprise comparison. Client-side
only: no backend, contract or migration change.

## The change

The run page's time window gains Gatling Enterprise's time controls: an
always-visible absolute range with presets, an Offset/Datetime mode that
relabels every single-run time axis, a navigator header that states its
resolution and duration, and six zoom and pan buttons. The existing drag
strip and the From/To fields stay.

## Why

A reader correlating a spike with their own APM, logs or deploy history needs
wall-clock time. Today every time axis reads elapsed seconds, and the one
anchor, `toolStartedAt`, reaches the browser and is shown nowhere near the
window, so lining a window up against anything external means arithmetic by
hand. The window is also drag-or-type only: nothing widens, narrows or steps
it without re-dragging.

## What Gatling does, measured rather than assumed

Observed on cloud.gatling.io against a two-minute run (17:12:09 to 17:14:09,
Asia/Calcutta) by operating each control and reading the range and the URL
after every step.

| Control | Measured behaviour |
|---|---|
| Range line | `15 Aug 2026, 17:12:09 GMT+5:30 → 15 Aug 2026, 17:14:09 GMT+5:30 │ 2m 00s ⌄`: seconds, the zone, the selection's width |
| Its menu | Last 5 Minutes, Last 15 Minutes, Last 30 Minutes, Last 1 hour, Last 1 day, Everything |
| Mode dropdown | `Offset` (the default) and `Datetime (Asia/Calcutta - GMT+5:30)` |
| Mode effect | every time axis switches between elapsed `00:00:15` and wall-clock `17:12:24`; the range line, the URL and the navigator header do not change |
| Mode persistence | survives a reload; never in the URL |
| Navigator header | `Resolution: 1s   Duration: 2m 00s`; Duration stays the whole run while the selection is 1m 00s |
| Zoom in | 17:12:09–17:14:09 became 17:12:39–17:13:39: each edge inward by 25% of the width, centre kept |
| Zoom out | 17:13:09–17:14:09 became 17:12:54–17:14:09: each edge outward by 25%, truncated at the run's end (60 s to 75 s, not slid) |
| Backward, Forward | 17:12:39–17:13:39 became 17:12:27–17:13:27: 20% of the width, width kept |
| Fast backward, Fast forward | 17:12:25–17:12:44 became 17:12:44–17:13:03: 100% of the width |
| A pan at an end | 17:12:27–17:13:27, fast back, became 17:12:09–17:13:09: slides against the end, width kept |
| Every bound | lands on a whole second, the resolution |

## Copied exactly

1. **Range line**, always visible: `<start> → <end> │ <width> ⌄`, both ends to
   the second with the viewer's zone named. It opens the preset menu.
2. **Presets**, measured back from the run's end: Last 5, 15 and 30 Minutes,
   Last 1 hour, Last 1 day, Everything. A preset at least as long as the run
   is the whole run.
3. **Mode dropdown** beside it: `Offset` (the default) and
   `Datetime (<IANA zone> - <GMT offset>)`, the offset taken at the run's own
   start so a daylight-saving zone is labelled for the run, not for today.
4. **Mode scope**: every single-run time axis. That is the navigator, the
   Charts tab, errors over time, telemetry, and the request and group
   drill-downs. Per viewer and persisted like the theme and the rail collapse;
   never in the URL, which is this repo's AC-DASH-4 line: a reading preference
   is not the question.
5. **Navigator header**: `Resolution: <bucket width>   Duration: <run>`.
6. **Six buttons**: Fast backward, Backward, Zoom out, Zoom in, Forward, Fast
   forward, named and tooltipped with those words and behaving as measured.
   Zoom moves each edge by 25% of the width (in halves it, out grows it by
   half, truncated at the ends); pan moves 20%; fast pan moves 100%; pans
   slide against the ends keeping the width.
7. **Snapping**: every interior bound is rounded to the nearest multiple of
   the resolution. A bound at either end of the run is that end exactly, so
   no step can drop the run's last partial bucket.
8. **Tick notation** `HH:MM:SS`: elapsed in Offset, wall-clock in Datetime.
   The axis pointer label, which is the tooltip's title, follows the ticks.
   Elapsed hours may exceed 24 for a long soak.
9. **Compare stays elapsed**, as Gatling's does: five runs have five wall
   clocks and no single anchor.

## Deliberate deviations

Each keeps a property this repo already relies on. A to E were approved with
the design; F was found while writing this spec and is new.

- **A. The URL keeps offset milliseconds**, not Gatling's epoch milliseconds.
  `parseWindow`, every metrics endpoint and every link already shared speak
  offsets, and the reader sees no difference.
- **B. The whole run keeps an empty URL.** Gatling writes the full range in;
  `TimeBrush.commit` deliberately drops the parameters so that a link follows
  a re-ingested run.
- **C. The From/To fields stay.** Gatling has none. Here they are the
  documented keyboard and precision path: ECharts' dataZoom is pointer-only,
  and six coarse steps cannot reach an exact 30 s to 90 s.
- **D. Chart data tables keep numeric `Elapsed (s)` columns.** They are the
  export surface; only the axis notation changes.
- **E. No anchor, no Datetime.** `RunIdentity.toolStartedAt` is
  `nullable().optional()`. When it is absent the Datetime option is shown
  disabled with its reason in visible text, axes stay elapsed, and the range
  line writes its ends as elapsed `HH:MM:SS`, there being no absolute time to
  write.
- **F. Durations use this app's `formatDuration`, not Gatling's `2m 00s`.**
  The app deliberately has two duration notations, `formatDuration` for a
  length and `formatOffset` for an offset into a run; a third on one page is
  the "one page, two vocabularies" defect this repo has fixed repeatedly. The
  navigator's Duration is `activityMs ?? durationMs`, the expression
  `RunHeader` and the live tile already compute (PR #231), so the page never
  shows two numbers under the word "Duration".

## The anchor, and why it is exact

Wall-clock time is `toolStartedAt + offsetMs`. That these share one zero was
verified, not assumed: the worker writes `toolStartedAt` from
`EngineResult.runStartedAtMs`, which is `LiveEngine.#runStartMs`, the meta
event's `startedAtMs`, and every `BucketSeries`, `ErrorSeries` and
`UserSeries` is constructed with `startMs: this.#runStartMs`. No lead-in
correction applies, unlike the `durationMs` and `activityMs` pair.

## The one number that differs, stated

The range line shows the WINDOW. For the whole run that is the series span
`[0, durationMs]`, the axis domain every chart has to cover, which begins at
the run header and so exceeds the header chip's Duration (`activityMs`, from
the first event) by the lead-in: about a second on the reference run, 63 s
against 62 s. Both are true, and neither carries the other's label. This
paragraph exists so the gap is not "fixed" by moving the window's start,
which would make the range line disagree with its own endpoints.

## How it fits this codebase

- **`routes/format.ts`** gains a seconds-precision instant formatter beside
  `formatInstant`, which has no seconds and would render both ends of a
  30-second window identically, and an `HH:MM:SS` elapsed formatter.
- **`routes/window.ts`** gains the step math as pure functions (zoom, pan,
  preset), each taking a window, the run's span and the resolution and
  returning a window, or `null` for the whole run. That file already owns
  parsing the window; stepping it is the same domain.
- **A time-axis context** carries `{ mode, anchorMs, setMode }`. Its
  provider takes the run's `toolStartedAt` as a prop, from the run read each
  page already holds (`RunShell`'s `identity`, a drill-down's
  `useRunTerminal`), so it adds no query and no observer. Until the anchor
  arrives, axes read elapsed. Outside any provider the value is
  `{ mode: 'offset', anchorMs: null }`.
- **Where it is provided.** `RunShell`, and both drill-downs, because
  `/runs/:runId/requests/:name` and `/runs/:runId/groups/:name` are siblings
  of the run route rather than children of it: a provider in `RunShell`
  alone would leave their percentile and rate charts elapsed in Datetime
  mode, with nothing saying so.
- **`Chart`** reads the context in its one `tickUnit === 'ms-as-s'` branch,
  for the ticks, the pointer label and the axis name, and lists it among the
  option effect's dependencies, without which switching mode would redraw
  nothing.
- **The axis name follows the mode** (`Elapsed`, or `Time (GMT+5:30)`),
  because `Elapsed (s)` over `00:01:15` ticks states a unit those ticks no
  longer use. The thirteen `name: 'Elapsed (s)'` literals, across seven
  components (six in `TelemetryCharts`, two in `UsersChart`, one in each of
  the rest), move into `Chart` as one definition. For five of those
  components that is their only edit; `TimeBrush` is the feature itself, and
  `CompareChart` also gains the anchor-less context below.
  `timeAxis.test.ts`'s pairing guard is re-pointed at the new definition.
- **`CompareChart`** provides an anchor-less context around itself.
- **The mode preference** uses the `theme.ts` and `ProjectRail` storage
  discipline: one key, read and written inside `try`/`catch`, and an unknown
  stored value reads as `offset`.
- **`TimeBrush` layout.** One always-visible row carries the range line and
  the mode dropdown. The timeline (navigator header, buttons, strip and
  fields) stays collapsible beneath it and still opens itself whenever a
  window is applied, which is review M01's safety property. No control sits
  inside a `<summary>`, whose descendants are presentational in the
  accessibility tree. M01's fold bound (the run totals above 900 px at
  1440x900, 649 px today) must still hold and is re-measured, not assumed.

## Edge cases

- **Buttons at their limits** are disabled: zoom in at one bucket's width;
  zoom out and every pan while the whole run is selected; backward at the
  start; forward at the end.
- **A run crossing midnight**: wall-clock ticks wrap (`23:59:50`,
  `00:00:10`), and the range line carries both dates, so the wrap is never
  ambiguous.
- **Which window a step starts from**: the requested window, the URL's,
  otherwise the whole run. Not the server's snapped window (`applied`): its
  end is `min(ceil(to / width) × width, last bucket + width)`, which can land
  a bucket short of the run's end or past it, so every "at the end" decision
  (is Forward live, where a pan slides to) would be wrong by that bucket. The
  range line still states the snapped window, as the window's header always
  has, held to the run's own span.
- **An elapsed axis never ticks finer than one second.** Zoomed to one
  bucket, ECharts would otherwise tick every 200 ms and print one `HH:MM:SS`
  five times.
- **A step that lands on the whole run** clears the URL, through the same
  rule `commit` already applies to a drag covering the whole extent.

## Testing

Unit, every case red-verified before it is trusted:

- the step math against the exact figures in the measurement table: 120 s to
  60 s centred; 60 s at the end to 75 s truncated; the 20% and 100% pans; the
  sliding clamp; rounding to the resolution; an end bound kept exact; the
  minimum width; presets shorter and longer than the run;
- the anchor: wall-clock is `toolStartedAt + offset`, including across
  midnight;
- ticks, pointer label and axis name in both modes, and Compare staying
  elapsed while the viewer's mode is Datetime;
- the preference: a round trip, a throwing `localStorage`, an unknown stored
  value;
- `TimeBrush`: the range line, the preset menu, the mode options naming the
  zone, Datetime disabled with its reason when there is no anchor, the buttons
  disabled at their limits, and the window each button commits;
- the drill-downs follow the mode.

Every case that formats wall-clock time sets `TZ` to `Asia/Kolkata`, a
non-zero and DST-free offset, and asserts the change took before asserting
anything else, because on a UTC runner an anchor defect is invisible (this
repo's timezone-test rule).

End to end: Datetime relabels the Charts tab, survives a reload and leaves the
URL untouched; zooming in from the whole run writes bounds derived from the
payload, and zooming back out clears them; a preset longer than the run clears
them; a drill-down follows the mode; Compare stays elapsed; the M01 fold bound
still holds.

Existing tests that pin seconds ticks or `Elapsed (s)` on an axis are
re-pointed at the claim, never deleted.

## Deliberately out of scope

- Typing clock times into the fields, declined in the design.
- Changing the URL encoding (deviation A).
- `CompactWindowNotice`, the one-line window notice below 768 px. No time axis
  is mounted at that width (section 22.6), so the mode has nothing to relabel
  there; restating its range in wall-clock is a follow-up, not this branch.
- The Summary and Report split, and the Report's scoped `Charts | Table`
  toggle: backlog item #7.
- Surfaces with no elapsed-time axis: Trends plots runs, and the run list has
  no time axis.
