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
// send" as an ordinary tick, not an error. A negative n is clamped up to 0
// rather than looping backward or panicking — unreachable today (the only
// call site passes a constant), but the same asymmetry New's capacity clamp
// exists to fix, so both are handled the same way.
func (r *Ring[T]) DrainUpTo(n int) []T {
	r.mu.Lock()
	defer r.mu.Unlock()

	if n < 0 {
		n = 0
	}
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
