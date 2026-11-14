//! Bounded outbound frames • no PDF parsing or personal signing.
use super::identity::PersonalCpf;
use hmac::{Hmac, Mac};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use uuid::Uuid;
use zeroize::Zeroizing;

pub(super) const BASE_MAX: usize = 20 * 1024 * 1024;
pub(super) const CANDIDATE_MAX: usize = 32 * 1024 * 1024;
const MAGIC: &[u8] = b"AVILA-CV1\n";
const HEADER_MAX: usize = 32 * 1024;
pub(super) const CONTENT_TYPE: &str =
    "application/vnd.avila.contract-validation+octet-stream;version=1";

#[derive(Debug, thiserror::Error)]
#[error("Resposta de validação indisponível ou incompatível")]
pub(crate) struct WireError;

#[derive(Clone, Debug)]
pub(super) struct RequestContext {
    pub request_id: Uuid,
    pub tenant_id: Uuid,
    pub envelope_id: Uuid,
    pub document_id: Uuid,
    pub policy_sha256: String,
    pub trust_bundle_sha256: String,
}
pub(super) struct Signer<'a> {
    pub participant_id: Uuid,
    pub cpf: &'a PersonalCpf,
}
pub(super) enum Input<'a> {
    Preflight {
        base: &'a [u8],
    },
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "Increment is constructed by the upload worker in workflow plan task 3"
        )
    )]
    Increment {
        base: &'a [u8],
        parent: &'a [u8],
        candidate: &'a [u8],
        signer: Signer<'a>,
        previous_signers: Vec<Signer<'a>>,
    },
}
pub(super) struct EncodedRequest {
    body: Zeroizing<Vec<u8>>,
    context: RequestContext,
    operation: &'static str,
    frame_sha256: String,
    binding: DocumentBinding,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum DocumentBinding {
    Preflight {
        base_sha256: String,
        base_size: usize,
    },
    Increment {
        participant_id: Uuid,
        parent_sha256: String,
        candidate_sha256: String,
    },
}

pub(super) fn sha256(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}
pub(super) fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
}

// Field declaration order is the protocol's sorted ASCII key order. Borrow CPF
// directly; buffers owned by this codec are zeroized on drop.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireSigner<'a> {
    expected_cpf: &'a str,
    participant_id: Uuid,
}
#[derive(Serialize)]
struct Part<'a> {
    length: usize,
    name: &'a str,
    sha256: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Header<'a> {
    document_id: Uuid,
    envelope_id: Uuid,
    operation: &'static str,
    parts: Vec<Part<'a>>,
    policy_sha256: &'a str,
    previous_signers: Vec<WireSigner<'a>>,
    request_id: Uuid,
    schema_version: &'static str,
    signer: Option<WireSigner<'a>>,
    tenant_id: Uuid,
    trust_bundle_sha256: &'a str,
}

pub(super) fn encode(
    context: RequestContext,
    input: Input<'_>,
) -> Result<EncodedRequest, WireError> {
    if [
        context.request_id,
        context.tenant_id,
        context.envelope_id,
        context.document_id,
    ]
    .iter()
    .any(Uuid::is_nil)
        || !is_sha256(&context.policy_sha256)
        || !is_sha256(&context.trust_bundle_sha256)
    {
        return Err(WireError);
    }
    let (operation, blobs, signer, previous_signers) = match input {
        Input::Preflight { base } => ("preflight", vec![("base", base)], None, Vec::new()),
        Input::Increment {
            base,
            parent,
            candidate,
            signer,
            previous_signers,
        } => {
            if previous_signers.len() > 9 {
                return Err(WireError);
            }
            let mut ids = HashSet::new();
            let mut cpfs = HashSet::new();
            for person in previous_signers.iter().chain(std::iter::once(&signer)) {
                if person.participant_id.is_nil()
                    || !ids.insert(person.participant_id)
                    || !cpfs.insert(person.cpf.expose())
                {
                    return Err(WireError);
                }
            }
            let current = WireSigner {
                expected_cpf: signer.cpf.expose(),
                participant_id: signer.participant_id,
            };
            let previous = previous_signers
                .into_iter()
                .map(|s| WireSigner {
                    expected_cpf: s.cpf.expose(),
                    participant_id: s.participant_id,
                })
                .collect();
            (
                "increment",
                vec![("base", base), ("parent", parent), ("candidate", candidate)],
                Some(current),
                previous,
            )
        }
    };
    for (name, bytes) in &blobs {
        let limit = if *name == "base" {
            BASE_MAX
        } else {
            CANDIDATE_MAX
        };
        if bytes.is_empty() || bytes.len() > limit {
            return Err(WireError);
        }
    }
    let header = Header {
        document_id: context.document_id,
        envelope_id: context.envelope_id,
        operation,
        parts: blobs
            .iter()
            .map(|(name, bytes)| Part {
                length: bytes.len(),
                name,
                sha256: sha256(bytes),
            })
            .collect(),
        policy_sha256: &context.policy_sha256,
        previous_signers,
        request_id: context.request_id,
        schema_version: "avila-contract-request/1",
        signer,
        tenant_id: context.tenant_id,
        trust_bundle_sha256: &context.trust_bundle_sha256,
    };
    let metadata = Zeroizing::new(serde_json::to_vec(&header).map_err(|_| WireError)?);
    if metadata.len() > HEADER_MAX {
        return Err(WireError);
    }
    let binding = if let Some(signer) = &header.signer {
        DocumentBinding::Increment {
            participant_id: signer.participant_id,
            parent_sha256: header.parts[1].sha256.clone(),
            candidate_sha256: header.parts[2].sha256.clone(),
        }
    } else {
        DocumentBinding::Preflight {
            base_sha256: header.parts[0].sha256.clone(),
            base_size: header.parts[0].length,
        }
    };
    let total =
        MAGIC.len() + 4 + metadata.len() + blobs.iter().map(|(_, b)| b.len()).sum::<usize>();
    let mut body = Zeroizing::new(Vec::new());
    body.try_reserve_exact(total).map_err(|_| WireError)?;
    body.extend_from_slice(MAGIC);
    body.extend_from_slice(&(metadata.len() as u32).to_be_bytes());
    body.extend_from_slice(&metadata);
    for (_, bytes) in blobs {
        body.extend_from_slice(bytes);
    }
    let frame_sha256 = sha256(&body);
    Ok(EncodedRequest {
        body,
        context,
        operation,
        frame_sha256,
        binding,
    })
}

