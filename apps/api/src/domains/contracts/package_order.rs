//! Customer packet order • supporting purchase documents precede the contract.
pub(super) fn order<T>(parts: &mut [(T, String)]) {
    parts.sort_by_key(|(_, kind)| match kind.as_str() {
        "order" => 0,
        "danfe" => 1,
        "nfe" => 2,
        "payment" => 3,
        "contract" => 4,
        _ => 5,
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn purchase_documents_precede_contract_and_other_attachments_follow_it() {
        let mut parts = vec![
            ("contract.pdf", "contract".into()),
            ("photo.jpg", "attachment".into()),
            ("receipt.doc", "payment".into()),
            ("invoice.xml", "nfe".into()),
            ("order.pdf", "order".into()),
            ("invoice.pdf", "danfe".into()),
        ];
        order(&mut parts);
        assert_eq!(
            parts.iter().map(|(file, _)| *file).collect::<Vec<_>>(),
            [
                "order.pdf",
                "invoice.pdf",
                "invoice.xml",
                "receipt.doc",
                "contract.pdf",
                "photo.jpg"
            ]
        );
    }

    #[test]
    fn missing_documents_are_not_created_and_equal_kinds_keep_their_order() {
        let mut parts = vec![
            (1, "other".into()),
            (2, "payment".into()),
            (3, "contract".into()),
            (4, "payment".into()),
            (5, "unknown".into()),
        ];
        order(&mut parts);
        assert_eq!(
            parts.iter().map(|(id, _)| *id).collect::<Vec<_>>(),
            [2, 4, 3, 1, 5]
        );
    }
}
