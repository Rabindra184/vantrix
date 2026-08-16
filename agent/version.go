// Package agent is the root of the PerfPortal load-generator telemetry agent.
//
// It lives OUTSIDE the pnpm workspace on purpose: pnpm-workspace.yaml globs
// only `packages/*` and `apps/*`, so nothing here is a workspace member, no
// tsconfig project reference reaches it, and ESLint's TypeScript file matchers
// never see it. `cd agent && go test ./...` is its own gate command — see
// CLAUDE.md's Verification section.
package agent

// Version is stamped into the User-Agent so a server log can tell which agent
// build produced a sample. Bumped by hand; the agent deliberately does not
// self-update (spec §10 — a binary that rewrites itself on a load generator
// mid-test is a way to invalidate a run).
const Version = "0.1.0"

// UserAgent is sent on every telemetry POST.
func UserAgent() string { return "perfportal-agent/" + Version }
