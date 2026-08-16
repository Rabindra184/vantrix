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

// Unreachable today (the only call site passes the constant batchSamples),
// but the same asymmetry New's capacity clamp exists to fix: a negative n
// must not loop backward or panic.
func TestDrainUpToClampsANegativeNToZero(t *testing.T) {
	r := New[int](4)
	r.Push(1)
	r.Push(2)

	got := r.DrainUpTo(-1)
	if len(got) != 0 {
		t.Fatalf("DrainUpTo(-1) = %v, want empty", got)
	}
	if l := r.Len(); l != 2 {
		t.Fatalf("Len() = %d after DrainUpTo(-1), want 2 (nothing drained)", l)
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
