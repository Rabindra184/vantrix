# Spike — Gatling binary `simulation.log` decoder

**Status: succeeded.** Throwaway code kept as an executable specification of the format.

```bash
node decode.mjs ../../fixtures/gatling-3.15.1.2/reference-report/simulation.log
```

Exits `0` when every exact statistic is reproduced from raw bytes.

## Why this existed

Validating the parity matrix found that `simulation.log` is **binary** in Gatling 3.15.1.2 — there is no text option. That made the format the single largest technical risk in the project: it gates M1 → M2 → M3, and if it were not reliably decodable there would be no product. This spike answered that before any production code was written.

## Result

| | |
|---|---|
| Format | Fully recovered and decoded |
| File consumption | Clean EOF — 37,769 / 37,769 bytes, no trailing slack |
| Records | 895 request · 490 user · 405 group · 0 error |
| Exact statistics | **All reproduced** — counts, KO, indicator bands, max, mean, stddev, scenarios, assertions |
| Error messages | Both reproduced with exact counts (15× 500, 9× 503) |
| Group hierarchy | Nested `Catalog / Recommendations` recovered correctly |

Verdict: **decoding is tractable and cheap.** The decoder is ~120 lines with no dependencies. The ongoing cost is not difficulty — it is version compatibility, since the format carries no compatibility guarantee.

## How the format was recovered

Not by reverse-engineering hexdumps. The format is defined by classes shipped in the Gatling jars, which the Gradle build had already downloaded:

```
io.gatling.core.stats.writer.RecordHeader              record type bytes
io.gatling.core.stats.writer.*MessageSerializer        field order per record
io.gatling.core.stats.writer.BufferedFileChannelWriter primitive encodings
io.gatling.charts.stats.LogFileParser                  the authoritative read side
```

`javap -c` on those gives the layout definitively. **Read the parser, not just the writer** — the one bug in this spike came from inferring the cached-string protocol from the writer; the reader made the actual rule unambiguous.

## Format

The full specification is below. Two details cause silent corruption if guessed:

- **Record types are `Run=0, Request=1, User=2, Group=3, Error=4`.** Request and User are *not* in declaration order.
- **`cachedString` uses the sign as its discriminator:** a non-negative int means a new string follows inline; a negative int is a back-reference to `cache[-i]`. Index 0 can never be back-referenced, since `-0 === 0`.

Also note `string` puts its **coder byte after the payload**, and an empty string is a bare `int 0` with no coder byte at all.

## The unexpected finding

Gatling's reported percentiles are **histogram estimates, not observations**. Three of its four printed percentiles are values that never occurred in the run:

```
p50   true  108   gatling  109   -0.9%   not in data
p75   true  251   gatling  250   +0.4%   not in data
p95   true  654   gatling  654    0.0%   in data
p99   true 2501   gatling 2369   +5.6%   not in data
```

This invalidated AC-PARITY-2, which had required percentiles to match Gatling within 1%. Matching would mean reproducing another tool's estimator error. The criterion now compares **exact quantities to Gatling** and **percentiles to ground truth**.

It also yields a defensible product claim: DDSketch guarantees 1% relative error at every quantile, where the static report being replaced is 5.6% off at p99 on a sample this size.

## What this is not

Not production code. The production plugin needs: streaming rather than `readFileSync`, version-gated record layouts, bounded memory, structured errors with remediation, assertion protobuf decoding (skipped here as opaque bytes), and the `sanitize()` behaviour `LogFileParser` applies to strings.
