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
