package agent

import (
	"strings"
	"testing"
)

// The toolchain's smoke test: it exists so `go test ./...` has something to
// run before any metric is collected, and so a broken CI Go step fails on this
// rather than on the first real sampler.
func TestUserAgentIdentifiesTheBinaryAndVersion(t *testing.T) {
	ua := UserAgent()
	if !strings.HasPrefix(ua, "perfportal-agent/") {
		t.Fatalf("UserAgent() = %q, want a perfportal-agent/ prefix", ua)
	}
	if !strings.HasSuffix(ua, Version) {
		t.Fatalf("UserAgent() = %q, want it to end with Version %q", ua, Version)
	}
}
