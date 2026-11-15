// PRATA Remote — Android (Command 002, Tugas 2-3)
// Proyek Gradle: :shared (library) + :agent + :controller (aplikasi).
// Buka folder apps/android di Android Studio (JDK 17, AGP 8.7.3).
// Build pertama mengunduh AGP, plugin Kotlin, Compose, AndroidX,
// Retrofit, OkHttp, CameraX, ML Kit, ZXing dari Google Maven Central.
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
rootProject.name = "prata-remote-android"
include(":shared")
include(":agent")
include(":controller")
