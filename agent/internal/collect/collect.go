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
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/mem"
	"github.com/shirou/gopsutil/v4/net"
)

// connectionsMinInterval bounds how often Sample actually calls
// net.Connections, independent of the caller's own sampling interval — see
// shouldReadConnections and the Collector.connectionStates doc comment.
//
// MEASURED, not guessed. On Linux, gopsutil's net.Connections walks
// /proc/<pid>/fd across EVERY process on the host to map socket inodes to
// connection states, so its cost scales with the host's process and socket
// count, not just this agent's own footprint. Bisected in a golang:1.24
// container over a 10s window: 0.373% of one core WITH the call, 0.180%
// WITHOUT it — roughly half the total cost — and on a GitHub Actions
// ubuntu-latest runner, with a real /proc to walk, the SAME 10s footprint
// test measured 1.386%, over the §5 budget (agent/footprint_test.go). A load
// generator holding tens of thousands of sockets in production is the worst
// case, so even 1.386% is optimistic. Every other field in Sample — CPU,
// memory, bandwidth, the TCP protocol counters — is cheap and stays at the
// full interval; only this one call is throttled.
const connectionsMinInterval = 5 * time.Second

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
	// everywhere else — see the protoUnavailable field on Collector and its
	// ProtoUnavailable accessor below.
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

// counterSourceDegradeAfterFailures (K) is how many CONSECUTIVE failures a
// source that has NEVER succeeded must accumulate before Sample concludes it
// is permanently unavailable on this host and degrades to a zero-filled
// value. At tick 1, "not implemented on this platform" (net.ProtoCounters on
// darwin) and "not ready yet" (a /proc permission hiccup at startup, a
// container still initialising) are indistinguishable — everSucceeded is
// false in both cases. Below K, Sample returns an error and the sampler
// skips the tick rather than guessing; only once a source has failed K times
// in a row with no success anywhere in between does Sample treat it as
// permanently absent. The price is K-1 skipped ticks at startup on a
// platform that genuinely lacks the source (two skipped outright, the third
// the one where it finally degrades) — cheap, next to the alternative: a
// zero-filled sample that a later success would measure its delta from,
// manufacturing a spike orders of magnitude too large. See
// counterSource.shouldDegrade.
const counterSourceDegradeAfterFailures = 3

// counterSource tracks whether a CUMULATIVE-counter read has EVER succeeded
// on this host, and how many times in a row it has failed since, which
// together decide what a failed read means:
//
//   - never succeeded, fewer than counterSourceDegradeAfterFailures
//     consecutive failures → too soon to tell "not implemented on this
//     platform" from "not ready yet". The caller must skip the tick.
//   - never succeeded, counterSourceDegradeAfterFailures or more consecutive
//     failures → permanently unavailable on this platform (e.g.
//     net.ProtoCounters on darwin). Degrading to a zero-filled value is safe
//     here because the counter is ALWAYS zero, so every delta computed
//     against it is 0 - 0 = 0. No spike is possible.
//   - succeeded before, now failing → transient, regardless of how many
//     times. A zero-filled sample here is exactly what manufactures a false
//     spike: downstream correctly reads THIS sample as a counter reset
//     (current < previous), but the RECOVERY is then measured from 0
//     against a since-boot counter — a delta many orders of magnitude too
//     large, drawn as a real traffic burst. The caller must skip the tick
//     instead of degrading.
//
// Safe for concurrent use — both fields are atomics, matching Collector's own
// contract. Extracted so the decision is testable without faking a gopsutil
// failure — see TestCounterSourceShouldDegrade.
type counterSource struct {
	everSucceeded       atomic.Bool
	consecutiveFailures atomic.Int64
}

// recordSuccess marks this source as having produced at least one real
// reading, and resets the consecutive-failure count. Idempotent; call it
// every time a read succeeds.
func (c *counterSource) recordSuccess() {
	c.everSucceeded.Store(true)
	c.consecutiveFailures.Store(0)
}

// shouldDegrade records ONE failed read of this source and reports how it
// should be handled: true means degrade to a zero-filled value and carry on;
// false means the caller must abort the whole sample instead (return an
// error so the sampler skips the tick). Call it exactly once per failed
// read — see counterSource's doc comment for the three cases this decides
// between.
func (c *counterSource) shouldDegrade() bool {
	if c.everSucceeded.Load() {
		// Transient: this source has worked before, so degrading now would
		// manufacture a spike the moment it next succeeds.
		return false
	}
	failures := c.consecutiveFailures.Add(1)
	return failures >= counterSourceDegradeAfterFailures
}

