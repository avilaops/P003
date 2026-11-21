import SwiftUI

// Mesmos tokens de apps/web/src/app/globals.css (:root).
enum ErpColor {
    static let primary = Color(red: 0x15 / 255, green: 0x5E / 255, blue: 0xEF / 255)
    static let foreground = Color(red: 0x17 / 255, green: 0x20 / 255, blue: 0x33 / 255)
    static let mutedForeground = Color(red: 0x59 / 255, green: 0x65 / 255, blue: 0x79 / 255)
    static let destructive = Color(red: 0xB9 / 255, green: 0x1C / 255, blue: 0x1C / 255)
    static let border = Color(red: 0xE4 / 255, green: 0xE7 / 255, blue: 0xEC / 255)
}

// Interface compacta: texto entre 12 e 14 pt; títulos até 17 pt.
enum ErpFont {
    static let title = Font.system(size: 17, weight: .semibold)
    static let rowTitle = Font.system(size: 14, weight: .semibold)
    static let body = Font.system(size: 14)
    static let small = Font.system(size: 12)
}

enum Format {
    private static let currency: NumberFormatter = {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.locale = Locale(identifier: "pt_BR")
        return formatter
    }()

    static func money(_ value: DecimalText) -> String {
        Decimal(string: value.value, locale: Locale(identifier: "en_US_POSIX")).flatMap { currency.string(from: $0 as NSDecimalNumber) } ?? value.value
    }

    /// Datas ISO vindas da API (aaaa-mm-dd...) mostradas como dd/mm/aaaa.
    static func date(_ value: String?) -> String {
        guard let parts = value?.prefix(10).split(separator: "-"), parts.count == 3 else { return "—" }
        return parts.reversed().joined(separator: "/")
    }

    static let orderStatus = ["draft": "Rascunho", "accepted": "Aceito", "confirmed": "Confirmado", "completed": "Concluído", "cancelled": "Cancelado"]
}

struct ListRow: View {
    let title: String
    let subtitle: String?
    let trailing: String?

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(ErpFont.rowTitle).lineLimit(1)
                if let subtitle { Text(subtitle).font(ErpFont.small).foregroundStyle(ErpColor.mutedForeground).lineLimit(1) }
            }
            Spacer(minLength: 0)
            if let trailing { Text(trailing).font(ErpFont.rowTitle) }
        }
        .padding(.vertical, 2)
    }
}

struct Notice: View {
    let text: String
    var error = false
    var body: some View {
        Text(text).font(ErpFont.small).foregroundStyle(error ? ErpColor.destructive : ErpColor.mutedForeground)
    }
}
