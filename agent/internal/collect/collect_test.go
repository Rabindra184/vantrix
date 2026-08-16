package collect

import (
	"context"
	"reflect"
	"runtime"
	"testing"
	"time"
)

// warmUp advances c past FIX A's startup grace period (see
// counterSourceDegradeAfterFailures) by sampling it up to K-1 times and
// discarding both results and errors. On a platform where a counter source
// is genuinely unimplemented for the whole process lifetime (e.g.
// ProtoCounters on darwin), Sample now legitimately errors on the first K-1
// calls from a fresh Collector — see that constant's doc comment — so tests
// that only care about a Sample's steady-state shape or timing, and are not
// themselves about the startup behavior, call this first. The startup
// behavior itself is covered by
// TestDegradesRatherThanFailingWhereProtoCountersAreUnavailable.
func warmUp(c *Collector) {
	for i := 0; i < counterSourceDegradeAfterFailures-1; i++ {
		_, _ = c.Sample(context.Background())
	}
}

func TestSampleReadsGaugesAndCumulativeCounters(t *testing.T) {
	c := New()
	warmUp(c)
	s, err := c.Sample(context.Background())
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
	c := New()
	s, err := c.Sample(context.Background())
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
	// The other half of the ProtoUnavailable contract: CI is ubuntu-latest, so
	// this is the ONLY environment that ever proves the flag stays false when
	// the counters really did come back. Without this, its correctness rested
	// entirely on someone happening to run the degraded-path test on a Mac.
	if c.ProtoUnavailable() {
		t.Fatal("ProtoUnavailable() = true, want false — the counters populated above, nothing degraded")
	}
}

// FIX A. A source that has never succeeded must fail
// counterSourceDegradeAfterFailures times IN A ROW before Sample degrades it
// to zero — see counterSourceDegradeAfterFailures's doc comment in
// collect.go for why tick 1 alone cannot tell "not implemented on this
// platform" from "not ready yet". So the first K-1 calls on a platform that
// genuinely lacks ProtoCounters (darwin) must return an error and skip the
// tick, and only the Kth call may degrade cleanly.
func TestDegradesRatherThanFailingWhereProtoCountersAreUnavailable(t *testing.T) {
	if runtime.GOOS == "linux" {
		t.Skip("this asserts the DEGRADED path, which linux does not take")
	}
	c := New()

	for i := 1; i < counterSourceDegradeAfterFailures; i++ {
		if _, err := c.Sample(context.Background()); err == nil {
			t.Fatalf("Sample() call %d: error = nil, want an error — fewer than "+
				"counterSourceDegradeAfterFailures (%d) consecutive failures is too soon to "+
				"presume ProtoCounters is permanently unavailable", i, counterSourceDegradeAfterFailures)
		}
		if c.ProtoUnavailable() {
			t.Fatalf("Sample() call %d: ProtoUnavailable() = true, want false — must not degrade before "+
				"counterSourceDegradeAfterFailures (%d) consecutive failures", i, counterSourceDegradeAfterFailures)
		}
	}

	// The whole point: on a platform with no ProtoCounters, once the
	// consecutive-failure threshold is reached Sample still returns a usable
	// sample rather than an error, so a developer on macOS gets CPU, memory,
	// bandwidth and connection states.
	s, err := c.Sample(context.Background())
	if err != nil {
		t.Fatalf("Sample() call %d (the Kth): error = %v, want a degraded sample and no error",
			counterSourceDegradeAfterFailures, err)
	}
	if s.MemTotalBytes <= 0 {
		t.Fatal("the degraded path dropped the gauges too")
	}
	// The degrade signal itself. This is the only test in the module that
	// exercises c.protoUnavailable.Store(true) at all — CI is ubuntu-latest,
	// so that line of collect.go never runs there. Without this assertion, a
	// developer on macOS could delete the .Store(true) call outright and
	// every test, everywhere, would stay green.
	if !c.ProtoUnavailable() {
		t.Fatal("ProtoUnavailable() = false, want true — ProtoCounters is not implemented on this platform")
	}
	if s.TCPInSegs != 0 || s.TCPOutSegs != 0 || s.TCPActiveOpens != 0 {
		t.Fatalf("TCPInSegs = %d, TCPOutSegs = %d, TCPActiveOpens = %d, want all 0 on the degraded path",
			s.TCPInSegs, s.TCPOutSegs, s.TCPActiveOpens)
	}
}

