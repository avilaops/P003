//! Strict correlated report; called only after both authenticated byte layers.
use super::{
    bundle::{Verdict, Verification},
    transport::{DocumentBinding, WireError, is_sha256, sha256},
    wire_json::{self, keys, require, text},
};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use time::{Duration, OffsetDateTime, UtcOffset, format_description::well_known::Rfc3339};

pub(super) struct VerifiedReport {
    pub verdict: Verdict,
    pub checked_at: OffsetDateTime,
    pub checked_at_text: String,
    pub report_sha256: String,
    pub evidence_sha256: String,
    pub required_evidence: BTreeSet<String>,
}
struct Check {
    verdict: Verdict,
    reason: String,
    hashes: Vec<String>,
}
fn verdict(value: &Value) -> Result<Verdict, WireError> {
    match text(value)? {
        "accepted" => Ok(Verdict::Accepted),
        "invalid" => Ok(Verdict::Invalid),
        "indeterminate" => Ok(Verdict::Indeterminate),
        "unsupported" => Ok(Verdict::Unsupported),
        _ => Err(WireError),
    }
}
fn code(value: &str) -> bool {
    (1..=80).contains(&value.len()) && value.bytes().all(|v| v.is_ascii_lowercase() || v == b'_')
}
fn version(value: &str) -> bool {
    if value.len() > 64 || !value.is_ascii() {
        return false;
    }
    let parts = value.splitn(3, '.').collect::<Vec<_>>();
    parts.len() == 3
        && parts[..2]
            .iter()
            .all(|v| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()))
        && parts[2].as_bytes().first().is_some_and(u8::is_ascii_digit)
        && parts[2]
            .bytes()
            .all(|v| v.is_ascii_alphanumeric() || b".+-".contains(&v))
}
fn checked_at(stamp: &str, expected: &Verification<'_>) -> Result<OffsetDateTime, WireError> {
    let bytes = stamp.as_bytes();
    require(
        (bytes.len() == 20 || bytes.len() == 27)
            && bytes[10] == b'T'
            && bytes.last() == Some(&b'Z'),
    )?;
    require(bytes[17..19].iter().all(u8::is_ascii_digit) && &bytes[17..19] < b"60".as_slice())?;
    if bytes.len() == 27 {
        require(
            bytes[19] == b'.'
                && bytes[20..26].iter().all(u8::is_ascii_digit)
                && bytes[20..26].iter().any(|v| *v != b'0'),
        )?;
    }
    let checked = OffsetDateTime::parse(stamp, &Rfc3339).map_err(|_| WireError)?;
    require(expected.now.offset() == UtcOffset::UTC)?;
    let sent = OffsetDateTime::from_unix_timestamp(expected.authentication.sent_at())
        .map_err(|_| WireError)?;
    for difference in [expected.now - checked, checked - sent] {
        require(difference >= Duration::seconds(-5) && difference <= Duration::seconds(60))?;
    }
    Ok(checked)
}

