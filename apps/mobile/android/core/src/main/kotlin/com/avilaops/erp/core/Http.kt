package com.avilaops.erp.core

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI

data class HttpRequest(
    val method: String,
    val url: String,
    val headers: Map<String, String> = emptyMap(),
    val body: String? = null,
)

data class HttpResponse(val status: Int, val headers: Map<String, String>, val body: String) {
    fun header(name: String): String? = headers.entries.firstOrNull { it.key.equals(name, ignoreCase = true) }?.value
}

/** Transporte HTTP sem estado. Os testes usam uma implementação falsa; o app usa [UrlConnectionTransport]. */
fun interface HttpTransport {
    @Throws(IOException::class)
    fun send(request: HttpRequest): HttpResponse
}

/** HTTPS do próprio Java/Android: o app não precisa de uma biblioteca de rede para cinco rotas. */
class UrlConnectionTransport(private val timeoutMillis: Int = 15_000) : HttpTransport {
    override fun send(request: HttpRequest): HttpResponse {
        val connection = URI(request.url).toURL().openConnection() as HttpURLConnection
        try {
            connection.requestMethod = request.method
            connection.instanceFollowRedirects = false
            connection.connectTimeout = timeoutMillis
            connection.readTimeout = timeoutMillis
            connection.useCaches = false
            request.headers.forEach { (name, value) -> connection.setRequestProperty(name, value) }
            if (request.body != null) {
                connection.doOutput = true
                connection.outputStream.use { it.write(request.body.toByteArray(Charsets.UTF_8)) }
            }
            val status = connection.responseCode
            val stream = if (status >= 400) connection.errorStream else connection.inputStream
            val body = stream?.use { it.readBytes().toString(Charsets.UTF_8) }.orEmpty()
            val headers = connection.headerFields.filterKeys { it != null }.mapValues { it.value.joinToString(",") }
            return HttpResponse(status, headers, body)
        } finally {
            connection.disconnect()
        }
    }
}
