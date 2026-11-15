// PRATA Remote — Aplikasi Controller (Command 002, Tugas 3)
// Kotlin + Jetpack Compose. Login controller, daftar perangkat,
// dan pemindai QR pairing (CameraX + ML Kit).
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.prata.remote.controller"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.prata.remote.controller"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
    }
    composeOptions {
        kotlinCompilerExtensionVersion = "2.0.21"
    }
}

dependencies {
    implementation(project(":shared"))
    implementation(platform("androidx.compose:compose-bom:2024.10.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.activity:activity-compose:1.9.2")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.6")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.6")
    implementation("androidx.navigation:navigation-compose:2.8.0")
    // CameraX (pemindai QR) + ML Kit Barcode (hanya format QR).
    implementation("androidx.camera:camera-core:1.3.4")
    implementation("androidx.camera:camera-camera2:1.3.4")
    implementation("androidx.camera:camera-lifecycle:1.3.4")
    implementation("androidx.camera:camera-view:1.3.4")
    implementation("com.google.mlkit:barcode-scanning:17.3.0")
    // WAJIB untuk parent tema XML Theme.Material3.DayNight.NoActionBar
    // di res/values/themes.xml (bukan bagian dari Compose material3).
    implementation("com.google.android.material:material:1.12.0")
    // WebRTC (SurfaceViewRenderer + EglBase dipakai langsung di modul ini;
    // implementation :shared tidak diturunkan ke consumer).
    // Fork LiveKit (pengganti google-webrtc JCenter yang mati) — lihat agent/build.gradle.kts.
    implementation("io.github.webrtc-sdk:android:125.6422.07")
    // Biometrik (jalur buka alternatif kunci aplikasi) + FragmentActivity
    // (BiometricPrompt membutuhkan FragmentActivity sebagai host).
    implementation("androidx.biometric:biometric:1.2.0-alpha05")
    implementation("androidx.fragment:fragment-ktx:1.8.2")
    debugImplementation("androidx.compose.ui:ui-tooling")
}