pub(super) fn verify(raw: &[u8], expected: &Verification<'_>) -> Result<VerifiedReport, WireError> {
    let wrapper = wire_json::parse(raw, 256 * 1024)?;
    keys(
        &wrapper,
        &[
            "schemaVersion",
            "requestId",
            "tenantId",
            "envelopeId",
            "documentId",
            "operation",
            "requestSha256",
            "checkedAt",
            "reportSha256",
            "report",
        ],
    )?;
    let context = expected.request.context();
    require(
        wrapper["schemaVersion"] == "avila-contract-response/1"
            && wrapper["requestId"] == context.request_id.to_string()
            && wrapper["tenantId"] == context.tenant_id.to_string()
            && wrapper["envelopeId"] == context.envelope_id.to_string()
            && wrapper["documentId"] == context.document_id.to_string()
            && wrapper["operation"] == expected.request.operation()
            && wrapper["requestSha256"] == expected.request.frame_sha256(),
    )?;
    let stamp = text(&wrapper["checkedAt"])?;
    let checked_at = checked_at(stamp, expected)?;
    let report = &wrapper["report"];
    let report_sha256 = sha256(&wire_json::canonical(report)?);
    require(wrapper["reportSha256"] == report_sha256)?;
    let operation = expected.request.operation();
    let mut common = vec![
        "schemaVersion",
        "binding",
        "verdict",
        "trustProfile",
        "engine",
        "checks",
        "longTermValidation",
    ];
    common.push(if operation == "preflight" {
        "baseline"
    } else {
        "timestampStatus"
    });
    keys(report, &common)?;
    require(
        report["trustProfile"] == "icp_brasil" && report["longTermValidation"] == "not_established",
    )?;
    keys(
        &report["engine"],
        &["validator", "pyHanko", "certvalidator"],
    )?;
    for value in report["engine"].as_object().ok_or(WireError)?.values() {
        require(version(text(value)?))?;
    }
    let mut binding = json!({"documentId":context.document_id,"policySha256":context.policy_sha256,"trustBundleSha256":context.trust_bundle_sha256,"checkedAt":stamp});
    let baseline_present = match expected.request.binding() {
        DocumentBinding::Preflight {
            base_sha256,
            base_size,
        } => {
            require(
                operation == "preflight" && report["schemaVersion"] == "avila-contract-preflight/1",
            )?;
            binding["baseSha256"] = json!(base_sha256);
            if !report["baseline"].is_null() {
                let baseline = &report["baseline"];
                keys(
                    baseline,
                    &[
                        "documentId",
                        "baseSha256",
                        "baseSize",
                        "policySha256",
                        "trustBundleSha256",
                        "signatures",
                    ],
                )?;
                require(
                    baseline["documentId"] == context.document_id.to_string()
                        && baseline["baseSha256"] == *base_sha256
                        && baseline["baseSize"].as_u64() == Some(*base_size as u64)
                        && baseline["policySha256"] == context.policy_sha256
                        && baseline["trustBundleSha256"] == context.trust_bundle_sha256,
                )?;
                let signatures = baseline["signatures"].as_array().ok_or(WireError)?;
                require(signatures.len() <= 32)?;
                for signature in signatures {
                    keys(
                        signature,
                        &["cmsSha256", "certificateSha256", "fieldSha256"],
                    )?;
                    for value in signature.as_object().ok_or(WireError)?.values() {
                        require(is_sha256(text(value)?))?;
                    }
                }
                true
            } else {
                false
            }
        }
        DocumentBinding::Increment {
            participant_id,
            parent_sha256,
            candidate_sha256,
        } => {
            require(
                operation == "increment"
                    && report["schemaVersion"] == "avila-contract-validation/1",
            )?;
            require(
                ["absent", "unsupported", "invalid"].contains(&text(&report["timestampStatus"])?),
            )?;
            binding["participantId"] = json!(participant_id);
            binding["parentSha256"] = json!(parent_sha256);
            binding["candidateSha256"] = json!(candidate_sha256);
            true
        }
    };
    require(report["binding"] == binding)?;
    let values = report["checks"].as_array().ok_or(WireError)?;
    require(values.len() <= 32)?;
    let mut checks = BTreeMap::new();
    for check in values {
        keys(check, &["name", "verdict", "reason", "evidenceHashes"])?;
        let name = text(&check["name"])?;
        let reason = text(&check["reason"])?;
        require(code(name) && code(reason))?;
        let hashes = check["evidenceHashes"].as_array().ok_or(WireError)?;
        require(hashes.len() <= 128)?;
        let hashes = hashes
            .iter()
            .map(|v| {
                let hash = text(v)?;
                require(is_sha256(hash))?;
                Ok(hash.to_owned())
            })
            .collect::<Result<Vec<_>, WireError>>()?;
        let check = Check {
            verdict: verdict(&check["verdict"])?,
            reason: reason.into(),
            hashes,
        };
        require(checks.insert(name.to_owned(), check).is_none())?;
    }
    let required: &[&str] = if operation == "preflight" {
        &["binding", "format", "baseline"]
    } else {
        &[
            "binding",
            "increment",
            "baseline",
            "identity",
            "chain",
            "revocation",
            "prior_signatures",
            "modifications",
            "coverage",
            "algorithms",
        ]
    };
    let computed = if checks.values().any(|c| c.verdict == Verdict::Invalid) {
        Verdict::Invalid
    } else if checks.values().any(|c| c.verdict == Verdict::Unsupported) {
        Verdict::Unsupported
    } else if !baseline_present
        || checks.values().any(|c| c.verdict == Verdict::Indeterminate)
        || required.iter().any(|name| !checks.contains_key(*name))
    {
        Verdict::Indeterminate
    } else {
        Verdict::Accepted
    };
    require(verdict(&report["verdict"])? == computed)?;
    if operation == "increment" && computed == Verdict::Accepted {
        require(report["timestampStatus"] == "absent")?;
    }
    let inventory = checks.get("evidence_set").ok_or(WireError)?;
    require(
        inventory.verdict == Verdict::Accepted
            && inventory.reason == "typed_evidence_set_bound"
            && inventory.hashes.len() == 1,
    )?;
    let evidence_sha256 = inventory.hashes[0].clone();
    let required_evidence = checks
        .iter()
        .filter(|(name, _)| name.as_str() != "evidence_set")
        .flat_map(|(_, c)| c.hashes.iter().cloned())
        .collect();
    Ok(VerifiedReport {
        verdict: computed,
        checked_at,
        checked_at_text: stamp.into(),
        report_sha256,
        evidence_sha256,
        required_evidence,
    })
}
