//! CONSTRUCTED protocol reports under a synthetic MAC key, not actual ICP PDFs.
use super::super::{
    identity::PersonalCpf,
    transport::{self, Input, Signer},
    wire_json,
};
use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::Sha256;
use time::Duration;

const ROOTS: &[u8] = include_bytes!("../../../../../../deploy/fiscal/icp-brasil-roots.pem");
const MAGIC: &[u8] = b"AVILA-CVB1\n";
fn vector(operation: &str) -> Value {
    serde_json::from_str(if operation == "preflight" {
        include_str!("../../../../tests/fixtures/contract-wire/preflight.json")
    } else {
        include_str!("../../../../tests/fixtures/contract-wire/increment.json")
    })
    .unwrap()
}
struct Fixture {
    value: Value,
    request: EncodedRequest,
    authentication: RequestAuthentication,
    key: ServiceKey,
    trust: ApprovedTrust,
    body: Vec<u8>,
    headers: Vec<(String, String)>,
    now: OffsetDateTime,
}
impl Fixture {
    fn new(operation: &str) -> Self {
        let value = vector(operation);
        let part = |name: &str| {
            STANDARD
                .decode(value["parts"][name].as_str().unwrap())
                .unwrap()
        };
        let ctx = RequestContext {
            request_id: value["requestId"].as_str().unwrap().parse().unwrap(),
            tenant_id: value["tenantId"].as_str().unwrap().parse().unwrap(),
            envelope_id: value["envelopeId"].as_str().unwrap().parse().unwrap(),
            document_id: value["documentId"].as_str().unwrap().parse().unwrap(),
            policy_sha256: value["policySha256"].as_str().unwrap().into(),
            trust_bundle_sha256: value["trustBundleSha256"].as_str().unwrap().into(),
        };
        let base = part("base");
        let current = PersonalCpf::parse("52998224725").unwrap();
        let previous = PersonalCpf::parse("11144477735").unwrap();
        let request = if operation == "preflight" {
            transport::encode(ctx, Input::Preflight { base: &base }).unwrap()
        } else {
            transport::encode(
                ctx,
                Input::Increment {
                    base: &base,
                    parent: &part("parent"),
                    candidate: &part("candidate"),
                    signer: Signer {
                        participant_id: value["signer"]["participantId"]
                            .as_str()
                            .unwrap()
                            .parse()
                            .unwrap(),
                        cpf: &current,
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
            .unwrap()
        };
        let key = ServiceKey::new(
            "test",
            &STANDARD
                .decode(value["keyBase64"].as_str().unwrap())
                .unwrap(),
        )
        .unwrap();
        let authentication = key
            .authenticate(&request, value["sentAt"].as_i64().unwrap())
            .unwrap();
        let body = STANDARD
            .decode(value["responseBundleBase64"].as_str().unwrap())
            .unwrap();
        let headers = value["responseHeaders"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), v.as_str().unwrap().into()))
            .collect();
        let now = OffsetDateTime::from_unix_timestamp(value["sentAt"].as_i64().unwrap()).unwrap();
        Self {
            value,
            request,
            authentication,
            key,
            trust: ApprovedTrust::new(ROOTS, b"").unwrap(),
            body,
            headers,
            now,
        }
    }
    fn verify(
        &self,
        body: Vec<u8>,
        headers: &[(String, String)],
        now: OffsetDateTime,
    ) -> Result<VerifiedBundle, WireError> {
        decode(
            body,
            headers,
            Verification {
                request: &self.request,
                authentication: &self.authentication,
                key: &self.key,
                trust: &self.trust,
                now,
            },
        )
    }
    fn signed(&self, body: &[u8], media_type: &str) -> Vec<(String, String)> {
        let digest = transport::sha256(body);
        let message = format!(
            "AVILA-CV-RESPONSE/1\ntest\n{}\n{}\n{digest}\n{}\n",
            self.value["requestId"].as_str().unwrap(),
            self.value["frameSha256"].as_str().unwrap(),
            body.len()
        );
        let mut mac = Hmac::<Sha256>::new_from_slice(
            &STANDARD
                .decode(self.value["keyBase64"].as_str().unwrap())
                .unwrap(),
        )
        .unwrap();
        mac.update(message.as_bytes());
        vec![
            ("content-type".into(), media_type.into()),
            ("content-length".into(), body.len().to_string()),
            ("x-validation-response-sha256".into(), digest),
            (
                "x-validation-response-mac".into(),
                format!("HMAC-SHA256 test:{:x}", mac.finalize().into_bytes()),
            ),
        ]
    }
    fn split(&self) -> (Value, Vec<Vec<u8>>) {
        let start = MAGIC.len();
        let length = u32::from_be_bytes(self.body[start..start + 4].try_into().unwrap()) as usize;
        let meta: Value =
            serde_json::from_slice(&self.body[start + 4..start + 4 + length]).unwrap();
        let mut offset = start + 4 + length;
        let parts = meta["parts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| {
                let length = p["length"].as_u64().unwrap() as usize;
                let bytes = self.body[offset..offset + length].to_vec();
                offset += length;
                bytes
            })
            .collect();
        (meta, parts)
    }
    fn assemble(&self, mut meta: Value, parts: Vec<Vec<u8>>) -> (Vec<u8>, Vec<(String, String)>) {
        for (part, bytes) in meta["parts"].as_array_mut().unwrap().iter_mut().zip(&parts) {
            part["length"] = json!(bytes.len());
            part["sha256"] = json!(transport::sha256(bytes));
        }
        let raw = wire_json::canonical(&meta).unwrap();
        let mut body = MAGIC.to_vec();
        body.extend_from_slice(&(raw.len() as u32).to_be_bytes());
        body.extend(raw);
        for part in parts {
            body.extend(part);
        }
        let headers = self.signed(&body, CONTENT_TYPE);
        (body, headers)
    }
    fn report(&self, change: impl FnOnce(&mut Value)) -> (Vec<u8>, Vec<(String, String)>) {
        let (mut meta, mut parts) = self.split();
        let mut wrapper: Value = serde_json::from_slice(&parts[0]).unwrap();
        change(&mut wrapper);
        wrapper["reportSha256"] = json!(transport::sha256(
            &wire_json::canonical(&wrapper["report"]).unwrap()
        ));
        parts[0] = wire_json::canonical(&wrapper).unwrap();
        meta["responseHeaders"] = json!(
            self.signed(&parts[0], REPORT_TYPE)
                .into_iter()
                .collect::<BTreeMap<_, _>>()
        );
        self.assemble(meta, parts)
    }
}

