# Load-generator telemetry agent — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** answer "was the load generator itself the bottleneck?" by running a
small Go daemon on the generators, storing its raw counters, and drawing them
on the run's own elapsed-time axis beside every other chart.

**Architecture:** a static Go binary samples `gopsutil` on a fixed interval and
POSTs **raw cumulative counters** in batches to `POST /v1/telemetry` under a new
`telemetry` scope. The agent never knows about runs; a run selects the samples
whose wall-clock timestamps fall inside `[toolStartedAt, toolStartedAt +
durationMs]`. `GET /v1/runs/:id/telemetry` converts each sample's wall clock
into an elapsed offset, differences consecutive counters into rates, and buckets
them at the run's own `bucketWidthMs` — which is what makes the charts inherit
the shared crosshair and the `?from=&to=` window for free.

**Tech Stack:** Go 1.24 + `gopsutil/v4` (agent); TypeScript — Zod contracts,
NestJS, raw `pg` on a date-partitioned table, React + ECharts (server and web).

**Spec:** [`docs/superpowers/specs/2026-08-16-load-generator-telemetry-agent-design.md`](../specs/2026-08-16-load-generator-telemetry-agent-design.md)

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Node 22 (`.nvmrc` = 22.19.0). `nvm use` FIRST.** On Node 20 jsdom 30's
  undici lacks `webidl.util.markAsUncloneable` and every DOM-environment test
  file throws while LOADING; Vitest prints a confident green `Test Files N
  passed` above a separate `Errors` line. A run reporting fewer than **78 files
  / 904 tests** did not run everything.
- **The full gate, in this order — integration BEFORE e2e:**
  `pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration && pnpm test:e2e`.
  Reversing the last two truncates every table underneath a still-draining
  Playwright worker and produces a bare `exit 1` with no failing assertion.
- **This plan adds a second gate command: `cd agent && go test ./...`.** Task 1
  adds it to `CLAUDE.md`'s Verification section and to CI as its own job.
- **Expectations are computed from the payload, never written down.** A test
  that hard-codes a value the fixture supplies breaks on the next re-capture
  for a reason that is not a defect.
- **`getByRole(role, { name })` is EXACT in Testing Library and a
  case-insensitive SUBSTRING in Playwright.** Pass `exact: true` in every
  Playwright role query in this plan. `ProjectRail` puts N project links in
  every authenticated document, so a bare `getByRole('link', { name })` can be
  satisfied by a rail row.
- **Never `uppercase` on anything queried by accessible name.** Playwright
  applies `text-transform` when computing a name; jsdom does not, so the unit
  suite stays green while the e2e assertion stops resolving.
- **A token not declared in `@theme` produces NO utility, silently.** Tailwind
  v4 generates utilities only from `@theme`, never from a bare `:root` custom
  property.
- **No decorative `<svg>` inside a chart `<figure>`.** `Chart` renders its data
  table inside the figure and nine specs prove a chart drew by counting SVG
  elements within it.
- **The agent NEVER sends `orgId` or `projectId`.** They are columns on the row
  and they come from the TOKEN. A payload-supplied tenant would let a token for
  one project write telemetry into another, from a load generator — a far
  easier machine to reach than the API.
- **Counters are stored and transmitted RAW.** Never a rate the agent computed.
  A pre-computed rate turns a counter reset into a plausible enormous spike
  that is indistinguishable from a real traffic burst.

### One spec contradiction, resolved here

Spec §4 states the **server** does the counter arithmetic, and §3's schema
stores raw counters — but §8's testing table assigns "counter deltas across a
reset produce a skipped interval" and "CPU percentages derive from Δbusy/Δtotal"
to the **Agent (Go)** layer.

**§4 is normative; §8's Agent row is misattributed.** All delta and rate
arithmetic lives in `packages/statistics/src/telemetry.ts` (Task 8), tested
there. The agent's own Go tests cover what the agent actually does: sample,
buffer, batch, send (Tasks 2–5). Writing the arithmetic in both places would
give two implementations of reset detection that can disagree, which is worse
than either.

### Constants introduced by this plan

| Constant | Value | Where | Why |
|---|---|---|---|
| `DEFAULT_INTERVAL` | `1s` | agent | Gatling's own cadence |
| `BATCH_SAMPLES` | `30` | agent | at 1 s, `BATCH_WINDOW` fires first — one request per 10 s carrying ~10 samples; the 30-sample bound only binds below a 1/3 s interval |
| `BATCH_WINDOW` | `10s` | agent | a crash loses at most ten seconds |
| `BUFFER_BATCHES` | `64` | agent | bounded; ~32 min of history at the above |
| `TELEMETRY_LOOKBACK_MS` | `60_000` | persistence | gives the first in-run bucket a predecessor to difference against |
| `CLOCK_SKEW_WARN_MS` | `5_000` | contracts | above this the UI warns rather than quietly misaligning |

---

## File Structure

**New, outside the pnpm workspace** (`pnpm-workspace.yaml` globs only
`packages/*` and `apps/*`, so a top-level `agent/` is invisible to pnpm, to
`tsc -b`'s project references, and to ESLint's TS-only file matchers):

- `agent/go.mod`, `agent/go.sum` — module `github.com/Rabindra184/vantrix/agent`
- `agent/version.go`, `agent/version_test.go` — the toolchain's smoke test
- `agent/internal/buffer/buffer.go` + `_test.go` — bounded drop-oldest ring
- `agent/internal/collect/collect.go` + `_test.go` — one `Sample()`, gopsutil
- `agent/internal/send/send.go` + `_test.go` — batching and POST
- `agent/cmd/perfportal-agent/main.go` — flags and the sampling loop
- `agent/footprint_test.go` — the §5 budget, measured

**New in the TypeScript tree:**

- `packages/persistence/prisma/migrations/20260817090000_telemetry_sample/migration.sql`
- `packages/persistence/src/metrics/telemetry.ts` — `TelemetryWriter`, `TelemetryReader`, `TELEMETRY_WINDOW_SQL`
- `packages/statistics/src/telemetry.ts` — the delta/rate/bucket arithmetic
- `apps/api/src/telemetry/telemetry.controller.ts`, `telemetry.module.ts`
- `apps/web/src/charts/transforms/telemetry.ts`
- `apps/web/src/charts/TelemetryCharts.tsx`
- `apps/web/src/routes/RunTelemetry.tsx`

**Modified:** `.github/workflows/ci.yml`, `CLAUDE.md`, `.gitignore`,
`packages/contracts/src/metrics.ts`, `packages/persistence/src/{index.ts,client.ts}`,
`packages/statistics/src/index.ts`, `apps/api/src/auth/{scopes.decorator.ts,auth.middleware.ts}`,
`apps/api/src/app.module.ts`, `apps/api/src/metrics/metrics.controller.ts`,
`apps/api/src/openapi/document.ts`, `apps/api/test/support/app.ts`,
`apps/web/src/{App.tsx,api/metrics.ts,routes/paths.ts,routes/RunTabs.tsx}`,
`apps/web/e2e/fixtures.ts`.

---

## Task 1: The Go toolchain

Spec §9 and §9b step 1. **First, not last** — this is more novel process than
the agent's logic, and discovering the toolchain story at the end of a
sub-project is how the last one lost an afternoon.

**Files:**
- Create: `agent/go.mod`, `agent/version.go`, `agent/version_test.go`, `agent/.gitignore`
- Modify: `.github/workflows/ci.yml`, `.gitignore`, `CLAUDE.md`

**Interfaces:**
- Consumes: nothing.
- Produces: a Go module at `agent/`, module path
  `github.com/Rabindra184/vantrix/agent`, that `go build ./...`, `go vet ./...`
  and `go test ./...` all succeed against, locally and in CI.

- [ ] **Step 1: Create the module**

```bash
mkdir -p agent && cd agent && go mod init github.com/Rabindra184/vantrix/agent
```

Then edit `agent/go.mod` so the `go` directive is exactly `go 1.24` (not
`1.24.3` — `actions/setup-go`'s `go-version-file` reads this line and a patch
version pins CI to one patch release that may be delisted).

- [ ] **Step 2: Write the failing test**

`agent/version_test.go`:

```go
package agent

import (
	"strings"
	"testing"
)

// The toolchain's smoke test: it exists so `go test ./...` has something to
// run before any metric is collected, and so a broken CI Go step fails on this
// rather than on the first real sampler.
func TestUserAgentIdentifiesTheBinaryAndVersion(t *testing.T) {
	ua := UserAgent()
	if !strings.HasPrefix(ua, "perfportal-agent/") {
		t.Fatalf("UserAgent() = %q, want a perfportal-agent/ prefix", ua)
	}
	if !strings.HasSuffix(ua, Version) {
		t.Fatalf("UserAgent() = %q, want it to end with Version %q", ua, Version)
	}
}
```

- [ ] **Step 3: Run it to verify it fails**

```bash
cd agent && go test ./...
```

Expected: FAIL — `undefined: UserAgent`, `undefined: Version`.

- [ ] **Step 4: Write the minimal implementation**

`agent/version.go`:

