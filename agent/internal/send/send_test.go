package send

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/Rabindra184/vantrix/agent/internal/collect"
)

func sampleAt(ms int64) collect.Sample {
	return collect.Sample{
		SampledAt:     time.UnixMilli(ms).UTC(),
		CPUIdleMs:     ms,
		MemTotalBytes: 1024,
		MemUsedBytes:  512,
		TCPStates:     map[string]int{"ESTABLISHED": 3},
	}
}

func TestPostSendsTheHostLabelAndNoTenant(t *testing.T) {
	var body map[string]any
	var auth, agentHeader string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		agentHeader = r.Header.Get("User-Agent")
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()

	c := New(srv.URL, "pp_tok_secret", "gen-1", srv.Client())
	if err := c.Post(context.Background(), []collect.Sample{sampleAt(1000), sampleAt(2000)}); err != nil {
		t.Fatalf("Post() error = %v", err)
	}

	if auth != "Bearer pp_tok_secret" {
		t.Fatalf("Authorization = %q", auth)
	}
	if agentHeader == "" {
		t.Fatal("User-Agent is empty; a server log cannot tell which build produced a sample")
	}
	if body["host"] != "gen-1" {
		t.Fatalf("host = %v, want gen-1", body["host"])
	}

	// SPEC §2, THE SECURITY PROPERTY. The agent must not be able to name a
	// tenant: the server takes both from the token. Asserted on the wire, not
	// on the struct, because a struct field added later with a json tag would
	// pass a struct-level check and still ship.
	for _, forbidden := range []string{"orgId", "projectId", "org_id", "project_id"} {
		if _, present := body[forbidden]; present {
			t.Fatalf("payload carries %q; org and project come from the TOKEN", forbidden)
		}
	}

	samples, ok := body["samples"].([]any)
	if !ok || len(samples) != 2 {
		t.Fatalf("samples = %v, want 2", body["samples"])
	}
	first, _ := samples[0].(map[string]any)
	// Raw counters on the wire, never a rate the agent computed (spec §4).
	if _, present := first["cpuIdleMs"]; !present {
		t.Fatalf("sample = %v, want the raw cpuIdleMs counter", first)
	}
	for _, forbidden := range []string{"cpuPercent", "rxBytesPerSec"} {
		if _, present := first[forbidden]; present {
			t.Fatalf("sample carries the derived field %q; the server does the arithmetic", forbidden)
		}
	}
}

func TestPostOnAnEmptyBatchDoesNotCallTheServer(t *testing.T) {
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()

	c := New(srv.URL, "t", "gen-1", srv.Client())
	if err := c.Post(context.Background(), nil); err != nil {
		t.Fatalf("Post(nil) error = %v, want nil", err)
	}
	if called {
		t.Fatal("an empty batch reached the server")
	}
}

func TestPostReturnsAnErrorOnRejectionAndNeverPanics(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	defer srv.Close()

	c := New(srv.URL, "t", "gen-1", srv.Client())
	err := c.Post(context.Background(), []collect.Sample{sampleAt(1000)})
	if err == nil {
		t.Fatal("Post() = nil on a 403; the caller must be able to count the failure")
	}
	// The batch is DROPPED by the caller, not retried here. An agent that
	// retried aggressively during an outage would add load to the machine
	// whose load is the thing being measured (spec §5).
}
