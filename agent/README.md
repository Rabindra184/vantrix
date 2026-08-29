# PerfPortal load-generator agent

A single static binary that samples the host it runs on — CPU, memory, network
— and posts the counters to PerfPortal. Run it **on the machine generating
load**, beside Gatling, for the duration of a test.

It knows nothing about runs. It reports samples with a timestamp and a host
label; a run picks up whatever samples overlap its own window, which is why
the agent can be started once and left running across many tests. Those
samples are what the run page's **Load generators** tab draws.

## Install

Released binaries are attached to each `v*` [GitHub
Release](https://github.com/Rabindra184/vantrix/releases), for `linux` and
`darwin` on `amd64` and `arm64`, with a `SHA256SUMS` file beside them.

```bash
VERSION=v0.2.0            # the release you want
OS=linux ARCH=amd64       # or darwin / arm64
BASE="https://github.com/Rabindra184/vantrix/releases/download/$VERSION"

curl -fsSLO "$BASE/perfportal-agent-$OS-$ARCH"
curl -fsSLO "$BASE/SHA256SUMS"
sha256sum --ignore-missing -c SHA256SUMS
install -m 0755 "perfportal-agent-$OS-$ARCH" /usr/local/bin/perfportal-agent
```

**Check the checksum.** This binary runs on a load generator with a credential
in its environment; `--ignore-missing` above is what lets one `SHA256SUMS`
cover a directory holding only the one file you downloaded.

Or build it from source — it is a plain Go module with one dependency
(`gopsutil`), outside the pnpm workspace:

```bash
cd agent && CGO_ENABLED=0 go build -o perfportal-agent ./cmd/perfportal-agent
```

## Run it

```bash
export PERFPORTAL_TELEMETRY_TOKEN='pp_...'      # scope: telemetry
perfportal-agent --endpoint https://perf.example.com --host-label gen-01
```

| Flag | Default | Meaning |
|------|---------|---------|
| `--endpoint` | *(required)* | The PerfPortal API root, e.g. `https://perf.example.com`. Not a path — the agent appends `/v1/telemetry` itself. |
| `--host-label` | the OS hostname | What this generator is called on the run page. Set it: hostnames on ephemeral generators collide and change, and the label is the only thing distinguishing two rows. |
| `--interval` | `1s` | Sampling interval. Gatling's own cadence; a longer one gives a coarser chart, not a cheaper agent. |
| `--version` | — | Print the version and exit. |

### There is no `--token` flag, and that is deliberate

The token comes from `PERFPORTAL_TELEMETRY_TOKEN` and from nowhere else.

`/proc/<pid>/cmdline` is world-readable on Linux, so a token passed as a flag
is readable by **any local user** on the load generator — a machine that is
frequently shared, frequently ephemeral, and managed less carefully than CI.
It would also land in shell history and in `ps` output.
`/proc/<pid>/environ` is readable only by the process owner, which makes the
environment variable materially safer rather than merely different. The Gatling
Gradle plugin refuses a token property for the same reason.

### Minting the token

Any token this agent holds should carry the **`telemetry`** scope and nothing
else. That scope grants exactly one route — `POST /v1/telemetry` — so a token
sitting on a shared generator cannot upload a result bundle, read a run, or
open a live stream.

From a signed-in session (see the root [`README.md`](../README.md)'s
Authentication section):

```bash
curl -sS -b /tmp/cookies.txt -X POST \
  https://perf.example.com/v1/projects/checkout/tokens \
  -H 'Content-Type: application/json' \
  -d '{"name":"gen-01 telemetry","scopes":["telemetry"]}'
```

The plaintext token is returned once, at mint.

## What it costs on the generator

The agent's whole job is to not perturb the thing it measures, so its
footprint is a tested property rather than an aspiration:
`agent/footprint_test.go` asserts a budget, and CI runs it
(`go test -run TestFootprintBudget -v ./...`).

The sampler and the sender are separate goroutines with a bounded ring buffer
between them (`internal/buffer`), so a slow or unreachable API can never stall
sampling. The buffer holds roughly 32 minutes of one-second samples; a longer
outage drops its oldest samples and says so. Batches flush every 30 samples or
10 seconds, whichever comes first — one request per second per generator would
itself be load.

## As a service

```ini
# /etc/systemd/system/perfportal-agent.service
[Unit]
Description=PerfPortal load-generator agent
After=network-online.target

[Service]
# The token is read from the environment and never appears in the unit's
# ExecStart, so it stays out of `systemctl cat` and `ps`.
EnvironmentFile=/etc/perfportal-agent.env      # PERFPORTAL_TELEMETRY_TOKEN=pp_...
ExecStart=/usr/local/bin/perfportal-agent --endpoint https://perf.example.com --host-label %H
Restart=always
RestartSec=5
DynamicUser=yes
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes

[Install]
WantedBy=multi-user.target
```

Give `/etc/perfportal-agent.env` mode `0600`. It is the whole secret.

## Development

This module is outside the pnpm workspace, so `pnpm lint`, `pnpm typecheck`
and every `pnpm test:*` are blind to it. Its gate is its own:

```bash
cd agent && go vet ./... && go test ./... -race
```

`-race` is not optional. The agent's design is a sampler goroutine writing to
a bounded buffer that a sender goroutine drains; a data race in that pair is
the one defect class these tests exist to catch, and the race detector is what
makes them able to catch it.
