package collect

import (
	"context"
	"reflect"
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

func TestDegradesRatherThanFailingWhereProtoCountersAreUnavailable(t *testing.T) {
	if runtime.GOOS == "linux" {
		t.Skip("this asserts the DEGRADED path, which linux does not take")
	}
	// The whole point: on a platform with no ProtoCounters, Sample still
	// returns a usable sample rather than an error, so a developer on macOS
	// gets CPU, memory, bandwidth and connection states.
	c := New()
	s, err := c.Sample(context.Background())
	if err != nil {
		t.Fatalf("Sample() error = %v, want a degraded sample and no error", err)
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

// FIX 1. A collector reading a transient failure (source read successfully
// before, fails now) must be told to skip the tick rather than degrade —
// degrading here is exactly what turns a five-sample series like
//
//	[1000, null] [2000, 2000] [3000, null] [4000, 1006000] [5000, 2000]
//
// into a false 503x spike on recovery (the reset at offset 3 is correctly
// null, but the zero-filled sample sent FOR it means offset 4's delta is
// measured from 0 against a since-boot counter). This cannot be exercised
// through Sample() itself without faking a gopsutil failure on demand, which
// the package does not support — so the "have we ever succeeded" decision
// is extracted into counterSource and tested here in isolation. Without the
// fix (i.e. shouldDegrade() unconditionally returning true, which is what
// Sample() effectively did before it consulted counterSource at all), the
// "succeeded once, now failing" case below goes red: it wants false and a
// pre-fix implementation returns true.
func TestCounterSourceShouldDegrade(t *testing.T) {
	tests := []struct {
		name         string
		succeedFirst bool
		want         bool
	}{
		{
			name:         "never succeeded, still failing -> degrade (permanently unavailable, zero is safe)",
			succeedFirst: false,
			want:         true,
		},
		{
			name:         "succeeded before, now failing -> do NOT degrade (transient; zero would manufacture a spike)",
			succeedFirst: true,
			want:         false,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var c counterSource
			if tt.succeedFirst {
				c.recordSuccess()
			}
			if got := c.shouldDegrade(); got != tt.want {
				t.Fatalf("shouldDegrade() = %v, want %v", got, tt.want)
			}
		})
	}
}

// A source that keeps failing without ever having succeeded must keep
// degrading on every subsequent read, not just the first — recordSuccess is
// never called, so nothing should flip shouldDegrade() to false on its own.
func TestCounterSourceKeepsDegradingAcrossRepeatedFailures(t *testing.T) {
	var c counterSource
	for i := 0; i < 3; i++ {
		if !c.shouldDegrade() {
			t.Fatalf("shouldDegrade() = false on attempt %d with no recorded success", i)
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
func TestSampleReadsConnectionsAtMostOncePerMinInterval(t *testing.T) {
	c := New()
	if _, err := c.Sample(context.Background()); err != nil {
		t.Fatalf("Sample() error = %v", err)
	}

	c.connMu.Lock()
	firstRead := c.lastConnRead
	c.connMu.Unlock()
	if firstRead.IsZero() {
		t.Fatal("lastConnRead is still zero after the first Sample() — the first tick must always read connections")
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
