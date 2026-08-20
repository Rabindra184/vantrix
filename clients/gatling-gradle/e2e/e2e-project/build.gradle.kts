// Task 7 (gatling-gradle-live-streaming): a real Gatling run, built by the real
// `io.gatling.gradle` plugin, streamed live by our own `dev.vantrix.gatling`
// plugin (resolved from mavenLocal(), see settings.gradle.kts) into a real
// running Vantrix platform.
//
// This file is a near-verbatim copy of the reference fixture's own
// build.gradle.kts (fixtures/gatling-3.15.1.2/simulation/build.gradle.kts,
// itself lifted from Gatling's own gatling-gradle-plugin-demo-kotlin) with one
// addition: the `dev.vantrix.gatling` plugin line. The simulation source
// itself is copied in by run-e2e.sh (never edited here) into this project's
// default Gatling Kotlin source set, `src/gatling/kotlin/` -- see that
// script's own comment for why a runtime copy rather than a committed one.
plugins {
    kotlin("jvm") version "2.4.10"
    kotlin("plugin.allopen") version "2.4.10"

    // Loads io.gatling.gradle and applies it directly.
    id("io.gatling.gradle") version "3.15.1.2"

    // The plugin under test. Pure env config (VANTRIX_URL / VANTRIX_TOKEN /
    // VANTRIX_TICK_SECONDS, set by run-e2e.sh) -- no vantrix{} block needed,
    // see ResolvedConfig.from's fallback to System.getenv().
    id("dev.vantrix.gatling") version "0.1.0-SNAPSHOT"
}

tasks.withType(JavaCompile::class) {
    options.release.set(21)
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_21)
    }
}

repositories {
    mavenCentral()
}
