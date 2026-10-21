package io.perfportal.gatlingmethod;

import com.tdunning.math.stats.AVLTreeDigest;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.PrintStream;
import java.lang.reflect.InaccessibleObjectException;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Random;

/**
 * Replays a run's response times the way Gatling's report computes its
 * percentiles, and prints, per stats key, the lowest and highest value each
 * percentile takes across N seeded replays.
 *
 * <h2>The method</h2>
 *
 * Gatling 3.15.1's report keeps one t-digest 3.3 {@code AVLTreeDigest(100)}
 * per stats key and population, adds every response time to it in log order,
 * and prints {@code Math.round(digest.quantile(p / 100.0))}.
 *
 * <h2>Why N replays and a range</h2>
 *
 * {@code AVLTreeDigest.add} breaks a tie between two equidistant centroids
 * with {@code gen.nextDouble()}, and {@code gen} is an UNSEEDED
 * {@code java.util.Random}. Two reports of one log can therefore print
 * different percentiles, and no single replay can claim to be "Gatling's
 * value". This tool replaces {@code gen} with {@code new Random(seed)} for
 * seeds {@code 0..N-1}, so its answer is reproducible, and reports the set's
 * bounds. Measured: every percentile cell of two real reports lies inside the
 * 200-seed range.
 *
 * <h2>I/O</h2>
 *
 * <pre>
 *   args:   --seeds N --percentiles 50,75,95,99
 *   stdin:  lines of  key TAB integer-ms   (key = everything before the LAST tab)
 *   stdout: one JSON line per key, in first-seen order:
 *           {"key":"…","n":count,"p":{"50":[low,high],"75":[…],…}}
 *   exit:   0 ok; 2 bad arguments or input; 3 the digest cannot be seeded
 * </pre>
 *
 * Memory is the values, not N digests: each key's digests are built and
 * dropped one seed at a time.
 */
public final class GatlingMethod {

    /** Gatling's compression for every report digest. */
    static final double COMPRESSION = 100.0;

    private GatlingMethod() {}

    /** A key's values in arrival order: an int array that grows. */
    static final class Values {
        int[] data = new int[16];
        int size;

        void add(int v) {
            if (size == data.length) data = Arrays.copyOf(data, size * 2);
            data[size++] = v;
        }
    }

    static final class UsageError extends Exception {
        private static final long serialVersionUID = 1L;

        UsageError(String message) {
            super(message);
        }
    }

    public static void main(String[] args) {
        PrintStream err = System.err;
        try {
            run(args);
        } catch (UsageError e) {
            err.println("gatling-method: " + e.getMessage());
            System.exit(2);
        } catch (ReflectiveOperationException | InaccessibleObjectException e) {
            err.println("gatling-method: cannot seed AVLTreeDigest: " + e);
            System.exit(3);
        } catch (IOException e) {
            err.println("gatling-method: " + e.getMessage());
            System.exit(2);
        }
    }

    static void run(String[] args) throws UsageError, IOException, ReflectiveOperationException {
        int seeds = -1;
        String[] percentiles = null;
        for (int i = 0; i < args.length; i += 2) {
            if (i + 1 >= args.length) throw new UsageError(args[i] + " needs a value");
            switch (args[i]) {
                case "--seeds" -> {
                    try {
                        seeds = Integer.parseInt(args[i + 1]);
                    } catch (NumberFormatException e) {
                        throw new UsageError("--seeds must be an integer, got " + args[i + 1]);
                    }
                    if (seeds < 1) throw new UsageError("--seeds must be at least 1");
                }
                case "--percentiles" -> percentiles = args[i + 1].split(",");
                default -> throw new UsageError("unknown argument " + args[i]);
            }
        }
        if (seeds < 0) throw new UsageError("--seeds is required");
        if (percentiles == null || percentiles.length == 0) throw new UsageError("--percentiles is required");
        double[] quantiles = new double[percentiles.length];
        for (int i = 0; i < percentiles.length; i++) {
            double p;
            try {
                p = Double.parseDouble(percentiles[i].trim());
            } catch (NumberFormatException e) {
                throw new UsageError("not a percentile: " + percentiles[i]);
            }
            if (!(p >= 0 && p <= 100)) throw new UsageError("a percentile must be within 0..100, got " + percentiles[i]);
            percentiles[i] = percentiles[i].trim();
            quantiles[i] = p / 100.0;
        }

        Map<String, Values> keys = readInput(new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8)));

        Field gen = AVLTreeDigest.class.getDeclaredField("gen");
        gen.setAccessible(true);

        BufferedWriter out = new BufferedWriter(new OutputStreamWriter(System.out, StandardCharsets.UTF_8));
        for (Map.Entry<String, Values> entry : keys.entrySet()) {
            long[][] range = replay(entry.getValue(), quantiles, seeds, gen);
            out.write(json(entry.getKey(), entry.getValue().size, percentiles, range));
            out.write('\n');
        }
        out.flush();
    }

    static Map<String, Values> readInput(BufferedReader in) throws IOException, UsageError {
        Map<String, Values> keys = new LinkedHashMap<>();
        String line;
        long lineNo = 0;
        while ((line = in.readLine()) != null) {
            lineNo++;
            if (line.endsWith("\r")) line = line.substring(0, line.length() - 1);
            if (line.isEmpty()) continue;
            int tab = line.lastIndexOf('\t');
            if (tab < 0) throw new UsageError("line " + lineNo + " has no tab");
            String key = line.substring(0, tab);
            int value;
            try {
                value = Integer.parseInt(line.substring(tab + 1).trim());
            } catch (NumberFormatException e) {
                throw new UsageError("line " + lineNo + ": not an integer: " + line.substring(tab + 1));
            }
            keys.computeIfAbsent(key, k -> new Values()).add(value);
        }
        return keys;
    }

    /** {@code [percentile][0=low, 1=high]} across seeds {@code 0..seeds-1}. */
    static long[][] replay(Values values, double[] quantiles, int seeds, Field gen) throws IllegalAccessException {
        long[][] range = new long[quantiles.length][2];
        for (long[] r : range) {
            r[0] = Long.MAX_VALUE;
            r[1] = Long.MIN_VALUE;
        }
        for (int seed = 0; seed < seeds; seed++) {
            AVLTreeDigest digest = new AVLTreeDigest(COMPRESSION);
            gen.set(digest, new Random(seed));
            for (int i = 0; i < values.size; i++) digest.add((double) values.data[i]);
            for (int q = 0; q < quantiles.length; q++) {
                long v = Math.round(digest.quantile(quantiles[q]));
                if (v < range[q][0]) range[q][0] = v;
                if (v > range[q][1]) range[q][1] = v;
            }
        }
        return range;
    }

    static String json(String key, int n, String[] percentiles, long[][] range) {
        StringBuilder sb = new StringBuilder(64 + key.length());
        sb.append("{\"key\":");
        quote(sb, key);
        sb.append(",\"n\":").append(n).append(",\"p\":{");
        for (int i = 0; i < percentiles.length; i++) {
            if (i > 0) sb.append(',');
            quote(sb, percentiles[i]);
            sb.append(":[").append(range[i][0]).append(',').append(range[i][1]).append(']');
        }
        return sb.append("}}").toString();
    }

    /** A JSON string literal: quotes, backslash and every control character escaped. */
    static void quote(StringBuilder sb, String s) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"' -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                case '\b' -> sb.append("\\b");
                case '\f' -> sb.append("\\f");
                default -> {
                    if (c < 0x20 || c == 0x2028 || c == 0x2029) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
                }
            }
        }
        sb.append('"');
    }
}
