package com.avilaops.erp.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import com.avilaops.erp.core.AccessProfile

private enum class Section(val label: String) { Pending("Pendências"), Orders("Pedidos"), Customer("Cliente") }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(
    profile: AccessProfile,
    api: ApiRunner,
    biometricUnlock: Boolean,
    biometricAvailable: Boolean,
    onBiometricChange: (Boolean) -> Unit,
    onSwitchCompany: () -> Unit,
    onSignOut: () -> Unit,
) {
    var section by rememberSaveable { mutableStateOf(Section.Pending) }
    var openOrder by rememberSaveable { mutableStateOf<String?>(null) }
    var menu by rememberSaveable { mutableStateOf(false) }
    BackHandler(enabled = openOrder != null) { openOrder = null }
    val canReadOrders = profile.can("sales.orders.read")

    Scaffold(
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
                title = {
                    Column {
                        Text(profile.tenant.displayName, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(profile.identity.name, style = MaterialTheme.typography.bodySmall, color = ErpColors.MutedForeground, maxLines = 1)
                    }
                },
                navigationIcon = { if (openOrder != null) TextButton(onClick = { openOrder = null }) { Text("Voltar") } },
                actions = {
                    Box {
                        TextButton(onClick = { menu = true }) { Text("Conta") }
                        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                            if (biometricAvailable) DropdownMenuItem(
                                text = { Text("Desbloquear com biometria") },
                                trailingIcon = { Switch(checked = biometricUnlock, onCheckedChange = null) },
                                onClick = { onBiometricChange(!biometricUnlock) },
                            )
                            DropdownMenuItem(text = { Text("Trocar empresa") }, onClick = { menu = false; onSwitchCompany() })
                            DropdownMenuItem(text = { Text("Sair") }, onClick = { menu = false; onSignOut() })
                        }
                    }
                },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            val order = openOrder
            if (order != null) {
                OrderDetailScreen(api, order)
                return@Column
            }
            TabRow(selectedTabIndex = section.ordinal, containerColor = MaterialTheme.colorScheme.surface) {
                Section.entries.forEach { item ->
                    Tab(selected = section == item, onClick = { section = item }, text = { Text(item.label, style = MaterialTheme.typography.labelLarge) })
                }
            }
            when (section) {
                Section.Pending -> if (canReadOrders) OrderList(api, status = "draft", searchable = false, emptyText = "Nenhum pedido em rascunho aguardando ação.") { openOrder = it }
                    else Notice("Você não tem permissão para consultar pedidos nesta empresa.")
                Section.Orders -> if (canReadOrders) OrderList(api, status = "", searchable = true, emptyText = "Nenhum pedido encontrado.") { openOrder = it }
                    else Notice("Você não tem permissão para consultar pedidos nesta empresa.")
                Section.Customer -> QuickCustomerScreen(api, enabled = profile.can("catalog.parties.manage") && profile.can("catalog.parties.read"))
            }
        }
    }
}
