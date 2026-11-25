plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
}

fun escapeBuildConfig(raw: String): String =
    raw.replace("\\", "\\\\").replace("\"", "\\\"")

val buildCommit = System.getenv("DROPIT_BUILD_COMMIT")?.trim()?.takeIf { it.isNotEmpty() } ?: "dev"
val buildDate = System.getenv("DROPIT_BUILD_DATE")?.trim()?.takeIf { it.isNotEmpty() } ?: ""
val dropitKeystorePath = System.getenv("DROPIT_KEYSTORE")?.trim()?.takeIf { it.isNotEmpty() }
val dropitKeystorePassword = System.getenv("DROPIT_KEYSTORE_PASSWORD") ?: ""

android {
    namespace = "dev.dropit.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "dev.dropit.app"
        minSdk = 23
        targetSdk = 35
        versionCode = 6
        versionName = "0.4.0-native"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        buildConfigField("String", "BUILD_COMMIT", "\"${escapeBuildConfig(buildCommit)}\"")
        buildConfigField("String", "BUILD_DATE", "\"${escapeBuildConfig(buildDate)}\"")
    }

    // Keep identical PKCS12 signing logic as mobile/android/app/build.gradle so CI builds
    // signed with ANDROID_KEYSTORE_B64 can upgrade over existing 0.3.2 (code 5) installs.
    signingConfigs {
        if (dropitKeystorePath != null) {
            create("dropit") {
                storeFile = file(dropitKeystorePath)
                storeType = "pkcs12"
                storePassword = dropitKeystorePassword
                keyAlias = "dropit"
                keyPassword = dropitKeystorePassword
            }
        }
    }

    buildTypes {
        debug {
            if (dropitKeystorePath != null) {
                signingConfig = signingConfigs.getByName("dropit")
            }
        }
        release {
            isMinifyEnabled = false
            if (dropitKeystorePath != null) {
                signingConfig = signingConfigs.getByName("dropit")
            }
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        isCoreLibraryDesugaringEnabled = true
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    testOptions {
        unitTests {
            isReturnDefaultValues = true
        }
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    coreLibraryDesugaring(libs.desugar.jdk.libs)

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons.extended)
    debugImplementation(libs.androidx.compose.ui.tooling)

    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.androidx.browser)

    implementation(libs.androidx.room.runtime)
    implementation(libs.androidx.room.ktx)
    ksp(libs.androidx.room.compiler)

    implementation(libs.androidx.work.runtime.ktx)
    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)

    implementation(libs.coil)
    implementation(libs.coil.compose)

    implementation(libs.androidx.media3.exoplayer)
    implementation(libs.androidx.media3.ui)
    implementation(libs.androidx.media3.datasource.okhttp)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
}