#[test]
fn contract_bundle_actual_python_preflight_and_increment_round_trip_exact_artifact() {
    for operation in ["preflight", "increment"] {
        let f = Fixture::new(operation);
        let proof = f.verify(f.body.clone(), &f.headers, f.now).unwrap();
        assert_eq!(proof.verdict(), Verdict::Accepted);
        assert_eq!(proof.bytes(), f.body);
        assert_eq!(proof.sha256(), f.value["responseBundleSha256"]);
        assert_eq!(proof.evidence_sha256(), f.value["evidenceSetSha256"]);
        assert_eq!(proof.checked_at(), f.now);
        assert_eq!(proof.document_binding(), f.request.binding());
        assert_eq!(proof.context().tenant_id, f.request.context().tenant_id);
        assert_eq!(proof.headers().len(), 4);
        assert!(transport::is_sha256(proof.report_sha256()));
    }
}

#[test]
fn contract_bundle_verifies_retained_binding_after_http_body_ownership_transfer() {
    let mut f = Fixture::new("increment");
    let bytes = f.request.take_body();
    assert_eq!(transport::sha256(&bytes), f.value["frameSha256"]);
    assert!(f.request.body().is_empty());
    assert!(
        f.key
            .authenticate(&f.request, f.now.unix_timestamp())
            .is_err()
    );
    assert_eq!(
        f.verify(f.body.clone(), &f.headers, f.now)
            .unwrap()
            .verdict(),
        Verdict::Accepted
    );
}

