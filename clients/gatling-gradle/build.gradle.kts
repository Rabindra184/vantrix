// `java` in a build script resolves to the java{} extension, shadowing the
// package -- hence the explicit import for the jar-content check below.
import java.net.URI
import java.nio.file.FileSystems
import java.nio.file.Files
import java.util.jar.JarInputStream
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
version = providers.gradleProperty("releaseVersion").getOrElse("0.3.0-SNAPSHOT")

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

// ─── The agent, carried as a file ───────────────────────────────────────────
// The plugin hands the PerfPortal Gatling agent to the user's Gatling JVM as
// `-javaagent:`, so its jar travels INSIDE the plugin jar, as a resource the
// plugin extracts at run time. It is a FILE the user's JVM loads, never a
// class the plugin loads -- hence a resource and not a dependency: on the
// runtime classpath the shadow step below would merge its classes into ours
// and keep only our manifest, losing the Premain-Class that makes it an agent.
//
// settings.gradle.kts includes ../gatling-agent as a build, so this one
// coordinate is satisfied by the sibling's own shadowJar, built from source
// in the same invocation -- a clean checkout needs no separate agent build,
// and the agent's tests (a real-Gatling e2e among them) never run here: only
// the task producing the artifact is scheduled. Its version is irrelevant;
// an included build substitutes by group and name.
val AGENT_RESOURCE = "dev/vantrix/gradle/agent/gatling-agent.jar"
val agentJar: Configuration by configurations.creating {
    isCanBeConsumed = false
    // Byte Buddy is already inside the agent jar, relocated; nothing else is
    // wanted, and nothing of the agent's may reach the plugin's classpath.
    isTransitive = false
    // SHADOWED selects the shadow plugin's own variant (shadowRuntimeElements).
    // The agent build disables its plain jar, so the ordinary runtime variant
    // names a jar that is never produced.
    attributes {
        attribute(Usage.USAGE_ATTRIBUTE, objects.named(Usage.JAVA_RUNTIME))
        attribute(Category.CATEGORY_ATTRIBUTE, objects.named(Category.LIBRARY))
        attribute(LibraryElements.LIBRARY_ELEMENTS_ATTRIBUTE, objects.named(LibraryElements.JAR))
        attribute(Bundling.BUNDLING_ATTRIBUTE, objects.named(Bundling.SHADOWED))
    }
}
dependencies { agentJar("io.perfportal:gatling-agent") }

tasks.processResources {
    from(agentJar) {
        into(AGENT_RESOURCE.substringBeforeLast('/'))
        rename { AGENT_RESOURCE.substringAfterLast('/') }
    }
}

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

    // THE AGENT IS ADDED AFTER THE SHADOW COPY, NOT BY IT. Shadow's copy
    // action unpacks EVERY file whose path ends in `.jar` and merges its
    // entries in -- there is no opt-out (ShadowCopyAction's isArchive is a
    // suffix test) -- so left in the main output, the agent arrived as
    // io/perfportal/agent/*.class beside our own classes and no
    // gatling-agent.jar at all. Measured, not assumed: the first build of
    // this carried 9161 entries (3063 once fixed) and verifyShadedJar refused
    // it. So the resource is excluded here and written in, byte for byte,
    // once the jar exists. The TestKit classpath still sees it through
    // processResources.
    exclude(AGENT_RESOURCE)
    inputs.files(agentJar).withPropertyName("agentJar")
    doLast {
        val out = archiveFile.get().asFile
        FileSystems.newFileSystem(URI.create("jar:${out.toURI()}"), emptyMap<String, Any>()).use { fs ->
            val target = fs.getPath(AGENT_RESOURCE)
            Files.createDirectories(target.parent)
            Files.copy(agentJar.singleFile.toPath(), target)
        }
    }
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
        // The agent rides inside as a FILE, and the user's JVM is what reads
        // it -- so the check opens it the way that JVM will: as a jar whose
        // own manifest names the premain. A resource that is present but is
        // not an agent (a stale copy, the plain jar the agent build disables,
        // a jar the shadow step rewrote) would fail at `-javaagent:` on the
        // user's machine, where nothing of ours can see it.
        val agentBytes = ZipFile(jar).use { z ->
            val entry = z.getEntry(AGENT_RESOURCE)
            check(entry != null) { "shadow jar carries no $AGENT_RESOURCE -- the agent did not get packaged" }
            z.getInputStream(entry).use { it.readBytes() }
        }
        val premain = JarInputStream(agentBytes.inputStream()).use {
            it.manifest?.mainAttributes?.getValue("Premain-Class")
        }
        check(premain == "io.perfportal.agent.AgentMain") {
            "$AGENT_RESOURCE is not the PerfPortal agent: its manifest names Premain-Class=$premain"
        }
        // Byte-identical to what the agent build produced in this same
        // invocation, because that is the shape the agent's own gate (its
        // tests, the image's smoke check) is written against; a copy the
        // plugin's shadow step touched on the way in is a jar no check of the
        // agent's describes.
        val built = agentJar.singleFile.readBytes()
        check(agentBytes.contentEquals(built)) {
            "$AGENT_RESOURCE differs from the agent build's own jar (${agentBytes.size} bytes against ${built.size})"
        }
    }
}
tasks.build { dependsOn(verifyShadedJar) }

// The shaded deps are BUNDLED, so nothing published may declare them. TWO
// documents matter, and fixing only the POM is a trap this project fell into:
// Gradle also publishes module metadata (.module) and CONSUMERS PREFER IT, so
// a cleaned POM with live module metadata still leaks gson onto every
// consumer's buildscript classpath -- found by resolving as a real consumer
// (the Downloads demo), not by any of this module's own checks. Module
// metadata is disabled outright; consumers fall back to the POM, which the
// withXml below empties. A plugin needs no variant metadata.
tasks.withType<GenerateModuleMetadata>().configureEach { enabled = false }

publishing {
    publications.withType<MavenPublication>().configureEach {
        // LICENCE METADATA, because a published artefact travels without its
        // repository. A consumer resolving this plugin sees the POM and
        // nothing else -- no LICENSE file, no README -- so an artefact with no
        // <licenses> block is one whose terms nobody downstream can determine.
        pom {
            name.set("Vantrix Gatling Gradle plugin")
            description.set("Streams Gatling results from a Gradle build into PerfPortal.")
            url.set("https://github.com/Rabindra184/vantrix")
            licenses {
                license {
                    name.set("The Apache License, Version 2.0")
                    url.set("https://www.apache.org/licenses/LICENSE-2.0.txt")
                }
            }
        }
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
