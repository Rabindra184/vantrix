plugins {
    `java-gradle-plugin`
    `maven-publish`
    kotlin("jvm") version "2.0.21"
}

group = "dev.vantrix"
version = "0.1.0-SNAPSHOT"

kotlin { jvmToolchain(21) }

repositories { mavenCentral() }

dependencies {
    implementation("com.google.code.gson:gson:2.11.0")
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
