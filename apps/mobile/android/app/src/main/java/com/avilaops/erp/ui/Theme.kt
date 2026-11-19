package com.avilaops.erp.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.Typography
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.math.BigDecimal
import java.text.NumberFormat
import java.util.Locale

// Mesmos tokens de apps/web/src/app/globals.css (:root).
object ErpColors {
    val Primary = Color(0xFF155EEF)
    val Foreground = Color(0xFF172033)
    val Muted = Color(0xFFF4F4F5)
    val MutedForeground = Color(0xFF596579)
    val Secondary = Color(0xFFF2F4F7)
    val SecondaryForeground = Color(0xFF344054)
    val Accent = Color(0xFFEDF3FF)
    val Destructive = Color(0xFFB91C1C)
    val Border = Color(0xFFE4E7EC)
}

// Interface compacta: texto entre 12 e 14 sp; títulos até 17 sp.
private val typography = Typography(
    titleLarge = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.SemiBold, lineHeight = 22.sp),
    titleMedium = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold, lineHeight = 20.sp),
    titleSmall = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold, lineHeight = 18.sp),
    bodyLarge = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
    bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
    bodySmall = TextStyle(fontSize = 12.sp, lineHeight = 16.sp),
    labelLarge = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium),
    labelMedium = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Medium),
    labelSmall = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Medium),
)

@Composable
fun ErpTheme(content: @Composable () -> Unit) = MaterialTheme(
    colorScheme = lightColorScheme(
        primary = ErpColors.Primary,
        onPrimary = Color.White,
        primaryContainer = ErpColors.Accent,
        onPrimaryContainer = ErpColors.Primary,
        secondaryContainer = ErpColors.Accent,
        onSecondaryContainer = ErpColors.Primary,
        background = Color.White,
        onBackground = ErpColors.Foreground,
        surface = Color.White,
        onSurface = ErpColors.Foreground,
        surfaceVariant = ErpColors.Muted,
        onSurfaceVariant = ErpColors.MutedForeground,
        surfaceContainer = Color.White,
        error = ErpColors.Destructive,
        outline = ErpColors.Border,
        outlineVariant = ErpColors.Border,
    ),
    typography = typography,
    content = content,
)

private val currency = NumberFormat.getCurrencyInstance(Locale("pt", "BR"))
fun money(value: String): String = runCatching { currency.format(BigDecimal(value)) }.getOrDefault(value)

/** Datas ISO vindas da API (aaaa-mm-dd...) mostradas como dd/mm/aaaa. */
fun date(value: String?): String = value?.take(10)?.split('-')?.takeIf { it.size == 3 }?.reversed()?.joinToString("/") ?: "—"

val orderStatusLabels = mapOf(
    "draft" to "Rascunho",
    "accepted" to "Aceito",
    "confirmed" to "Confirmado",
    "completed" to "Concluído",
    "cancelled" to "Cancelado",
)

@Composable
fun ListRow(title: String, subtitle: String?, trailing: String?, trailingNote: String? = null, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                subtitle?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = ErpColors.MutedForeground, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            }
            Column(horizontalAlignment = Alignment.End) {
                trailing?.let { Text(it, style = MaterialTheme.typography.titleSmall) }
                trailingNote?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = ErpColors.MutedForeground) }
            }
        }
        HorizontalDivider(color = ErpColors.Border)
    }
}

@Composable
fun Notice(text: String, error: Boolean = false, modifier: Modifier = Modifier) {
    Text(
        text,
        modifier = modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
        style = MaterialTheme.typography.bodySmall,
        color = if (error) ErpColors.Destructive else ErpColors.MutedForeground,
    )
}