// shouldReadConnections reports whether Sample should call net.Connections
// now, given when it last actually did.
//
// A TIME threshold, not a tick count: --interval is configurable, so "every
// Nth tick" would mean connectionsMinInterval at the default 1s interval and
// something ten times coarser at `--interval 10s`, silently changing the
// staleness bound with it. Comparing elapsed wall-clock time instead means a
// coarse --interval naturally reads every tick (elapsed already exceeds
// minInterval), which is exactly what the last table case below checks.
// lastRead.IsZero() covers the very first sample, which must always read —
// there is nothing to carry forward yet.
//
// Extracted so the decision is testable without faking a slow net.Connections
// call, in the same style as counterSource.shouldDegrade above — see
// TestShouldReadConnections.
func shouldReadConnections(lastRead, now time.Time, minInterval time.Duration) bool {
	return lastRead.IsZero() || now.Sub(lastRead) >= minInterval
}

// Collector reads host state. Safe for concurrent use; the agent uses one.
type Collector struct {
	// Set once, the first time ProtoCounters is unavailable AND has never
	// once succeeded on this host, so the warning is logged once rather than
	// once a second forever (spec §5, "failure is silent and cheap") — and
	// never for a transient blip on a host where it normally works, which
	// proto.shouldDegrade() below routes to an error instead.
	protoUnavailable atomic.Bool

	// Whether bandwidth (net.IOCounters) and TCP protocol counters
	// (net.ProtoCounters) have ever been read successfully on this host. See
	// counterSource's doc comment for why a failure needs to know this.
	io    counterSource
	proto counterSource

	// connMu guards lastConnRead and lastConnStates, the mutable state behind
	// connectionStates' slower cadence (see connectionsMinInterval). A plain
	// mutex, not an atomic, because what it protects is a map: read and
	// written on every Sample(), and Sample may be called concurrently per
	// this type's own contract above.
	connMu         sync.Mutex
	lastConnRead   time.Time
	lastConnStates map[string]int
}

// New returns a Collector.
func New() *Collector { return &Collector{} }

// ProtoUnavailable reports whether TCP protocol counters have never once
// succeeded on this host. main uses it to log the degradation exactly once.
func (c *Collector) ProtoUnavailable() bool { return c.protoUnavailable.Load() }

// Sample reads every source once.
//
// It returns an error when a source that exists on EVERY platform fails —
// CPU times or memory — and ALSO when bandwidth or TCP protocol counters
// fail without yet having earned a degrade: either the source has read
// successfully before on THIS host (a transient failure), or it never has
// but has failed fewer than counterSourceDegradeAfterFailures times in a
// row (too soon to tell "not ready yet" from "not implemented here"). This
// host's own history — success ever, and consecutive failures since — is
// what tells those apart from permanent unavailability, and only they can
// manufacture a false spike downstream (see counterSource's doc comment). A
// source that has NEVER succeeded on this host AND has now failed that many
// times in a row — e.g. net.ProtoCounters on darwin, windows — instead
// degrades: those six counters stay zero and protoUnavailable is set,
// because a developer on macOS should still get CPU, memory, bandwidth and
// connection states rather than nothing at all.
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
	}

	// `false` = summed across every interface. A per-interface breakdown is
	// not a chart Gatling draws, and summing here keeps the row narrow.
	if io, err := net.IOCountersWithContext(ctx, false); err == nil && len(io) > 0 {
		c.io.recordSuccess()
		s.NetRxBytes = int64(io[0].BytesRecv)
		s.NetTxBytes = int64(io[0].BytesSent)
	} else if !c.io.shouldDegrade() {
		// Either bandwidth has read successfully before on this host (a zero
		// here would be sent as this sample's counters, correctly read
		// downstream as a reset, and then manufacture a false spike the
		// moment the NEXT sample succeeds and measures its delta from zero),
		// or it has never succeeded but hasn't yet failed
		// counterSourceDegradeAfterFailures times in a row, so it is too
		// soon to tell "not ready yet" from "not implemented here". Either
		// way: skip the whole tick instead of degrading — see
		// counterSource's doc comment.
		if err == nil {
			err = errNoIOCounters
		}
		return Sample{}, fmt.Errorf("net.IOCounters unavailable, not yet presumed permanently absent: %w", err)
	}
	// else: net.IOCounters has never succeeded on this host and has now
	// failed counterSourceDegradeAfterFailures times in a row. Degrade
	// rather than fail — NetRxBytes/NetTxBytes stay zero like every other
	// interval on a source that is always zero, so every delta is 0 - 0 = 0.

	if protos, err := net.ProtoCountersWithContext(ctx, []string{"tcp"}); err == nil && len(protos) > 0 {
		c.proto.recordSuccess()
		st := protos[0].Stats
		s.TCPInSegs = st["InSegs"]
		s.TCPOutSegs = st["OutSegs"]
		s.TCPRetransSegs = st["RetransSegs"]
		s.TCPInErrs = st["InErrs"]
		s.TCPActiveOpens = st["ActiveOpens"]
		s.TCPPassiveOpens = st["PassiveOpens"]
	} else if c.proto.shouldDegrade() {
		c.protoUnavailable.Store(true)
	} else {
		// Same transient-vs-not-yet-proven distinction as IOCounters above:
		// either this host's protocol counters have worked before, so a
		// zero-filled sample now would manufacture a spike on the next
		// successful read, or they haven't failed
		// counterSourceDegradeAfterFailures times in a row yet, so it is too
		// soon to presume they're unimplemented on this platform.
		if err == nil {
			err = errNoProtoCounters
		}
		return Sample{}, fmt.Errorf("net.ProtoCounters unavailable, not yet presumed permanently absent: %w", err)
	}

	s.TCPStates = c.connectionStates(ctx, now)

	return s, nil
}

