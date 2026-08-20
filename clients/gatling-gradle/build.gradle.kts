// `java` in a build script resolves to the java{} extension, shadowing the
// package -- hence the explicit import for the jar-content check below.
import java.util.zip.ZipFile

plugins {
    `java-gradle-plugin`
    `maven-publish`
    kotlin("jvm") version "2.0.21"
    // Shades and RELOCATES the two runtime deps (gson, commons-compress) into
    // dev.vantrix.gradle.shaded.*, so a consumer's build never sees our copies
    // and a second plugin on a different gson major cannot conflict with us.
    id("com.gradleup.shadow") version "8.3.6"
}

group = "dev.vantrix"
// The tag-driven release workflow overrides this with -PreleaseVersion=<tag>;
// every other build (local, CI snapshot publish) gets the -SNAPSHOT default.
// A plain `version = "..."` assignment would silently win over -P flags, which
// is why the override arrives through its own named property.
version = providers.gradleProperty("releaseVersion").getOrElse("0.2.0-SNAPSHOT")

kotlin { jvmToolchain(21) }

repositories { mavenCentral() }

dependencies {
    implementation("com.google.code.gson:gson:2.11.0")
    implementation("org.apache.commons:commons-compress:1.26.2")
    testImplementation(platform("org.junit:junit-bom:5.10.2"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testImplementation(gradleTestKit())
    testImplementation(kotlin("test"))
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

gradlePlugin {
    plugins {
        create("vantrix") {
            id = "dev.vantrix.gatling"
            implementationClass = "dev.vantrix.gradle.VantrixPlugin"
        }
    }
}

tasks.test { useJUnitPlatform() }

// ─── Shading ────────────────────────────────────────────────────────────────
// The shadow jar IS the artifact: classifier "" so the publications pick it
// up, and the plain jar is disabled so it cannot be published by accident.
tasks.shadowJar {
    archiveClassifier = ""
    relocate("com.google.gson", "dev.vantrix.gradle.shaded.gson")
    relocate("org.apache.commons.compress", "dev.vantrix.gradle.shaded.commonscompress")
    // gson's own transitive annotation jar; relocated so nothing of ours
    // leaks an unshaded com.google.* package.
    relocate("com.google.errorprone", "dev.vantrix.gradle.shaded.errorprone")
    // NO minimize(): gson and commons-compress both load classes reflectively
    // (type adapters; compressors resolved by name), and a minimized jar is a
    // runtime-only failure the suite cannot see. Size is irrelevant here.
}
tasks.jar { enabled = false }

// java-gradle-plugin's auto-created `pluginMaven` publication takes its
// artifact from component java's outgoing configurations, which point at the
// (disabled) plain jar. Repoint both at the shadow jar so the publication and
// any consuming build resolve the SHADED artifact and nothing references a
// task that no longer produces output.
configurations.apiElements {
    outgoing {
        artifacts.clear()
        artifact(tasks.shadowJar)
    }
}
configurations.runtimeElements {
    outgoing {
        artifacts.clear()
        artifact(tasks.shadowJar)
    }
}
// `build` runs `assemble`, which must produce the shadowed artifact.
tasks.assemble { dependsOn(tasks.shadowJar) }

// TestKit's withPluginClasspath() and the plugin-under-test metadata read the
// plain classes/dirs, not the jar — tests are unaffected by shading. What
// MUST be checked forever is the published artifact itself:
val verifyShadedJar by tasks.registering {
    dependsOn(tasks.shadowJar)
    doLast {
        val jar = tasks.shadowJar.get().archiveFile.get().asFile
        val entries = ZipFile(jar).use { z ->
            z.entries().asSequence().map { it.name }.toList()
        }
        val leaked = entries.filter {
            it.startsWith("com/google/") || it.startsWith("org/apache/commons/compress/")
        }
        check(leaked.isEmpty()) {
            "shadow jar leaks unrelocated third-party classes:\n" +
                leaked.take(10).joinToString("\n")
        }
        check(entries.any { name -> name.startsWith("dev/vantrix/gradle/shaded/gson/") }) {
            "shadow jar carries no relocated gson -- relocation silently vanished"
        }
        check(entries.any { name -> name.startsWith("dev/vantrix/gradle/VantrixPlugin") }) {
            "shadow jar is missing the plugin's own classes"
        }
    }
}
tasks.build { dependsOn(verifyShadedJar) }

// The shaded deps are BUNDLED, so the published POM must not declare them:
// a consumer resolving our POM should see zero runtime dependencies.
publishing {
    publications.withType<MavenPublication>().configureEach {
        pom.withXml {
            val root = asNode()
            @Suppress("UNCHECKED_CAST")
            val deps = (root.children() as List<groovy.util.Node>)
                .filter { (it.name() as? groovy.namespace.QName)?.localPart == "dependencies" || it.name() == "dependencies" }
            deps.forEach { root.remove(it) }
        }
    }
}

publishing {
    repositories {
        maven {
            name = "GitHubPackages"
            url = uri("https://maven.pkg.github.com/Rabindra184/vantrix")
            credentials {
                username = System.getenv("GITHUB_ACTOR") ?: ""
                password = System.getenv("GITHUB_TOKEN") ?: ""
            }
        }
    }
}
