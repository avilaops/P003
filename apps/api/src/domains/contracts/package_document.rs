//! Customer package documents use the preserved contract snapshot exclusively.
use crate::domains::sales::order_document::pdf::{self, Document, Item};
use serde_json::Value;

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or_default()
}

fn decimal(value: &str, currency: bool) -> String {
    let (whole, fraction) = value.split_once('.').unwrap_or((value, ""));
    let negative = whole.starts_with('-');
    let digits = whole.trim_start_matches('-');
    let mut grouped = String::new();
    for (index, character) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            grouped.push('.');
        }
        grouped.push(character);
    }
    if negative {
        grouped.insert(0, '-');
    }
    let fraction = if currency {
        fraction
    } else {
        fraction.trim_end_matches('0')
    };
    if !fraction.is_empty() {
        grouped.push(',');
        grouped.push_str(fraction);
    }
    if currency {
        format!("R$ {grouped}")
    } else {
        grouped
    }
}

fn date(value: &str) -> String {
    match value.split('-').collect::<Vec<_>>().as_slice() {
        [year, month, day] => format!("{day}/{month}/{year}"),
        _ => value.to_owned(),
    }
}

fn identity(value: &Value, name: &str) -> Vec<String> {
    let mut lines = vec![text(value, name).to_owned()];
    for (key, label) in [
        ("taxId", "CPF/CNPJ"),
        ("email", "E-mail"),
        ("phone", "Telefone"),
    ] {
        if !text(value, key).is_empty() {
            lines.push(format!("{label}: {}", text(value, key)));
        }
    }
    if let Some(address) = value["addresses"].as_array().and_then(|a| {
        a.iter()
            .find(|v| v["primary"] == true)
            .or_else(|| a.first())
    }) {
        let address = [
            "street",
            "number",
            "complement",
            "district",
            "city",
            "state",
            "postalCode",
        ]
        .iter()
        .map(|key| text(address, key))
        .filter(|v| !v.is_empty())
        .collect::<Vec<_>>()
        .join(" • ");
        if !address.is_empty() {
            lines.push(address);
        }
    }
    let address = [
        "street",
        "number",
        "complement",
        "district",
        "city",
        "state",
        "postalCode",
    ]
    .iter()
    .map(|key| text(value, key))
    .filter(|v| !v.is_empty())
    .collect::<Vec<_>>()
    .join(" • ");
    if !address.is_empty() {
        lines.push(address);
    }
    lines
}

fn document(snapshot: &Value) -> Document {
    let company = &snapshot["company"];
    let issuer = identity(company, "legalName");
    Document {
        issuer_name: text(company, "legalName").into(),
        issuer_lines: issuer.into_iter().skip(1).collect(),
        logo_data_url: text(company, "logoDataUrl").into(),
        number: text(&snapshot["order"], "number").into(),
        revision: snapshot["order"]["revision"].as_i64().unwrap_or(1),
        status: "Cópia do pedido preservado no contrato".into(),
        due: date(text(&snapshot["order"], "dueDate")),
        customer_lines: identity(&snapshot["customer"], "name"),
        items: Vec::new(),
        total: decimal(text(&snapshot["order"], "amount"), true),
        weight: "Não informado no documento preservado".into(),
        sections: Vec::new(),
    }
}

pub(super) fn order(snapshot: &Value) -> Result<Vec<u8>, std::io::Error> {
    let mut document = document(snapshot);
    document.items = snapshot["items"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|item| {
            let mut description = vec![
                text(item, "name").to_owned(),
                format!("Código: {}", text(item, "sku")),
            ];
            for (key, label) in [
                ("structureColor", "Estrutura"),
                ("swingArmColor", "Braço móvel"),
                ("upholsteryColor", "Estofado"),
                ("plateHolderColor", "Anilheiro"),
                ("plateHolderType", "Tipo de anilheiro"),
            ] {
                if !text(item, key).is_empty() {
                    description.push(format!("{label}: {}", text(item, key)));
                }
            }
            Item {
                description,
                quantity: format!(
                    "{} {}",
                    decimal(text(item, "quantity"), false),
                    text(item, "unit")
                ),
                unit_price: decimal(text(item, "unitPrice"), true),
                amount: decimal(text(item, "amount"), true),
            }
        })
        .collect();
    let terms = snapshot
        .get("commercialTerms")
        .filter(|v| v.is_object())
        .unwrap_or(&snapshot["proposal"]);
    for (key, label) in [
        ("paymentTerms", "Pagamento previsto"),
        ("deliveryTerms", "Entrega"),
        ("notes", "Observações"),
    ] {
        if !text(terms, key).trim().is_empty() {
            document
                .sections
                .push((label.into(), text(terms, key).into()));
        }
    }
    pdf::render(&document)
}