#[test]
fn contract_bundle_valid_microsecond_observation_is_preserved_without_rounding() {
    let f = Fixture::new("preflight");
    let (mut meta, mut parts) = f.split();
    let mut wrapper: Value = serde_json::from_slice(&parts[0]).unwrap();
    let stamp = "2026-11-14T12:00:00.123456Z";
    let evidence = transport::sha256(
        &wire_json::canonical(&json!({"observedAt":stamp,"certificates":[],"crls":[],"ocsps":[]}))
            .unwrap(),
    );
    wrapper["checkedAt"] = json!(stamp);
    wrapper["report"]["binding"]["checkedAt"] = json!(stamp);
    wrapper["report"]["checks"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|c| c["name"] == "evidence_set")
        .unwrap()["evidenceHashes"] = json!([evidence]);
    wrapper["reportSha256"] = json!(transport::sha256(
        &wire_json::canonical(&wrapper["report"]).unwrap()
    ));
    parts[0] = wire_json::canonical(&wrapper).unwrap();
    meta["evidenceSetSha256"] = json!(evidence);
    meta["responseHeaders"] = json!(
        f.signed(&parts[0], REPORT_TYPE)
            .into_iter()
            .collect::<BTreeMap<_, _>>()
    );
    let (body, headers) = f.assemble(meta, parts);
    let proof = f
        .verify(body, &headers, f.now + Duration::seconds(1))
        .unwrap();
    assert_eq!(proof.checked_at(), f.now + Duration::microseconds(123456));
    assert!(
        f.verify(
            f.body.clone(),
            &f.headers,
            f.now.to_offset(time::UtcOffset::from_hms(1, 0, 0).unwrap())
        )
        .is_err()
    );
}

#[test]
fn contract_bundle_indeterminate_and_unsupported_are_verified_but_never_accepted() {
    let f = Fixture::new("increment");
    let (body, headers) = f.report(|v| {
        v["report"]["checks"]
            .as_array_mut()
            .unwrap()
            .retain(|c| c["name"] != "identity");
        v["report"]["verdict"] = json!("indeterminate");
    });
    assert_eq!(
        f.verify(body, &headers, f.now).unwrap().verdict(),
        Verdict::Indeterminate
    );
    let (body, headers) = f.report(|v| {
        v["report"]["checks"][0]["verdict"] = json!("unsupported");
        v["report"]["verdict"] = json!("unsupported");
        v["report"]["timestampStatus"] = json!("unsupported");
    });
    assert_eq!(
        f.verify(body, &headers, f.now).unwrap().verdict(),
        Verdict::Unsupported
    );
}

#[test]
fn contract_bundle_rejects_duplicate_json_checks_and_implicit_trust_as_evidence() {
    let f = Fixture::new("increment");
    let (mut meta, mut parts) = f.split();
    parts[0] = [
        br#"{"schemaVersion":"avila-contract-response/1","#.as_slice(),
        &parts[0][1..],
    ]
    .concat();
    meta["responseHeaders"] = json!(
        f.signed(&parts[0], REPORT_TYPE)
            .into_iter()
            .collect::<BTreeMap<_, _>>()
    );
    let (body, headers) = f.assemble(meta, parts);
    assert!(f.verify(body, &headers, f.now).is_err());
    let (body, headers) = f.report(|v| {
        let copy = v["report"]["checks"][0].clone();
        v["report"]["checks"].as_array_mut().unwrap().push(copy);
    });
    assert!(f.verify(body, &headers, f.now).is_err());
    let registry:Value=serde_json::from_slice(include_bytes!("../../../../../contract-signature-validator/src/contract_signature_validator/trust_registry.json")).unwrap();
    let (body, headers) = f.report(|v| {
        v["report"]["checks"][0]["evidenceHashes"] = json!([registry["roots"][0]["sha256"]])
    });
    assert!(
        f.verify(body, &headers, f.now).is_err(),
        "trust roots are not implicit typed evidence"
    );
    let (body, headers) =
        f.report(|v| v["report"]["engine"]["pyHanko"] = json!("unknown\nversion"));
    assert!(f.verify(body, &headers, f.now).is_err());
}

#[test]
fn contract_bundle_rejects_oversized_truncated_and_overflowing_authenticated_frames() {
    let f = Fixture::new("preflight");
    assert!(f.verify(vec![0; MAX_BYTES + 1], &f.headers, f.now).is_err());
    let body = f.body[..f.body.len() - 1].to_vec();
    assert!(
        f.verify(body.clone(), &f.signed(&body, CONTENT_TYPE), f.now)
            .is_err()
    );
    let (mut meta, parts) = f.split();
    meta["parts"][0]["length"] = json!(u64::MAX);
    let raw = wire_json::canonical(&meta).unwrap();
    let mut body = MAGIC.to_vec();
    body.extend_from_slice(&(raw.len() as u32).to_be_bytes());
    body.extend(raw);
    for part in parts {
        body.extend(part);
    }
    assert!(
        f.verify(body.clone(), &f.signed(&body, CONTENT_TYPE), f.now)
            .is_err()
    );
    let mut body = f.body.clone();
    body[MAGIC.len()..MAGIC.len() + 4].copy_from_slice(&u32::MAX.to_be_bytes());
    assert!(
        f.verify(body.clone(), &f.signed(&body, CONTENT_TYPE), f.now)
            .is_err()
    );
}

