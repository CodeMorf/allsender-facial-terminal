plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.kapt")
}

android {
    namespace = "tech.allsender.facialterminal"
    compileSdk = 35

    defaultConfig {
        applicationId = "tech.allsender.facialterminal"
        minSdk = 26
        targetSdk = 35
        versionCode = 10000
        versionName = "1.0.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("String", "BASE_URL", "\"https://nomina.allsender.tech\"")
        // Las tablets actuales de la terminal son ARM64. Evita empaquetar
        // runtimes x86 de emulador y mantiene el APK razonable.
        ndk {
            abiFilters += listOf("arm64-v8a")
        }
    }

    buildFeatures {
        buildConfig = true
    }

    sourceSets {
        getByName("main").assets.srcDirs(
            rootProject.file("models/facial"),
            rootProject.file("../models/facial"),
            rootProject.file("../../models/facial"),
        )
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
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
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-ktx:1.10.0")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.room:room-runtime:2.6.1")
    implementation("androidx.room:room-ktx:2.6.1")
    kapt("androidx.room:room-compiler:2.6.1")
    implementation("androidx.work:work-runtime-ktx:2.10.0")
    implementation("com.microsoft.onnxruntime:onnxruntime-android:1.20.0")
}