// connectionStates returns the TCP-state counts to attach to this sample: a
// fresh net.Connections read when at least connectionsMinInterval has
// elapsed since the last one (or this is the first sample ever), otherwise
// the states from the last successful read, carried forward unchanged.
//
// CARRYING FORWARD ON A SKIPPED TICK, NEVER AN EMPTY MAP. TCPStates is a
// GAUGE, and Sample's own field comment records that the wire format omits a
// state at zero rather than sending it — "absent means zero". The web
// transform toTcpStateChart (apps/web/src/charts/transforms/telemetry.ts)
// takes that literally: it zero-fills every state it has EVER seen for a
// host across the whole series. So an empty map on the four ticks out of
// five that skip the real read would not read as "no new data" — it would
// render as every connection state dropping to zero and springing back,
// four times out of five: a sawtooth with no basis in the host's actual
// state. Carrying the last reading forward instead is also simply honest: a
// gauge sampled less often than the rest of the row is a step function, not
// a gap, and a step function is what this produces.
//
// A read that fails (net.Connections returns an error) is treated the same
// as a skipped tick — carry forward — except lastConnRead is NOT advanced,
// so the very next call retries immediately rather than waiting out another
// full connectionsMinInterval.
//
// The map handed back is always a fresh copy: a caller holding onto a
// Sample must not be able to mutate this Collector's internal state by
// mutating the map it received.
func (c *Collector) connectionStates(ctx context.Context, now time.Time) map[string]int {
	c.connMu.Lock()
	lastRead := c.lastConnRead
	carried := copyConnStates(c.lastConnStates)
	c.connMu.Unlock()

	if !shouldReadConnections(lastRead, now, connectionsMinInterval) {
		return carried
	}

	conns, err := net.ConnectionsWithContext(ctx, "tcp")
	if err != nil {
		return carried
	}

	states := map[string]int{}
	for _, conn := range conns {
		if conn.Status == "" {
			continue
		}
		states[conn.Status]++
	}

	c.connMu.Lock()
	c.lastConnRead = now
	c.lastConnStates = states
	c.connMu.Unlock()

	return copyConnStates(states)
}

// copyConnStates returns a fresh copy of m, never nil — so a Sample's
// TCPStates is always a real map (see TestSampleReadsGaugesAndCumulativeCounters)
// and never aliases a Collector's internal state.
func copyConnStates(m map[string]int) map[string]int {
	out := make(map[string]int, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

func secondsToMs(seconds float64) int64 { return int64(seconds * 1000) }

type collectError string

func (e collectError) Error() string { return string(e) }

const errNoCPUTimes = collectError("cpu.Times returned no entries")
const errNoIOCounters = collectError("net.IOCounters returned no interfaces")
const errNoProtoCounters = collectError("net.ProtoCounters returned no protocols")
