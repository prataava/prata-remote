// PRATA Remote — Aplikasi Agent (Command 002, Tugas 2)
// Kotlin + Jetpack Compose. Menampilkan QR pairing bila belum terdaftar,
// dashboard status bila sudah terdaftar, dan menjaga koneksi signaling
// lewat Foreground Service.
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.prata.remote.agent"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.prata.remote.agent"
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
    // Parent tema XML (Theme.Material3.DayNight.NoActionBar) tinggal di
    // library Material Views, bukan di Compose material3 — tanpa dep ini
    // AAPT gagal saat build.
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.activity:activity-compose:1.9.2")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.6")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.6")
    implementation("androidx.navigation:navigation-compose:2.8.0")
    implementation("com.google.zxing:core:3.5.3")
    // Storage Access Framework (DocumentFile) untuk File Manager.
    implementation("androidx.documentfile:documentfile:1.0.1")
    // OkHttp/Retrofit dipakai langsung di modul ini (OkHttpClient,
    // RequestBody upload blob, retrofit2.Response). Versi SAMA dengan
    // :shared — implementation tidak diturunkan antar modul.
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.squareup.retrofit2:retrofit:2.11.0")
    implementation("com.squareup.retrofit2:converter-gson:2.11.0")
    // WebRTC dipakai langsung di AgentViewModel (ScreenCapturerAndroid).
    // Versi SAMA dengan modul :shared (implementation tidak diturunkan).
    // CATATAN: org.webrtc:google-webrtc:1.0.32006 (M83, 2020) TIDAK ADA di
    // Maven Central/Google Maven — ia hanya pernah ada di JCenter yang sudah
    // mati. Penggantinya: fork LiveKit (io.github.webrtc-sdk:android, M125),
    // drop-in dengan paket/API org.webrtc yang sama, terverifikasi ada di
    // Maven Central (latest 125.6422.07).
    implementation("io.github.webrtc-sdk:android:125.6422.07")
    debugImplementation("androidx.compose.ui:ui-tooling")
}
