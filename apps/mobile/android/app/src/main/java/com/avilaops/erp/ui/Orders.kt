package com.avilaops.erp.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import com.avilaops.erp.core.ApiException
import com.avilaops.erp.core.ErpApi
import com.avilaops.erp.core.OrderDetail
import com.avilaops.erp.core.OrderPage
import com.avilaops.erp.core.OrderPricing
import com.avilaops.erp.core.Revised
import kotlinx.coroutines.launch
import java.util.UUID

/** Executa chamadas da API com o token válido e a empresa ativa (implementado pela sessão). */
interface ApiRunner {
    suspend fun <T> call(block: (ErpApi, String) -> T): T
}

/**
 * Lista de pedidos. Em Pendências, mostra os rascunhos (fonte provisória até o painel D01, #293);
 * em Pedidos, permite buscar por cliente, CPF/CNPJ ou número.
 */
@Composable
fun OrderList(api: ApiRunner, status: String, searchable: Boolean, emptyText: String, onOpen: (String) -> Unit) {
    var query by remember { mutableStateOf("") }
    var submitted by remember { mutableStateOf("") }
    var page by remember { mutableStateOf<OrderPage?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(true) }

    LaunchedEffect(status, submitted) {
        loading = true
        error = null
        try {
            page = api.call { client, tenant -> client.orders(tenant, submitted, status) }
        } catch (failure: ApiException) {
            error = failure.message
        }
        loading = false
    }

    Column(Modifier.fillMaxSize()) {
        if (searchable) {
            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                placeholder = { Text("Cliente, CPF/CNPJ ou número") },
                singleLine = true,
                textStyle = MaterialTheme.typography.bodyMedium,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                keyboardActions = KeyboardActions(onSearch = { submitted = query.trim() }),
            )
        }
        if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        error?.let { Notice(it, error = true) }
        val orders = page?.data.orEmpty()
        if (!loading && error == null && orders.isEmpty()) Notice(emptyText)
        LazyColumn(Modifier.fillMaxSize()) {
            items(orders, key = { it.id }) { order ->
                ListRow(
                    title = "PV-${order.number} • ${order.customerName ?: "Sem cliente"}",
                    subtitle = "${orderStatusLabels[order.status] ?: order.status} • vence ${date(order.dueDate)}",
                    trailing = money(order.amount),
                    modifier = Modifier.clickable { onOpen(order.id) },
                )
            }
            page?.let { if (it.total > it.data.size) item { Notice("Mostrando ${it.data.size} de ${it.total}. Refine a busca.") } }
        }
    }
}

/** Detalhe do pedido com a aprovação de exceção de preço (alçada atual do ERP). */
@Composable
fun OrderDetailScreen(api: ApiRunner, id: String) {
    var detail by remember { mutableStateOf<Revised<OrderDetail>?>(null) }
    var pricing by remember { mutableStateOf<Revised<OrderPricing>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableStateOf(0) }
    var approving by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(id, reload) {
        error = null
        try {
            detail = api.call { client, tenant -> client.order(tenant, id) }
            pricing = api.call { client, tenant -> client.pricing(tenant, id) }
        } catch (failure: ApiException) {
            error = failure.message
        }
    }

    val current = detail
    Column(Modifier.fillMaxSize()) {
        error?.let { Notice(it, error = true) }
        notice?.let { Notice(it) }
        if (current == null) {
            if (error == null) LinearProgressIndicator(Modifier.fillMaxWidth())
            return@Column
        }
        val order = current.value.data
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("PV-${order.number}", style = MaterialTheme.typography.titleLarge)
            Text(order.customerName ?: "Sem cliente", style = MaterialTheme.typography.bodyMedium)
            Text(
                "${orderStatusLabels[order.status] ?: order.status} • vence ${date(order.dueDate)} • ${money(order.amount)}",
                style = MaterialTheme.typography.bodySmall,
                color = ErpColors.MutedForeground,
            )
        }
        val price = pricing?.value
        if (price?.awaitingApproval == true) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp)) {
                Text("Preço fora da política: aguarda aprovação.", style = MaterialTheme.typography.bodySmall, color = ErpColors.Destructive, modifier = Modifier.weight(1f))
            }
            if (price.canApprove) {
                Button(onClick = { approving = true }, modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp)) { Text("Aprovar preço") }
            } else {
                Notice("A aprovação exige alçada de gestão e outra pessoa que não o solicitante.")
            }
        }
        HorizontalDivider(color = ErpColors.Border, modifier = Modifier.padding(top = 8.dp))
        LazyColumn(Modifier.fillMaxSize()) {
            items(current.value.items) { item ->
                ListRow(item.name, listOfNotNull(item.sku, "${item.quantity} ${item.unit.orEmpty()} × ${money(item.unitPrice)}").joinToString(" • "), money(item.amount))
            }
        }
    }

    if (approving) {
        ApproveDialog(
            onDismiss = { approving = false },
            onConfirm = { reason, key ->
                scope.launch {
                    try {
                        val revision = current!!.revision
                        api.call { client, tenant -> client.approvePricing(tenant, id, revision, reason, key) }
                        approving = false
                        notice = "Preço aprovado."
                        reload++
                    } catch (failure: ApiException) {
                        error = failure.message
                        if (failure.status == 412) { approving = false; reload++ }
                    }
                }
            },
        )
    }
}

@Composable
private fun ApproveDialog(onDismiss: () -> Unit, onConfirm: (String, UUID) -> Unit) {
    var reason by remember { mutableStateOf("") }
    // Mesma chave em toda tentativa desta decisão: repetir após falha de rede não aprova duas vezes.
    val key = remember { UUID.randomUUID() }
    val valid = reason.trim().length in 3..2000
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Aprovar preço", style = MaterialTheme.typography.titleMedium) },
        text = {
            OutlinedTextField(
                value = reason,
                onValueChange = { reason = it },
                label = { Text("Motivo") },
                textStyle = MaterialTheme.typography.bodyMedium,
                minLines = 2,
            )
        },
        confirmButton = { TextButton(onClick = { onConfirm(reason, key) }, enabled = valid) { Text("Aprovar") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancelar") } },
    )
}