impl EncodedRequest {
    #[cfg(test)]
    pub fn body(&self) -> &[u8] {
        &self.body
    }
    pub fn context(&self) -> &RequestContext {
        &self.context
    }
    pub fn operation(&self) -> &'static str {
        self.operation
    }
    pub fn binding(&self) -> &DocumentBinding {
        &self.binding
    }
    pub fn frame_sha256(&self) -> &str {
        &self.frame_sha256
    }
    pub fn take_body(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.body)
    }
}

pub(super) struct ServiceKey {
    id: String,
    bytes: Zeroizing<Vec<u8>>,
}
pub(super) struct RequestAuthentication {
    headers: BTreeMap<String, String>,
    request_sha256: String,
    sent_at: i64,
    key_id: String,
}
impl ServiceKey {
    pub fn new(id: &str, bytes: &[u8]) -> Result<Self, WireError> {
        if id.is_empty()
            || id.len() > 32
            || !id.as_bytes()[0].is_ascii_lowercase() && !id.as_bytes()[0].is_ascii_digit()
            || !id
                .bytes()
                .all(|v| v.is_ascii_lowercase() || v.is_ascii_digit() || v == b'_' || v == b'-')
            || !(32..=64).contains(&bytes.len())
        {
            return Err(WireError);
        }
        Ok(Self {
            id: id.into(),
            bytes: Zeroizing::new(bytes.to_vec()),
        })
    }
    pub fn authenticate(
        &self,
        request: &EncodedRequest,
        sent_at: i64,
    ) -> Result<RequestAuthentication, WireError> {
        if !(1..=999_999_999_999).contains(&sent_at) || request.body.is_empty() {
            return Err(WireError);
        }
        let request_sha256 = request.frame_sha256.clone();
        let message = format!(
            "AVILA-CV-AUTH/1\nPOST\n/internal/v1/{}\n{}\n{sent_at}\n{}\n{request_sha256}\n{}\n",
            request.operation,
            self.id,
            request.context.request_id,
            request.body.len()
        );
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.bytes).map_err(|_| WireError)?;
        mac.update(message.as_bytes());
        let signature = format!("{:x}", mac.finalize().into_bytes());
        Ok(RequestAuthentication {
            headers: BTreeMap::from([
                (
                    "authorization".into(),
                    format!("HMAC-SHA256 {}:{signature}", self.id),
                ),
                ("content-type".into(), CONTENT_TYPE.into()),
                ("content-length".into(), request.body.len().to_string()),
                ("x-validation-time".into(), sent_at.to_string()),
                (
                    "x-validation-request-id".into(),
                    request.context.request_id.to_string(),
                ),
                ("x-validation-content-sha256".into(), request_sha256.clone()),
            ]),
            request_sha256,
            sent_at,
            key_id: self.id.clone(),
        })
    }

    pub fn verify_response(
        &self,
        body: &[u8],
        received: &str,
        request: &EncodedRequest,
        authentication: &RequestAuthentication,
    ) -> Result<(), WireError> {
        if authentication.key_id != self.id || authentication.request_sha256 != request.frame_sha256
        {
            return Err(WireError);
        }
        let prefix = format!("HMAC-SHA256 {}:", self.id);
        let received = received
            .strip_prefix(&prefix)
            .filter(|v| is_sha256(v))
            .ok_or(WireError)?;
        let signature = (0..64)
            .step_by(2)
            .map(|index| u8::from_str_radix(&received[index..index + 2], 16).map_err(|_| WireError))
            .collect::<Result<Vec<_>, _>>()?;
        let message = format!(
            "AVILA-CV-RESPONSE/1\n{}\n{}\n{}\n{}\n{}\n",
            self.id,
            request.context.request_id,
            authentication.request_sha256,
            sha256(body),
            body.len()
        );
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.bytes).map_err(|_| WireError)?;
        mac.update(message.as_bytes());
        mac.verify_slice(&signature).map_err(|_| WireError)
    }
}

impl RequestAuthentication {
    pub fn headers(&self) -> &BTreeMap<String, String> {
        &self.headers
    }
    pub fn sent_at(&self) -> i64 {
        self.sent_at
    }
}

impl std::fmt::Debug for ServiceKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ServiceKey([REDACTED])")
    }
}

#[cfg(test)]
#[path = "codec_tests.rs"]
mod tests;
