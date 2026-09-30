plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val vCode = (project.findProperty("versionCode") as String?)?.toIntOrNull() ?: 1

android {
    namespace = "ru.dvaryada.player"
    compileSdk = 34

    defaultConfig {
        applicationId = "ru.dvaryada.player"
        minSdk = 24
        targetSdk = 34
        versionCode = vCode
        versionName = "1.0.$vCode"
    }

    // Ключ подписи лежит в репозитории: приложение семейное, а один и тот же ключ
    // нужен, чтобы новые версии ставились поверх старых без удаления.
    signingConfigs {
        create("family") {
            storeFile = file("dvaryada.keystore")
            storePassword = "dvaryada"
            keyAlias = "dvaryada"
            keyPassword = "dvaryada"
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("family")
        }
        debug { signingConfig = signingConfigs.getByName("family") }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { buildConfig = true }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.2")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
}