pub(super) fn payment(
    snapshot: &Value,
    amount_cents: i64,
    method: &str,
    reference: &str,
    occurred_on: &str,
) -> Result<Vec<u8>, std::io::Error> {
    let mut document = document(snapshot);
    document.status = "Recebimento registrado".into();
    let absolute = i128::from(amount_cents).abs();
    document.total = decimal(
        &format!(
            "{}{}.{:02}",
            if amount_cents < 0 { "-" } else { "" },
            absolute / 100,
            absolute % 100
        ),
        true,
    );
    document.sections = vec![(
        "Dados do recebimento".into(),
        format!(
            "Pedido: {}\nForma de pagamento: {method}\nReferência: {reference}\nData do recebimento: {}",
            document.number,
            date(occurred_on)
        ),
    )];
    pdf::render_with_labels(
        &document,
        "COMPROVANTE DE RECEBIMENTO",
        "VALOR RECEBIDO",
        false,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn extract(bytes: &[u8]) -> String {
        let pdf = lopdf::Document::load_mem(bytes).unwrap();
        pdf.extract_text(&pdf.get_pages().keys().copied().collect::<Vec<_>>())
            .unwrap()
    }
    #[test]
    fn snapshot_order_pdf_preserves_unicode_prices_and_terms_without_internal_data() {
        let snapshot = json!({"order":{"number":"PV-42","amount":"1234567.89","dueDate":"2027-01-01"},"company":{"legalName":"Ávila Ltda."},"customer":{"name":"João São José"},"items":[{"sku":"SKU-42","name":"Estação Olímpica","quantity":"2.500000","unit":"UN","unitPrice":"493827.15","amount":"1234567.89","structureColor":"Azul","cost":"SECRET_COST"}],"commercialTerms":{"paymentTerms":"Parcela 2: R$ 14,99 • 01/02/2027","deliveryTerms":"45 dias após recebimento da entrada"},"margin":"SECRET_MARGIN"});
        let bytes = order(&snapshot).unwrap();
        assert!(bytes.starts_with(b"%PDF-"));
        let text = extract(&bytes);
        for value in [
            "PV-42",
            "Ávila",
            "João São José",
            "Estação Olímpica",
            "SKU-42",
            "R$ 1.234.567,89",
            "R$ 493.827,15",
            "2,5 UN",
            "Parcela 2: R$ 14,99",
            "45 dias após",
        ] {
            assert!(text.contains(value), "missing {value}: {text}");
        }
        assert!(!text.contains("SECRET_"));
    }
    #[test]
    fn receipt_uses_recorded_amount_and_omits_order_summary() {
        let bytes = payment(
            &json!({"order":{"number":"PV-42","amount":"9999.99"},"customer":{"name":"José"}}),
            12345,
            "bank_transfer",
            "TED-42",
            "2026-11-06",
        )
        .unwrap();
        let text = extract(&bytes);
        for value in [
            "COMPROVANTE DE RECEBIMENTO",
            "VALOR RECEBIDO",
            "R$ 123,45",
            "TED-42",
            "06/11/2026",
            "José",
        ] {
            assert!(text.contains(value), "missing {value}: {text}");
        }
        for value in [
            "ITENS DO PEDIDO",
            "RESUMO DO PEDIDO",
            "Peso bruto",
            "R$ 9.999,99",
            "TOTAL DO PEDIDO",
        ] {
            assert!(!text.contains(value));
        }
    }
}