```go
// Package agent is the root of the PerfPortal load-generator telemetry agent.
//
// It lives OUTSIDE the pnpm workspace on purpose: pnpm-workspace.yaml globs
// only `packages/*` and `apps/*`, so nothing here is a workspace member, no
// tsconfig project reference reaches it, and ESLint's TypeScript file matchers
// never see it. `cd agent && go test ./...` is its own gate command — see
// CLAUDE.md's Verification section.
package agent

// Version is stamped into the User-Agent so a server log can tell which agent
// build produced a sample. Bumped by hand; the agent deliberately does not
// self-update (spec §10 — a binary that rewrites itself on a load generator
// mid-test is a way to invalidate a run).
const Version = "0.1.0"

// UserAgent is sent on every telemetry POST.
func UserAgent() string { return "perfportal-agent/" + Version }
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd agent && go test ./... && go vet ./... && go build ./...
```

Expected: `ok  github.com/Rabindra184/vantrix/agent`, then two silent successes.

- [ ] **Step 6: Keep built binaries out of git**

`agent/.gitignore`:

```gitignore
/dist/
/perfportal-agent
```

- [ ] **Step 7: Add the CI job**

In `.github/workflows/ci.yml`, add a **second job** alongside `build` (not a
step inside it). It needs no Postgres, Redis or MinIO, so as its own job it
runs in parallel and a Go failure reports in under a minute instead of behind
the whole Node gate:

```yaml
  agent:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: agent

    steps:
      - uses: actions/checkout@v4
      # `go-version-file: agent/go.mod` rather than a literal: the `go`
      # directive in that file is the single source of truth for the toolchain,
      # exactly as .nvmrc is for Node. A literal here drifts silently.
      - uses: actions/setup-go@v5
        with:
          go-version-file: agent/go.mod
          cache-dependency-path: agent/go.sum

      - run: go vet ./...
      - run: go test ./... -race

      # Cross-compiled for the platforms load generators actually run on
      # (spec §9). linux/amd64 and linux/arm64 at minimum; CGO_ENABLED=0 so the
      # result is a single static binary with no glibc floor, which is what
      # makes "copy it onto the box" a real distribution story.
      - run: GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o dist/perfportal-agent-linux-amd64 ./cmd/perfportal-agent
      - run: GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -o dist/perfportal-agent-linux-arm64 ./cmd/perfportal-agent
      - run: cd dist && sha256sum * > SHA256SUMS && cat SHA256SUMS

      - uses: actions/upload-artifact@v4
        with:
          name: perfportal-agent
          path: agent/dist/
```

Note: `./cmd/perfportal-agent` does not exist until Task 4. Until then the two
`go build` lines fail. **Add the `go vet` / `go test` steps in this task and
add the three build/checksum/upload steps in Task 4**, where the main package
lands — a CI file that is red for three tasks teaches everyone to ignore it.

- [ ] **Step 8: Record the new gate command**

In `CLAUDE.md`, under `## Verification`, after the `pnpm typecheck && …` block,
add:

```markdown
**There is now a second gate, and `pnpm` does not run it.** The load-generator
telemetry agent is Go, lives at `agent/`, and is outside the pnpm workspace —
so `pnpm lint`, `pnpm typecheck` and every `pnpm test:*` are all blind to it:

```
cd agent && go vet ./... && go test ./... -race
```

`-race` is not optional here. The agent's whole design is a sampler goroutine
writing to a bounded buffer a sender goroutine drains; a data race in that pair
is the one defect class its tests exist to catch, and the race detector is what
makes those tests able to catch it.
```

- [ ] **Step 9: Commit**

```bash
git add agent .gitignore .github/workflows/ci.yml CLAUDE.md
git commit -m "build(agent): a Go module that builds and tests in CI, before any metric is collected"
```

---

## Task 2: The bounded buffer

Spec §5 — "Bounded buffer, drop-oldest. It never grows memory, and it never
blocks the sampler on the sender." The one thing a measurement tool may not do
is change what it measures.

**Files:**
- Create: `agent/internal/buffer/buffer.go`, `agent/internal/buffer/buffer_test.go`

**Interfaces:**
- Consumes: Task 1's module.
- Produces: `buffer.Ring[T any]` with `New[T](capacity int) *Ring[T]`,
  `(*Ring[T]).Push(v T)`, `(*Ring[T]).DrainUpTo(n int) []T`,
  `(*Ring[T]).Len() int`, `(*Ring[T]).Dropped() uint64`. Task 4 instantiates it
  as `*buffer.Ring[collect.Sample]`.

- [ ] **Step 1: Write the failing tests**

`agent/internal/buffer/buffer_test.go`:

```go
package buffer

import (
	"sync"
	"testing"
)

func TestPushBeyondCapacityDropsTheOldest(t *testing.T) {
	r := New[int](3)
	for i := 1; i <= 5; i++ {
		r.Push(i)
	}

	if got := r.Len(); got != 3 {
		t.Fatalf("Len() = %d, want the capacity 3 — the buffer grew", got)
	}
	if got := r.Dropped(); got != 2 {
		t.Fatalf("Dropped() = %d, want 2", got)
	}

	// 1 and 2 are gone, NOT 4 and 5. Dropping the newest would throw away the
	// only samples that describe the outage the agent is currently living
	// through, which is the interesting part of the history.
	got := r.DrainUpTo(10)
	want := []int{3, 4, 5}
	if len(got) != len(want) {
		t.Fatalf("DrainUpTo() = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("DrainUpTo() = %v, want %v (oldest first)", got, want)
		}
	}
}

func TestDrainUpToTakesAtMostNAndLeavesTheRest(t *testing.T) {
	r := New[int](8)
	for i := 1; i <= 5; i++ {
		r.Push(i)
	}

	first := r.DrainUpTo(2)
	if len(first) != 2 || first[0] != 1 || first[1] != 2 {
		t.Fatalf("DrainUpTo(2) = %v, want [1 2]", first)
	}
	if got := r.Len(); got != 3 {
		t.Fatalf("Len() = %d after draining 2 of 5, want 3", got)
	}

	rest := r.DrainUpTo(99)
	if len(rest) != 3 || rest[0] != 3 {
		t.Fatalf("DrainUpTo(99) = %v, want [3 4 5]", rest)
	}
	if got := r.Len(); got != 0 {
		t.Fatalf("Len() = %d after draining everything, want 0", got)
	}
}

func TestDrainOnEmptyReturnsEmptyRatherThanBlocking(t *testing.T) {
	r := New[int](4)
	if got := r.DrainUpTo(10); len(got) != 0 {
		t.Fatalf("DrainUpTo() on an empty ring = %v, want empty", got)
	}
}

// Run under -race. The sampler goroutine pushes while the sender goroutine
// drains, forever; this is the pair whose data race would be invisible in
// production and would corrupt the very numbers the agent exists to report.
func TestConcurrentPushAndDrainNeverExceedCapacity(t *testing.T) {
	const capacity = 16
	r := New[int](capacity)

	var wg sync.WaitGroup
	wg.Add(2)

	go func() {
		defer wg.Done()
		for i := 0; i < 10_000; i++ {
			r.Push(i)
			if n := r.Len(); n > capacity {
				t.Errorf("Len() = %d, above capacity %d", n, capacity)
				return
			}
		}
	}()

	go func() {
		defer wg.Done()
		for i := 0; i < 10_000; i++ {
			r.DrainUpTo(4)
		}
	}()

	wg.Wait()
}
```

- [ ] **Step 2: Run them to verify they fail**

```bash
cd agent && go test ./internal/buffer/... -race
```

Expected: FAIL to build — `undefined: New`.

- [ ] **Step 3: Write the implementation**

`agent/internal/buffer/buffer.go`:

```go
// Package buffer holds the agent's one piece of back-pressure policy.
package buffer

import "sync"

// Ring is a fixed-capacity FIFO that DROPS THE OLDEST element when full.
//
// Drop-oldest, not drop-newest, and not block. Blocking would couple the
// sampler's cadence to the network — an outage would stretch the sampling
// interval and every rate the server later derives would be wrong by exactly
// that stretch, with nothing on the chart looking off. Drop-newest would
// discard the samples describing the outage the agent is currently living
// through, which is the interesting part of the history.
//
// Every method takes the mutex: a sampler goroutine Pushes while a sender
// goroutine Drains, and that pair is exactly what `go test -race` exists to
// police here.
type Ring[T any] struct {
	mu      sync.Mutex
	items   []T
	head    int // index of the oldest element
	len     int
	dropped uint64
}

// New returns an empty Ring. A capacity below 1 is raised to 1 rather than
// panicking: a misconfigured buffer must not take the agent down on a load
// generator mid-test.
func New[T any](capacity int) *Ring[T] {
	if capacity < 1 {
		capacity = 1
	}
	return &Ring[T]{items: make([]T, capacity)}
}

// Push appends v, evicting the oldest element if the ring is full. It never
// blocks and never allocates after construction.
func (r *Ring[T]) Push(v T) {
	r.mu.Lock()
	defer r.mu.Unlock()

	capacity := len(r.items)
	if r.len == capacity {
		// Full: overwrite the oldest and advance head past it.
		r.items[r.head] = v
		r.head = (r.head + 1) % capacity
		r.dropped++
		return
	}
	r.items[(r.head+r.len)%capacity] = v
	r.len++
}

// DrainUpTo removes and returns at most n elements, oldest first. Returns an
// empty (non-nil) slice when the ring is empty — the sender treats "nothing to
// send" as an ordinary tick, not an error.
func (r *Ring[T]) DrainUpTo(n int) []T {
	r.mu.Lock()
	defer r.mu.Unlock()

	if n > r.len {
		n = r.len
	}
	out := make([]T, 0, n)
	capacity := len(r.items)
	for i := 0; i < n; i++ {
		out = append(out, r.items[r.head])
		var zero T
		// Zeroed so a drained element cannot keep anything it referenced
		// alive; Sample carries a map, so this is not academic.
		r.items[r.head] = zero
		r.head = (r.head + 1) % capacity
	}
	r.len -= n
	return out
}

// Len is the number of elements currently buffered.
func (r *Ring[T]) Len() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.len
}

// Dropped is the lifetime count of elements evicted by Push. Reported in the
// agent's own log so a persistent outage is visible as data loss rather than
// as a quietly shorter history.
func (r *Ring[T]) Dropped() uint64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.dropped
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd agent && go test ./internal/buffer/... -race -v
```

Expected: PASS, four tests.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/buffer
git commit -m "feat(agent): a bounded buffer that drops the oldest, never the newest, and never blocks"
```

---

## Task 3: The collector

Spec §1's chart-by-chart mapping, made real. One `Sample()` that reads every
source and blocks on none of them.

**Files:**
- Create: `agent/internal/collect/collect.go`, `agent/internal/collect/collect_test.go`
- Modify: `agent/go.mod`, `agent/go.sum` (adds `gopsutil/v4`)

**Interfaces:**
- Consumes: Task 1's module.
- Produces: `collect.Sample` (the struct below, with JSON tags matching Task 7's
  Zod contract exactly) and `collect.New() *Collector` /
  `(*Collector).Sample(ctx context.Context) (Sample, error)`. Task 4 calls
  `Sample` on a ticker; Task 5 measures it.

### The portability trap this task must handle

**`net.ProtoCounters` is Linux-only.** On darwin gopsutil returns
`common.ErrNotImplementedError`, and the machine this repo is developed on is
macOS. Spec §10 puts non-Linux generators out of scope and calls macOS "a
convenience for developers, not a target" — so the collector must **degrade**
(leave those six counters zero, report once) rather than fail, and the test that
asserts on them must be `runtime.GOOS == "linux"`-gated. CI runs
`ubuntu-latest`, so the gated assertion still runs where it matters. A test that
asserted unconditionally would be red on every developer machine and would be
disabled within a week.

`cpu.Times().Iowait` is likewise always 0 on darwin. Do not assert it is
positive.

- [ ] **Step 1: Add the dependency**

```bash
cd agent && go get github.com/shirou/gopsutil/v4@latest && go mod tidy
```

- [ ] **Step 2: Write the failing tests**

`agent/internal/collect/collect_test.go`:

```go
package collect

import (
	"context"
	"runtime"
	"testing"
	"time"
)

func TestSampleReadsGaugesAndCumulativeCounters(t *testing.T) {
	s, err := New().Sample(context.Background())
	if err != nil {
		t.Fatalf("Sample() error = %v", err)
	}

	if s.SampledAt.IsZero() {
		t.Fatal("SampledAt is zero — every row is keyed on it")
	}
	// Gauges. Total memory is the one value that is non-zero on every platform
	// this could ever run on, so it is the honest smoke test.
	if s.MemTotalBytes <= 0 {
		t.Fatalf("MemTotalBytes = %d, want > 0", s.MemTotalBytes)
	}
	if s.MemUsedBytes <= 0 || s.MemUsedBytes > s.MemTotalBytes {
		t.Fatalf("MemUsedBytes = %d, want 0 < used <= total (%d)", s.MemUsedBytes, s.MemTotalBytes)
	}
	// CPU time since boot. Idle alone is guaranteed positive on a machine that
	// has been up long enough to run a test; user/system are too, but idle is
	// the one that cannot plausibly be zero.
	if s.CPUIdleMs <= 0 {
		t.Fatalf("CPUIdleMs = %d, want > 0", s.CPUIdleMs)
	}
	if s.TCPStates == nil {
		t.Fatal("TCPStates is nil — absent-when-zero means an empty map, not a nil one")
	}
}

// LINUX ONLY. net.ProtoCounters returns common.ErrNotImplementedError on
// darwin, and spec §10 puts non-Linux generators out of scope. CI is
// ubuntu-latest, so this assertion runs exactly where the agent is meant to.
func TestProtoCountersPopulateTheTCPSegmentSeriesOnLinux(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skipf("net.ProtoCounters is not implemented on %s; spec §10", runtime.GOOS)
	}
	s, err := New().Sample(context.Background())
	if err != nil {
		t.Fatalf("Sample() error = %v", err)
	}
	// The four series Gatling's "TCP Segment Events per Second" chart draws.
	// InSegs and OutSegs are non-zero on any machine that has ever used the
	// network; RetransSegs and InErrs are legitimately zero on a healthy host,
	// so they are checked for presence via the pair above rather than asserted
	// positive.
	if s.TCPInSegs <= 0 || s.TCPOutSegs <= 0 {
		t.Fatalf("TCPInSegs = %d, TCPOutSegs = %d, want both > 0", s.TCPInSegs, s.TCPOutSegs)
	}
	if s.TCPActiveOpens <= 0 {
		t.Fatalf("TCPActiveOpens = %d, want > 0", s.TCPActiveOpens)
	}
}

func TestDegradesRatherThanFailingWhereProtoCountersAreUnavailable(t *testing.T) {
	if runtime.GOOS == "linux" {
		t.Skip("this asserts the DEGRADED path, which linux does not take")
	}
	// The whole point: on a platform with no ProtoCounters, Sample still
	// returns a usable sample rather than an error, so a developer on macOS
	// gets CPU, memory, bandwidth and connection states.
	s, err := New().Sample(context.Background())
	if err != nil {
		t.Fatalf("Sample() error = %v, want a degraded sample and no error", err)
	}
	if s.MemTotalBytes <= 0 {
		t.Fatal("the degraded path dropped the gauges too")
	}
}

// SAMPLING MUST NOT SLEEP. cpu.Percent(d, …) blocks for d, which would make
// the agent pause inside the measurement it is taking (spec §4). Nothing in
// Sample may do that. The budget is generous because net.Connections walks the
// kernel's socket table and is the slowest call here — if this ever fails, the
// lever is to sample connection states on a slower cadence than the rest, not
// to raise the bound.
func TestSampleDoesNotBlockForAnInterval(t *testing.T) {
	c := New()
	start := time.Now()
	if _, err := c.Sample(context.Background()); err != nil {
		t.Fatalf("Sample() error = %v", err)
	}
	if elapsed := time.Since(start); elapsed > 500*time.Millisecond {
		t.Fatalf("Sample() took %s, want < 500ms — something in it is sleeping", elapsed)
	}
}
```

- [ ] **Step 3: Run them to verify they fail**

```bash
cd agent && go test ./internal/collect/... -race
```

Expected: FAIL to build — `undefined: New`.

- [ ] **Step 4: Write the implementation**

`agent/internal/collect/collect.go`:

```go
// Package collect turns one instant of host state into one Sample.
//
// EVERY CUMULATIVE VALUE IS THE RAW COUNTER, never a rate. Spec §4: the
// sampling interval is the agent's and it drifts, so a rate computed against an
// assumed interval is wrong by exactly that drift — and, decisively, a counter
// reset is detectable in raw values (current < previous) and invisible in a
// pre-computed rate, where it arrives as a plausible enormous spike a reader
// would believe. The arithmetic happens server-side, in
// packages/statistics/src/telemetry.ts.
package collect

import (
	"context"
	"sync/atomic"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/mem"
	"github.com/shirou/gopsutil/v4/net"
)

// Sample is one instant of host state. The JSON tags are the wire format and
// must stay identical to TelemetrySampleSchema in packages/contracts.
//
// IT CARRIES NO orgId OR projectId. Spec §2: those are columns on the stored
// row and they come from the TOKEN. An agent runs on a load generator, which is
// a machine an attacker is far likelier to reach than the API; a
// payload-supplied tenant would let a token for one project write telemetry
// into another, and the read path would serve it without a murmur.
type Sample struct {
	SampledAt time.Time `json:"sampledAt"`

	// CPU time since boot, in milliseconds. From cpu.Times, NEVER cpu.Percent
	// — see the package comment and TestSampleDoesNotBlockForAnInterval.
	CPUUserMs   int64 `json:"cpuUserMs"`
	CPUSystemMs int64 `json:"cpuSystemMs"`
	CPUIdleMs   int64 `json:"cpuIdleMs"`
	CPUIowaitMs int64 `json:"cpuIowaitMs"`

	// Gauges, as read.
	MemUsedBytes  int64 `json:"memUsedBytes"`
	MemTotalBytes int64 `json:"memTotalBytes"`

	// Bandwidth, cumulative.
	NetRxBytes int64 `json:"netRxBytes"`
	NetTxBytes int64 `json:"netTxBytes"`

	// The MIB-II TCP counters. These are Gatling's own "TCP Segment Events per
	// Second" (InSegs/OutSegs/RetransSegs/InErrs) and "TCP Connections Events
	// per Second" (ActiveOpens/PassiveOpens) series, one-to-one — which is
	// what turns a CPU chart into parity with a section. LINUX ONLY: zero
	// everywhere else, see errProtoUnavailable below.
	TCPInSegs       int64 `json:"tcpInSegs"`
	TCPOutSegs      int64 `json:"tcpOutSegs"`
	TCPRetransSegs  int64 `json:"tcpRetransSegs"`
	TCPInErrs       int64 `json:"tcpInErrs"`
	TCPActiveOpens  int64 `json:"tcpActiveOpens"`
	TCPPassiveOpens int64 `json:"tcpPassiveOpens"`

	// Connection counts by kernel TCP state, absent when zero — e.g.
	// {"ESTABLISHED": 412, "TIME_WAIT": 88}. A map rather than columns because
	// the state set is the kernel's, not ours.
	TCPStates map[string]int `json:"tcpStates"`
}

// Collector reads host state. Safe for concurrent use; the agent uses one.
type Collector struct {
	// Set once, the first time ProtoCounters is unavailable, so the warning is
	// logged once rather than once a second forever (spec §5, "failure is
	// silent and cheap").
	protoUnavailable atomic.Bool
}

// New returns a Collector.
func New() *Collector { return &Collector{} }

// ProtoUnavailable reports whether TCP protocol counters were unavailable on
// this host. main uses it to log the degradation exactly once.
func (c *Collector) ProtoUnavailable() bool { return c.protoUnavailable.Load() }

// Sample reads every source once.
//
// It returns an error only when a source that exists on EVERY platform fails
// — CPU times or memory. A missing net.ProtoCounters (darwin, windows) leaves
// those six counters zero and sets protoUnavailable, because a developer on
// macOS should still get CPU, memory, bandwidth and connection states rather
// than nothing at all.
func (c *Collector) Sample(ctx context.Context) (Sample, error) {
	now := time.Now().UTC()

	// `false` = aggregated across all cores, one entry. Gatling's chart is
	// Total/User/Sys for the host, not per-core.
	times, err := cpu.TimesWithContext(ctx, false)
	if err != nil {
		return Sample{}, err
	}
	if len(times) == 0 {
		return Sample{}, errNoCPUTimes
	}
	vm, err := mem.VirtualMemoryWithContext(ctx)
	if err != nil {
		return Sample{}, err
	}

	s := Sample{
		SampledAt: now,
		// gopsutil reports these as float64 SECONDS since boot. Milliseconds
		// on the wire because the column is BIGINT and a float would make
		// "current < previous" a floating-point comparison.
		CPUUserMs:     secondsToMs(times[0].User),
		CPUSystemMs:   secondsToMs(times[0].System),
		CPUIdleMs:     secondsToMs(times[0].Idle),
		CPUIowaitMs:   secondsToMs(times[0].Iowait), // always 0 on darwin
		MemUsedBytes:  int64(vm.Used),
		MemTotalBytes: int64(vm.Total),
		TCPStates:     map[string]int{},
	}

	// `false` = summed across every interface. A per-interface breakdown is
	// not a chart Gatling draws, and summing here keeps the row narrow.
	if io, err := net.IOCountersWithContext(ctx, false); err == nil && len(io) > 0 {
		s.NetRxBytes = int64(io[0].BytesRecv)
		s.NetTxBytes = int64(io[0].BytesSent)
	}

	if protos, err := net.ProtoCountersWithContext(ctx, []string{"tcp"}); err == nil && len(protos) > 0 {
		st := protos[0].Stats
		s.TCPInSegs = st["InSegs"]
		s.TCPOutSegs = st["OutSegs"]
		s.TCPRetransSegs = st["RetransSegs"]
		s.TCPInErrs = st["InErrs"]
		s.TCPActiveOpens = st["ActiveOpens"]
		s.TCPPassiveOpens = st["PassiveOpens"]
	} else {
		c.protoUnavailable.Store(true)
	}

	if conns, err := net.ConnectionsWithContext(ctx, "tcp"); err == nil {
		for _, conn := range conns {
			if conn.Status == "" {
				continue
			}
			s.TCPStates[conn.Status]++
		}
	}

	return s, nil
}

func secondsToMs(seconds float64) int64 { return int64(seconds * 1000) }

type collectError string

func (e collectError) Error() string { return string(e) }

const errNoCPUTimes = collectError("cpu.Times returned no entries")
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd agent && go test ./internal/collect/... -race -v
```

Expected: PASS. On macOS,
`TestProtoCountersPopulateTheTCPSegmentSeriesOnLinux` **SKIPs** and
`TestDegradesRatherThanFailingWhereProtoCountersAreUnavailable` runs; on Linux
the reverse. Confirm the skip line actually prints — a skip that never appears
means the gate is wrong.

- [ ] **Step 6: Commit**

```bash
git add agent/internal/collect agent/go.mod agent/go.sum
git commit -m "feat(agent): one Sample() reading raw counters, degrading where ProtoCounters is not implemented"
```

---

## Task 4: The sender, and the binary

Spec §5. Batching, silent cheap failure, and the flags.

**Files:**
- Create: `agent/internal/send/send.go`, `agent/internal/send/send_test.go`, `agent/cmd/perfportal-agent/main.go`
- Modify: `.github/workflows/ci.yml` (the three build/checksum/upload steps deferred from Task 1)

**Interfaces:**
- Consumes: `agent.UserAgent()` (Task 1), `buffer.Ring[collect.Sample]` (Task 2),
  `collect.Sample` / `collect.New()` (Task 3).
- Produces: `send.New(endpoint, token, hostLabel string, http *http.Client) *Client`
  and `(*Client).Post(ctx context.Context, samples []collect.Sample) error`;
  a `perfportal-agent` binary. Task 5 drives the same loop; Task 7's endpoint
  receives this exact body.

- [ ] **Step 1: Write the failing tests**

`agent/internal/send/send_test.go`:

```go
package send

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/Rabindra184/vantrix/agent/internal/collect"
)

func sampleAt(ms int64) collect.Sample {
	return collect.Sample{
		SampledAt:     time.UnixMilli(ms).UTC(),
		CPUIdleMs:     ms,
		MemTotalBytes: 1024,
		MemUsedBytes:  512,
		TCPStates:     map[string]int{"ESTABLISHED": 3},
	}
}

func TestPostSendsTheHostLabelAndNoTenant(t *testing.T) {
	var body map[string]any
	var auth, agentHeader string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		agentHeader = r.Header.Get("User-Agent")
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()

	c := New(srv.URL, "pp_tok_secret", "gen-1", srv.Client())
	if err := c.Post(context.Background(), []collect.Sample{sampleAt(1000), sampleAt(2000)}); err != nil {
		t.Fatalf("Post() error = %v", err)
	}

	if auth != "Bearer pp_tok_secret" {
		t.Fatalf("Authorization = %q", auth)
	}
	if agentHeader == "" {
		t.Fatal("User-Agent is empty; a server log cannot tell which build produced a sample")
	}
	if body["host"] != "gen-1" {
		t.Fatalf("host = %v, want gen-1", body["host"])
	}

	// SPEC §2, THE SECURITY PROPERTY. The agent must not be able to name a
	// tenant: the server takes both from the token. Asserted on the wire, not
	// on the struct, because a struct field added later with a json tag would
	// pass a struct-level check and still ship.
	for _, forbidden := range []string{"orgId", "projectId", "org_id", "project_id"} {
		if _, present := body[forbidden]; present {
			t.Fatalf("payload carries %q; org and project come from the TOKEN", forbidden)
		}
	}

	samples, ok := body["samples"].([]any)
	if !ok || len(samples) != 2 {
		t.Fatalf("samples = %v, want 2", body["samples"])
	}
	first, _ := samples[0].(map[string]any)
	// Raw counters on the wire, never a rate the agent computed (spec §4).
	if _, present := first["cpuIdleMs"]; !present {
		t.Fatalf("sample = %v, want the raw cpuIdleMs counter", first)
	}
	for _, forbidden := range []string{"cpuPercent", "rxBytesPerSec"} {
		if _, present := first[forbidden]; present {
			t.Fatalf("sample carries the derived field %q; the server does the arithmetic", forbidden)
		}
	}
}

func TestPostOnAnEmptyBatchDoesNotCallTheServer(t *testing.T) {
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()

	c := New(srv.URL, "t", "gen-1", srv.Client())
	if err := c.Post(context.Background(), nil); err != nil {
		t.Fatalf("Post(nil) error = %v, want nil", err)
	}
	if called {
		t.Fatal("an empty batch reached the server")
	}
}

func TestPostReturnsAnErrorOnRejectionAndNeverPanics(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	defer srv.Close()

	c := New(srv.URL, "t", "gen-1", srv.Client())
	err := c.Post(context.Background(), []collect.Sample{sampleAt(1000)})
	if err == nil {
		t.Fatal("Post() = nil on a 403; the caller must be able to count the failure")
	}
	// The batch is DROPPED by the caller, not retried here. An agent that
	// retried aggressively during an outage would add load to the machine
	// whose load is the thing being measured (spec §5).
}
```

- [ ] **Step 2: Run them to verify they fail**

```bash
cd agent && go test ./internal/send/... -race
```

Expected: FAIL to build — `undefined: New`.

- [ ] **Step 3: Write the sender**

`agent/internal/send/send.go`:

```go
// Package send posts batches of samples to PerfPortal.
package send

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/Rabindra184/vantrix/agent"
	"github.com/Rabindra184/vantrix/agent/internal/collect"
)

// batch is the wire body of POST /v1/telemetry.
//
// TWO FIELDS, AND THE ABSENCE IS THE DESIGN. There is no orgId and no
// projectId: the server reads both from the bearer token (spec §2). `host` is
// a free-text label, not a foreign key to anything — hostnames collide and
// change on ephemeral generators, so it is configurable and is the dimension
// every chart groups by.
type batch struct {
	Host    string           `json:"host"`
	Samples []collect.Sample `json:"samples"`
}

// Client posts to one endpoint with one token.
type Client struct {
	endpoint  string
	token     string
	hostLabel string
	http      *http.Client
}

// New returns a Client. endpoint is the API root (e.g. https://perf.example);
// the telemetry path is appended here so a misconfigured path cannot silently
// POST samples at some other route.
func New(endpoint, token, hostLabel string, httpClient *http.Client) *Client {
	return &Client{
		endpoint:  strings.TrimRight(endpoint, "/") + "/v1/telemetry",
		token:     token,
		hostLabel: hostLabel,
		http:      httpClient,
	}
}

// Post sends one batch. An empty batch is a no-op rather than an empty request:
// at a 1 s interval with a 10 s window, the flush timer fires on every quiet
// stretch and a request per tick would be pure noise on a machine whose load is
// the measurement.
//
// It does not retry. A rejected POST is the caller's to count and drop — see
// the bounded buffer in Task 2 and spec §5.
func (c *Client) Post(ctx context.Context, samples []collect.Sample) error {
	if len(samples) == 0 {
		return nil
	}

	body, err := json.Marshal(batch{Host: c.hostLabel, Samples: samples})
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("User-Agent", agent.UserAgent())

	res, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()

	if res.StatusCode < 200 || res.StatusCode >= 300 {
		// The status only. The response body may name internal infrastructure,
		// and this string is written to a log on a shared load generator.
		return fmt.Errorf("telemetry rejected: %s", res.Status)
	}
	return nil
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd agent && go test ./internal/send/... -race -v
```

Expected: PASS, three tests.

- [ ] **Step 5: Write the binary**

`agent/cmd/perfportal-agent/main.go`:

```go
// Command perfportal-agent samples this host and posts the counters to
// PerfPortal. It knows nothing about runs: a run selects whatever samples
// overlap its own window (spec §2).
package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Rabindra184/vantrix/agent"
	"github.com/Rabindra184/vantrix/agent/internal/buffer"
	"github.com/Rabindra184/vantrix/agent/internal/collect"
	"github.com/Rabindra184/vantrix/agent/internal/send"
)

const (
	// Gatling's own cadence.
	defaultInterval = time.Second
	// Whichever comes first. Small enough that a crash loses at most ten
	// seconds of history, large enough that a 1 s sampler is not one request
	// per second per generator.
	batchSamples = 30
	batchWindow  = 10 * time.Second
	// Bounded, per spec §5 — roughly 32 minutes of 1 s samples. The number is a
	// memory ceiling, not a durability promise: an outage longer than this
	// loses its oldest samples, visibly, via Dropped().
	bufferSamples = 64 * batchSamples
	// One warning per interval at most, so a long outage does not turn the
	// agent into the thing generating load on the generator.
	logEvery = time.Minute
)

func main() {
	endpoint := flag.String("endpoint", "", "PerfPortal API root, e.g. https://perf.example (required)")
	token := flag.String("token", os.Getenv("PERFPORTAL_TELEMETRY_TOKEN"),
		`API token with the "telemetry" scope; defaults to $PERFPORTAL_TELEMETRY_TOKEN`)
	hostLabel := flag.String("host-label", "", "label this generator reports as; defaults to the OS hostname")
	interval := flag.Duration("interval", defaultInterval, "sampling interval")
	showVersion := flag.Bool("version", false, "print the version and exit")
	flag.Parse()

	if *showVersion {
		log.SetFlags(0)
		log.Println(agent.UserAgent())
		return
	}
	if *endpoint == "" || *token == "" {
		log.Fatal("both --endpoint and --token (or $PERFPORTAL_TELEMETRY_TOKEN) are required")
	}
	label := *hostLabel
	if label == "" {
		// Hostnames collide and change on ephemeral generators, which is why
		// --host-label exists; the hostname is only the default.
		name, err := os.Hostname()
		if err != nil {
			log.Fatalf("no --host-label and the hostname is unreadable: %v", err)
		}
		label = name
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	collector := collect.New()
	ring := buffer.New[collect.Sample](bufferSamples)
	// A timeout well under batchWindow, so a hung server cannot stall the
	// sender past its own next flush.
	client := send.New(*endpoint, *token, label, &http.Client{Timeout: 5 * time.Second})

	log.Printf("%s sampling every %s as %q → %s", agent.UserAgent(), *interval, label, *endpoint)

	go sample(ctx, collector, ring, *interval)
	drain(ctx, client, ring)
}

// sample pushes one Sample per tick and NEVER blocks on the sender. A tick
// missed because Sample errored is skipped, not retried: the next tick is
// milliseconds away and a retry loop inside the sampler would stretch the
// interval that every server-side rate is computed against.
func sample(ctx context.Context, c *collect.Collector, ring *buffer.Ring[collect.Sample], interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	var lastComplaint time.Time
	warnedProto := false

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s, err := c.Sample(ctx)
			if err != nil {
				if time.Since(lastComplaint) >= logEvery {
					log.Printf("sampling failed: %v", err)
					lastComplaint = time.Now()
				}
				continue
			}
			if !warnedProto && c.ProtoUnavailable() {
				warnedProto = true
				log.Print("TCP protocol counters are not available on this platform; " +
					"segment and connection-event series will be empty (spec §10)")
			}
			ring.Push(s)
		}
	}
}

// drain flushes on whichever comes first: batchSamples buffered, or batchWindow
// elapsed. A rejected POST DROPS the batch — see spec §5: an agent that retried
// aggressively during an outage would add load to a machine whose load is the
// thing being measured.
func drain(ctx context.Context, client *send.Client, ring *buffer.Ring[collect.Sample]) {
	// Polled well below batchWindow so a full buffer flushes promptly rather
	// than waiting out the window.
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()

	lastFlush := time.Now()
	var lastComplaint time.Time

	flush := func() {
		lastFlush = time.Now()
		samples := ring.DrainUpTo(batchSamples)
		if err := client.Post(ctx, samples); err != nil {
			if time.Since(lastComplaint) >= logEvery {
				log.Printf("dropped %d samples (%d lifetime buffer evictions): %v",
					len(samples), ring.Dropped(), err)
				lastComplaint = time.Now()
			}
		}
	}

	for {
		select {
		case <-ctx.Done():
			// One last flush on SIGTERM, with a fresh context: ctx is already
			// cancelled, and the samples in hand are the ones describing
			// whatever just killed the process.
			final, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = client.Post(final, ring.DrainUpTo(batchSamples))
			return
		case <-ticker.C:
			if ring.Len() >= batchSamples || time.Since(lastFlush) >= batchWindow {
				flush()
			}
		}
	}
}
```

- [ ] **Step 6: Build and smoke-test it**

```bash
cd agent && go build -o dist/perfportal-agent ./cmd/perfportal-agent && ./dist/perfportal-agent --version
```

Expected: `perfportal-agent/0.1.0`.

- [ ] **Step 7: Add the deferred CI build steps**

In `.github/workflows/ci.yml`'s `agent` job, append the three steps written out
in Task 1 Step 7 (`GOOS=linux GOARCH=amd64 …`, `GOOS=linux GOARCH=arm64 …`,
`cd dist && sha256sum …`, and the `upload-artifact` step). They compile now
that `./cmd/perfportal-agent` exists.

- [ ] **Step 8: Run every Go test**

```bash
cd agent && go vet ./... && go test ./... -race
```

Expected: PASS across `buffer`, `collect`, `send` and the root package.

- [ ] **Step 9: Commit**

```bash
git add agent .github/workflows/ci.yml
git commit -m "feat(agent): batch, post, and drop rather than retry on a machine we are measuring"
```

---

## Task 5: The footprint budget, measured

Spec §5 — "a stated footprint budget, **measured rather than assumed**, in the
same spirit as the windowed re-aggregation benchmark: under 1% of one core and
under 50 MB RSS at a 1 s interval." A budget nobody measures is a sentence in a
document.

**Files:**
- Create: `agent/footprint_test.go`

**Interfaces:**
- Consumes: `collect.New()`, `buffer.New`.
- Produces: nothing importable — a gate.

### Why `runtime.MemStats`, not `Maxrss`

`syscall.Getrusage` is the obvious source for both numbers, and it is right for
CPU: `Utime + Stime` measured as a **delta across the window** cancels the test
harness's own startup. It is wrong for memory. `Ru_Maxrss` is **kilobytes on
Linux and bytes on Darwin** — the same field, two units, no way to tell from Go
— so an assertion against it is off by 1024× on one of the two platforms and
passes vacuously on whichever one is looser. `runtime.MemStats.Sys` is portable
and is the number the agent actually controls.

- [ ] **Step 1: Write the failing test**

`agent/footprint_test.go`:

```go
package agent_test

import (
	"context"
	"runtime"
	"syscall"
	"testing"
	"time"

	"github.com/Rabindra184/vantrix/agent/internal/buffer"
	"github.com/Rabindra184/vantrix/agent/internal/collect"
)

const (
	// Spec §5. Under 1% of ONE core: over a 10 s window that is 100 ms of CPU.
	budgetCPUFraction = 0.01
	// Spec §5. runtime.MemStats.Sys, not Ru_Maxrss — see the plan's note.
	budgetMemBytes = 50 << 20

	footprintWindow   = 10 * time.Second
	footprintInterval = time.Second
)

func cpuUsed() time.Duration {
	var ru syscall.Rusage
	if err := syscall.Getrusage(syscall.RUSAGE_SELF, &ru); err != nil {
		return 0
	}
	return time.Duration(ru.Utime.Nano()) + time.Duration(ru.Stime.Nano())
}

// The §5 footprint budget. Skipped under -short so `go test ./...` in a tight
// loop stays fast; CI runs the full form.
//
// IF THIS FAILS, THE FIRST LEVER IS THE INTERVAL, not the bound. The likely
// culprit is net.Connections, which walks the kernel's socket table and grows
// with the connection count — on a generator holding tens of thousands of
// sockets it is by far the most expensive call in Sample().
func TestFootprintBudgetAtTheDefaultInterval(t *testing.T) {
	if testing.Short() {
		t.Skip("footprint budget takes 10s; run without -short")
	}

	c := collect.New()
	ring := buffer.New[collect.Sample](64 * 30)

	// Warm up: the first Sample() faults in gopsutil's lazily-initialised
	// platform state, and charging that one-off to a steady-state budget would
	// make the gate depend on how long the window is.
	if _, err := c.Sample(context.Background()); err != nil {
		t.Fatalf("Sample() error = %v", err)
	}

	var before runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	cpuBefore := cpuUsed()

	ctx, cancel := context.WithTimeout(context.Background(), footprintWindow)
	defer cancel()
	ticker := time.NewTicker(footprintInterval)
	defer ticker.Stop()

	samples := 0
loop:
	for {
		select {
		case <-ctx.Done():
			break loop
		case <-ticker.C:
			s, err := c.Sample(context.Background())
			if err != nil {
				t.Fatalf("Sample() error = %v", err)
			}
			ring.Push(s)
			samples++
		}
	}

	cpuDelta := cpuUsed() - cpuBefore
	var after runtime.MemStats
	runtime.ReadMemStats(&after)

	if samples == 0 {
		t.Fatal("no samples taken; the measurement proves nothing")
	}

	// Fraction of ONE core over the window.
	used := float64(cpuDelta) / float64(footprintWindow)
	t.Logf("%d samples · CPU %s (%.3f%% of one core) · Sys %d MiB",
		samples, cpuDelta, used*100, after.Sys>>20)

	if used > budgetCPUFraction {
		t.Fatalf("CPU %.3f%% of one core over %s, budget %.3f%% (spec §5). "+
			"Lower the sampling interval before raising this bound.",
			used*100, footprintWindow, budgetCPUFraction*100)
	}
	if after.Sys > budgetMemBytes {
		t.Fatalf("runtime Sys = %d MiB, budget %d MiB (spec §5)",
			after.Sys>>20, budgetMemBytes>>20)
	}
	// The buffer is bounded and this window cannot have filled it, so it must
	// hold exactly what was pushed — proof the sampler is not leaking into it.
	if ring.Len() != samples {
		t.Fatalf("buffer holds %d of %d samples", ring.Len(), samples)
	}
	if ring.Dropped() != 0 {
		t.Fatalf("buffer dropped %d samples in a window that cannot fill it", ring.Dropped())
	}
}
```

- [ ] **Step 2: Run it**

```bash
cd agent && go test -run TestFootprintBudget -v ./...
```

Expected: PASS, with the `t.Logf` line printing the actual numbers. **Record
those numbers in the commit message** — the spec asks for a measurement, and a
green gate with no reported figure is not one.

If it FAILS on CPU: confirm `net.Connections` is the cost by commenting it out
and re-running; if so, do not raise the bound — report it and stop. That is a
finding about the design, and the plan's answer (spec §5) is the sampling
interval, which is a decision for the human partner.

- [ ] **Step 3: Make CI run it**

The `agent` job's `go test ./... -race` already runs it (no `-short`). Note that
`-race` inflates CPU substantially — 5–10× is normal. Split the step so the
budget is measured **without** the race detector, which is the only way the
number means anything:

```yaml
      - run: go test ./... -race
      # WITHOUT -race. The detector multiplies CPU by 5-10x, so a budget
      # measured under it is measuring the detector.
      - run: go test -run TestFootprintBudget -v ./...
```

- [ ] **Step 4: Commit**

```bash
git add agent/footprint_test.go .github/workflows/ci.yml
git commit -m "test(agent): measure the footprint budget rather than asserting it

<paste the t.Logf line here>"
```

---

## Task 6: The table, and reading it back

Spec §3 and §6's read query. Storage before any endpoint, so the round trip and
the partition pruning are proven with no HTTP in the picture.

**Files:**
- Create: `packages/persistence/prisma/migrations/20260817090000_telemetry_sample/migration.sql`
- Create: `packages/persistence/src/metrics/telemetry.ts`
- Create: `packages/persistence/test/telemetry.integration.test.ts`
- Modify: `packages/persistence/src/index.ts`, `packages/persistence/src/client.ts`
- Modify: `packages/persistence/prisma/schema.prisma`

**Interfaces:**
- Consumes: `ProjectScope` from `packages/persistence`.
- Produces:
  - `TELEMETRY_LOOKBACK_MS = 60_000`
  - `interface StoredTelemetrySample` — `host, sampledAtMs, receivedAtMs,
    cpuUserMs, cpuSystemMs, cpuIdleMs, cpuIowaitMs, memUsedBytes,
    memTotalBytes, netRxBytes, netTxBytes, tcpInSegs, tcpOutSegs,
    tcpRetransSegs, tcpInErrs, tcpActiveOpens, tcpPassiveOpens,
    tcpStates: Record<string, number>` (all numbers)
  - `TELEMETRY_WINDOW_SQL` (exported for the pruning test)
  - `class TelemetryStore` with
    `insert(scope: ProjectScope, host: string, samples: readonly InboundTelemetrySample[]): Promise<number>` and
    `forRun(scope: ProjectScope, fromMs: number, toMs: number): Promise<StoredTelemetrySample[]>`
  - `interface InboundTelemetrySample` — the same fields minus `host`/`receivedAtMs`,
    with `sampledAtMs: number`.

- [ ] **Step 1: Write the migration**

`packages/persistence/prisma/migrations/20260817090000_telemetry_sample/migration.sql`:

```sql
-- Load-generator host telemetry. Partitioned on sampled_on exactly like
-- run_series_bucket, run_user_bucket and run_error_bucket, for retention:
-- dropping a partition beats a delete storm. Retention matters MORE here than
-- for those three, because this table grows on wall-clock time rather than on
-- runs — a daemon writing a sample a second, forever, whether or not a test is
-- running.
--
-- THE PARTITION KEY IS THE AGENT'S DATE, NOT THE SERVER'S. It has to be, so a
-- sample lands in the partition its sampled_at implies and a window query can
-- prune. A clock skewed across midnight puts a sample in the neighbouring
-- partition; the pruning predicate in TELEMETRY_WINDOW_SQL covers both edges,
-- and received_at is what makes such a case diagnosable rather than mysterious.
--
-- NO run_id COLUMN, AND THAT IS THE ARCHITECTURE. A run does not exist in
-- PerfPortal until its bundle is POSTed, which happens AFTER the test finishes;
-- an agent handed a run id would need a handshake, an ordering guarantee
-- between test and upload, and a failure mode for when the upload never comes.
-- Instead a run selects whatever overlaps its own window.
--
-- org_id and project_id come from the TOKEN, never from the agent's payload.
-- An agent runs on a load generator, which is a machine an attacker is far
-- likelier to reach than the API.
CREATE TABLE "telemetry_sample" (
    "sampled_on"  DATE        NOT NULL,
    "org_id"      UUID        NOT NULL,
    "project_id"  UUID        NOT NULL,
    "host"        TEXT        NOT NULL,
    "sampled_at"  TIMESTAMPTZ NOT NULL,
    "received_at" TIMESTAMPTZ NOT NULL,

    -- Cumulative counters, stored RAW. Never a rate the agent computed: the
    -- sampling interval is the agent's and it drifts, and a counter reset
    -- (process restart, interface flap) is detectable here as
    -- `current < previous` and invisible in a pre-computed rate, where it
    -- arrives as a plausible enormous spike a reader would believe.
    --
    -- BIGINT throughout. These are since-boot counters on a machine that may
    -- be up for months; INTEGER overflows net_rx_bytes inside a day at 10Gb/s.
    "cpu_user_ms"       BIGINT NOT NULL,
    "cpu_system_ms"     BIGINT NOT NULL,
    "cpu_idle_ms"       BIGINT NOT NULL,
    "cpu_iowait_ms"     BIGINT NOT NULL,
    "net_rx_bytes"      BIGINT NOT NULL,
    "net_tx_bytes"      BIGINT NOT NULL,
    "tcp_in_segs"       BIGINT NOT NULL,
    "tcp_out_segs"      BIGINT NOT NULL,
    "tcp_retrans_segs"  BIGINT NOT NULL,
    "tcp_in_errs"       BIGINT NOT NULL,
    "tcp_active_opens"  BIGINT NOT NULL,
    "tcp_passive_opens" BIGINT NOT NULL,

    -- Gauges, stored as read.
    "mem_used_bytes"  BIGINT NOT NULL,
    "mem_total_bytes" BIGINT NOT NULL,

    -- Connection counts by TCP state. JSONB because the state set is the
    -- KERNEL'S, not ours: ESTABLISHED, TIME_WAIT, CLOSE_WAIT, SYN_SENT and
    -- more, and a column per state would need a migration every time an OS
    -- reports one we had not enumerated.
    -- {"ESTABLISHED": 412, "TIME_WAIT": 88} — absent when zero.
    "tcp_states" JSONB NOT NULL,

    -- A unique/primary key on a partitioned table must contain the partition
    -- key. (org_id, project_id) precede host so the tenant predicate is a
    -- prefix of the index the window query uses.
    CONSTRAINT "telemetry_sample_pkey"
      PRIMARY KEY ("sampled_on", "org_id", "project_id", "host", "sampled_at")
) PARTITION BY RANGE ("sampled_on");

-- No secondary index. The window query filters
-- (sampled_on, org_id, project_id) and orders by (host, sampled_at) — a strict
-- prefix followed by the remaining key columns, so the primary key's own btree
-- serves it. The same reasoning 0001_init records for run_series_bucket.

-- Twelve months from 2026-01, matching every other partitioned table here.
-- Automatic rollover is a later milestone; until then a write past the last
-- partition fails LOUDLY rather than silently landing somewhere wrong.
CREATE TABLE "telemetry_sample_2026_01" PARTITION OF "telemetry_sample"
  FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE "telemetry_sample_2026_02" PARTITION OF "telemetry_sample"
  FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE "telemetry_sample_2026_03" PARTITION OF "telemetry_sample"
  FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE "telemetry_sample_2026_04" PARTITION OF "telemetry_sample"
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE "telemetry_sample_2026_05" PARTITION OF "telemetry_sample"
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE "telemetry_sample_2026_06" PARTITION OF "telemetry_sample"
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE "telemetry_sample_2026_07" PARTITION OF "telemetry_sample"
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE "telemetry_sample_2026_08" PARTITION OF "telemetry_sample"
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE "telemetry_sample_2026_09" PARTITION OF "telemetry_sample"
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE "telemetry_sample_2026_10" PARTITION OF "telemetry_sample"
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE "telemetry_sample_2026_11" PARTITION OF "telemetry_sample"
  FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE "telemetry_sample_2026_12" PARTITION OF "telemetry_sample"
  FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
```

- [ ] **Step 2: Mirror the table in `schema.prisma`**

The table is written and read through raw `pg`, but `schema.prisma` must
describe it or the next `prisma migrate dev` will generate a migration that
DROPs it. Add, following the style of the other partitioned tables in that file
(check how `run_error_bucket` is represented there and copy it exactly —
including whether it is present at all; if the other `*_bucket` tables are
absent from the schema, leave this one absent too and skip this step).

- [ ] **Step 3: Apply and verify the migration**

```bash
nvm use && docker compose -f infra/docker-compose.yml up -d
export DATABASE_URL=postgresql://perfportal:perfportal@localhost:5433/perfportal
pnpm --filter @perfportal/persistence exec prisma migrate deploy --schema prisma/schema.prisma
```

Expected: `The following migration(s) have been applied: 20260817090000_telemetry_sample`.

> **If it fails halfway, the migration is left in a FAILED state and no later
> migration will run.** Undo the partial DDL by hand, then
> `prisma migrate resolve --rolled-back 20260817090000_telemetry_sample`
> before retrying. This bit the `run_error_is_other` migration.

- [ ] **Step 4: Write the failing integration test**

`packages/persistence/test/telemetry.integration.test.ts` — follow the setup of
the existing `metrics.integration.test.ts` in that directory for pool creation,
org/project seeding and truncation.

```ts
import { describe, expect, it } from 'vitest';
import { TELEMETRY_WINDOW_SQL, TelemetryStore, type InboundTelemetrySample } from '../src/index.js';

// A sample builder, so every test states only what it is about. Counters climb
// with `n` so a delta is always positive unless a test deliberately resets one.
const sampleAt = (n: number, over: Partial<InboundTelemetrySample> = {}): InboundTelemetrySample => ({
  sampledAtMs: Date.UTC(2026, 7, 17, 10, 0, n),
  cpuUserMs: 1000 * n, cpuSystemMs: 500 * n, cpuIdleMs: 8000 * n, cpuIowaitMs: 10 * n,
  memUsedBytes: 1_000_000 + n, memTotalBytes: 8_000_000,
  netRxBytes: 10_000 * n, netTxBytes: 20_000 * n,
  tcpInSegs: 100 * n, tcpOutSegs: 120 * n, tcpRetransSegs: n, tcpInErrs: 0,
  tcpActiveOpens: 5 * n, tcpPassiveOpens: 3 * n,
  tcpStates: { ESTABLISHED: 10 + n, TIME_WAIT: n },
  ...over,
});

describe('TelemetryStore', () => {
  it('round-trips every counter and the state map', async () => {
    const store = new TelemetryStore(pool);
    const written = [sampleAt(1), sampleAt(2)];
    const inserted = await store.insert(scope, 'gen-1', written);
    expect(inserted).toBe(written.length);

    const read = await store.forRun(scope, written[0]!.sampledAtMs, written[1]!.sampledAtMs + 1);

    // DERIVED FROM WHAT WAS WRITTEN, never a literal — the builder above is
    // free to change.
    expect(read.map((r) => r.sampledAtMs)).toEqual(written.map((w) => w.sampledAtMs));
    expect(read.map((r) => r.tcpInSegs)).toEqual(written.map((w) => w.tcpInSegs));
    expect(read.map((r) => r.netRxBytes)).toEqual(written.map((w) => w.netRxBytes));
    expect(read.map((r) => r.tcpStates)).toEqual(written.map((w) => w.tcpStates));
    expect(read.every((r) => r.host === 'gen-1')).toBe(true);
  });

  it('stamps received_at from the SERVER clock, not the payload', async () => {
    const store = new TelemetryStore(pool);
    // An agent thirty seconds fast. Spec §2: this is not solvable without a
    // handshake, but it IS detectable without one — which is the whole reason
    // both clocks are stored.
    const skewed = sampleAt(1, { sampledAtMs: Date.now() + 30_000 });
    await store.insert(scope, 'skewed', [skewed]);

    const [row] = await store.forRun(scope, skewed.sampledAtMs - 1000, skewed.sampledAtMs + 1000);
    expect(row!.sampledAtMs).toBe(skewed.sampledAtMs);
    // The server clock is BEHIND the agent's here, by construction.
    expect(row!.receivedAtMs).toBeLessThan(row!.sampledAtMs);
  });

  it('is scoped to the tenant', async () => {
    const store = new TelemetryStore(pool);
    await store.insert(otherScope, 'gen-1', [sampleAt(1)]);
    const mine = await store.forRun(scope, 0, Number.MAX_SAFE_INTEGER);
    expect(mine).toEqual([]);
  });

  it('prunes partitions', async () => {
    // SHARED VERBATIM with the reader, exactly as the series/user/error
    // pruning tests are: `sampled_on BETWEEN $1 AND $2` is the partition-key
    // predicate, and a query filtering on sampled_at alone cannot prune and
    // silently scans every partition instead.
    const { rows } = await pool.query(
      `EXPLAIN (FORMAT JSON) ${TELEMETRY_WINDOW_SQL}`,
      ['2026-08-17', '2026-08-17', scope.orgId, scope.projectId,
       new Date(Date.UTC(2026, 7, 17, 10, 0, 0)), new Date(Date.UTC(2026, 7, 17, 11, 0, 0))],
    );
    const plan = JSON.stringify(rows[0]);
    expect(plan).toContain('telemetry_sample_2026_08');
    expect(plan).not.toContain('telemetry_sample_2026_01');
  });
});
```

- [ ] **Step 5: Run it to verify it fails**

```bash
nvm use && pnpm test:integration -- telemetry
```

Expected: FAIL — `TelemetryStore` is not exported.

- [ ] **Step 6: Write the store**

`packages/persistence/src/metrics/telemetry.ts`:

```ts
import type pg from 'pg';
import type { ProjectScope } from '../client.js';

/**
 * How far BEFORE a run's start the reader reaches for samples.
 *
 * Every rate this system draws is a difference between two consecutive
 * samples, so the FIRST sample inside a run's window has nothing to difference
 * against and can produce no rate at all. Without a lookback, every host's
 * first bucket would be blank on six charts, forever, for a reason no reader
 * could deduce.
 *
 * Sixty seconds is generous against the agent's 1s default and costs nothing:
 * the query is partition-pruned either way. Samples that resolve to a negative
 * offset are dropped by `toTelemetrySeries` — the lookback exists to seed the
 * first delta, not to show pre-run history.
 */