// FIX A. A collector reading a transient failure (source read successfully
// before, fails now) must be told to skip the tick rather than degrade —
// degrading here is exactly what turns a five-sample series like
//
//	[1000, null] [2000, 2000] [3000, null] [4000, 1006000] [5000, 2000]
//
// into a false 503x spike on recovery (the reset at offset 3 is correctly
// null, but the zero-filled sample sent FOR it means offset 4's delta is
// measured from 0 against a since-boot counter). And a source that has NEVER
// succeeded must not be assumed permanently unavailable from a single
// failure either — tick 1 of a source that is merely not ready yet (a /proc
// permission hiccup at startup, a container still initialising) looks
// identical to tick 1 of a source truly absent from the platform. Sending
// zeros for the former is the SAME false-spike bug through the mirror door:
// zeros now, a real since-boot counter the moment it recovers. Both cases
// are exercised here in isolation, without faking a gopsutil failure on
// demand, which the package does not support.
func TestCounterSourceShouldDegrade(t *testing.T) {
	t.Run("never succeeded, fewer than K consecutive failures -> do NOT degrade (too soon to tell not-ready-yet from not-implemented-here)", func(t *testing.T) {
		var c counterSource
		for i := 1; i < counterSourceDegradeAfterFailures; i++ {
			if c.shouldDegrade() {
				t.Fatalf("shouldDegrade() = true on consecutive failure %d, want false (K = %d)", i, counterSourceDegradeAfterFailures)
			}
		}
	})

	t.Run("never succeeded, K consecutive failures -> degrade (permanently unavailable, zero is safe)", func(t *testing.T) {
		var c counterSource
		for i := 1; i < counterSourceDegradeAfterFailures; i++ {
			c.shouldDegrade()
		}
		if !c.shouldDegrade() {
			t.Fatalf("shouldDegrade() = false on the Kth (%d) consecutive failure, want true", counterSourceDegradeAfterFailures)
		}
	})

	t.Run("succeeded before, now failing -> do NOT degrade no matter how many times (transient; zero would manufacture a spike)", func(t *testing.T) {
		var c counterSource
		c.recordSuccess()
		for i := 0; i < counterSourceDegradeAfterFailures+2; i++ {
			if c.shouldDegrade() {
				t.Fatalf("shouldDegrade() = true on failure %d after a prior success, want false — always transient once it has ever succeeded", i)
			}
		}
	})

	// recordSuccess's effect on shouldDegrade()'s return value is already
	// covered above (once ever succeeded, always false) — this checks the
	// state it is documented to change, consecutiveFailures itself, directly:
	// a later success must not leave a stale count sitting behind the
	// permanently-transient everSucceeded flag.
	t.Run("recordSuccess resets the consecutive-failure count", func(t *testing.T) {
		var c counterSource
		for i := 0; i < counterSourceDegradeAfterFailures-1; i++ {
			c.shouldDegrade()
		}
		if got := c.consecutiveFailures.Load(); got != int64(counterSourceDegradeAfterFailures-1) {
			t.Fatalf("consecutiveFailures = %d before recordSuccess, want %d", got, counterSourceDegradeAfterFailures-1)
		}
		c.recordSuccess()
		if got := c.consecutiveFailures.Load(); got != 0 {
			t.Fatalf("consecutiveFailures = %d after recordSuccess, want 0 — the count must reset on success", got)
		}
	})
}

