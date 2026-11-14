//! Authenticated offline result • only this boundary may construct a proof.
use super::{
    result_report,
    transport::{
        DocumentBinding, EncodedRequest, RequestAuthentication, RequestContext, ServiceKey,
        WireError, is_sha256, sha256,
    },
    trust::{ApprovedTrust, POLICY_SHA256},
    wire_json::{self, keys, require, text},
};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};
use time::OffsetDateTime;

pub(super) const CONTENT_TYPE: &str = "application/vnd.avila.contract-validation-bundle;version=1";
pub(super) const REPORT_TYPE: &str =
    "application/vnd.avila.contract-validation-result+json;version=1";
pub(super) const MAX_BYTES: usize = 40 * 1024 * 1024;
const MAGIC: &[u8] = b"AVILA-CVB1\n";
const REQUIRED_HEADERS: [&str; 4] = [
    "content-type",
    "content-length",
    "x-validation-response-sha256",
    "x-validation-response-mac",
];
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Verdict {
    Accepted,
    Invalid,
    Indeterminate,
    Unsupported,
}
pub(super) struct Verification<'a> {
    pub request: &'a EncodedRequest,
    pub authentication: &'a RequestAuthentication,
    pub key: &'a ServiceKey,
    pub trust: &'a ApprovedTrust,
    pub now: OffsetDateTime,
}
pub(super) struct VerifiedBundle {
    bytes: Vec<u8>,
    sha256: String,
    evidence_sha256: String,
    report_sha256: String,
    checked_at: OffsetDateTime,
    verdict: Verdict,
    context: RequestContext,
    headers: BTreeMap<String, String>,
    document_binding: DocumentBinding,
}
impl VerifiedBundle {
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
    pub fn sha256(&self) -> &str {
        &self.sha256
    }
    pub fn evidence_sha256(&self) -> &str {
        &self.evidence_sha256
    }
    pub fn report_sha256(&self) -> &str {
        &self.report_sha256
    }
    pub fn checked_at(&self) -> OffsetDateTime {
        self.checked_at
    }
    pub fn verdict(&self) -> Verdict {
        self.verdict
    }
    pub fn context(&self) -> &RequestContext {
        &self.context
    }
    pub fn headers(&self) -> &BTreeMap<String, String> {
        &self.headers
    }
    pub fn document_binding(&self) -> &DocumentBinding {
        &self.document_binding
    }
}
pub(super) fn decode(
    body: Vec<u8>,
    headers: &[(String, String)],
    expected: Verification<'_>,
) -> Result<VerifiedBundle, WireError> {
    require(!body.is_empty() && body.len() <= MAX_BYTES)?;
    let headers = authenticate(&body, headers, CONTENT_TYPE, &expected)?;
    // No JSON or binary header is interpreted before the outer MAC succeeds.
    require(
        expected.request.context().policy_sha256 == POLICY_SHA256
            && expected.request.context().trust_bundle_sha256 == expected.trust.sha256(),
    )?;
    let start = MAGIC.len() + 4;
    require(body.starts_with(MAGIC) && body.len() > start)?;
    let size =
        u32::from_be_bytes(body[MAGIC.len()..start].try_into().map_err(|_| WireError)?) as usize;
    require(size > 0 && size <= 32 * 1024 && start + size < body.len())?;
    let meta = wire_json::parse(&body[start..start + size], 32 * 1024)?;
    keys(
        &meta,
        &[
            "schemaVersion",
            "responseHeaders",
            "evidenceSetSha256",
            "trustProfile",
            "parts",
        ],
    )?;
    require(
        meta["schemaVersion"] == "avila-contract-bundle/1" && meta["trustProfile"] == "icp_brasil",
    )?;
    let inventory = meta["parts"].as_array().ok_or(WireError)?;
    require((3..=99).contains(&inventory.len()))?;
    let mut offset = start + size;
    let mut report = None;
    let mut snapshot_bytes = 0;
    let mut evidence_bytes = 0;
    let mut last_group = 0;
    let mut typed: [BTreeSet<String>; 3] = std::array::from_fn(|_| BTreeSet::new());
    for (position, part) in inventory.iter().enumerate() {
        keys(part, &["name", "index", "length", "sha256"])?;
        let name = text(&part["name"])?;
        let index = part["index"].as_u64().ok_or(WireError)?;
        let length = part["length"].as_u64().ok_or(WireError)?;
        let limit = match name {
            "report" => 256 * 1024,
            "rootsPem" | "intermediatesPem" => 4 * 1024 * 1024,
            "certificates" | "ocsps" => 256 * 1024,
            "crls" => 8 * 1024 * 1024,
            _ => return Err(WireError),
        };
        require(length <= limit && (length > 0 || name == "intermediatesPem"))?;
        let length = length as usize;
        let end = offset.checked_add(length).ok_or(WireError)?;
        let bytes = body.get(offset..end).ok_or(WireError)?;
        let digest = sha256(bytes);
        require(text(&part["sha256"])? == digest)?;
        offset = end;
        if position < 3 {
            require(name == ["report", "rootsPem", "intermediatesPem"][position] && index == 0)?;
            if position == 0 {
                report = Some(bytes);
            } else {
                snapshot_bytes += length;
                require(snapshot_bytes <= 4 * 1024 * 1024)?;
                require(
                    digest
                        == if position == 1 {
                            expected.trust.roots_pem_sha256()
                        } else {
                            expected.trust.intermediates_pem_sha256()
                        },
                )?;
            }
        } else {
            let group = match name {
                "certificates" => 0,
                "crls" => 1,
                "ocsps" => 2,
                _ => return Err(WireError),
            };
            require(
                group >= last_group
                    && index == typed[group].len() as u64
                    && index < [64, 16, 16][group],
            )?;
            last_group = group;
            require(typed[group].insert(digest))?;
            evidence_bytes += length;
            require(evidence_bytes <= 32 * 1024 * 1024)?;
        }
    }
    require(offset == body.len())?;
    keys(&meta["responseHeaders"], &REQUIRED_HEADERS)?;
    let inner_headers = meta["responseHeaders"]
        .as_object()
        .ok_or(WireError)?
        .iter()
        .map(|(name, value)| Ok((name.clone(), text(value)?.to_owned())))
        .collect::<Result<Vec<_>, WireError>>()?;
    let report = report.ok_or(WireError)?;
    authenticate(report, &inner_headers, REPORT_TYPE, &expected)?;
    let verified = result_report::verify(report, &expected)?;
    let evidence_identity = json!({"observedAt":verified.checked_at_text,"certificates":typed[0],"crls":typed[1],"ocsps":typed[2]});
    let evidence_sha256 = sha256(&wire_json::canonical(&evidence_identity)?);
    require(
        meta["evidenceSetSha256"] == evidence_sha256 && verified.evidence_sha256 == evidence_sha256,
    )?;
    let available = typed.into_iter().flatten().collect::<BTreeSet<_>>();
    require(verified.required_evidence.is_subset(&available))?;
    Ok(VerifiedBundle {
        sha256: sha256(&body),
        bytes: body,
        evidence_sha256,
        report_sha256: verified.report_sha256,
        checked_at: verified.checked_at,
        verdict: verified.verdict,
        context: expected.request.context().clone(),
        headers,
        document_binding: expected.request.binding().clone(),
    })
}

