//! Public trust identity • reviewed roots, never anchors selected by a response.
use super::{
    transport::{WireError, is_sha256, sha256},
    wire_json,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::collections::BTreeSet;

pub(super) const POLICY_SHA256: &str =
    "88e36db3af86abbf7df5bb49794ad7f50a161aab2eb1827980a62b640825013e";
const REGISTRY: &[u8] = include_bytes!(
    "../../../../../contract-signature-validator/src/contract_signature_validator/trust_registry.json"
);
const REGISTRY_SHA256: &str = "7780e435da30c445e5a927f894640a0c09b5eca2fabbf3c4b068c7682350d5bc";
pub(super) struct ApprovedTrust {
    sha256: String,
    roots_pem_sha256: String,
    intermediates_pem_sha256: String,
}
impl ApprovedTrust {
    pub fn new(roots: &[u8], intermediates: &[u8]) -> Result<Self, WireError> {
        if roots.len().saturating_add(intermediates.len()) > 4 * 1024 * 1024
            || sha256(REGISTRY) != REGISTRY_SHA256
        {
            return Err(WireError);
        }
        let registry: Value = serde_json::from_slice(REGISTRY).map_err(|_| WireError)?;
        let approved = registry["roots"]
            .as_array()
            .ok_or(WireError)?
            .iter()
            .map(|root| {
                let hash = root["sha256"].as_str().ok_or(WireError)?;
                if !is_sha256(hash) {
                    return Err(WireError);
                }
                Ok(hash.to_owned())
            })
            .collect::<Result<BTreeSet<_>, _>>()?;
        let root_der = certificates(roots)?;
        let intermediate_der = certificates(intermediates)?;
        let root_hashes = root_der.iter().map(|v| sha256(v)).collect::<BTreeSet<_>>();
        let intermediate_hashes = intermediate_der
            .iter()
            .map(|v| sha256(v))
            .collect::<BTreeSet<_>>();
        if root_hashes.is_empty() || !root_hashes.is_subset(&approved) {
            return Err(WireError);
        }
        let identity = json!({"profile":"icp_brasil","registrySha256":REGISTRY_SHA256,"roots":root_hashes,"intermediates":intermediate_hashes});
        let sha256 = sha256(&wire_json::canonical(&identity)?);
        let roots_pem_sha256 = super::transport::sha256(&armor(&root_der));
        let intermediates_pem_sha256 = super::transport::sha256(&armor(&intermediate_der));
        Ok(Self {
            sha256,
            roots_pem_sha256,
            intermediates_pem_sha256,
        })
    }
    pub fn sha256(&self) -> &str {
        &self.sha256
    }
    pub fn roots_pem_sha256(&self) -> &str {
        &self.roots_pem_sha256
    }
    pub fn intermediates_pem_sha256(&self) -> &str {
        &self.intermediates_pem_sha256
    }
}

// Only public, explicitly configured PEM is processed here. We hash DER bytes,
// never interpret certificates from a network response or validate PDF signing.
fn certificates(mut bytes: &[u8]) -> Result<BTreeSet<Vec<u8>>, WireError> {
    const BEGIN: &[u8] = b"-----BEGIN CERTIFICATE-----";
    const END: &[u8] = b"-----END CERTIFICATE-----";
    let mut values = BTreeSet::new();
    let mut count = 0;
    while !bytes.trim_ascii().is_empty() {
        bytes = bytes.trim_ascii();
        let rest = bytes.strip_prefix(BEGIN).ok_or(WireError)?;
        let end = rest
            .windows(END.len())
            .position(|v| v == END)
            .ok_or(WireError)?;
        let encoded = &rest[..end];
        if encoded
            .iter()
            .any(|v| !v.is_ascii_alphanumeric() && !b"+/= \r\n\t".contains(v))
        {
            return Err(WireError);
        }
        let encoded = encoded
            .iter()
            .copied()
            .filter(|v| !v.is_ascii_whitespace())
            .collect::<Vec<_>>();
        let der = STANDARD.decode(encoded).map_err(|_| WireError)?;
        count += 1;
        if der.is_empty() || der.len() > 256 * 1024 || count > 256 {
            return Err(WireError);
        }
        values.insert(der);
        bytes = &rest[end + END.len()..];
    }
    Ok(values)
}
fn armor(values: &BTreeSet<Vec<u8>>) -> Vec<u8> {
    let mut output = Vec::new();
    for der in values {
        output.extend_from_slice(b"-----BEGIN CERTIFICATE-----\n");
        for chunk in STANDARD.encode(der).as_bytes().chunks(64) {
            output.extend_from_slice(chunk);
            output.push(b'\n');
        }
        output.extend_from_slice(b"-----END CERTIFICATE-----\n");
    }
    output
}

#[cfg(test)]
#[path = "trust_tests.rs"]
mod tests;
