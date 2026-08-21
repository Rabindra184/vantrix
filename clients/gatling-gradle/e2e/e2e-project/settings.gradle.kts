// THE PLUGIN VERSION IS NOT WRITTEN DOWN HERE, AND THAT IS THE POINT.
//
// It used to be a literal in build.gradle.kts (`version "0.1.0-SNAPSHOT"`),
// which silently stopped matching the moment the plugin's own default version
// moved on — publishToMavenLocal produced 0.2.0-SNAPSHOT while this project
// asked for 0.1.0-SNAPSHOT, and the whole manual e2e failed in Gradle's
// plugin-resolution phase with "was not found in any of the following
// sources", before Gatling or the platform were involved at all. Nothing
// caught it: this gate is manual and outside every `pnpm` and CI job.
//
// `run-e2e.sh` now DERIVES the version from the plugin project and passes it
// in, exactly as CI's own `plugin-consume` job already did
// (`.github/workflows/ci.yml` — `awk '/^version:/{print $2}'`). One source,
// so the two sides cannot disagree again.
pluginManagement {
    repositories {
        mavenLocal()
        gradlePluginPortal()
        mavenCentral()
    }

    val vantrixVersion = providers.gradleProperty("vantrixPluginVersion").orNull
        ?: error(
            "vantrixPluginVersion was not set. This project is built by " +
                "clients/gatling-gradle/e2e/run-e2e.sh, which derives the version from the " +
                "plugin build and passes -PvantrixPluginVersion. Deliberately NO default: a " +
                "fallback here is what let the version drift out of step in the first place."
        )

    plugins {
        id("dev.vantrix.gatling") version vantrixVersion
    }
}

rootProject.name = "gatling-gradle-e2e"