#[test]
fn contract_bundle_authentication_cannot_be_reused_for_another_request() {
    let f = Fixture::new("preflight");
    let mut context = f.request.context().clone();
    context.request_id = uuid::Uuid::now_v7();
    let other = transport::encode(
        context,
        Input::Preflight {
            base: b"different request",
        },
    )
    .unwrap();
    let authentication = f.key.authenticate(&other, f.now.unix_timestamp()).unwrap();
    assert!(
        decode(
            f.body.clone(),
            &f.headers,
            Verification {
                request: &f.request,
                authentication: &authentication,
                key: &f.key,
                trust: &f.trust,
                now: f.now
            }
        )
        .is_err()
    );
    let mut headers = f.headers.clone();
    headers.push(("server".into(), "unit fixture".into()));
    let proof = f.verify(f.body.clone(), &headers, f.now).unwrap();
    assert_eq!(proof.headers().len(), 4);
}

#[test]
fn contract_bundle_accepts_exact_nonempty_typed_material_and_rejects_recategorization() {
    let f = Fixture::new("increment");
    let (mut meta, mut parts) = f.split();
    let root = String::from_utf8(ROOTS.to_vec()).unwrap();
    let block = root
        .split("-----BEGIN CERTIFICATE-----")
        .nth(1)
        .unwrap()
        .split("-----END CERTIFICATE-----")
        .next()
        .unwrap();
    let certificate = STANDARD
        .decode(block.split_ascii_whitespace().collect::<String>())
        .unwrap();
    let crl = b"CONSTRUCTED-CRL-WIRE-ONLY".to_vec();
    let certificate_hash = transport::sha256(&certificate);
    let crl_hash = transport::sha256(&crl);
    let mut wrapper: Value = serde_json::from_slice(&parts[0]).unwrap();
    let evidence=transport::sha256(&wire_json::canonical(&json!({"observedAt":wrapper["checkedAt"],"certificates":[certificate_hash],"crls":[crl_hash],"ocsps":[]})).unwrap());
    wrapper["report"]["checks"][0]["evidenceHashes"] = json!([certificate_hash, crl_hash]);
    wrapper["report"]["checks"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|c| c["name"] == "evidence_set")
        .unwrap()["evidenceHashes"] = json!([evidence]);
    wrapper["reportSha256"] = json!(transport::sha256(
        &wire_json::canonical(&wrapper["report"]).unwrap()
    ));
    parts[0] = wire_json::canonical(&wrapper).unwrap();
    meta["evidenceSetSha256"] = json!(evidence);
    meta["responseHeaders"] = json!(
        f.signed(&parts[0], REPORT_TYPE)
            .into_iter()
            .collect::<BTreeMap<_, _>>()
    );
    meta["parts"].as_array_mut().unwrap().extend([
        json!({"name":"certificates","index":0}),
        json!({"name":"crls","index":0}),
    ]);
    parts.extend([certificate, crl]);
    let (body, headers) = f.assemble(meta.clone(), parts.clone());
    assert_eq!(
        f.verify(body, &headers, f.now).unwrap().verdict(),
        Verdict::Accepted
    );
    meta["parts"][3]["name"] = json!("crls");
    meta["parts"][4]["index"] = json!(1);
    let (body, headers) = f.assemble(meta, parts);
    assert!(f.verify(body, &headers, f.now).is_err());
}

#[test]
fn contract_bundle_authentication_rejects_tamper_duplicate_headers_and_transfer_encoding() {
    let f = Fixture::new("increment");
    let mut changed = f.body.clone();
    *changed.last_mut().unwrap() ^= 1;
    assert!(f.verify(changed, &f.headers, f.now).is_err());
    for extra in [
        ("Content-Type", CONTENT_TYPE),
        ("content-encoding", "gzip"),
        ("transfer-encoding", "chunked"),
    ] {
        let mut headers = f.headers.clone();
        headers.push((extra.0.into(), extra.1.into()));
        assert!(f.verify(f.body.clone(), &headers, f.now).is_err());
    }
    let mut headers = f.headers.clone();
    headers
        .iter_mut()
        .find(|v| v.0 == "content-type")
        .unwrap()
        .1 = "text/html".into();
    assert!(f.verify(f.body.clone(), &headers, f.now).is_err());
}

