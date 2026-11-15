//! Serializable, customer-facing financial evidence. No float arithmetic.
use crate::domains::sales::order_document::pdf::{self, Document};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Row {
    pub id: Uuid,
    pub party: String,
    pub due_date: String,
    pub amount_cents: i64,
    pub settled_cents: i64,
    pub outstanding_cents: i64,
    pub status: String,
    pub revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_id: Option<Uuid>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Snapshot {
    pub tenant_id: Uuid,
    pub company: Value,
    #[serde(default)]
    pub recipient: Option<String>,
    pub receivables: Vec<Row>,
    pub payables: Vec<Row>,
}
pub(super) fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn money(cents: i128) -> String {
    let absolute = cents.abs();
    let raw = (absolute / 100).to_string();
    let mut grouped = String::new();
    for (index, c) in raw.chars().enumerate() {
        if index > 0 && (raw.len() - index).is_multiple_of(3) {
            grouped.push('.');
        }
        grouped.push(c);
    }
    format!(
        "R$ {}{grouped},{:02}",
        if cents < 0 { "-" } else { "" },
        absolute % 100
    )
}
fn date(value: &str) -> String {
    match value.split('-').collect::<Vec<_>>().as_slice() {
        [y, m, d] => format!("{d}/{m}/{y}"),
        _ => value.into(),
    }
}
fn status(value: &str) -> &str {
    match value {
        "cancelled" => "Cancelado",
        "paid" => "Recebimento ou pagamento declarado",
        _ => "Em aberto",
    }
}
fn field<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or_default()
}

impl Snapshot {
    pub fn hash(&self) -> String {
        digest(&serde_json::to_vec(self).expect("financial snapshot is serializable"))
    }
    pub fn title(&self, title: bool) -> &'static str {
        if title {
            "Título a receber"
        } else {
            "Relatório financeiro"
        }
    }
    pub fn scope(&self, title: bool) -> &'static str {
        if title {
            "Um título a receber • valores e recebimentos declarados no sistema"
        } else {
            "Primeiros 100 registros por fonte • contas a receber e a pagar • ordem de vencimento e ID • indicadores referentes exclusivamente a este recorte"
        }
    }
    pub fn totals(&self) -> (i128, i128, usize, usize) {
        let receive = self
            .receivables
            .iter()
            .filter(|r| r.status != "cancelled")
            .map(|r| i128::from(r.outstanding_cents))
            .sum();
        let pay = self
            .payables
            .iter()
            .filter(|r| r.status != "cancelled")
            .map(|r| i128::from(r.outstanding_cents))
            .sum();
        (
            receive,
            pay,
            self.receivables
                .iter()
                .filter(|r| r.status != "cancelled" && r.outstanding_cents > 0)
                .count(),
            self.payables
                .iter()
                .filter(|r| r.status != "cancelled" && r.outstanding_cents > 0)
                .count(),
        )
    }
    pub fn pdf(&self, title: bool, revision: i64) -> Result<Vec<u8>, std::io::Error> {
        let details = &self.company["details"];
        let mut issuer_lines = vec![format!("CPF/CNPJ: {}", field(&self.company, "taxId"))];
        for keys in [
            &[
                "street",
                "number",
                "complement",
                "district",
                "city",
                "state",
                "postalCode",
            ][..],
            &["email", "phone"][..],
        ] {
            let value = keys
                .iter()
                .map(|key| field(details, key))
                .filter(|v| !v.is_empty())
                .collect::<Vec<_>>()
                .join(" • ");
            if !value.is_empty() {
                issuer_lines.push(value);
            }
        }
        let mut document = Document {
            issuer_name: field(&self.company, "legalName").into(),
            issuer_lines,
            logo_data_url: field(details, "logoDataUrl").into(),
            number: if title {
                self.receivables
                    .first()
                    .map(|r| r.id.to_string())
                    .unwrap_or_default()
            } else {
                "Financeiro".into()
            },
            revision,
            status: "Posição declarada no sistema".into(),
            due: String::new(),
            customer_lines: vec![self.scope(title).into()],
            items: Vec::new(),
            total: String::new(),
            weight: String::new(),
            sections: Vec::new(),
        };
        if title {
            let row = self
                .receivables
                .first()
                .ok_or_else(|| std::io::Error::other("missing receivable"))?;
            document.customer_lines = vec![row.party.clone(), format!("Título: {}", row.id)];
            document.total = money(i128::from(row.amount_cents));
            document.sections.push(("Dados do título".into(),format!("Vencimento: {}\nValor do título: {}\nRecebido declarado: {}\nSaldo restante: {}\nSituação: {}",date(&row.due_date),money(i128::from(row.amount_cents)),money(i128::from(row.settled_cents)),money(i128::from(row.outstanding_cents)),status(&row.status))));
            if let Some(order) = row.source_id {
                document
                    .sections
                    .push(("Origem".into(), format!("Pedido: {order}")));
            }
        } else {
            let (receive, pay, open_receive, open_pay) = self.totals();
            document.total = money(receive - pay);
            document.sections.push(("Indicadores do recorte".into(),format!("A receber: {}\nA pagar: {}\nTítulos a receber com saldo: {open_receive}\nTítulos a pagar com saldo: {open_pay}\nRegistros incluídos: {} a receber • {} a pagar",money(receive),money(pay),self.receivables.len(),self.payables.len())));
            for (kind, rows) in [
                ("A receber", &self.receivables),
                ("A pagar", &self.payables),
            ] {
                if rows.is_empty() {
                    document
                        .sections
                        .push((kind.into(), "Nenhum registro neste recorte.".into()));
                }
                for (index, row) in rows.iter().enumerate() {
                    document.sections.push((format!("{kind} • {:03}",index+1),format!("{}\nTítulo: {} • Revisão {}\nVencimento: {} • Situação: {}\nValor: {} • {}: {} • Saldo: {}",row.party,row.id,row.revision,date(&row.due_date),status(&row.status),money(i128::from(row.amount_cents)),if kind=="A receber"{"Recebido declarado"}else{"Pago declarado"},money(i128::from(row.settled_cents)),money(i128::from(row.outstanding_cents)))));
                }
            }
        }
        document.sections.push(("Natureza do documento".into(),"Este documento apresenta registros declarados no sistema e não comprova conciliação bancária ou quitação integral de pedido. Valores recebidos ou pagos correspondem aos lançamentos e estornos registrados.".into()));
        pdf::render_financial(
            &document,
            if title {
                "TÍTULO A RECEBER"
            } else {
                "RELATÓRIO FINANCEIRO"
            },
            if title {
                "VALOR DO TÍTULO"
            } else {
                "SALDO DO RECORTE"
            },
            false,
            if title {
                "CLIENTE"
            } else {
                "ESCOPO DO RELATÓRIO"
            },
        )
    }
}

#[cfg(test)]
#[path = "document_tests.rs"]
mod tests;
