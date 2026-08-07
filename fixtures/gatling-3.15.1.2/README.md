# Gatling 3.15.1.2 parity reference fixture

The pinned reference for the Gatling parity matrix (tracked in the project's internal spec). Every row in that matrix was verified against the report in `reference-report/`, and the parity test suite (`PT-*`) asserts against it.

**Generated 2026-08-07 · Gatling 3.15.1.2 · Java 21 · gradle plugin `io.gatling.gradle` 3.15.1.2**

## Why this fixture exists

The matrix was originally written from expectation. Validating it against a real report found **five errors**, one of them critical: `simulation.log` is binary in this version, with no text option. This fixture is what makes the parity claim checkable rather than assertable, and it is why the same validation must be repeated for every newly supported Gatling major.

## What it deliberately exercises

| Coverage | How |
|---|---|
| Two scenarios | `Browse` and `Checkout`, with offset injection profiles |
| Groups, including nesting | `Catalog` → `Recommendations`, plus `Cart` |
| Indicator bands (800ms / 1200ms defaults) | `/fast` well under, `/slow` with a 12% heavy tail above |
| Percentile separation | `/spiky` injects rare 2.5s outliers so p99 diverges from p50 |
| Error table with >1 message | `/flaky` returns 500 (~18%), `/unstable` returns 503 (~10%) |
| Assertions, both statuses | Two expected to pass, one deliberately set to fail |
| Ramp vs. steady phases | `rampUsers` then `constantUsersPerSec`, so concurrency and arrival rate diverge |

## Contents

```
simulation/          inputs — regenerate the report from these
  ParitySimulation.kt
  target-server.js         local seeded target; no external traffic
  build.gradle.kts · settings.gradle.kts · gradle.properties
reference-report/    outputs — what the matrix was verified against
  simulation.log           BINARY (see below)
  index.html               global page
  req_*.html   (7)         request detail pages
  group_*.html (3)         group detail pages
```

Gatling's bundled `js/` and `style/` assets (Highcharts, Bootstrap, jQuery) are **excluded** — third-party minified vendor code, not needed for parity verification, and regenerated on every run.

## `simulation.log` is binary

This is the single most consequential finding. The file is **not** TSV. It opens with a length-prefixed version string (`3.15.1`), the simulation class name, and the scenario name table, followed by binary records:

```
00000000  00 00 00 06  "3.15.1"            <- 4-byte length + version
          00 00 00 18  "example.Parity..."  <- 4-byte length + simulation class
          ...          <timestamp>
          00 00 00 02  "Browse" "Checkout"  <- scenario count + names
```

Decoding this is the Gatling plugin's **primary ingest path**, not an error branch. There is no text option. See `spikes/gatling-binary-log/README.md` for how the format was recovered and why this reversed an earlier design decision.

## Regenerating

Requires **Java 21** — the build targets JVM 21, and running with Java 17 fails with `UnsupportedClassVersionError` (class file 65 vs 61).

```bash
export JAVA_HOME=/path/to/jdk-21
node simulation/target-server.js &          # listens on 127.0.0.1:8099
./gradlew gatlingRun --no-daemon
```

The build exits non-zero **by design** — the third assertion is meant to fail, so the assertions table shows both statuses. The report is still generated.

The target server uses a seeded xorshift PRNG, so latency shapes are reproducible across runs. Absolute timings will still differ with machine load; the parity matrix asserts structure and relative shape, not wall-clock values.
