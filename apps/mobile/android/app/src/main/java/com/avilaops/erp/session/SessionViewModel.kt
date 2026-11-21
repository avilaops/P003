package com.avilaops.erp.session

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.avilaops.erp.BuildConfig
import com.avilaops.erp.core.AccessProfile
import com.avilaops.erp.core.ApiException
import com.avilaops.erp.core.AuthException
import com.avilaops.erp.core.AuthorizationRequest
import com.avilaops.erp.core.CompanySummary
import com.avilaops.erp.core.ErpApi
import com.avilaops.erp.core.OidcClient
import com.avilaops.erp.core.OidcMetadata
import com.avilaops.erp.core.UrlConnectionTransport
import com.avilaops.erp.ui.ApiRunner
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

sealed interface SessionState {
    data object Unconfigured : SessionState
    data object Loading : SessionState
    data class SignedOut(val message: String? = null) : SessionState
    data object Locked : SessionState
    data class ChoosingCompany(val companies: List<CompanySummary>, val message: String? = null) : SessionState
    data class Ready(val profile: AccessProfile, val biometricUnlock: Boolean) : SessionState
}

/**
 * Sessão do app: login OIDC + PKCE, renovação do token, empresa ativa e bloqueio por biometria.
 * As telas pedem dados por [call], que já envia o token válido e a empresa escolhida.
 */
class SessionViewModel(application: Application) : AndroidViewModel(application), ApiRunner {
    private val store = SecureStore(application)
    private val transport = UrlConnectionTransport()
    private val oidc = OidcClient(BuildConfig.AUTH_ISSUER, BuildConfig.AUTH_CLIENT_ID, BuildConfig.AUTH_REDIRECT_URI, transport)
    private val refreshLock = Mutex()
    private var metadata: OidcMetadata? = null
    private var pending: AuthorizationRequest? = null
    private var session: StoredSession? = null

    private val api: ErpApi? = BuildConfig.API_BASE_URL.takeIf { it.isNotBlank() }?.let { url ->
        ErpApi(url, transport) { session?.tokens?.accessToken ?: throw ApiException(401, "missing_token", "Entre novamente") }
    }

    private val _state = MutableStateFlow<SessionState>(if (api == null) SessionState.Unconfigured else SessionState.Loading)
    val state: StateFlow<SessionState> = _state

    init {
        if (api != null) {
            session = store.read()
            val saved = session
            _state.value = when {
                saved == null -> SessionState.SignedOut()
                saved.biometricUnlock -> SessionState.Locked
                else -> SessionState.Loading.also { viewModelScope.launch { resume() } }
            }
        }
    }

    /** Monta a URL do Auth. O verificador PKCE fica só na memória deste processo. */
    suspend fun beginLogin(): String? = try {
        val discovered = withContext(Dispatchers.IO) { metadata ?: oidc.discover().also { metadata = it } }
        oidc.authorizationRequest(discovered).also { pending = it }.url
    } catch (error: AuthException) {
        _state.value = SessionState.SignedOut(error.message); null
    } catch (error: java.io.IOException) {
        _state.value = SessionState.SignedOut("Sem conexão com o Auth. Tente novamente"); null
    }

    fun completeLogin(callback: String) {
        val request = pending ?: return run { _state.value = SessionState.SignedOut("Login expirou. Entre novamente") }
        pending = null
        _state.value = SessionState.Loading
        viewModelScope.launch {
            try {
                val tokens = withContext(Dispatchers.IO) {
                    val code = oidc.authorizationCode(callback, request)
                    oidc.exchangeCode(metadata!!, code, request)
                }
                save(StoredSession(tokens, tenantId = session?.tenantId, biometricUnlock = session?.biometricUnlock ?: false))
                resume()
            } catch (error: AuthException) {
                _state.value = SessionState.SignedOut(error.message)
            } catch (error: java.io.IOException) {
                _state.value = SessionState.SignedOut("Sem conexão com o Auth. Tente novamente")
            }
        }
    }

