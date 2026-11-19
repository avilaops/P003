package com.avilaops.erp

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.avilaops.erp.session.SessionState
import com.avilaops.erp.session.SessionViewModel
import com.avilaops.erp.ui.CompanyScreen
import com.avilaops.erp.ui.ErpTheme
import com.avilaops.erp.ui.HomeScreen
import com.avilaops.erp.ui.LoadingScreen
import com.avilaops.erp.ui.LockedScreen
import com.avilaops.erp.ui.LoginScreen
import com.avilaops.erp.ui.UnconfiguredScreen
import kotlinx.coroutines.launch

class MainActivity : FragmentActivity() {
    private val session: SessionViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        handleRedirect(intent)
        setContent {
            ErpTheme {
                Surface(Modifier.fillMaxSize()) {
                    val state by session.state.collectAsState()
                    val scope = rememberCoroutineScope()
                    when (val current = state) {
                        SessionState.Unconfigured -> UnconfiguredScreen()
                        SessionState.Loading -> LoadingScreen()
                        is SessionState.SignedOut -> LoginScreen(current.message) {
                            scope.launch { session.beginLogin()?.let(::openAuth) }
                        }
                        SessionState.Locked -> LockedScreen(onUnlock = ::promptBiometric, onSignOut = { session.signOut() })
                        is SessionState.ChoosingCompany -> CompanyScreen(current.companies, current.message, session::chooseCompany) { session.signOut() }
                        is SessionState.Ready -> HomeScreen(
                            profile = current.profile,
                            api = session,
                            biometricUnlock = current.biometricUnlock,
                            biometricAvailable = biometricAvailable(),
                            onBiometricChange = session::setBiometricUnlock,
                            onSwitchCompany = session::switchCompany,
                            onSignOut = { session.signOut() },
                        )
                    }
                }
            }
        }
        if (session.state.value == SessionState.Locked && savedInstanceState == null) promptBiometric()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleRedirect(intent)
    }

    private fun handleRedirect(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.toString().startsWith(BuildConfig.AUTH_REDIRECT_URI)) {
            session.completeLogin(data.toString())
            intent.data = null
        }
    }

    /** Login no navegador do sistema (Custom Tabs): a senha nunca passa pelo app. */
    private fun openAuth(url: String) = CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(this, Uri.parse(url))

    private fun biometricAvailable() =
        BiometricManager.from(this).canAuthenticate(BIOMETRIC_STRONG or DEVICE_CREDENTIAL) == BiometricManager.BIOMETRIC_SUCCESS

    private fun promptBiometric() {
        if (!biometricAvailable()) return session.unlocked()
        val prompt = BiometricPrompt(this, ContextCompat.getMainExecutor(this), object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) = session.unlocked()
        })
        prompt.authenticate(
            BiometricPrompt.PromptInfo.Builder()
                .setTitle("Desbloquear ERP")
                .setAllowedAuthenticators(BIOMETRIC_STRONG or DEVICE_CREDENTIAL)
                .build(),
        )
    }
}