// A source that keeps failing without ever having succeeded must keep
// degrading on every read once it has reached counterSourceDegradeAfterFailures
// consecutive failures, not just on the Kth — recordSuccess is never called,
// so nothing should flip shouldDegrade() back to false on its own.
func TestCounterSourceKeepsDegradingAcrossRepeatedFailures(t *testing.T) {
	var c counterSource
	for i := 1; i < counterSourceDegradeAfterFailures; i++ {
		if c.shouldDegrade() {
			t.Fatalf("shouldDegrade() = true on consecutive failure %d, want false (K = %d)", i, counterSourceDegradeAfterFailures)
		}
	}
	for i := 0; i < 3; i++ {
		if !c.shouldDegrade() {
			t.Fatalf("shouldDegrade() = false on attempt %d past the threshold, want true", i)
		}
	}
}

// FIX 2 (footprint budget). shouldReadConnections is the predicate that lets
// Sample throttle net.Connections to connectionsMinInterval regardless of the
// caller's own --interval. Extracted so it is testable in isolation, in the
// same style as TestCounterSourceShouldDegrade above — net.Connections itself
// cannot easily be made to fail or have its calls counted from the outside.
func TestShouldReadConnections(t *testing.T) {
	base := time.Date(2026, 8, 16, 12, 0, 0, 0, time.UTC)
	const minInterval = 5 * time.Second

	tests := []struct {
		name     string
		lastRead time.Time
		now      time.Time
		want     bool
	}{
		{
			name:     "zero lastRead (the very first sample) -> always read",
			lastRead: time.Time{},
			now:      base,
			want:     true,
		},
		{
			name:     "one second later, default 1s --interval -> skip (well under the threshold)",
			lastRead: base,
			now:      base.Add(time.Second),
			want:     false,
		},
		{
			name:     "just under the threshold -> skip",
			lastRead: base,
			now:      base.Add(minInterval - time.Millisecond),
			want:     false,
		},
		{
			name:     "exactly the threshold elapsed -> read (>=, not >)",
			lastRead: base,
			now:      base.Add(minInterval),
			want:     true,
		},
		{
			name:     "coarse --interval (10s), longer than the threshold -> reads every tick",
			lastRead: base,
			now:      base.Add(10 * time.Second),
			want:     true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := shouldReadConnections(tt.lastRead, tt.now, minInterval); got != tt.want {
				t.Fatalf("shouldReadConnections(%v, %v, %v) = %v, want %v",
					tt.lastRead, tt.now, minInterval, got, tt.want)
			}
		})
	}
}

// A collector sampled several times in rapid succession (well inside
// connectionsMinInterval) must call net.Connections at most once. There is no
// hook to count gopsutil's own calls, so this asserts the effect that proves
// it: lastConnRead — only ever advanced on an actual read, see
// connectionStates — must not move across three back-to-back Sample() calls.
// Before the fix, Sample called net.Connections on every tick with no
// lastConnRead field at all; this test (and the field it depends on) is part
// of the fix, so reverting the implementation change alone makes it fail to
// even compile, let alone pass.
//
// warmUp first because FIX A can make a fresh Collector's earliest calls
// return an error before ever reaching connectionStates (see that helper's
// doc comment) — that is a different test's concern, not this one's.
func TestSampleReadsConnectionsAtMostOncePerMinInterval(t *testing.T) {
	c := New()
	warmUp(c)
	if _, err := c.Sample(context.Background()); err != nil {
		t.Fatalf("Sample() error = %v", err)
	}

	c.connMu.Lock()
	firstRead := c.lastConnRead
	c.connMu.Unlock()
	if firstRead.IsZero() {
		t.Fatal("lastConnRead is still zero after the first completing Sample() — the first tick that completes must always read connections")
	}

	for i := 0; i < 3; i++ {
		if _, err := c.Sample(context.Background()); err != nil {
			t.Fatalf("Sample() error = %v", err)
		}
	}

	c.connMu.Lock()
	laterRead := c.lastConnRead
	c.connMu.Unlock()
	if !laterRead.Equal(firstRead) {
		t.Fatalf("lastConnRead moved from %v to %v across 3 rapid Sample() calls — "+
			"net.Connections was read more than once inside connectionsMinInterval", firstRead, laterRead)
	}
}