export const TELEMETRY_LOOKBACK_MS = 60_000;

/** What an agent sends, after the token has supplied the tenant. */
export interface InboundTelemetrySample {
  sampledAtMs: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  cpuIdleMs: number;
  cpuIowaitMs: number;
  memUsedBytes: number;
  memTotalBytes: number;
  netRxBytes: number;
  netTxBytes: number;
  tcpInSegs: number;
  tcpOutSegs: number;
  tcpRetransSegs: number;
  tcpInErrs: number;
  tcpActiveOpens: number;
  tcpPassiveOpens: number;
  tcpStates: Record<string, number>;
}

/** One stored row: an inbound sample plus the two things the server owns. */
export interface StoredTelemetrySample extends InboundTelemetrySample {
  host: string;
  /** The SERVER's clock. Compared against sampledAtMs to detect drift. */
  receivedAtMs: number;
}

/**
 * Shared verbatim with the "prunes partitions" integration test, for the same
 * load-bearing reason as SERIES_SQL: `sampled_on BETWEEN $1 AND $2` is the
 * partition-key predicate that lets Postgres prune telemetry_sample's range
 * partitions. A query filtering on sampled_at alone cannot prune and silently
 * scans every partition instead — and this table grows on wall-clock time, so
 * "every partition" gets worse every day whether or not anyone runs a test.
 *
 * TWO DATE BOUNDS, NOT ONE. Unlike the run tables, whose rows all share one
 * run_started_on, a window here can straddle midnight — and so can a skewed
 * agent clock, which is precisely the case §2 says must stay diagnosable.
 */
