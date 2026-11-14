use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::Value;

const ROOTS: &[u8] = include_bytes!("../../../../../../deploy/fiscal/icp-brasil-roots.pem");
fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../tests/fixtures/contract-wire/preflight.json"
    ))
    .unwrap()
}

#[test]
fn contract_wire_trust_identity_matches_actual_python_registry_and_bundle() {
    let trust = ApprovedTrust::new(ROOTS, b"").unwrap();
    let vector = fixture();
    assert_eq!(trust.sha256(), vector["trustBundleSha256"]);
    assert_eq!(POLICY_SHA256, vector["policySha256"]);
    let body = STANDARD
        .decode(vector["responseBundleBase64"].as_str().unwrap())
        .unwrap();
    let start = b"AVILA-CVB1\n".len();
    let length = u32::from_be_bytes(body[start..start + 4].try_into().unwrap()) as usize;
    let meta: Value = serde_json::from_slice(&body[start + 4..start + 4 + length]).unwrap();
    assert_eq!(trust.roots_pem_sha256(), meta["parts"][1]["sha256"]);
    assert_eq!(trust.intermediates_pem_sha256(), meta["parts"][2]["sha256"]);
}

#[test]
fn contract_wire_trust_canonicalizes_duplicate_public_certificates_and_line_endings() {
    let trust = ApprovedTrust::new(ROOTS, b"").unwrap();
    let doubled = [ROOTS, ROOTS].concat();
    let crlf = String::from_utf8(ROOTS.to_vec())
        .unwrap()
        .replace('\n', "\r\n");
    assert_eq!(
        trust.sha256(),
        ApprovedTrust::new(&doubled, b"").unwrap().sha256()
    );
    assert_eq!(
        trust.roots_pem_sha256(),
        ApprovedTrust::new(crlf.as_bytes(), b"")
            .unwrap()
            .roots_pem_sha256()
    );
}

#[test]
fn contract_wire_trust_rejects_empty_unreviewed_and_non_pem_material() {
    for roots in [
        b"".as_slice(),
        b"not a certificate",
        b"-----BEGIN CERTIFICATE-----\nYWJj\n-----END CERTIFICATE-----\n",
    ] {
        assert!(ApprovedTrust::new(roots, b"").is_err());
    }
    assert!(ApprovedTrust::new(ROOTS, b"private or unrelated material").is_err());
    let mut injected = b"unreviewed header".to_vec();
    injected.extend_from_slice(ROOTS);
    assert!(ApprovedTrust::new(&injected, b"").is_err());
}
