// The PerfPortal Gatling agent: a -javaagent loaded into every Gatling JVM the
// on-prem runner starts, recording DNS/TCP/TLS/socket/status/JVM/machine
// figures into an NDJSON file (format `perfportal-agent/1`).
//
// It runs inside a USER's JVM, which may be Java 11 or 17, so its bytecode is
// `--release 11` whatever toolchain builds it.
plugins {
    java
    // Shades AND RELOCATES Byte Buddy into io.perfportal.agent.shaded.*, so the
    // agent's copy can never clash with a Byte Buddy the simulation carries.
    id("com.gradleup.shadow") version "8.3.6"
}

group = "io.perfportal"
version = "0.1.0"

repositories { mavenCentral() }

// An OLD Byte Buddy, never on the agent's or the tests' own classpath: GatlingRunE2ETest puts it
// first on a simulation's classpath to prove the agent's relocated copy cannot clash with it.
// A configuration of its own because on testRuntimeClasspath Gradle would resolve it UP to 1.17.6.
val oldByteBuddy: Configuration by configurations.creating { isTransitive = false }

tasks.withType<JavaCompile>().configureEach { options.release.set(11) }

dependencies {
    implementation("net.bytebuddy:byte-buddy:1.17.6")

    // Provided by the Gatling runtime the agent is loaded into -- never bundled.
    compileOnly("io.gatling:gatling-http-client:3.15.1")
    compileOnly("io.gatling:gatling-http:3.15.1")

    testImplementation("io.gatling:gatling-http-client:3.15.1")
    testImplementation("io.gatling:gatling-http:3.15.1")
    testImplementation("io.gatling.highcharts:gatling-charts-highcharts:3.15.1")
    testImplementation(platform("org.junit:junit-bom:5.11.4"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")

    oldByteBuddy("net.bytebuddy:byte-buddy:1.10.22")
}

// The shadow jar IS the artifact; the plain jar would carry no Byte Buddy.
tasks.jar { enabled = false }
tasks.shadowJar {
    archiveClassifier.set("")
    archiveFileName.set("gatling-agent.jar")
    relocate("net.bytebuddy", "io.perfportal.agent.shaded.bytebuddy")
    // Byte Buddy's module descriptor names the packages relocation just moved;
    // a stale descriptor is worse than none (an agent jar is never a module).
    exclude("**/module-info.class")
    manifest {
        attributes(
            "Premain-Class" to "io.perfportal.agent.AgentMain",
            "Can-Redefine-Classes" to "true",
            "Can-Retransform-Classes" to "true",
            "Multi-Release" to "true",
        )
    }
}
tasks.build { dependsOn(tasks.shadowJar) }

tasks.test {
    useJUnitPlatform()
    dependsOn(tasks.shadowJar)
    // Later tasks launch a JVM with -javaagent:<this> to test the real artifact.
    systemProperty("agentJar", tasks.shadowJar.get().archiveFile.get().asFile.path)
    inputs.files(oldByteBuddy)
    doFirst { systemProperty("oldByteBuddyJar", oldByteBuddy.singleFile.path) }
}
