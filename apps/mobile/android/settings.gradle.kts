pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "erp-mobile"
include(":core")
// O app Android exige o SDK; `-Perp.coreOnly=true` testa só o núcleo JVM em máquinas sem SDK.
if (providers.gradleProperty("erp.coreOnly").orNull != "true") include(":app")
