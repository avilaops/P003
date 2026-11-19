plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// Endereços públicos de homologação (gradle.properties ou -P). Nenhum segredo entra no APK:
// o cliente OIDC é público e usa PKCE.
fun setting(name: String) = providers.gradleProperty(name).orElse("").get()

android {
    namespace = "com.avilaops.erp"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.avilaops.erp"
        minSdk = 30
        targetSdk = 35
        versionCode = (providers.gradleProperty("erp.versionCode").orNull ?: "1").toInt()
        versionName = "0.1.0"
        buildConfigField("String", "API_BASE_URL", "\"${setting("erp.apiBaseUrl")}\"")
        buildConfigField("String", "AUTH_ISSUER", "\"${setting("erp.authIssuer")}\"")
        buildConfigField("String", "AUTH_CLIENT_ID", "\"${setting("erp.authClientId")}\"")
        buildConfigField("String", "AUTH_REDIRECT_URI", "\"com.avilaops.erp:/oauth2redirect\"")
        manifestPlaceholders["authRedirectScheme"] = "com.avilaops.erp"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Assinatura de release fica fora do repositório (teste interno do Play).
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures {
        compose = true
        buildConfig = true
    }
}

dependencies {
    implementation(project(":core"))
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.material3)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.browser)
    implementation(libs.androidx.biometric)
    implementation(libs.kotlinx.coroutines.android)
}
