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
			//
			// DRAIN UNTIL EMPTY, not one batch. The ring is bufferSamples deep
			// (~1920) specifically so a slow-server blip or a brief outage does
			// not lose data; a single DrainUpTo(batchSamples) here would flush
			// only the oldest 30 and abandon everything behind it — throwing
			// away, at the one moment durability matters most, exactly the
			// backlog Task 2's buffer exists to preserve. DrainUpTo(n) returns
			// at least one element whenever Len() > 0, so Len() strictly
			// decreases every iteration and this loop terminates.
			//
			// STOP ON THE FIRST FAILURE, though. Looping past one is the same
			// mistake as retrying: a POST that fails because the server is
			// unreachable will keep failing, and hammering it while the
			// process is dying turns shutdown into a retry storm against the
			// machine whose load is the measurement — spec §5, same rule as
			// flush() above. The 5s timeout on `final` is the actual bound in
			// wall-clock terms: once it elapses every Post fails immediately
			// on a cancelled context and the loop exits on the next iteration.
			final, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			sent := 0
			for ring.Len() > 0 {
				s := ring.DrainUpTo(batchSamples)
				if err := client.Post(final, s); err != nil {
					// Logged unconditionally (not rate-limited like the
					// steady-state path): this is the only diagnostic anyone
					// will ever have for "did the last batch make it out."
					log.Printf("final flush sent %d samples, then failed with %d unsent (%d in the failed POST, %d never attempted): %v",
						sent, len(s)+ring.Len(), len(s), ring.Len(), err)
					return
				}
				sent += len(s)
			}
			log.Printf("final flush sent %d samples", sent)
			return
		case <-ticker.C:
			if ring.Len() >= batchSamples || time.Since(lastFlush) >= batchWindow {
				flush()
			}
		}
	}
}