#[test]
fn contract_bundle_authenticated_context_policy_identity_and_head_must_match() {
    let f = Fixture::new("increment");
    for field in [
        "tenantId",
        "envelopeId",
        "documentId",
        "requestId",
        "requestSha256",
        "operation",
    ] {
        let (body, headers) = f.report(|v| v[field] = json!("wrong"));
        assert!(f.verify(body, &headers, f.now).is_err(), "{field}");
    }
    for field in [
        "parentSha256",
        "candidateSha256",
        "participantId",
        "policySha256",
        "trustBundleSha256",
        "checkedAt",
    ] {
        let (body, headers) = f.report(|v| v["report"]["binding"][field] = json!("wrong"));
        assert!(f.verify(body, &headers, f.now).is_err(), "{field}");
    }
}

#[test]
fn contract_bundle_recomputes_verdict_and_rejects_missing_checks_and_false_ltv() {
    let f = Fixture::new("increment");
    let (body, headers) = f.report(|v| {
        v["report"]["checks"]
            .as_array_mut()
            .unwrap()
            .retain(|c| c["name"] != "identity")
    });
    assert!(f.verify(body, &headers, f.now).is_err());
    let (body, headers) = f.report(|v| v["report"]["checks"][0]["verdict"] = json!("invalid"));
    assert!(f.verify(body, &headers, f.now).is_err());
    let (body, headers) = f.report(|v| {
        v["report"]["checks"][0]["verdict"] = json!("invalid");
        v["report"]["verdict"] = json!("invalid");
    });
    assert_eq!(
        f.verify(body, &headers, f.now).unwrap().verdict(),
        Verdict::Invalid
    );
    for (field, value) in [
        ("trustProfile", "synthetic_not_icp"),
        ("longTermValidation", "established"),
        ("timestampStatus", "unsupported"),
    ] {
        let (body, headers) = f.report(|v| v["report"][field] = json!(value));
        assert!(f.verify(body, &headers, f.now).is_err());
    }
}

#[test]
fn contract_bundle_rejects_added_evidence_even_when_every_outer_hash_and_mac_is_valid() {
    let f = Fixture::new("increment");
    let (mut meta, mut parts) = f.split();
    meta["parts"]
        .as_array_mut()
        .unwrap()
        .push(json!({"name":"crls","index":0,"length":0,"sha256":""}));
    parts.push(b"unvalidated negative evidence".to_vec());
    let (body, headers) = f.assemble(meta, parts);
    assert!(f.verify(body, &headers, f.now).is_err());
    let (body, headers) = f.report(|v| {
        v["report"]["checks"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|c| c["name"] == "evidence_set")
            .unwrap()["evidenceHashes"] = json!(["a".repeat(64)])
    });
    assert!(f.verify(body, &headers, f.now).is_err());
}

#[test]
fn contract_bundle_expiration_uses_exact_clock_limits_not_rounded_seconds() {
    let f = Fixture::new("preflight");
    for offset in [-5, 60] {
        assert!(
            f.verify(
                f.body.clone(),
                &f.headers,
                f.now + Duration::seconds(offset)
            )
            .is_ok()
        );
    }
    for offset in [-5_000_001, 60_000_001] {
        assert!(
            f.verify(
                f.body.clone(),
                &f.headers,
                f.now + Duration::microseconds(offset)
            )
            .is_err()
        );
    }
}

#[test]
fn contract_bundle_rejects_inner_mac_tail_duplicate_parts_and_inconsistent_preflight() {
    let f = Fixture::new("preflight");
    let mut body = f.body.clone();
    body.push(0);
    assert!(
        f.verify(body.clone(), &f.signed(&body, CONTENT_TYPE), f.now)
            .is_err()
    );
    let (mut meta, parts) = f.split();
    meta["responseHeaders"]["x-validation-response-mac"] =
        json!(format!("HMAC-SHA256 test:{}", "0".repeat(64)));
    let (body, headers) = f.assemble(meta, parts);
    assert!(f.verify(body, &headers, f.now).is_err());
    let (mut meta, mut parts) = f.split();
    let duplicate = meta["parts"][2].clone();
    meta["parts"].as_array_mut().unwrap().push(duplicate);
    parts.push(vec![]);
    let (body, headers) = f.assemble(meta, parts);
    assert!(f.verify(body, &headers, f.now).is_err());
    for field in ["baseSha256", "baseSize", "policySha256", "documentId"] {
        let (body, headers) = f.report(|v| v["report"]["baseline"][field] = json!("wrong"));
        assert!(f.verify(body, &headers, f.now).is_err());
    }
}
