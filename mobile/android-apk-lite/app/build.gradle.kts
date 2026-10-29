plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.musicflow.player"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.musicflow.player"
        minSdk = 24
        targetSdk = 34
        versionCode = 350
        versionName = "3.5.0-HyperFlow"
    }

    buildFeatures {
        buildConfig = true
    }

    signingConfigs {
        create("release") {
            storeFile = file("../release-key.jks")
            storePassword = "musicflow123"
            keyAlias = "musicflow"
            keyPassword = "musicflow123"
        }
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
            excludes += "META-INF/DEPENDENCIES"
            excludes += "DebugProbesKt.bin"
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("androidx.media:media:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.2")
    implementation("androidx.lifecycle:lifecycle-process:2.8.2")

    // Embedded HTTP server (serves web frontend + API on localhost)
    implementation("org.nanohttpd:nanohttpd:2.3.1")

    // OkHttp for YouTube API calls and audio stream proxying
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // JSON parsing
    implementation("com.google.code.gson:gson:2.11.0")

    // AndroidX Media3 (ExoPlayer + MediaSessionService for production background playback & caching)
    implementation("androidx.media3:media3-exoplayer:1.3.1")
    implementation("androidx.media3:media3-session:1.3.1")
    implementation("androidx.media3:media3-ui:1.3.1")
    implementation("androidx.media3:media3-datasource-okhttp:1.3.1")

    // Palette for dynamic dominant-color gradients
    implementation("androidx.palette:palette-ktx:1.0.0")
}
