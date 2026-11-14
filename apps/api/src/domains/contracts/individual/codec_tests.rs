use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::Value;

fn fixture(operation: &str) -> Value {
    serde_json::from_str(match operation {
        "preflight" => include_str!("../../../../tests/fixtures/contract-wire/preflight.json"),
        _ => include_str!("../../../../tests/fixtures/contract-wire/increment.json"),
    })
    .unwrap()
}

#[test]
fn contract_wire_trust_registry_has_identical_pinned_bytes_on_windows_and_linux() {
    let bytes = include_bytes!(
        "../../../../../contract-signature-validator/src/contract_signature_validator/trust_registry.json"
    );
    assert!(
        !bytes.contains(&b'\r'),
        "Trust registry bytes must not depend on checkout platform"
    );
    assert_eq!(
        sha256(bytes),
        "7780e435da30c445e5a927f894640a0c09b5eca2fabbf3c4b068c7682350d5bc"
    );
}
fn context(value: &Value) -> RequestContext {
    RequestContext {
        request_id: value["requestId"].as_str().unwrap().parse().unwrap(),
        tenant_id: value["tenantId"].as_str().unwrap().parse().unwrap(),
        envelope_id: value["envelopeId"].as_str().unwrap().parse().unwrap(),
        document_id: value["documentId"].as_str().unwrap().parse().unwrap(),
        policy_sha256: value["policySha256"].as_str().unwrap().into(),
        trust_bundle_sha256: value["trustBundleSha256"].as_str().unwrap().into(),
    }
}
fn part(value: &Value, name: &str) -> Vec<u8> {
    STANDARD
        .decode(value["parts"][name].as_str().unwrap())
        .unwrap()
}

#[test]
fn contract_wire_preflight_matches_real_python_frame_and_hmac_bytes() {
    let value = fixture("preflight");
    let base = part(&value, "base");
    let encoded = encode(context(&value), Input::Preflight { base: &base }).unwrap();
    assert_eq!(
        *encoded.body,
        STANDARD
            .decode(value["frameBase64"].as_str().unwrap())
            .unwrap()
    );
    let key = ServiceKey::new(
        value["keyId"].as_str().unwrap(),
        &STANDARD
            .decode(value["keyBase64"].as_str().unwrap())
            .unwrap(),
    )
    .unwrap();
    let authenticated = key
        .authenticate(&encoded, value["sentAt"].as_i64().unwrap())
        .unwrap();
    assert_eq!(
        serde_json::to_value(&authenticated.headers).unwrap(),
        value["headers"]
    );
    assert_eq!(authenticated.request_sha256, value["frameSha256"]);
    assert_eq!(authenticated.key_id, "test");
    assert_eq!(authenticated.sent_at, 1794657600);
}

#[test]
fn contract_wire_increment_matches_python_with_prior_identity_without_logging_cpf() {
    let value = fixture("increment");
    let base = part(&value, "base");
    let parent = part(&value, "parent");
    let candidate = part(&value, "candidate");
    let cpf = PersonalCpf::parse("52998224725").unwrap();
    let previous = PersonalCpf::parse("11144477735").unwrap();
    let encoded = encode(
        context(&value),
        Input::Increment {
            base: &base,
            parent: &parent,
            candidate: &candidate,
            signer: Signer {
                participant_id: value["signer"]["participantId"]
                    .as_str()
                    .unwrap()
                    .parse()
                    .unwrap(),
                cpf: &cpf,
            },
            previous_signers: vec![Signer {
                participant_id: value["previousSigners"][0]["participantId"]
                    .as_str()
                    .unwrap()
                    .parse()
                    .unwrap(),
                cpf: &previous,
            }],
        },
    )
    .unwrap();
    assert_eq!(
        *encoded.body,
        STANDARD
            .decode(value["frameBase64"].as_str().unwrap())
            .unwrap()
    );
    let key = ServiceKey::new(
        "test",
        &STANDARD
            .decode(value["keyBase64"].as_str().unwrap())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        serde_json::to_value(key.authenticate(&encoded, 1794657600).unwrap().headers).unwrap(),
        value["headers"]
    );
}

#[test]
fn contract_wire_rejects_nil_ids_malformed_hashes_empty_and_oversized_parts() {
    let value = fixture("preflight");
    let mut invalid = context(&value);
    invalid.document_id = Uuid::nil();
    assert!(encode(invalid, Input::Preflight { base: b"pdf" }).is_err());
    for malformed in ["A".repeat(64), "a".repeat(63), "x".repeat(64)] {
        let mut invalid = context(&value);
        invalid.policy_sha256 = malformed;
        assert!(encode(invalid, Input::Preflight { base: b"pdf" }).is_err());
    }
    assert!(encode(context(&value), Input::Preflight { base: b"" }).is_err());
    let too_large = vec![0; BASE_MAX + 1];
    assert!(encode(context(&value), Input::Preflight { base: &too_large }).is_err());
    let at_limit = vec![0; BASE_MAX];
    assert!(encode(context(&value), Input::Preflight { base: &at_limit }).is_ok());
}

#[test]
fn contract_wire_rejects_duplicate_person_or_id_and_invalid_service_key() {
    let value = fixture("increment");
    let cpf = PersonalCpf::parse("52998224725").unwrap();
    let other = PersonalCpf::parse("11144477735").unwrap();
    let id = Uuid::now_v7();
    for previous in [
        Signer {
            participant_id: Uuid::now_v7(),
            cpf: &cpf,
        },
        Signer {
            participant_id: id,
            cpf: &other,
        },
    ] {
        assert!(
            encode(
                context(&value),
                Input::Increment {
                    base: b"base",
                    parent: b"parent",
                    candidate: b"candidate",
                    signer: Signer {
                        participant_id: id,
                        cpf: &cpf
                    },
                    previous_signers: vec![previous]
                }
            )
            .is_err()
        );
    }
    for id in ["", "BAD", "bad\nkey", "a/b", "-bad"] {
        assert!(ServiceKey::new(id, &[3; 32]).is_err());
    }
    for length in [0, 31, 65] {
        assert!(ServiceKey::new("test", &vec![3; length]).is_err());
    }
    let encoded = encode(context(&value), Input::Preflight { base: b"base" }).unwrap();
    assert!(
        ServiceKey::new("test", &[3; 32])
            .unwrap()
            .authenticate(&encoded, 0)
            .is_err()
    );
}

#[test]
fn contract_wire_increment_accepts_32mib_candidate_and_rejects_one_extra_byte() {
    let value = fixture("increment");
    let cpf = PersonalCpf::parse("52998224725").unwrap();
    let id = Uuid::now_v7();
    let mut candidate = vec![0; CANDIDATE_MAX];
    assert!(
        encode(
            context(&value),
            Input::Increment {
                base: b"base",
                parent: b"parent",
                candidate: &candidate,
                signer: Signer {
                    participant_id: id,
                    cpf: &cpf
                },
                previous_signers: vec![]
            }
        )
        .is_ok()
    );
    candidate.push(0);
    assert!(
        encode(
            context(&value),
            Input::Increment {
                base: b"base",
                parent: b"parent",
                candidate: &candidate,
                signer: Signer {
                    participant_id: id,
                    cpf: &cpf
                },
                previous_signers: vec![]
            }
        )
        .is_err()
    );
}
