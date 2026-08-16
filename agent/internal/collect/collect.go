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

// counterSource tracks whether a CUMULATIVE-counter read has EVER succeeded
// on this host, which is the fact that decides what a failed read means:
//
//   - never succeeded, still failing → permanently unavailable on this
//     platform (e.g. net.ProtoCounters on darwin). Degrading to a
//     zero-filled value is safe here because the counter is ALWAYS zero, so
//     every delta computed against it is 0 - 0 = 0. No spike is possible.
//   - succeeded before, now failing → transient. A zero-filled sample here
//     is exactly what manufactures a false spike: downstream correctly reads
//     THIS sample as a counter reset (current < previous), but the RECOVERY
//     is then measured from 0 against a since-boot counter — a delta many
//     orders of magnitude too large, drawn as a real traffic burst. The
//     caller must skip the tick instead of degrading.
//
// Extracted so the decision is testable without faking a gopsutil failure —
// see TestCounterSourceShouldDegrade.
type counterSource struct {
	everSucceeded atomic.Bool
}

// recordSuccess marks this source as having produced at least one real
// reading. Idempotent; call it every time a read succeeds.
func (c *counterSource) recordSuccess() {
	c.everSucceeded.Store(true)
}

// shouldDegrade reports how a FAILED read of this source should be handled:
// true means degrade to a zero-filled value and carry on (this source has
// never worked, so zero is safe); false means the caller must abort the
// whole sample instead (this source worked before, so zero would read as a
// counter reset it is not).
func (c *counterSource) shouldDegrade() bool {
	return !c.everSucceeded.Load()
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
}

// New returns a Collector.
func New() *Collector { return &Collector{} }

// ProtoUnavailable reports whether TCP protocol counters have never once
// succeeded on this host. main uses it to log the degradation exactly once.
func (c *Collector) ProtoUnavailable() bool { return c.protoUnavailable.Load() }

// Sample reads every source once.
//
// It returns an error when a source that exists on EVERY platform fails —
// CPU times or memory — and ALSO when a source that has read successfully
// before on THIS host (bandwidth or TCP protocol counters) fails now. The
// latter is deliberate: this host's own history is what tells a transient
// failure apart from permanent unavailability, and only the transient case
// can manufacture a false spike downstream (see counterSource's doc
// comment). A source that has NEVER succeeded on this host — e.g.
// net.ProtoCounters on darwin, windows — instead degrades: those six
// counters stay zero and protoUnavailable is set, because a developer on
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
		c.io.recordSuccess()
		s.NetRxBytes = int64(io[0].BytesRecv)
		s.NetTxBytes = int64(io[0].BytesSent)
	} else if !c.io.shouldDegrade() {
		// Bandwidth has read successfully before on this host: a zero here
		// would be sent as this sample's counters, correctly read downstream
		// as a reset, and then manufacture a false spike the moment the NEXT
		// sample succeeds and measures its delta from zero. Skip the whole
		// tick instead of degrading — see counterSource's doc comment.
		if err == nil {
			err = errNoIOCounters
		}
		return Sample{}, fmt.Errorf("net.IOCounters regressed after previously succeeding: %w", err)
	}
	// else: net.IOCounters has never succeeded on this host. Degrade rather
	// than fail — NetRxBytes/NetTxBytes stay zero like every other interval
	// on a source that is always zero, so every delta is 0 - 0 = 0.

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
		// Same transient-vs-permanent distinction as IOCounters above: this
		// host's protocol counters have worked before, so a zero-filled
		// sample now would manufacture a spike on the next successful read.
		if err == nil {
			err = errNoProtoCounters
		}
		return Sample{}, fmt.Errorf("net.ProtoCounters regressed after previously succeeding: %w", err)
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
const errNoIOCounters = collectError("net.IOCounters returned no interfaces")
const errNoProtoCounters = collectError("net.ProtoCounters returned no protocols")