export const TELEMETRY_WINDOW_SQL = `SELECT host, sampled_at, received_at,
              cpu_user_ms, cpu_system_ms, cpu_idle_ms, cpu_iowait_ms,
              mem_used_bytes, mem_total_bytes,
              net_rx_bytes, net_tx_bytes,
              tcp_in_segs, tcp_out_segs, tcp_retrans_segs, tcp_in_errs,
              tcp_active_opens, tcp_passive_opens, tcp_states
         FROM telemetry_sample
        WHERE sampled_on BETWEEN $1 AND $2
          AND org_id = $3 AND project_id = $4
          AND sampled_at >= $5 AND sampled_at < $6
        ORDER BY host, sampled_at`;

/** `YYYY-MM-DD` in UTC — the partition key, derived from the AGENT's clock. */
const sampledOn = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export class TelemetryStore {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Writes a batch.
   *
   * `scope` comes from the TOKEN and `host` from the payload — the one split
   * that matters. An agent may say which machine it is; it may not say which
   * tenant it belongs to.
   *
   * ON CONFLICT DO NOTHING because a retried batch after a timeout that
   * actually succeeded must be idempotent, and the primary key
   * (sampled_on, org, project, host, sampled_at) already identifies a sample
   * uniquely. Returns rows actually inserted, so a caller can see a duplicate
   * batch as a smaller number rather than as an error.
   */
  async insert(
    scope: ProjectScope,
    host: string,
    samples: readonly InboundTelemetrySample[],
  ): Promise<number> {
    if (samples.length === 0) return 0;

    const columns = 20;
    const values: unknown[] = [];
    const tuples = samples.map((s, i) => {
      const base = i * columns;
      values.push(
        sampledOn(s.sampledAtMs), scope.orgId, scope.projectId, host,
        new Date(s.sampledAtMs), new Date(),
        s.cpuUserMs, s.cpuSystemMs, s.cpuIdleMs, s.cpuIowaitMs,
        s.memUsedBytes, s.memTotalBytes, s.netRxBytes, s.netTxBytes,
        s.tcpInSegs, s.tcpOutSegs, s.tcpRetransSegs, s.tcpInErrs,
        s.tcpActiveOpens, s.tcpPassiveOpens,
      );
      // tcp_states is the 21st value and is appended after the loop body's
      // fixed 20 so the JSON stringification is visible at the call site.
      values.push(JSON.stringify(s.tcpStates));
      const placeholders = Array.from({ length: columns + 1 }, (_, k) => `$${base + i + k + 1}`);
      return `(${placeholders.join(', ')})`;
    });

    const { rowCount } = await this.pool.query(
      `INSERT INTO telemetry_sample (
         sampled_on, org_id, project_id, host, sampled_at, received_at,
         cpu_user_ms, cpu_system_ms, cpu_idle_ms, cpu_iowait_ms,
         mem_used_bytes, mem_total_bytes, net_rx_bytes, net_tx_bytes,
         tcp_in_segs, tcp_out_segs, tcp_retrans_segs, tcp_in_errs,
         tcp_active_opens, tcp_passive_opens, tcp_states
       ) VALUES ${tuples.join(', ')}
       ON CONFLICT DO NOTHING`,
      values,
    );
    return rowCount ?? 0;
  }

  /**
   * Every sample for this tenant in `[fromMs, toMs)`, ordered by host then
   * time — the order `toTelemetrySeries` needs to difference consecutive
   * samples without re-sorting.
   *
   * The DATE bounds are derived here from the millisecond bounds rather than
   * taken from the caller, so no caller can pass a pair that disagrees and
   * silently prune away the partition holding half the answer.
   */
  async forRun(scope: ProjectScope, fromMs: number, toMs: number): Promise<StoredTelemetrySample[]> {
    const { rows } = await this.pool.query(TELEMETRY_WINDOW_SQL, [
      sampledOn(fromMs), sampledOn(toMs),
      scope.orgId, scope.projectId,
      new Date(fromMs), new Date(toMs),
    ]);
    return rows.map((r) => ({
      host: r.host,
      sampledAtMs: r.sampled_at.getTime(),
      receivedAtMs: r.received_at.getTime(),
      // BIGINT arrives from node-postgres as a STRING, not a number — the
      // driver refuses to silently lose precision above 2^53. Every one of
      // these needs Number(), and forgetting one yields string concatenation
      // in the delta arithmetic rather than a type error.
      cpuUserMs: Number(r.cpu_user_ms),
      cpuSystemMs: Number(r.cpu_system_ms),
      cpuIdleMs: Number(r.cpu_idle_ms),
      cpuIowaitMs: Number(r.cpu_iowait_ms),
      memUsedBytes: Number(r.mem_used_bytes),
      memTotalBytes: Number(r.mem_total_bytes),
      netRxBytes: Number(r.net_rx_bytes),
      netTxBytes: Number(r.net_tx_bytes),
      tcpInSegs: Number(r.tcp_in_segs),
      tcpOutSegs: Number(r.tcp_out_segs),
      tcpRetransSegs: Number(r.tcp_retrans_segs),
      tcpInErrs: Number(r.tcp_in_errs),
      tcpActiveOpens: Number(r.tcp_active_opens),
      tcpPassiveOpens: Number(r.tcp_passive_opens),
      tcpStates: r.tcp_states as Record<string, number>,
    }));
  }
}
```

- [ ] **Step 7: Export it, and register the table**

In `packages/persistence/src/index.ts` add
`export * from './metrics/telemetry.js';`.

In `packages/persistence/src/client.ts`, add `'telemetry_sample'` to
`SCHEMA_TABLES` — **after `'run_error_bucket'` and before `'sla_rule'`**, so
truncation order still respects foreign keys (this table has none, so position
is cosmetic, but the list reads as a schema and should stay grouped).

- [ ] **Step 8: Run the test to verify it passes**

```bash
nvm use && pnpm test:integration -- telemetry
```

Expected: PASS, four tests.

- [ ] **Step 9: Commit**

```bash
git add packages/persistence
git commit -m "feat(persistence): telemetry_sample, partitioned on the agent's date, read with both clocks"
```

---

## Task 7: The contract, the `telemetry` scope, and `POST /v1/telemetry`

Spec §6's ingest half. The scope is the point: an agent token lives on a load
generator, which is often shared, often ephemeral, and often less carefully
managed than CI. It must not be able to upload bundles or read results.

**Files:**
- Create: `apps/api/src/telemetry/telemetry.controller.ts`, `apps/api/src/telemetry/telemetry.module.ts`
- Create: `apps/api/test/telemetry.integration.test.ts`
- Modify: `packages/contracts/src/metrics.ts`, `packages/contracts/src/index.ts`
- Modify: `apps/api/src/auth/scopes.decorator.ts`, `apps/api/src/auth/auth.middleware.ts`
- Modify: `apps/api/src/app.module.ts`, `apps/api/src/openapi/document.ts`
- Modify: `apps/api/test/support/app.ts`

**Interfaces:**
- Consumes: `TelemetryStore`, `InboundTelemetrySample` (Task 6).
- Produces: `TelemetryBatchSchema` / `TelemetryBatch` and
  `TelemetrySampleSchema` in `@perfportal/contracts`; `TokenScope` widened to
  `'ingest' | 'read' | 'telemetry'`; `TestContext.telemetryToken`.

- [ ] **Step 1: Write the ingest contract**

In `packages/contracts/src/metrics.ts`:

```ts
/**
 * One sample as an agent sends it. Field names match the Go struct tags in
 * `agent/internal/collect/collect.go` exactly — the two are one wire format,
 * and a rename on either side must be a rename on both.
 *
 * EVERY CUMULATIVE FIELD IS THE RAW COUNTER. There is deliberately no
 * `cpuPercent` and no `rxBytesPerSec`: the sampling interval is the agent's and
 * it drifts, so a rate computed against an assumed interval is wrong by exactly
 * that drift — and a counter reset is detectable in raw values
 * (`current < previous`) and invisible in a rate, where it arrives as a
 * plausible enormous spike that is indistinguishable from a real traffic burst.
 *
 * `.int().nonnegative()` on every counter: a negative since-boot counter is not
 * a reading, and rejecting it at the edge means the delta arithmetic downstream
 * only ever has to consider a RESET, never a negative.
 */
