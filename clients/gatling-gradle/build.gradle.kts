plugins {
    `java-gradle-plugin`
    `maven-publish`
    kotlin("jvm") version "2.0.21"
}

group = "dev.vantrix"
// The tag-driven release workflow overrides this with -PreleaseVersion=<tag>;
// every other build (local, CI snapshot publish) gets the -SNAPSHOT default.
// A plain `version = "..."` assignment would silently win over -P flags, which
// is why the override arrives through its own named property.
version = providers.gradleProperty("releaseVersion").getOrElse("0.1.0-SNAPSHOT")

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
