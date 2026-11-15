use super::*;
use serde_json::json;

fn fixture() -> Snapshot {
    serde_json::from_value(json!({"tenantId":"11111111-1111-4111-8111-111111111111","company":{"legalName":"Ávila São José","taxId":"123"},"receivables":[{"id":"11111111-1111-4111-8111-111111111112","party":"João","dueDate":"2027-01-01","amountCents":10001,"settledCents":1,"outstandingCents":10000,"status":"open","revision":1}],"payables":[{"id":"11111111-1111-4111-8111-111111111113","party":"Fornecedor","dueDate":"2027-01-02","amountCents":20002,"settledCents":2,"outstandingCents":20000,"status":"open","revision":1}]})).unwrap()
}

#[test]
fn hash_changes_for_every_financial_source_but_is_stable_without_emission_time() {
    let snapshot = fixture();
    let hash = snapshot.hash();
    assert_eq!(hash, snapshot.hash());
    let mut changed = fixture();
    changed.payables[0].revision += 1;
    assert_ne!(hash, changed.hash());
    changed = fixture();
    changed.receivables[0].settled_cents += 1;
    assert_ne!(hash, changed.hash());
}

#[test]
fn report_pdf_contains_all_two_hundred_records_and_exact_cent_totals() {
    let mut snapshot = fixture();
    for index in 1..100 {
        let mut row = snapshot.receivables[0].clone();
        row.party = format!("Cliente {index:03}");
        snapshot.receivables.push(row);
        let mut row = snapshot.payables[0].clone();
        row.party = format!("Fornecedor {index:03}");
        snapshot.payables.push(row);
    }
    assert_eq!(snapshot.totals(), (1_000_000, 2_000_000, 100, 100));
    let bytes = snapshot.pdf(false, 1).unwrap();
    if let Ok(directory) = std::env::var("ERP_ORDER_PDF_SAMPLE_DIR") {
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            std::path::Path::new(&directory).join("finance-report.pdf"),
            &bytes,
        )
        .unwrap();
    }
    let pdf = lopdf::Document::load_mem(&bytes).unwrap();
    let text = pdf
        .extract_text(&pdf.get_pages().keys().copied().collect::<Vec<_>>())
        .unwrap();
    for term in [
        "RELATÓRIO FINANCEIRO",
        "Ávila São José",
        "R$ 10.000,00",
        "R$ 20.000,00",
        "Cliente 099",
        "Fornecedor 099",
        "João",
        "R$ 100,01",
        "R$ 200,02",
        "100 registros por fonte",
    ] {
        assert!(text.contains(term), "missing {term}");
    }
    assert!(!text.contains("TOTAL DO PEDIDO"));
    assert!(!text.contains("ITENS DO PEDIDO"));
}

#[test]
fn title_pdf_describes_declared_receipt_without_claiming_bank_settlement() {
    let snapshot = fixture();
    let bytes = snapshot.pdf(true, 7).unwrap();
    if let Ok(directory) = std::env::var("ERP_ORDER_PDF_SAMPLE_DIR") {
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            std::path::Path::new(&directory).join("finance-title.pdf"),
            &bytes,
        )
        .unwrap();
    }
    let pdf = lopdf::Document::load_mem(&bytes).unwrap();
    let text = pdf
        .extract_text(&pdf.get_pages().keys().copied().collect::<Vec<_>>())
        .unwrap();
    for term in [
        "TÍTULO A RECEBER",
        "João",
        "01/01/2027",
        "R$ 100,01",
        "R$ 0,01",
        "R$ 100,00",
        "não comprova conciliação bancária",
    ] {
        assert!(text.contains(term), "missing {term}: {text}");
    }
    assert!(!text.contains("Fornecedor"));
}