const counter = () => z.number().int().nonnegative();

export const TelemetrySampleSchema = z.object({
  /** ISO 8601, the AGENT's clock. The server stamps its own separately. */
  sampledAt: z.string().datetime(),
  cpuUserMs: counter(),
  cpuSystemMs: counter(),
  cpuIdleMs: counter(),
  cpuIowaitMs: counter(),
  memUsedBytes: counter(),
  memTotalBytes: counter(),
  netRxBytes: counter(),
  netTxBytes: counter(),
  tcpInSegs: counter(),
  tcpOutSegs: counter(),
  tcpRetransSegs: counter(),
  tcpInErrs: counter(),
  tcpActiveOpens: counter(),
  tcpPassiveOpens: counter(),
  /** Kernel TCP state → count, absent when zero. The state set is the OS's. */
  tcpStates: z.record(z.string(), z.number().int().nonnegative()),
});
export type TelemetrySample = z.infer<typeof TelemetrySampleSchema>;

/**
 * The body of POST /v1/telemetry.
 *
 * ═══ THERE IS NO orgId AND NO projectId, ON PURPOSE ═══
 *
 * Both come from the bearer token. An agent runs on a load generator — a
 * machine an attacker is far likelier to reach than the API — and a
 * payload-supplied tenant would let a token minted for one project write
 * telemetry into another, which the read path would then serve without a
 * murmur. `.strict()` is what makes that a REJECTION rather than a silently
 * ignored field, so a future agent that starts sending one fails loudly on its
 * first request instead of appearing to work.
 */
export const TelemetryBatchSchema = z
  .object({
    /**
     * The generator's label. Free text, NOT a foreign key: hostnames collide
     * and change on ephemeral generators, which is why the agent takes
     * `--host-label`. It is the dimension every telemetry chart groups by.
     */
    host: z.string().min(1).max(255),
    /**
     * Bounded so one request cannot pin the event loop. The agent batches at
     * 30; 500 leaves generous headroom for a backlog flush after an outage
     * while keeping the worst-case body small.
     */
    samples: z.array(TelemetrySampleSchema).min(1).max(500),
  })
  .strict();
export type TelemetryBatch = z.infer<typeof TelemetryBatchSchema>;
```

Export both from `packages/contracts/src/index.ts` if that file re-exports by
name rather than with `export *`.

- [ ] **Step 2: Widen the scope type**

`apps/api/src/auth/scopes.decorator.ts`:

```ts
/**
 * `telemetry` is deliberately a THIRD scope rather than a reuse of `ingest`.
 *
 * An agent token lives on a load generator: often shared, often ephemeral,
 * often less carefully managed than CI. A token that could post host counters
 * AND upload bundles AND read results would make every generator in the fleet a
 * full-privilege credential store. This one can do exactly one thing.
 */
export type TokenScope = 'ingest' | 'read' | 'telemetry';
```

In `apps/api/src/auth/auth.middleware.ts`, `authenticateSession` returns
`scopes: ['read', 'ingest']`. **Leave it.** Add:

```ts
    // NOT 'telemetry'. A browser session has no reason to post host counters,
    // and widening this would make the scope's whole purpose decorative.
    scopes: ['read', 'ingest'],
```

- [ ] **Step 3: Mint a telemetry token in the test harness**

In `apps/api/test/support/app.ts`: add `telemetryToken: string` to
`TestContext`, mint a third token with `scopes: ['telemetry']` following the
existing `rd` block exactly, and return it. Also add `'telemetry_sample'` to
that file's local `TABLES` array — **it is a separate list from
`SCHEMA_TABLES`**, and a table missing from it leaks rows between tests.

- [ ] **Step 4: Write the failing tests**

`apps/api/test/telemetry.integration.test.ts`:

```ts
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestContext } from './support/app.js';

const sample = (secondsFromNow = 0) => ({
  sampledAt: new Date(Date.now() + secondsFromNow * 1000).toISOString(),
  cpuUserMs: 1000, cpuSystemMs: 500, cpuIdleMs: 8000, cpuIowaitMs: 10,
  memUsedBytes: 1_000_000, memTotalBytes: 8_000_000,
  netRxBytes: 10_000, netTxBytes: 20_000,
  tcpInSegs: 100, tcpOutSegs: 120, tcpRetransSegs: 1, tcpInErrs: 0,
  tcpActiveOpens: 5, tcpPassiveOpens: 3,
  tcpStates: { ESTABLISHED: 10 },
});

describe('POST /v1/telemetry', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await createTestApp(); });
  afterEach(async () => { await ctx.close(); });

  it('accepts a batch from a telemetry token', async () => {
    const res = await request(ctx.app.getHttpServer())
      .post('/v1/telemetry')
      .set('Authorization', `Bearer ${ctx.telemetryToken}`)
      .send({ host: 'gen-1', samples: [sample(0), sample(1)] });

    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(2);
  });

  // ═══ THE SCOPE IS ASSERTED BOTH WAYS ═══
  // A scope that is not enforced is decoration, and only one of these two
  // directions is the one people remember to test.

  it('refuses an ingest token', async () => {
    const res = await request(ctx.app.getHttpServer())
      .post('/v1/telemetry')
      .set('Authorization', `Bearer ${ctx.ingestToken}`)
      .send({ host: 'gen-1', samples: [sample()] });
    expect(res.status).toBe(403);
  });

  it('refuses a read token', async () => {
    const res = await request(ctx.app.getHttpServer())
      .post('/v1/telemetry')
      .set('Authorization', `Bearer ${ctx.readToken}`)
      .send({ host: 'gen-1', samples: [sample()] });
    expect(res.status).toBe(403);
  });

  it('a telemetry token cannot upload a bundle', async () => {
    const res = await request(ctx.app.getHttpServer())
      .post('/v1/runs')
      .set('Authorization', `Bearer ${ctx.telemetryToken}`)
      .field('metadata', JSON.stringify({}));
    expect(res.status).toBe(403);
  });

  it('a telemetry token cannot read runs', async () => {
    const res = await request(ctx.app.getHttpServer())
      .get('/v1/runs')
      .set('Authorization', `Bearer ${ctx.telemetryToken}`);
    expect(res.status).toBe(403);
  });

  it('rejects a payload that names a tenant', async () => {
    // Spec §2, enforced rather than documented. `.strict()` turns a
    // hypothetical privilege escalation into a 400 on the first request.
    const res = await request(ctx.app.getHttpServer())
      .post('/v1/telemetry')
      .set('Authorization', `Bearer ${ctx.telemetryToken}`)
      .send({ host: 'gen-1', projectId: ctx.projectId, samples: [sample()] });
    expect(res.status).toBe(400);
  });

  it('refuses an org-scoped credential', async () => {
    // A session names no project, and a telemetry row must belong to one.
    // Refuse and say what to use instead, exactly as ingest does.
    const res = await request(ctx.app.getHttpServer())
      .post('/v1/telemetry')
      .send({ host: 'gen-1', samples: [sample()] });
    expect([401, 400]).toContain(res.status);
  });
});
```

- [ ] **Step 5: Run to verify they fail**

```bash
nvm use && pnpm test:integration -- telemetry.integration
```

Expected: FAIL — 404 on every POST; the route does not exist.

- [ ] **Step 6: Write the controller**

`apps/api/src/telemetry/telemetry.controller.ts`:

```ts
import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { TelemetryBatchSchema } from '@perfportal/contracts';
import { TelemetryStore } from '@perfportal/persistence';
import type { Request } from 'express';
import { Scopes } from '../auth/scopes.decorator.js';
import { badRequest } from '../common/validation.js';

