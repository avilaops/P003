package com.avilaops.erp.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.avilaops.erp.core.ApiException
import com.avilaops.erp.core.QuickCustomerInput
import com.avilaops.erp.core.blankToNull
import kotlinx.coroutines.launch
import java.util.UUID

/**
 * Cadastro rápido de cliente. A validação de CPF/CNPJ, e-mail e parâmetros da empresa é da API;
 * o app só exige os campos obrigatórios. Endereço, contatos e fiscal ficam no ERP web.
 */
@Composable
fun QuickCustomerScreen(api: ApiRunner, enabled: Boolean) {
    var personType by remember { mutableStateOf("juridica") }
    var legalName by remember { mutableStateOf("") }
    var tradeName by remember { mutableStateOf("") }
    var taxId by remember { mutableStateOf("") }
    var email by remember { mutableStateOf("") }
    var phone by remember { mutableStateOf("") }
    var message by remember { mutableStateOf<Pair<String, Boolean>?>(null) }
    var saving by remember { mutableStateOf(false) }
    // Uma chave por cadastro: tocar em salvar de novo após falha de rede não duplica o cliente.
    var key by remember { mutableStateOf(UUID.randomUUID()) }
    val scope = rememberCoroutineScope()

    if (!enabled) {
        Notice("Você não tem permissão para cadastrar clientes nesta empresa.")
        return
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Novo cliente", style = MaterialTheme.typography.titleLarge)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(selected = personType == "juridica", onClick = { personType = "juridica"; key = UUID.randomUUID() }, label = { Text("Pessoa jurídica") })
            FilterChip(selected = personType == "fisica", onClick = { personType = "fisica"; key = UUID.randomUUID() }, label = { Text("Pessoa física") })
        }
        val edit: (String) -> Unit = { _ -> key = UUID.randomUUID(); message = null }
        CompactField(if (personType == "juridica") "CNPJ" else "CPF", taxId, KeyboardType.Ascii) { taxId = it; edit(it) }
        CompactField(if (personType == "juridica") "Razão social" else "Nome", legalName) { legalName = it; edit(it) }
        if (personType == "juridica") CompactField("Nome fantasia (opcional)", tradeName) { tradeName = it; edit(it) }
        CompactField("E-mail (opcional)", email, KeyboardType.Email) { email = it; edit(it) }
        CompactField("Telefone (opcional)", phone, KeyboardType.Phone) { phone = it; edit(it) }
        message?.let { (text, isError) -> Notice(text, error = isError, modifier = Modifier.padding(0.dp)) }
        Button(
            enabled = !saving && legalName.isNotBlank() && taxId.isNotBlank(),
            modifier = Modifier.fillMaxWidth(),
            onClick = {
                saving = true
                scope.launch {
                    try {
                        val input = QuickCustomerInput(
                            personType = personType,
                            legalName = legalName.trim(),
                            tradeName = tradeName.blankToNull().takeIf { personType == "juridica" },
                            taxId = taxId.trim(),
                            email = email.blankToNull(),
                            phone = phone.blankToNull(),
                        )
                        val party = api.call { client, tenant -> client.createCustomer(tenant, input, key) }
                        message = "Cliente ${party.legalName} cadastrado." to false
                        legalName = ""; tradeName = ""; taxId = ""; email = ""; phone = ""
                        key = UUID.randomUUID()
                    } catch (failure: ApiException) {
                        message = failure.message to true
                    }
                    saving = false
                }
            },
        ) { Text(if (saving) "Salvando…" else "Salvar cliente") }
    }
}

@Composable
private fun CompactField(label: String, value: String, keyboard: KeyboardType = KeyboardType.Text, onChange: (String) -> Unit) = OutlinedTextField(
    value = value,
    onValueChange = onChange,
    label = { Text(label) },
    singleLine = true,
    textStyle = MaterialTheme.typography.bodyMedium,
    keyboardOptions = KeyboardOptions(keyboardType = keyboard),
    modifier = Modifier.fillMaxWidth(),
)
