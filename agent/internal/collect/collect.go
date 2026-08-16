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
