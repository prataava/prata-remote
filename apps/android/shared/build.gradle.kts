// PRATA Remote — Modul shared (Command 002, Tugas 2-3)
// Library Kotlin: model API + klien Retrofit + klien signaling WebSocket
// + penyimpanan token terenkripsi. Dipakai :agent dan :controller.
plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.prata.remote.shared"
    compileSdk = 35

    defaultConfig {
        minSdk = 26
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.squareup.retrofit2:retrofit:2.11.0")
    implementation("com.squareup.retrofit2:converter-gson:2.11.0")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    // WebRTC resmi Google (M120) — PeerConnection, capturer layar, EGL.
    implementation("org.webrtc:google-webrtc:1.0.32006")
}
