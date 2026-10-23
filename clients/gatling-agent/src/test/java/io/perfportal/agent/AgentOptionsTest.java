package io.perfportal.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Path;
import org.junit.jupiter.api.Test;

class AgentOptionsTest {
  @Test
  void parsesOutAndMax() {
    AgentOptions o = AgentOptions.parse("out=/w/a.ndjson,max=1024");
    assertEquals(Path.of("/w/a.ndjson"), o.out());
    assertEquals(1024L, o.maxBytes());
    assertFalse(o.isDisabled());
  }

  @Test
  void maxDefaultsTo256MiB() {
    assertEquals(268_435_456L, AgentOptions.parse("out=/w/a.ndjson").maxBytes());
  }

  @Test
  void anUnreadableMaxKeepsTheDefault() {
    assertEquals(268_435_456L, AgentOptions.parse("out=/w/a.ndjson,max=lots").maxBytes());
    assertEquals(268_435_456L, AgentOptions.parse("out=/w/a.ndjson,max=-5").maxBytes());
  }

  @Test
  void missingOutDisablesTheAgent() {
    assertTrue(AgentOptions.parse("max=5").isDisabled());
    assertTrue(AgentOptions.parse(null).isDisabled());
    assertTrue(AgentOptions.parse("").isDisabled());
    assertTrue(AgentOptions.parse("out=").isDisabled());
    assertTrue(AgentOptions.disabled().isDisabled());
  }

  @Test
  void ignoresUnknownKeysAndWhitespace() {
    AgentOptions o = AgentOptions.parse(" color=blue , out = /w/b.ndjson ");
    assertEquals(Path.of("/w/b.ndjson"), o.out());
  }

  @Test
  void aValueMayContainAnEqualsSign() {
    assertEquals(Path.of("/w/a=b.ndjson"), AgentOptions.parse("out=/w/a=b.ndjson").out());
  }
}
