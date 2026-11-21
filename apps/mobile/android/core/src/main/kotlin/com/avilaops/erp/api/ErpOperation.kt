package com.avilaops.erp.api

import java.net.URLEncoder

/** Operação do contrato OpenAPI do api-ts. As instâncias são geradas em [com.avilaops.erp.api.generated.ErpOperations]. */
data class ErpOperation(
    val id: String,
    val method: String,
    val path: String,
    val pathParameters: List<String>,
    val queryParameters: List<String>,
    val requiresTenant: Boolean,
    /** Preenchido quando a rota ainda não está no contrato TypeScript; descreve a dependência. */
    val pendingOn: String? = null,
) {
    /** Monta caminho e consulta. Parâmetros de caminho são obrigatórios e codificados; consultas vazias são omitidas. */
    fun resolve(path: Map<String, String> = emptyMap(), query: Map<String, String?> = emptyMap()): String {
        require(path.keys == pathParameters.toSet()) { "Parâmetros de caminho de $id: esperados $pathParameters" }
        var resolved = this.path
        for ((name, value) in path) {
            require(value.isNotEmpty()) { "Parâmetro $name vazio" }
            resolved = resolved.replace("{$name}", encode(value))
        }
        val pairs = query.filterValues { !it.isNullOrEmpty() }
        if (pairs.isEmpty()) return resolved
        return resolved + "?" + pairs.entries.joinToString("&") { (key, value) -> "${encode(key)}=${encode(value!!)}" }
    }

    private fun encode(value: String) = URLEncoder.encode(value, "UTF-8").replace("+", "%20")
}
