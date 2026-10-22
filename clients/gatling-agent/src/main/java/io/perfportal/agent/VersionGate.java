package io.perfportal.agent;

import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.net.URLConnection;
import java.util.Properties;
import java.util.Set;
import java.util.TreeSet;
import java.util.jar.Attributes;
import java.util.jar.Manifest;

/**
 * Decides whether the agent may instrument the Gatling it was loaded into.
 *
 * <p>The HTTP instrumentation hooks Gatling's internals by name, so it is only safe against a
 * version it was written for. Both jars it touches are checked: a version outside {@link
 * #SUPPORTED} turns HTTP collection off and says why, and the machine and JVM figures are
 * unaffected.
 *
 * <p>A version is read from the jar's {@code META-INF/maven/io.gatling/<artifact>/pom.properties}
 * when there is one, and otherwise from the {@code Implementation-Version} of the manifest of the
 * jar holding a class only that artifact ships. The second is NOT a nicety: Gatling's own 3.15.1
 * jars are built by sbt and carry NO {@code pom.properties} -- only a manifest -- so a gate that
 * read {@code pom.properties} alone would refuse the real runtime every time. The class is found
 * as a RESOURCE, never loaded, so the gate cannot load a Gatling class ahead of the
 * instrumentation that has to see it load.
 */
final class VersionGate {
  static final Set<String> SUPPORTED = Set.of("3.15.1");

  private static final String CLIENT = "gatling-http-client";
  private static final String HTTP = "gatling-http";
  // A class file each artifact ships and the other does not, to find its jar by.
  private static final String CLIENT_MARKER = "io/gatling/http/client/HttpClient.class";
  private static final String HTTP_MARKER = "io/gatling/http/engine/HttpEngine.class";

  private VersionGate() {}

  static Result check(ClassLoader cl) {
    String client = version(cl, CLIENT, CLIENT_MARKER);
    String http = version(cl, HTTP, HTTP_MARKER);
    String reason = refusal(CLIENT, client);
    if (reason == null) reason = refusal(HTTP, http);
    return new Result(reason, client, http);
  }

  private static String refusal(String artifact, String version) {
    if (version == null) return artifact + " was not found on the classpath";
    if (SUPPORTED.contains(version)) return null;
    return artifact
        + " "
        + version
        + " is not supported by agent "
        + AgentMain.VERSION
        + " (supported: "
        + String.join(", ", new TreeSet<>(SUPPORTED))
        + ")";
  }

  private static String version(ClassLoader cl, String artifact, String marker) {
    String v = pomVersion(cl, artifact);
    return v != null ? v : manifestVersion(cl, artifact, marker);
  }

  private static String pomVersion(ClassLoader cl, String artifact) {
    URL url = resource(cl, "META-INF/maven/io.gatling/" + artifact + "/pom.properties");
    if (url == null) return null;
    try (InputStream in = open(url)) {
      Properties p = new Properties();
      p.load(in);
      return clean(p.getProperty("version"));
    } catch (IOException | RuntimeException e) {
      return null;
    }
  }

  /**
   * The manifest of the jar (or directory) {@code marker} was found in. Its {@code
   * Implementation-Title} must name {@code artifact}, so a fat jar that bundled Gatling under
   * its own manifest reads as "not found" rather than as some other artifact's version.
   */
  private static String manifestVersion(ClassLoader cl, String artifact, String marker) {
    URL classUrl = resource(cl, marker);
    if (classUrl == null) return null;
    String s = classUrl.toString();
    if (!s.endsWith(marker)) return null;
    try (InputStream in = open(new URL(s.substring(0, s.length() - marker.length())
        + "META-INF/MANIFEST.MF"))) {
      Attributes main = new Manifest(in).getMainAttributes();
      if (!artifact.equals(clean(main.getValue(Attributes.Name.IMPLEMENTATION_TITLE)))) return null;
      return clean(main.getValue(Attributes.Name.IMPLEMENTATION_VERSION));
    } catch (IOException | RuntimeException e) {
      return null;
    }
  }

  private static URL resource(ClassLoader cl, String path) {
    try {
      return cl == null ? ClassLoader.getSystemResource(path) : cl.getResource(path);
    } catch (RuntimeException e) {
      return null;
    }
  }

  // Uncached, so reading a manifest never pins a JarFile the class loader did not open itself.
  private static InputStream open(URL url) throws IOException {
    URLConnection c = url.openConnection();
    c.setUseCaches(false);
    return c.getInputStream();
  }

  private static String clean(String v) {
    return v == null || v.trim().isEmpty() ? null : v.trim();
  }

  static final class Result {
    private final String reason;
    private final String gatlingHttpClient;
    private final String gatlingHttp;

    Result(String reason, String gatlingHttpClient, String gatlingHttp) {
      this.reason = reason;
      this.gatlingHttpClient = gatlingHttpClient;
      this.gatlingHttp = gatlingHttp;
    }

    /** Whether HTTP instrumentation is safe here. */
    boolean http() {
      return reason == null;
    }

    /** Why HTTP collection is off; null when it is on. */
    String reason() {
      return reason;
    }

    /** The version found, or null when the jar is absent. */
    String gatlingHttpClient() {
      return gatlingHttpClient;
    }

    /** The version found, or null when the jar is absent. */
    String gatlingHttp() {
      return gatlingHttp;
    }
  }
}