// The first sample always reads connections directly through
// connectionStates, independent of the Sample()-level test above.
func TestConnectionStatesAlwaysReadsOnTheFirstSample(t *testing.T) {
	c := New()
	now := time.Now()
	_ = c.connectionStates(context.Background(), now)

	c.connMu.Lock()
	lastRead := c.lastConnRead
	c.connMu.Unlock()
	if lastRead.IsZero() {
		t.Fatal("lastConnRead is still zero after the first connectionStates() call — " +
			"the first sample must always attempt a real read")
	}
}

// FIX 2's critical property. A skipped tick (well inside
// connectionsMinInterval of the last real read) must carry the previous
// states forward — never send an empty map. toTcpStateChart
// (apps/web/src/charts/transforms/telemetry.ts) zero-fills every state it
// has ever seen for a host, so an empty map on a skipped tick would render
// as every connection state dropping to zero on 4 ticks out of 5: a sawtooth
// with no basis in reality. The collector's internal state is seeded
// directly here (not via a real net.Connections read) so the assertion does
// not depend on what connections happen to exist on the test host.
func TestConnectionStatesCarriesForwardOnASkippedTick(t *testing.T) {
	c := New()
	now := time.Now()
	seeded := map[string]int{"ESTABLISHED": 7, "TIME_WAIT": 3}

	c.connMu.Lock()
	c.lastConnRead = now
	c.lastConnStates = seeded
	c.connMu.Unlock()

	// Well inside connectionsMinInterval (5s): must skip the real read and
	// carry the seeded states forward.
	got := c.connectionStates(context.Background(), now.Add(time.Second))

	if len(got) == 0 {
		t.Fatal("connectionStates on a skipped tick returned an empty map — " +
			"toTcpStateChart zero-fills every state it has ever seen, so this would render " +
			"as every connection dropping to zero (apps/web/src/charts/transforms/telemetry.ts)")
	}
	want := map[string]int{"ESTABLISHED": 7, "TIME_WAIT": 3}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("connectionStates = %v, want the carried-forward %v", got, want)
	}

	// Mutating the returned map must not corrupt the collector's own state —
	// connectionStates must hand back a copy, not the internal map itself.
	got["ESTABLISHED"] = 999
	c.connMu.Lock()
	internal := c.lastConnStates["ESTABLISHED"]
	c.connMu.Unlock()
	if internal != 7 {
		t.Fatalf("mutating the returned map changed the collector's internal state (ESTABLISHED = %d, want 7) — "+
			"connectionStates must return a copy", internal)
	}

	// lastConnRead must be untouched by a skipped tick — otherwise a run of
	// skips could each reset the clock and connections would never be read
	// again.
	c.connMu.Lock()
	lastRead := c.lastConnRead
	c.connMu.Unlock()
	if !lastRead.Equal(now) {
		t.Fatalf("lastConnRead changed from %v to %v on a skipped tick", now, lastRead)
	}
}

// SAMPLING MUST NOT SLEEP. cpu.Percent(d, …) blocks for d, which would make
// the agent pause inside the measurement it is taking (spec §4). Nothing in
// Sample may do that. The budget is generous because net.Connections walks the
// kernel's socket table and is the slowest call here, on the ticks that
// actually read it — connectionsMinInterval already throttles those to at
// most one every 5s regardless of --interval (see connectionsMinInterval's
// doc comment in collect.go). If this ever fails again, the lever is to
// raise that constant further, not this bound.
//
// warmUp first so the timed call below is one that actually reaches
// connectionStates — the call this test exists to bound — rather than one of
// FIX A's startup-grace-period calls, which return early with an error
// before ever getting there (see warmUp's doc comment).
func TestSampleDoesNotBlockForAnInterval(t *testing.T) {
	c := New()
	warmUp(c)
	start := time.Now()
	if _, err := c.Sample(context.Background()); err != nil {
		t.Fatalf("Sample() error = %v", err)
	}
	if elapsed := time.Since(start); elapsed > 500*time.Millisecond {
		t.Fatalf("Sample() took %s, want < 500ms — something in it is sleeping", elapsed)
	}
}