/**
 * The agent's one endpoint.
 *
 * NOT under /v1/runs. An agent knows nothing about runs — a run does not exist
 * in PerfPortal until its bundle is POSTed, which happens after the test
 * finishes. A run selects whatever samples overlap its own window; see
 * GET /v1/runs/:id/telemetry.
 */
@Controller('/v1/telemetry')
export class TelemetryController {
  constructor(private readonly store: TelemetryStore) {}

  @Post()
  @Scopes('telemetry')
  @HttpCode(202)
  async post(@Req() req: Request, @Body() body: unknown): Promise<{ accepted: number }> {
    const tenant = req.tenant!;
    const projectId = tenant.projectId;
    if (!projectId) {
      // A session is org-scoped and names no project, but a sample must belong
      // to one. Rather than guess, refuse and say what to use instead — the
      // same shape IngestController uses for the same reason. Extracting
      // projectId into its own const is also what narrows the tenant object
      // below; a property check alone does not narrow the object it came from.
      throw badRequest(
        'PROJECT_REQUIRED',
        'Telemetry requires a project-scoped credential.',
        'Run the agent with a project API token carrying the "telemetry" scope.',
      );
    }

    const parsed = TelemetryBatchSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest(
        'INVALID_TELEMETRY',
        `The telemetry batch is not valid: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
        'Send raw cumulative counters and no tenant fields; org and project come from the token.',
      );
    }

    // ═══ THE TENANT COMES FROM THE TOKEN ═══
    // Never from `parsed.data`, which has no such fields and rejects them.
    const accepted = await this.store.insert(
      { orgId: tenant.orgId, projectId },
      parsed.data.host,
      parsed.data.samples.map((s) => ({ ...s, sampledAtMs: Date.parse(s.sampledAt) })),
    );
    return { accepted };
  }
}
```

`apps/api/src/telemetry/telemetry.module.ts`: a `@Module` providing
`TelemetryStore` (constructed from the injected `pg.Pool`, following how
`runs.module.ts` provides `MetricReader` — that module had to provide it
explicitly or the API refused to boot) and declaring `TelemetryController`.
Import it in `app.module.ts`.

- [ ] **Step 7: Document the scope in OpenAPI**

In `apps/api/src/openapi/document.ts`, add the `POST /v1/telemetry` path and
amend the security description at line ~720 — it currently says *"every GET
requires 'read'"*, which is about to be one third of the story.

- [ ] **Step 8: Run to verify they pass**

```bash
nvm use && pnpm test:integration -- telemetry
```

Expected: PASS — the seven API tests plus Task 6's four.

- [ ] **Step 9: Commit**

```bash
git add packages/contracts apps/api
git commit -m "feat(api): POST /v1/telemetry under a third scope that can do exactly one thing"
```

---

## Task 8: The arithmetic — wall clock to run offsets

Spec §6's re-bucketing, and §4's reset detection. Pure, in
`packages/statistics`, where the ESLint rule already forbids filesystem, HTTP,
database and Nest imports.

**Files:**
- Create: `packages/statistics/src/telemetry.ts`, `packages/statistics/test/telemetry.test.ts`
- Modify: `packages/statistics/src/index.ts`

**Interfaces:**
- Consumes: nothing (pure). Its input type is structurally
  `StoredTelemetrySample` from Task 6, restated locally so the pure package
  does not import the persistence package.
- Produces:
  - `interface TelemetryInput` — `host, sampledAtMs, receivedAtMs` + the
    fourteen counters + `tcpStates`
  - `interface TelemetryPoint` — `startOffsetMs`, the nine nullable rate fields,
    the two gauges, `tcpStates`
  - `interface TelemetryHostSeries` — `{ host, clockSkewMs, points }`
  - `toTelemetrySeries(samples, toolStartedAtMs, bucketWidthMs): TelemetryHostSeries[]`
  - `CLOCK_SKEW_WARN_MS = 5_000`

- [ ] **Step 1: Write the failing tests**

`packages/statistics/test/telemetry.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { toTelemetrySeries, type TelemetryInput } from '../src/telemetry.js';

const T0 = Date.UTC(2026, 7, 17, 10, 0, 0);

/** Counters climb linearly with `n`; overrides state what a test is about. */
const at = (n: number, over: Partial<TelemetryInput> = {}): TelemetryInput => ({
  host: 'gen-1',
  sampledAtMs: T0 + n * 1000,
  receivedAtMs: T0 + n * 1000 + 50,
  cpuUserMs: 100 * n, cpuSystemMs: 50 * n, cpuIdleMs: 850 * n, cpuIowaitMs: 0,
  memUsedBytes: 1_000_000, memTotalBytes: 8_000_000,
  netRxBytes: 10_000 * n, netTxBytes: 20_000 * n,
  tcpInSegs: 100 * n, tcpOutSegs: 120 * n, tcpRetransSegs: 2 * n, tcpInErrs: n,
  tcpActiveOpens: 5 * n, tcpPassiveOpens: 3 * n,
  tcpStates: { ESTABLISHED: 10 },
  ...over,
});

describe('toTelemetrySeries', () => {
  it('derives CPU percentages from Δbusy/Δtotal', () => {
    const samples = [at(1), at(2)];
    const [series] = toTelemetrySeries(samples, T0, 1000);
    const point = series!.points.at(-1)!;

    // DERIVED FROM THE INPUT, not written down. busy = user + system + iowait.
    const dUser = samples[1]!.cpuUserMs - samples[0]!.cpuUserMs;
    const dSys = samples[1]!.cpuSystemMs - samples[0]!.cpuSystemMs;
    const dIdle = samples[1]!.cpuIdleMs - samples[0]!.cpuIdleMs;
    const dTotal = dUser + dSys + dIdle;

    expect(point.cpuUserPct).toBeCloseTo((dUser / dTotal) * 100, 6);
    expect(point.cpuSystemPct).toBeCloseTo((dSys / dTotal) * 100, 6);
    expect(point.cpuTotalPct).toBeCloseTo(((dUser + dSys) / dTotal) * 100, 6);
  });

  it('derives byte and segment rates against the ACTUAL elapsed time', () => {
    // 2500ms apart, not the agent's nominal 1000. A rate computed against an
    // assumed interval would be wrong by exactly this drift.
    const samples = [at(1), at(1, { sampledAtMs: T0 + 3500 })];
    samples[1] = { ...samples[1]!, netRxBytes: samples[0]!.netRxBytes + 25_000 };

    const [series] = toTelemetrySeries(samples, T0, 1000);
    const point = series!.points.at(-1)!;

    const dBytes = samples[1]!.netRxBytes - samples[0]!.netRxBytes;
    const dSeconds = (samples[1]!.sampledAtMs - samples[0]!.sampledAtMs) / 1000;
    expect(point.rxBytesPerSec).toBeCloseTo(dBytes / dSeconds, 6);
  });

  it('SKIPS the interval across a counter reset rather than drawing a spike', () => {
    // A process restart or interface flap sends the counter back to zero.
    // Given raw values the server sees current < previous; given a
    // pre-computed rate it would see a plausible enormous spike and draw it.
    const samples = [at(5), at(6, { netRxBytes: 0, netTxBytes: 0 })];
    const [series] = toTelemetrySeries(samples, T0, 1000);
    const point = series!.points.at(-1)!;

    expect(point.rxBytesPerSec).toBeNull();
    expect(point.txBytesPerSec).toBeNull();
    // The whole interval is void, not just the counter that reset: the reset
    // means the source restarted, so nothing it reported is comparable.
    expect(point.cpuTotalPct).toBeNull();
    expect(point.inSegsPerSec).toBeNull();
    // GAUGES SURVIVE. Memory and connection states are instantaneous readings,
    // not differences, and are still true across a restart.
    expect(point.memUsedBytes).toBe(samples[1]!.memUsedBytes);
    expect(point.tcpStates).toEqual(samples[1]!.tcpStates);
  });

  it('drops samples before the run and keeps the one that seeds the first delta', () => {
    // The lookback sample at -1s produces no point of its own (negative
    // offset) but IS the predecessor the first in-run point differences
    // against — which is the entire reason TELEMETRY_LOOKBACK_MS exists.
    const before = at(0, { sampledAtMs: T0 - 1000 });
    const first = at(1, { sampledAtMs: T0 });
    const [series] = toTelemetrySeries([before, first], T0, 1000);

    expect(series!.points.map((p) => p.startOffsetMs)).toEqual([0]);
    expect(series!.points[0]!.cpuTotalPct).not.toBeNull();
  });

  it('excludes a sample past the end of the window', () => {
    const inside = at(1, { sampledAtMs: T0 + 1000 });
    const outside = at(2, { sampledAtMs: T0 + 9000 });
    const [series] = toTelemetrySeries([inside, outside], T0, 1000, 5000);
    expect(series!.points.every((p) => p.startOffsetMs < 5000)).toBe(true);
  });

  it('buckets to the run width and separates hosts', () => {
    const a = [at(1), at(2), at(3)];
    const b = a.map((s) => ({ ...s, host: 'gen-2' }));
    const series = toTelemetrySeries([...a, ...b], T0, 2000);

    expect(series.map((s) => s.host).sort()).toEqual(['gen-1', 'gen-2']);
    // Offsets are multiples of the bucket width, ascending, unique.
    for (const s of series) {
      const offsets = s.points.map((p) => p.startOffsetMs);
      expect(offsets.every((o) => o % 2000 === 0)).toBe(true);
      expect([...offsets].sort((x, y) => x - y)).toEqual(offsets);
      expect(new Set(offsets).size).toBe(offsets.length);
    }
  });

  it('reports the largest clock gap, signed', () => {
    const ahead = at(1, { sampledAtMs: T0 + 1000, receivedAtMs: T0 + 1000 - 30_000 });
    const [series] = toTelemetrySeries([at(0), ahead], T0, 1000);
    // received BEFORE sampled means the agent's clock is AHEAD of the
    // server's. Negative, and large — a generator thirty seconds fast would
    // otherwise misalign every chart with nothing looking wrong.
    expect(series!.clockSkewMs).toBe(ahead.receivedAtMs - ahead.sampledAtMs);
  });

  it('returns nothing for no samples', () => {
    expect(toTelemetrySeries([], T0, 1000)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
nvm use && pnpm test:unit -- telemetry
```

Expected: FAIL — cannot resolve `../src/telemetry.js`.

- [ ] **Step 3: Write the implementation**

`packages/statistics/src/telemetry.ts`:

```ts
/**
 * Wall-clock host samples → the run's own elapsed-offset buckets.
 *
 * This one conversion is what makes the whole feature cheap. Once a telemetry
 * series is offset-based and bucketed like every other series in the system, it
 * inherits — with no further work — the shared crosshair, the same x-axis as
 * every other chart, and the `?from=&to=` window, because that window is
 * expressed in the same offsets.
 *
 * ALL COUNTER ARITHMETIC LIVES HERE, not in the agent. The spec's testing table
 * once put it on the agent; that would give two implementations of reset
 * detection that can disagree, in two languages, with only one of them covered
 * by the suite a change to the charts would run.
 */

/** Above this the UI warns rather than quietly misaligning every chart. */
export const CLOCK_SKEW_WARN_MS = 5_000;

/** One stored sample. Structurally `StoredTelemetrySample` from the
 *  persistence package, restated so this pure package imports nothing. */
export interface TelemetryInput {
  host: string;
  sampledAtMs: number;
  receivedAtMs: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  cpuIdleMs: number;
  cpuIowaitMs: number;
  memUsedBytes: number;
  memTotalBytes: number;
  netRxBytes: number;
  netTxBytes: number;
  tcpInSegs: number;
  tcpOutSegs: number;
  tcpRetransSegs: number;
  tcpInErrs: number;
  tcpActiveOpens: number;
  tcpPassiveOpens: number;
  tcpStates: Record<string, number>;
}

/**
 * One bucket for one host.
 *
 * Every RATE is nullable, and `null` is load-bearing: it means "this interval
 * cannot be measured" — the first sample of a host, or an interval spanning a
 * counter reset. Zero would claim the generator did nothing, which is the one
 * reading a reader must not be handed for a missing measurement.
 *
 * The two GAUGES are not nullable. They are instantaneous readings, not
 * differences, and are still true across a restart.
 */
export interface TelemetryPoint {
  startOffsetMs: number;
  cpuTotalPct: number | null;
  cpuUserPct: number | null;
  cpuSystemPct: number | null;
  memUsedBytes: number;
  memTotalBytes: number;
  rxBytesPerSec: number | null;
  txBytesPerSec: number | null;
  inSegsPerSec: number | null;
  outSegsPerSec: number | null;
  retransSegsPerSec: number | null;
  inErrsPerSec: number | null;
  activeOpensPerSec: number | null;
  passiveOpensPerSec: number | null;
  tcpStates: Record<string, number>;
}

export interface TelemetryHostSeries {
  host: string;
  /**
   * `receivedAt - sampledAt` for the sample where that gap was largest in
   * absolute value, SIGNED. Healthy agents report a small positive number
   * (network latency). A large NEGATIVE value means the agent's clock is ahead
   * of the server's, which is unsolvable without a handshake and detectable
   * without one — the honest middle.
   */
  clockSkewMs: number;
  points: TelemetryPoint[];
}

/** The counters a reset can appear in. A reset in ANY of them voids the whole
 *  interval: the source restarted, so nothing it reported is comparable. */
const CUMULATIVE = [
  'cpuUserMs', 'cpuSystemMs', 'cpuIdleMs', 'cpuIowaitMs',
  'netRxBytes', 'netTxBytes',
  'tcpInSegs', 'tcpOutSegs', 'tcpRetransSegs', 'tcpInErrs',
  'tcpActiveOpens', 'tcpPassiveOpens',
] as const satisfies readonly (keyof TelemetryInput)[];

const rate = (delta: number, seconds: number): number | null =>
  seconds > 0 ? delta / seconds : null;

/**
 * @param samples      every sample for the tenant in the run's window PLUS the
 *                     lookback before it. Order does not matter; this sorts.
 * @param toolStartedAtMs the load test's own start — offset zero.
 * @param bucketWidthMs   the run's own width, so these buckets line up with
 *                        every other chart's.
 * @param durationMs      the run's span. Samples past it are excluded.
 *                        Defaults to Infinity for a caller that has already
 *                        bounded its query.
 */
export function toTelemetrySeries(
  samples: readonly TelemetryInput[],
  toolStartedAtMs: number,
  bucketWidthMs: number,
  durationMs = Number.POSITIVE_INFINITY,
): TelemetryHostSeries[] {
  const byHost = new Map<string, TelemetryInput[]>();
  for (const s of samples) {
    let list = byHost.get(s.host);
    if (!list) {
      list = [];
      byHost.set(s.host, list);
    }
    list.push(s);
  }

  const out: TelemetryHostSeries[] = [];
  for (const [host, list] of byHost) {
    list.sort((a, b) => a.sampledAtMs - b.sampledAtMs);

    let clockSkewMs = 0;
    // Rates accumulate per bucket and are averaged; several samples can land
    // in one bucket once the engine has halved a long run's resolution.
    const buckets = new Map<number, { sums: Map<string, number>; counts: Map<string, number>; last: TelemetryInput }>();

    for (let i = 0; i < list.length; i++) {
      const cur = list[i]!;

      const skew = cur.receivedAtMs - cur.sampledAtMs;
      if (Math.abs(skew) > Math.abs(clockSkewMs)) clockSkewMs = skew;

      const offsetMs = cur.sampledAtMs - toolStartedAtMs;
      // The lookback samples land here. They produce no point of their own —
      // the run's axis starts at zero — but they have already served their
      // purpose as the predecessor of the first in-run sample.
      if (offsetMs < 0 || offsetMs >= durationMs) continue;

      const startOffsetMs = Math.floor(offsetMs / bucketWidthMs) * bucketWidthMs;
      let bucket = buckets.get(startOffsetMs);
      if (!bucket) {
        bucket = { sums: new Map(), counts: new Map(), last: cur };
        buckets.set(startOffsetMs, bucket);
      }
      // Gauges take the LAST sample in the bucket rather than an average: a
      // state histogram is a snapshot, not a quantity that averages, and
      // memory follows it so the two describe the same instant.
      bucket.last = cur;

      const prev = list[i - 1];
      if (!prev) continue;

      // ═══ RESET DETECTION ═══
      // A process restart or interface flap sends a counter back to zero.
      // Skipping the interval is the only honest answer: the alternative is a
      // spike indistinguishable from a real traffic burst, which would be the
      // first thing a reader believed.
      if (CUMULATIVE.some((k) => (cur[k] as number) < (prev[k] as number))) continue;

      const seconds = (cur.sampledAtMs - prev.sampledAtMs) / 1000;

      const dUser = cur.cpuUserMs - prev.cpuUserMs;
      const dSystem = cur.cpuSystemMs - prev.cpuSystemMs;
      const dIowait = cur.cpuIowaitMs - prev.cpuIowaitMs;
      const dIdle = cur.cpuIdleMs - prev.cpuIdleMs;
      // Δbusy / Δtotal across a PAIR of samples, never cpu.Percent(), which
      // blocks for its interval and would make the agent pause inside the
      // measurement it is taking.
      const dTotal = dUser + dSystem + dIowait + dIdle;

      const add = (key: string, value: number | null) => {
        if (value === null || !Number.isFinite(value)) return;
        bucket!.sums.set(key, (bucket!.sums.get(key) ?? 0) + value);
        bucket!.counts.set(key, (bucket!.counts.get(key) ?? 0) + 1);
      };

      if (dTotal > 0) {
        add('cpuUserPct', (dUser / dTotal) * 100);
        add('cpuSystemPct', (dSystem / dTotal) * 100);
        add('cpuTotalPct', ((dUser + dSystem + dIowait) / dTotal) * 100);
      }
      add('rxBytesPerSec', rate(cur.netRxBytes - prev.netRxBytes, seconds));
      add('txBytesPerSec', rate(cur.netTxBytes - prev.netTxBytes, seconds));
      add('inSegsPerSec', rate(cur.tcpInSegs - prev.tcpInSegs, seconds));
      add('outSegsPerSec', rate(cur.tcpOutSegs - prev.tcpOutSegs, seconds));
      add('retransSegsPerSec', rate(cur.tcpRetransSegs - prev.tcpRetransSegs, seconds));
      add('inErrsPerSec', rate(cur.tcpInErrs - prev.tcpInErrs, seconds));
      add('activeOpensPerSec', rate(cur.tcpActiveOpens - prev.tcpActiveOpens, seconds));
      add('passiveOpensPerSec', rate(cur.tcpPassiveOpens - prev.tcpPassiveOpens, seconds));
    }

    const points = [...buckets.entries()]
      .sort(([a], [b]) => a - b)
      .map(([startOffsetMs, b]) => {
        const mean = (key: string): number | null => {
          const n = b.counts.get(key) ?? 0;
          return n === 0 ? null : (b.sums.get(key) ?? 0) / n;
        };
        return {
          startOffsetMs,
          cpuTotalPct: mean('cpuTotalPct'),
          cpuUserPct: mean('cpuUserPct'),
          cpuSystemPct: mean('cpuSystemPct'),
          memUsedBytes: b.last.memUsedBytes,
          memTotalBytes: b.last.memTotalBytes,
          rxBytesPerSec: mean('rxBytesPerSec'),
          txBytesPerSec: mean('txBytesPerSec'),
          inSegsPerSec: mean('inSegsPerSec'),
          outSegsPerSec: mean('outSegsPerSec'),
          retransSegsPerSec: mean('retransSegsPerSec'),
          inErrsPerSec: mean('inErrsPerSec'),
          activeOpensPerSec: mean('activeOpensPerSec'),
          passiveOpensPerSec: mean('passiveOpensPerSec'),
          tcpStates: b.last.tcpStates,
        };
      });

    out.push({ host, clockSkewMs, points });
  }

  // Stable order, so a chart's legend and its palette do not shuffle between
  // requests for a run whose hosts arrive from the database in whatever order.
  out.sort((a, b) => a.host.localeCompare(b.host));
  return out;
}
```

- [ ] **Step 4: Export and run**

Add `export * from './telemetry.js';` to `packages/statistics/src/index.ts`.

```bash
nvm use && pnpm test:unit -- telemetry
```

Expected: PASS, eight tests.

- [ ] **Step 5: Commit**

```bash
git add packages/statistics
git commit -m "feat(statistics): wall-clock samples onto the run's axis, with a reset skipped rather than spiked"
```

---

## Task 9: `GET /v1/runs/:id/telemetry`

Spec §6's read half. Inherits the window because it inherits the offsets.

**Files:**
- Modify: `packages/contracts/src/metrics.ts`
- Modify: `apps/api/src/metrics/metrics.controller.ts`, `apps/api/src/metrics/metrics.module.ts` (or `runs.module.ts` — whichever provides `MetricReader`)
- Modify: `apps/api/src/openapi/document.ts`
- Modify: `apps/api/test/telemetry.integration.test.ts`

**Interfaces:**
- Consumes: `TelemetryStore.forRun`, `TELEMETRY_LOOKBACK_MS` (Task 6);
  `toTelemetrySeries`, `CLOCK_SKEW_WARN_MS` (Task 8); `resolveRange`,
  `snapWindow`, `inRange` (existing).
- Produces: `TelemetryResponseSchema` / `TelemetryResponse` in
  `@perfportal/contracts`, consumed by Task 10's `telemetryQuery`.

- [ ] **Step 1: Write the response contract**

In `packages/contracts/src/metrics.ts`:

```ts
export const TelemetryPointSchema = z.object({
  startOffsetMs: z.number().int(),
  /**
   * `null` means THIS INTERVAL CANNOT BE MEASURED — the first sample of a
   * host, or an interval spanning a counter reset. Never zero for that: zero
   * would claim the generator did nothing.
   */
  cpuTotalPct: z.number().nullable(),
  cpuUserPct: z.number().nullable(),
  cpuSystemPct: z.number().nullable(),
  /** Gauges. Not nullable — instantaneous readings survive a restart. */
  memUsedBytes: z.number(),
  memTotalBytes: z.number(),
  rxBytesPerSec: z.number().nullable(),
  txBytesPerSec: z.number().nullable(),
  inSegsPerSec: z.number().nullable(),
  outSegsPerSec: z.number().nullable(),
  retransSegsPerSec: z.number().nullable(),
  inErrsPerSec: z.number().nullable(),
  activeOpensPerSec: z.number().nullable(),
  passiveOpensPerSec: z.number().nullable(),
  tcpStates: z.record(z.string(), z.number().int().nonnegative()),
});

export const TelemetryResponseSchema = z.object({
  runId: z.string().uuid(),
  /**
   * False when no agent reported for this run's window — either because
   * `toolStartedAt` is null (the run never finished parsing, so it HAS no
   * window) or because nothing overlapped it.
   *
   * There is no "the generator was idle" state to confuse this with: an agent
   * that ran produced samples. The UI must say "no telemetry was recorded"
   * rather than draw empty axes, which would read as a quiet machine.
   */
  available: z.boolean(),
  /** The run's own width, so these buckets line up with every other chart. */
  bucketWidthMs: z.number().int().positive(),
  /** The window this payload was computed over, or null for the whole run.
   *  Non-null values are SNAPPED to bucket boundaries — see WindowSchema. */
  window: WindowSchema.nullable(),
  hosts: z.array(
    z.object({
      host: z.string(),
      /**
       * `receivedAt - sampledAt` where that gap was largest, SIGNED. A large
       * negative value means this generator's clock is AHEAD of the server's,
       * and every point below is misaligned on the run's axis by roughly that
       * much — with nothing about the chart looking wrong. The UI warns above
       * CLOCK_SKEW_WARN_MS rather than quietly misaligning.
       */
      clockSkewMs: z.number().int(),
      points: z.array(TelemetryPointSchema),
    }),
  ),
});
export type TelemetryResponse = z.infer<typeof TelemetryResponseSchema>;
```

- [ ] **Step 2: Write the failing tests**

Append to `apps/api/test/telemetry.integration.test.ts`. Seed a run with a
known `toolStartedAt` and `durationMs` (follow `window.integration.test.ts`'s
setup), POST telemetry with the telemetry token, then:

```ts
describe('GET /v1/runs/:id/telemetry', () => {
  it('places samples on the run\'s own elapsed axis', async () => {
    // sampledAt values are built from the run's OWN toolStartedAt, so the
    // expected offsets are derived from what was posted rather than written.
    const res = await get(`/v1/runs/${runId}/telemetry`);
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);

    const host = res.body.hosts.find((h: { host: string }) => h.host === 'gen-1');
    expect(host).toBeDefined();
    const expected = posted.map((s) =>
      Math.floor((Date.parse(s.sampledAt) - toolStartedAt.getTime()) / res.body.bucketWidthMs)
      * res.body.bucketWidthMs,
    );
    expect(host.points.map((p: { startOffsetMs: number }) => p.startOffsetMs))
      .toEqual([...new Set(expected)].sort((a, b) => a - b));
  });

  it('reports available: false for a run whose toolStartedAt is null', async () => {
    const res = await get(`/v1/runs/${unparsedRunId}/telemetry`);
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(res.body.hosts).toEqual([]);
  });

  it('reports available: false when no agent reported', async () => {
    const res = await get(`/v1/runs/${runWithNoTelemetryId}/telemetry`);
    expect(res.body.available).toBe(false);
  });

  it('narrows to ?from=&to= exactly as /series does', async () => {
    const whole = await get(`/v1/runs/${runId}/telemetry`);
    const width = whole.body.bucketWidthMs;
    const windowed = await get(`/v1/runs/${runId}/telemetry?from=0&to=${width * 2}`);

    expect(windowed.body.window).not.toBeNull();
    // Half-open, matching every other windowed endpoint: >= from AND < to.
    for (const h of windowed.body.hosts) {
      for (const p of h.points) {
        expect(p.startOffsetMs).toBeGreaterThanOrEqual(windowed.body.window.fromMs);
        expect(p.startOffsetMs).toBeLessThan(windowed.body.window.toMs);
      }
    }
    // Availability is a property of the RUN, not of the window — asked before
    // filtering, so a window over a quiet stretch does not read as "never
    // recorded".
    expect(windowed.body.available).toBe(whole.body.available);
  });

  it('separates hosts', async () => {
    const res = await get(`/v1/runs/${runId}/telemetry`);
    expect(res.body.hosts.map((h: { host: string }) => h.host)).toEqual(['gen-1', 'gen-2']);
  });

  it('requires the read scope, and a telemetry token does not have it', async () => {
    const res = await request(ctx.app.getHttpServer())
      .get(`/v1/runs/${runId}/telemetry`)
      .set('Authorization', `Bearer ${ctx.telemetryToken}`);
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 3: Run to verify they fail**

```bash
nvm use && pnpm test:integration -- telemetry
```

Expected: FAIL — 404.

- [ ] **Step 4: Write the handler**

In `apps/api/src/metrics/metrics.controller.ts`, inject `TelemetryStore`
alongside `MetricReader` and add:

```ts
  /**
   * Host telemetry for this run, on this run's own elapsed axis.
   *
   * TAKES NO `scope`/`name`. Telemetry is a property of the MACHINE, not of a
   * request or a group, so the `?name=X` without `?scope=` trap the sibling
   * endpoints carry cannot arise here: there is nothing to forget to send. The
   * one dimension is `host`, and the client filters on it — six charts for one
   * host at a time, because an aggregate across a fleet would hide the single
   * saturated generator this whole feature exists to find.
   */
  @Get('telemetry')
  @Scopes('read')
  async telemetry(
    @Param('id', uuidParam('id')) id: string,
    @Req() req: Request,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<TelemetryResponse> {
    const run = await this.#run(req, id);
    const range = await resolveRange(this.reader, run, from, to);
    const scope = { orgId: run.orgId, projectId: run.projectId };

    // The run's OWN bucket width, from its own series — never a 1000ms
    // constant. The engine halves resolution on a long run, and assuming 1000
    // would put telemetry on a different x-grid from every chart beside it.
    const series = await this.reader.series(scope, run.id, run.startedOn, {
      scope: 'run', name: '', family: 'response_time',
    });
    const offsets = series.map((b) => b.startOffsetMs);
    const bucketWidthMs = offsets.length > 0 ? inferBucketWidthMs([...offsets].sort((a, b) => a - b)) : 1000;

    // A run that never finished parsing has no toolStartedAt, so it has no
    // window at all — and therefore no telemetry. Reported as unavailable
    // rather than as an empty chart, which would read as an idle generator.
    if (run.toolStartedAt === null) {
      return { runId: run.id, available: false, bucketWidthMs, window: null, hosts: [] };
    }

    const startMs = run.toolStartedAt.getTime();
    const durationMs = run.durationMs ?? 0;
    const samples = await this.telemetry_.forRun(
      scope,
      // The lookback is what gives the first in-run bucket a predecessor to
      // difference against; toTelemetrySeries drops the negative offsets.
      startMs - TELEMETRY_LOOKBACK_MS,
      startMs + durationMs,
    );

    // Availability asked BEFORE the window filter, for the same reason
    // errors/series asks it before filtering: a window over a quiet stretch
    // must read as "nothing here", never as "this run was never recorded".
    const available = samples.length > 0;

    const all = toTelemetrySeries(samples, startMs, bucketWidthMs, durationMs);
    const hosts = all
      .map((h) => ({ ...h, points: h.points.filter((p) => inRange(p.startOffsetMs, range)) }))
      .filter((h) => h.points.length > 0);

    const everyOffset = all.flatMap((h) => h.points.map((p) => p.startOffsetMs));
    return {
      runId: run.id,
      available,
      bucketWidthMs,
      window: range === null ? null : snapWindow(everyOffset, range),
      hosts,
    };
  }
```

`this.telemetry_` is the injected `TelemetryStore`; name it to avoid colliding
with the method. Provide it in whichever module already provides `MetricReader`
for this controller — `runs.module.ts` had to provide `MetricReader`
explicitly or the API refused to boot, and the same applies here.

- [ ] **Step 5: Document it in OpenAPI**

Add the path to `apps/api/src/openapi/document.ts`, including the `from`/`to`
parameters and the `available` semantics.

- [ ] **Step 6: Run to verify they pass**

```bash
nvm use && pnpm test:integration -- telemetry
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts apps/api
git commit -m "feat(api): GET /v1/runs/:id/telemetry, on the run's own axis so the window comes free"
```

---

## Task 10: The Load generators tab

Spec §7. Six charts on the `run-time` crosshair group, one host at a time.

**Files:**
- Create: `apps/web/src/charts/transforms/telemetry.ts`, `apps/web/src/charts/TelemetryCharts.tsx`, `apps/web/src/routes/RunTelemetry.tsx`
- Create: `apps/web/test/telemetryTransform.test.ts`, `apps/web/test/RunTelemetry.test.tsx`
- Modify: `apps/web/src/api/metrics.ts`, `apps/web/src/routes/paths.ts`, `apps/web/src/routes/RunTabs.tsx`, `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: `TelemetryResponse`, `CLOCK_SKEW_WARN_MS`, `useWindowFromShell`,
  `Chart`, `EmptyState`.
- Produces: `runTelemetryPath(runId)`, `telemetryQuery(id, window)`,
  `telemetryQueryKey(id, window)`, and a route at
  `/runs/:runId/load-generators`.

- [ ] **Step 1: Add the path and the query**

`apps/web/src/routes/paths.ts`:

```ts
/**
 * `load-generators`, not `telemetry`. The URL is the reader's, and "load
 * generators" is what Gatling calls this section and what the question in the
 * reader's head sounds like — "was the generator the bottleneck?". The endpoint
 * keeps the engineering name.
 */
export function runTelemetryPath(runId: string): string {
  return `${runPath(runId)}/load-generators`;
}
```

`apps/web/src/api/metrics.ts`:

```ts
/* -------------------------------------------------------------------- *
 * load-generator telemetry — CPU, memory, bandwidth, TCP (spec §7)
 * -------------------------------------------------------------------- */

export const telemetryQueryKey = (id: string, window: Window | null = null) =>
  ['run', id, 'telemetry', window?.fromMs ?? null, window?.toMs ?? null] as const;

/**
 * TAKES NO `scope`/`name`, like `errorSeriesQuery` and for the same reason:
 * the endpoint declares no such parameters, so the "`?name=` without `scope=`
 * is silently ignored" trap has nothing to catch here.
 *
 * The window IS in the key. A windowed and an unwindowed payload are different
 * answers, and sharing a key under `staleTime: Infinity` would serve one for
 * the other.
 */
export const telemetryQuery = (id: string, window: Window | null = null) => ({
  queryKey: telemetryQueryKey(id, window),
  queryFn: () =>
    apiFetch(TelemetryResponseSchema, `${runPath(id)}/telemetry${rangeSuffix(window)}`),
  staleTime: Infinity,
});
```

- [ ] **Step 2: Write the failing transform test**

`apps/web/test/telemetryTransform.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { toCpuChart, toMemoryChart, toTcpStateChart } from '../src/charts/transforms/telemetry';

const host = {
  host: 'gen-1',
  clockSkewMs: 40,
  points: [
    { startOffsetMs: 0, cpuTotalPct: 12, cpuUserPct: 8, cpuSystemPct: 4,
      memUsedBytes: 2 * 1024 * 1024, memTotalBytes: 8 * 1024 * 1024,
      rxBytesPerSec: 1000, txBytesPerSec: 2000, inSegsPerSec: 10, outSegsPerSec: 12,
      retransSegsPerSec: 0, inErrsPerSec: 0, activeOpensPerSec: 1, passiveOpensPerSec: 0,
      tcpStates: { ESTABLISHED: 10, TIME_WAIT: 4 } },
    { startOffsetMs: 1000, cpuTotalPct: null, cpuUserPct: null, cpuSystemPct: null,
      memUsedBytes: 3 * 1024 * 1024, memTotalBytes: 8 * 1024 * 1024,
      rxBytesPerSec: null, txBytesPerSec: null, inSegsPerSec: null, outSegsPerSec: null,
      retransSegsPerSec: null, inErrsPerSec: null, activeOpensPerSec: null,
      passiveOpensPerSec: null, tcpStates: { ESTABLISHED: 12 } },
  ],
};

describe('telemetry transforms', () => {
  it('keeps an unmeasurable interval as null rather than zero', () => {
    const chart = toCpuChart(host);
    const total = chart.series.find((s) => /total/i.test(s.name))!;
    // ECharts draws a GAP for null and a point on the floor for 0. Zero here
    // would claim the generator was idle across a counter reset.
    expect(total.values[1]).toBeNull();
  });

  it('converts memory to MB, as Gatling labels it', () => {
    const chart = toMemoryChart(host);
    const used = chart.series.find((s) => /used/i.test(s.name))!;
    expect(used.values[0]).toBeCloseTo(host.points[0]!.memUsedBytes / (1024 * 1024), 6);
  });

  it('gives every state seen anywhere its own series, zero-filled where absent', () => {
    const chart = toTcpStateChart(host);
    expect(chart.series.map((s) => s.name).sort()).toEqual(['ESTABLISHED', 'TIME_WAIT']);
    // TIME_WAIT is absent from the second point — absent means zero (the
    // migration's "absent when zero"), NOT a gap in the line.
    const timeWait = chart.series.find((s) => s.name === 'TIME_WAIT')!;
    expect(timeWait.values[1]).toBe(0);
  });

  it('uses the payload\'s own offsets as the x axis', () => {
    expect(toCpuChart(host).x).toEqual(host.points.map((p) => p.startOffsetMs));
  });
});
```

- [ ] **Step 3: Run to verify it fails**

```bash
nvm use && pnpm test:unit -- telemetryTransform
```

Expected: FAIL — module not found.

- [ ] **Step 4: Write the transforms**

`apps/web/src/charts/transforms/telemetry.ts` — six functions returning
whatever shape `Chart` consumes (read `transforms/errorSeries.ts` and match it
exactly). Six exports:

- `toCpuChart(host)` — Total / User / Sys, `unit: '%'`
- `toMemoryChart(host)` — Used / Total in MB, `unit: ' MB'`
- `toBandwidthChart(host)` — Received / Sent, bytes/s
- `toConnectionEventsChart(host)` — Active opens / Passive opens, /s
- `toSegmentEventsChart(host)` — Received / Sent / Retransmitted / Received bad, /s
- `toTcpStateChart(host)` — one series per state seen anywhere in the payload,
  zero-filled where a point omits it

Header comment for the file:

```ts
/**
 * Gatling's own decomposition of the Load Generators section, one function per
 * chart, so a difference between what they draw and what we draw is a diff in
 * one place.
 *
 * `null` IS PRESERVED, NEVER COERCED TO 0. ECharts draws a gap for null and a
 * point on the floor for zero — and a rate is null exactly when the interval
 * could not be measured (the first sample of a host, or one spanning a counter
 * reset). A zero there would claim the generator went quiet at the precise
 * moment it restarted.
 *
 * TCP STATES ARE THE OPPOSITE: absent means zero, because the migration stores
 * the states the kernel actually reported and omits the ones at zero. So the
 * state chart zero-fills, and only the state chart.
 */
```

- [ ] **Step 5: Write the route**

`apps/web/src/routes/RunTelemetry.tsx`:

- reads `useWindowFromShell()` and the `runId` param
- `useQuery(telemetryQuery(runId, window))`
- `available === false` → `EmptyState` reading *"No telemetry was recorded for
  this run."* with a second line explaining the agent must run on the
  generators. **Not an empty chart** — that would read as an idle machine.
- a host `<select>` when `hosts.length > 1`, labelled "Load generator",
  defaulting to `hosts[0]`; hidden when there is exactly one
- when `Math.abs(host.clockSkewMs) > CLOCK_SKEW_WARN_MS`, a `role="status"`
  banner naming the gap and the direction
- six `<Chart>`s, each `group="run-time"`, `xAxis={{ type: 'value', name: 'Elapsed (ms)' }}`

Rules that bite, restated in the file's header comment:

```tsx
/**
 * ═══ NO ICON, NO DECORATIVE SVG IN ANY FIGURE ═══
 * `Chart` renders its data table INSIDE the `<figure>`, and the e2e suite
 * proves a chart really drew by counting SVG elements within it —
 * `toHaveCount(1)` per chart. An icon makes the count wrong AND destroys the
 * invariant it rests on.
 *
 * ═══ NO `uppercase` ON THE SECTION HEADINGS OR THE SELECT LABEL ═══
 * Playwright applies `text-transform` when computing an accessible name;
 * jsdom does not. A heading queried by name must not carry it.
 *
 * ═══ THE `run-time` GROUP IS THE WHOLE POINT ═══
 * Hovering any one of the six telemetry charts moves the pointer on the
 * other five at the same instant — the reason this tab exists rather than a
 * link out to Grafana. It works only because the endpoint returns the run's
 * own offsets at the run's own bucket width.
 */
```

- [ ] **Step 6: Wire the tab and the route**

`RunTabs.tsx` — a fifth `<Tab to={runTelemetryPath(runId)}>Load generators</Tab>`,
**after Charts and before Errors**. Update that component's doc comment, which
currently says "A run's four sections" and explains the Trends-goes-last
argument; extend it rather than leaving it stale:

```
 * Load generators sits between Charts and Errors: it answers a question about
 * THIS run (which is what the first tabs do), and it is the one a reader turns
 * to when the charts look wrong — so it belongs beside them, not after the
 * failures. Trends stays last for the reason below: it is the only tab that
 * leaves the run.
```

`App.tsx` — `<Route path="load-generators" element={<RunTelemetry />} />` inside
the `/runs/:runId` element.

- [ ] **Step 7: Write the component test**

`apps/web/test/RunTelemetry.test.tsx` — render with a stubbed fetch (follow an
existing route test in `apps/web/test`), and assert:

- `available: false` renders the empty-state text and **no** `figure`
- two hosts render a `combobox` named "Load generator"; selecting the second
  changes which host's numbers are on screen
- `clockSkewMs` beyond the threshold renders the `role="status"` banner; a
  small skew does not

- [ ] **Step 8: Run the unit suite**

```bash
nvm use && pnpm test:unit
```

Expected: everything green, and the totals **at or above 78 files / 904 tests**.
Below that, the DOM environment did not load — check `node -v` reads 22.

- [ ] **Step 9: Commit**

```bash
git add apps/web
git commit -m "feat(web): a Load generators tab on the same crosshair as everything it explains"
```

---

## Task 11: Browser coverage, the ledger, and the full gate

Spec §8's e2e row and §11's ledger rows.

**Files:**
- Create: `apps/web/e2e/run-telemetry.spec.ts`
- Modify: `apps/web/e2e/fixtures.ts`
- Modify: the published parity-ledger artifact (see Step 5)

**Interfaces:**
- Consumes: everything above.
- Produces: a green full gate.

- [ ] **Step 1: Seed telemetry in the e2e fixtures**

In `apps/web/e2e/fixtures.ts`, after the reference run is ingested and its
`toolStartedAt` is known, insert telemetry for **two** hosts across the run's
window using `TelemetryStore` directly (the fixture already imports from
`@perfportal/persistence`).

**Host names must not collide with anything else in the document.** Every
authenticated page carries `ProjectRail`'s N project links, and Playwright's
`name` match is a case-insensitive substring — so a host called `checkout`
would be matched by a rail row. Use `lg-alpha` and `lg-bravo`: no seeded
project, run or request name is a substring or case variant of either.

Counters must climb monotonically across samples so rates are non-null, and one
host should carry a deliberate reset partway so the browser sees a real gap.

- [ ] **Step 2: Write the failing spec**

`apps/web/e2e/run-telemetry.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

test.describe('Load generators', () => {
  test('draws six charts for the selected host', async ({ page }) => {
    await page.goto(`/runs/${runId}/load-generators`);

    // `exact: true` EVERYWHERE. Playwright's default name match is a
    // case-insensitive SUBSTRING, and ProjectRail puts N project links in this
    // document — a loose match can resolve against a rail row instead.
    await expect(page.getByRole('link', { name: 'Load generators', exact: true }))
      .toHaveAttribute('aria-current', 'page');

    const figures = page.getByRole('figure');
    await expect(figures).toHaveCount(6);

    // ONE SVG PER FIGURE. This is the invariant nine existing specs rest on:
    // a chart that failed to draw renders its axes and nothing else, and only
    // a mark count catches that. It is also why no figure here may contain a
    // decorative icon.
    for (let i = 0; i < 6; i++) {
      await expect(figures.nth(i).locator('svg')).toHaveCount(1);
    }
  });

  test('the host selector switches which generator is shown', async ({ page }) => {
    await page.goto(`/runs/${runId}/load-generators`);
    const select = page.getByRole('combobox', { name: 'Load generator', exact: true });
    await expect(select).toBeVisible();

    // Derived from the payload: whatever the fixture seeded is what the
    // options are. Two hosts were seeded, so there are two.
    const options = await select.locator('option').allTextContents();
    expect(options.length).toBe(2);

    await select.selectOption(options[1]!);
    await expect(page.getByRole('figure')).toHaveCount(6);
  });

  test('the brush narrows telemetry with every other chart', async ({ page }) => {
    await page.goto(`/runs/${runId}/load-generators`);
    const before = await page.getByRole('figure').first().locator('tbody tr').count();

    // The window is a URL parameter, so this is the same narrowing a drag
    // produces, without depending on a drag's pixel geometry.
    await page.goto(`/runs/${runId}/load-generators?from=0&to=4000`);
    const after = await page.getByRole('figure').first().locator('tbody tr').count();

    expect(after).toBeLessThan(before);
    expect(after).toBeGreaterThan(0);
  });

  test('a run with no telemetry says so instead of drawing empty axes', async ({ page }) => {
    await page.goto(`/runs/${runWithoutTelemetryId}/load-generators`);
    await expect(page.getByText(/no telemetry was recorded/i)).toBeVisible();
    await expect(page.getByRole('figure')).toHaveCount(0);
  });
});
```

- [ ] **Step 3: Run e2e**

```bash
nvm use && pnpm build && pnpm test:e2e -- run-telemetry
```

Expected: PASS. If a figure's SVG count is 0, the chart drew nothing — check
that the transform preserved the payload's offsets rather than producing an
empty `x`.

- [ ] **Step 4: Run the full gate**

**Integration BEFORE e2e**, and the Go gate too:

```bash
nvm use && cd agent && go vet ./... && go test ./... -race && cd .. && pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration && pnpm test:e2e
```

Expected: all green. Confirm `test:unit` reports **at least 78 files / 904
tests** — this sub-project adds suites, so the floor should now be higher.
**Update `CLAUDE.md`'s floor to the new measured numbers**, or the next reader
calibrates against a stale value and a silently-skipped run looks like a pass.

- [ ] **Step 5: Update the parity ledger**

Per spec §11, the published parity-ledger artifact (source at
`<scratchpad>/gatling-parity.html`) gets **three new rows and one split** — not
"the three telemetry families are done":

| Row | Score |
|---|---|
| Load generators — CPU, memory, TCP segment and connection events | **Have** — the whole of Gatling's section bar GC, which is blank in theirs |
| Connections — bandwidth, connections by state | **Have** |
| Connections — TCP connect and TLS handshake duration distributions | **Missing**, split into its own row — a bundled row scored Partial hides which half is done, which is why the time-window row was split |
| DNS — resolution duration | **Missing** |

Re-publish to the same artifact URL (pass the existing `url`, or find it with
`action: "list"`); a new file path claims a new link and orphans the old one.

- [ ] **Step 6: Commit and finish**

```bash
git add apps/web CLAUDE.md
git commit -m "test(web): a browser proves six charts drew, per host, and narrow with the brush"
```

Then **REQUIRED SUB-SKILL: superpowers:finishing-a-development-branch.** The
base is `main`; this repo merges with `--merge`, never squash, and does not use
`publish/*` branches.

---

## Self-Review

**Spec coverage.** §0 → the plan's premise, no task needed. §1 → Task 3
(collector) and Task 10 (six charts). §1's "cannot deliver" → nothing built,
recorded in §10/Step 5's ledger. §2 → Tasks 6 (schema, both clocks), 7 (tenant
from token), 9 (window selection, null `toolStartedAt`). §3 → Task 6. §4 →
Tasks 3 (raw on the wire), 7 (`counter()`, no derived fields), 8 (all
arithmetic). §5 → Tasks 2 (buffer), 4 (batching, silent failure, `--host-label`),
5 (footprint). §6 → Tasks 7 (scope, ingest) and 9 (read, re-bucketing). §7 →
Task 10. §8 → every task's tests, and Task 11's e2e row. §9/§9b → Task 1, and
the four layers are the task ordering. §10 → nothing built; the darwin
degradation in Task 3 is the one place non-Linux appears. §11 → Task 11 Step 5.

**Placeholders.** Two remain, deliberately and named as such: Task 6 Step 2
(mirror in `schema.prisma` **only if** the other partitioned tables are mirrored
there — checkable in one look, and guessing would be worse), and Task 10 Step 4
(the transforms return "whatever shape `Chart` consumes" — that shape is
`transforms/errorSeries.ts`, cited by path, and transcribing it here would
create a second copy to drift).

**Type consistency.** `TelemetryInput` (statistics) and
`StoredTelemetrySample` (persistence) are structurally identical by
construction, with `host` on both; the pure package restates rather than imports
so the ESLint boundary holds. The Go `Sample` JSON tags, `TelemetrySampleSchema`
and `InboundTelemetrySample` share one field list — `sampledAt` (ISO string) on
the wire becomes `sampledAtMs` (number) at the controller boundary, once, in
Task 7 Step 6. `TelemetryPoint` is defined in Task 8 and mirrored as
`TelemetryPointSchema` in Task 9 with the same thirteen fields and the same
nullability.

**One gap found and closed while reviewing.** The first draft had
`toTelemetrySeries` take no `durationMs`, so a sample after the run's end had
nothing to exclude it — the lookback was handled and its mirror image was not.
Task 8's signature now takes it and Task 8 Step 1 tests it.