fn authenticate(
    body: &[u8],
    headers: &[(String, String)],
    media_type: &str,
    expected: &Verification<'_>,
) -> Result<BTreeMap<String, String>, WireError> {
    require(headers.len() <= 32)?;
    let mut values = BTreeMap::new();
    let mut total = 0usize;
    for (name, value) in headers {
        total = total
            .saturating_add(name.len())
            .saturating_add(value.len())
            .saturating_add(4);
        require(
            total <= 16 * 1024
                && !name.is_empty()
                && name.bytes().all(|v| v.is_ascii_alphanumeric() || v == b'-')
                && value.bytes().all(|v| (32..127).contains(&v)),
        )?;
        require(
            values
                .insert(name.to_ascii_lowercase(), value.clone())
                .is_none(),
        )?;
    }
    require(!values.contains_key("transfer-encoding") && !values.contains_key("content-encoding"))?;
    require(
        values.get("content-type").is_some_and(|v| v == media_type)
            && values
                .get("content-length")
                .is_some_and(|v| v == &body.len().to_string())
            && values
                .get("x-validation-response-sha256")
                .is_some_and(|v| is_sha256(v) && v == &sha256(body)),
    )?;
    expected.key.verify_response(
        body,
        values.get("x-validation-response-mac").ok_or(WireError)?,
        expected.request,
        expected.authentication,
    )?;
    REQUIRED_HEADERS
        .into_iter()
        .map(|name| Ok((name.into(), values.get(name).ok_or(WireError)?.clone())))
        .collect()
}

#[cfg(test)]
#[path = "bundle_tests.rs"]
mod tests;
