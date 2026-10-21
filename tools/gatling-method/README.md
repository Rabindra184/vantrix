# gatling-method

Computes the percentiles Gatling's own HTML report would print for a run, so
PerfPortal can say where that report differs from the exact value at a rank.

## The method

Gatling 3.15.1 keeps one t-digest 3.3 `AVLTreeDigest(100)` per stats key and
population, adds every value to it in log order, and prints
`Math.round(digest.quantile(p / 100.0))`. This tool does the same — the same
library, the same compression, the same order — per key it is given.

**Gatling's report is not deterministic.** `AVLTreeDigest.add` breaks a tie
between two equidistant centroids with `gen.nextDouble()`, and `gen` is an
unseeded `java.util.Random`, so two reports of one log can differ. The tool
replaces `gen` (through reflection) with `new java.util.Random(seed)` for seeds
`0..N-1` and reports, per percentile, the lowest and highest value across those
replays. The output is therefore reproducible, and a report value is "Gatling's"
when it lies inside the range — and equals it wherever every seed agrees.

Measured on three real reports (`infra/test/gatling-method-fixtures.mjs`):
every percentile cell lies inside the 200-seed range.

## I/O contract

```
java -cp gatling-method.jar:t-digest-3.3.jar io.perfportal.gatlingmethod.GatlingMethod \
     --seeds <N> --percentiles 50,75,95,99
```

- **stdin:** lines of `<key>\t<integer ms>`. The key is opaque text up to the
  LAST tab; the worker sends `k0`, `k1`, … and maps them back itself. Values of
  one key are added in the order they arrive. Blank lines are ignored; a
  trailing `\r` is stripped.
- **stdout:** one JSON line per key, in first-seen order:

  ```
  {"key":"k0","n":895,"p":{"50":[109,109],"75":[250,250],"95":[654,654],"99":[2349,2412]}}
  ```

  `n` is the value count; each percentile maps to `[low, high]` across the
  seeds. The percentile labels are echoed exactly as given. Keys are
  JSON-escaped (quotes, backslash, every control character).
- **exit:** `0` success · `2` bad arguments or input (named on stderr) · `3`
  `AVLTreeDigest` cannot be seeded (the `gen` field is missing or
  inaccessible — a t-digest other than 3.3).

Memory is the values: each key's digests are built and dropped one seed at a
time.

## What feeds it (the worker's keys)

Gatling's report keys, each in log order:

- every request record feeds the run (all requests) in `total`, and its own
  request (`<groups…>/<name>`) in `total` and its status population
  (`ok`/`ko`); the value is `endMs − startMs`. The run has no status
  populations: Gatling's report prints its percentiles in the Total column
  alone;
- every group record feeds its own group (`<groups path>`) with its
  **cumulated** response time, in `total` and its status.

Every request record counts, warm-up included: Gatling knows no warm-up.

## Building

```
bash tools/gatling-method/build.sh     # → tools/gatling-method/build/gatling-method.jar
```

**Java 21 throughout.** `build.sh` needs a JDK 21 (`javac`, `jar`; `JAVA_HOME`
is honoured — on a machine whose default `java` is older, run it with
`JAVA_HOME=$(/usr/libexec/java_home -v 21)` or equivalent), and the jar is
`--release 21` bytecode, so RUNNING it needs a Java 21 runtime too: an older
`java` fails with `UnsupportedClassVersionError`. The fixture check runs
whichever `java` is first on `PATH` unless given `--java <path to a Java 21
java>`, and says so when that error is the cause:

```
node infra/test/gatling-method-fixtures.mjs \
  --jar tools/gatling-method/build/gatling-method.jar \
  --tdigest ~/.perfportal/gatling-home/lib/t-digest-3.3.jar \
  --fixtures fixtures/gatling-3.15.1.2 \
  [--seeds 200] [--java "$(/usr/libexec/java_home -v 21)/bin/java"]
```

It also needs t-digest 3.3:
`TDIGEST_JAR`, else `$RUNNER_GATLING_HOME/lib/t-digest-3.3.jar` (default
`/opt/gatling`), else `~/.perfportal/gatling-home/lib/t-digest-3.3.jar`.
t-digest is a compile-time and classpath dependency, deliberately not bundled:
the tool runs against the copy Gatling's own runtime carries. The production
image builds the jar in a JDK stage and ships it at
`/opt/perfportal/gatling-method.jar`.
