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
