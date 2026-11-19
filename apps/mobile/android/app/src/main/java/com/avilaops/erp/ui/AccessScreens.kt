package com.avilaops.erp.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import com.avilaops.erp.R
import com.avilaops.erp.core.CompanySummary

@Composable
private fun Centered(content: @Composable () -> Unit) = Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) { content() }
}

@Composable
private fun Brand() {
    Image(painterResource(R.mipmap.ic_launcher), contentDescription = null, modifier = Modifier.size(40.dp))
    Text("ERP • Avila Ops", style = MaterialTheme.typography.titleLarge)
}

@Composable
fun LoadingScreen() = Centered { CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp) }

@Composable
fun UnconfiguredScreen() = Centered {
    Brand()
    Notice("API não configurada neste build. Gere o build com erp.apiBaseUrl de homologação.", error = true)
}

@Composable
fun LoginScreen(message: String?, onLogin: () -> Unit) = Centered {
    Brand()
    Text("Entre com a mesma conta do ERP web.", style = MaterialTheme.typography.bodyMedium, color = ErpColors.MutedForeground)
    message?.let { Notice(it, error = true) }
    Button(onClick = onLogin, modifier = Modifier.fillMaxWidth()) { Text("Entrar") }
}

@Composable
fun LockedScreen(onUnlock: () -> Unit, onSignOut: () -> Unit) = Centered {
    Brand()
    Text("Sessão bloqueada", style = MaterialTheme.typography.titleMedium)
    Button(onClick = onUnlock, modifier = Modifier.fillMaxWidth()) { Text("Desbloquear") }
    TextButton(onClick = onSignOut) { Text("Sair") }
}

@Composable
fun CompanyScreen(companies: List<CompanySummary>, message: String?, onChoose: (CompanySummary) -> Unit, onSignOut: () -> Unit) {
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Escolha a empresa", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
            TextButton(onClick = onSignOut) { Text("Sair") }
        }
        message?.let { Notice(it, error = true) }
        LazyColumn {
            items(companies, key = { it.id }) { company ->
                ListRow(company.displayName, company.legalName.takeIf { it != company.displayName }, null, modifier = Modifier.clickable { onChoose(company) })
            }
        }
        Spacer(Modifier.height(16.dp))
    }
}
