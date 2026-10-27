rootProject.name = "gatling-gradle-plugin"

// The PerfPortal Gatling agent, built from source as part of this build so the
// plugin jar can carry it (build.gradle.kts, "The agent, carried as a file").
// A sibling directory, so it resolves from any full checkout -- CI's `plugin`
// job builds here inside one.
includeBuild("../gatling-agent")