    fun unlocked() {
        _state.value = SessionState.Loading
        viewModelScope.launch { resume() }
    }

    fun chooseCompany(company: CompanySummary) {
        _state.value = SessionState.Loading
        viewModelScope.launch {
            try {
                callRaw { it.selectCompany(company.id) }
                save(session!!.copy(tenantId = company.id))
                resume()
            } catch (error: ApiException) {
                handle(error)
            }
        }
    }

    fun switchCompany() {
        session?.let { save(it.copy(tenantId = null)) }
        _state.value = SessionState.Loading
        viewModelScope.launch { resume() }
    }

    fun setBiometricUnlock(enabled: Boolean) {
        val current = session ?: return
        save(current.copy(biometricUnlock = enabled))
        (_state.value as? SessionState.Ready)?.let { _state.value = it.copy(biometricUnlock = enabled) }
    }

    fun signOut(message: String? = null) {
        session = null
        store.clear()
        _state.value = SessionState.SignedOut(message)
    }

    /** Executa uma chamada da API com token renovado e a empresa ativa. */
    override suspend fun <T> call(block: (ErpApi, String) -> T): T {
        val tenant = session?.tenantId ?: throw ApiException(403, "tenant", "Escolha uma empresa")
        return try {
            callRaw { block(it, tenant) }
        } catch (error: ApiException) {
            if (error.sessionExpired) signOut(error.message)
            throw error
        }
    }

    private suspend fun resume() {
        try {
            val tenant = session?.tenantId
            if (tenant != null) {
                val profile = callRaw { it.me(tenant) }
                _state.value = SessionState.Ready(profile, session?.biometricUnlock ?: false)
                return
            }
            val directory = callRaw { it.companies() }
            val active = directory.data.filter { it.status == "active" }
            when {
                active.size == 1 -> chooseCompany(active.single())
                active.isEmpty() -> _state.value = SessionState.ChoosingCompany(emptyList(), "Nenhuma empresa ativa para este usuário. Cadastre a empresa no ERP web")
                else -> _state.value = SessionState.ChoosingCompany(active)
            }
        } catch (error: ApiException) {
            handle(error)
        }
    }

    private fun handle(error: ApiException) {
        when {
            error.sessionExpired -> signOut(error.message)
            error.status == 403 && session?.tenantId != null -> {
                save(session!!.copy(tenantId = null))
                _state.value = SessionState.ChoosingCompany(emptyList(), error.message)
                viewModelScope.launch { resume() }
            }
            else -> _state.value = (_state.value as? SessionState.ChoosingCompany)?.copy(message = error.message)
                ?: SessionState.SignedOut(error.message)
        }
    }

    private suspend fun <T> callRaw(block: (ErpApi) -> T): T {
        val client = api ?: throw ApiException(0, "unconfigured", "API não configurada")
        ensureFreshToken()
        return withContext(Dispatchers.IO) { block(client) }
    }

    private suspend fun ensureFreshToken() = refreshLock.withLock {
        val current = session ?: throw ApiException(401, "missing_token", "Entre novamente")
        if (!current.tokens.expiresWithin(System.currentTimeMillis() / 1000)) return@withLock
        val refresh = current.tokens.refreshToken ?: throw ApiException(401, "expired", "Sessão expirada. Entre novamente")
        try {
            val renewed = withContext(Dispatchers.IO) { oidc.refresh(metadata ?: oidc.discover().also { metadata = it }, refresh) }
            save(current.copy(tokens = renewed))
        } catch (error: AuthException) {
            throw ApiException(401, "expired", error.message ?: "Sessão expirada. Entre novamente")
        } catch (error: java.io.IOException) {
            throw ApiException(0, "network", "Sem conexão com o Auth. Tente novamente")
        }
    }

    private fun save(next: StoredSession) {
        session = next
        store.write(next)
    }
}
