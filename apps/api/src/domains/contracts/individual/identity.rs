//! Personal identity protection • no certificate material or fiscal vault access.
use std::collections::BTreeMap;

use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, AeadCore, OsRng, Payload},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{
    Deserialize, Deserializer,
    de::{MapAccess, Visitor},
};
use uuid::Uuid;
use zeroize::Zeroizing;

#[derive(Debug, thiserror::Error)]
#[error("Identidade do participante indisponível")]
pub struct IdentityError;

pub struct PersonalCpf(Zeroizing<String>);
impl std::fmt::Debug for PersonalCpf {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PersonalCpf([REDACTED])")
    }
}
impl PersonalCpf {
    pub fn parse(value: &str) -> Result<Self, IdentityError> {
        let shape = value.len() == 11 && value.bytes().all(|v| v.is_ascii_digit())
            || value.len() == 14
                && value.bytes().enumerate().all(|(index, byte)| match index {
                    3 | 7 => byte == b'.',
                    11 => byte == b'-',
                    _ => byte.is_ascii_digit(),
                });
        if !shape {
            return Err(IdentityError);
        }
        let digits = Zeroizing::new(
            value
                .bytes()
                .filter(u8::is_ascii_digit)
                .map(char::from)
                .collect::<String>(),
        );
        if !crate::platform::valid_document(&digits, "fisica") {
            return Err(IdentityError);
        }
        Ok(Self(digits))
    }
    pub fn masked(&self) -> String {
        format!("***.***.***-{}", &self.0[9..])
    }
    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}

#[derive(Clone)]
pub struct SealedIdentity {
    pub key_id: String,
    pub nonce: Vec<u8>,
    pub ciphertext: Vec<u8>,
}

pub struct IdentityKeyring {
    active: String,
    keys: BTreeMap<String, Zeroizing<Vec<u8>>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EncodedKeyring {
    active: String,
    #[serde(deserialize_with = "unique_keys")]
    keys: BTreeMap<String, Zeroizing<String>>,
}

fn unique_keys<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<BTreeMap<String, Zeroizing<String>>, D::Error> {
    struct Unique;
    impl<'de> Visitor<'de> for Unique {
        type Value = BTreeMap<String, Zeroizing<String>>;
        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("a bounded map of unique identity key identifiers")
        }
        fn visit_map<M: MapAccess<'de>>(self, mut access: M) -> Result<Self::Value, M::Error> {
            let mut values = BTreeMap::new();
            while let Some((id, key)) = access.next_entry::<String, Zeroizing<String>>()? {
                if values.len() == 10 || values.insert(id, key).is_some() {
                    return Err(serde::de::Error::custom("invalid identity keyring"));
                }
            }
            Ok(values)
        }
    }
    deserializer.deserialize_map(Unique)
}

fn context(
    tenant: Uuid,
    envelope: Uuid,
    participant: Uuid,
    key_id: &str,
) -> Result<String, IdentityError> {
    if tenant.is_nil() || envelope.is_nil() || participant.is_nil() {
        return Err(IdentityError);
    }
    Ok(format!(
        "AVILA-CONTRACT-IDENTITY/1\n{tenant}\n{envelope}\n{participant}\n{key_id}\n"
    ))
}
impl std::fmt::Debug for IdentityKeyring {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("IdentityKeyring([REDACTED])")
    }
}
impl IdentityKeyring {
    pub fn from_json(value: &str) -> Result<Self, IdentityError> {
        if value.len() > 16 * 1024 {
            return Err(IdentityError);
        }
        let encoded: EncodedKeyring = serde_json::from_str(value).map_err(|_| IdentityError)?;
        if encoded.keys.is_empty() || !encoded.keys.contains_key(&encoded.active) {
            return Err(IdentityError);
        }
        let mut keys = BTreeMap::new();
        for (id, encoded_key) in encoded.keys {
            if id.is_empty()
                || id.len() > 40
                || !id
                    .bytes()
                    .all(|v| v.is_ascii_alphanumeric() || v == b'-' || v == b'_')
            {
                return Err(IdentityError);
            }
            let key = Zeroizing::new(
                STANDARD
                    .decode(encoded_key.as_bytes())
                    .map_err(|_| IdentityError)?,
            );
            if key.len() != 32 {
                return Err(IdentityError);
            }
            keys.insert(id, key);
        }
        Ok(Self {
            active: encoded.active,
            keys,
        })
    }
    pub fn seal(
        &self,
        tenant: Uuid,
        envelope: Uuid,
        participant: Uuid,
        cpf: &PersonalCpf,
    ) -> Result<SealedIdentity, IdentityError> {
        let aad = context(tenant, envelope, participant, &self.active)?;
        let cipher =
            Aes256Gcm::new_from_slice(&self.keys[&self.active]).map_err(|_| IdentityError)?;
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let ciphertext = cipher
            .encrypt(
                &nonce,
                Payload {
                    msg: cpf.expose().as_bytes(),
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| IdentityError)?;
        Ok(SealedIdentity {
            key_id: self.active.clone(),
            nonce: nonce.to_vec(),
            ciphertext,
        })
    }
    pub fn open(
        &self,
        tenant: Uuid,
        envelope: Uuid,
        participant: Uuid,
        sealed: &SealedIdentity,
    ) -> Result<PersonalCpf, IdentityError> {
        if sealed.nonce.len() != 12 || sealed.ciphertext.len() != 27 {
            return Err(IdentityError);
        }
        let aad = context(tenant, envelope, participant, &sealed.key_id)?;
        let key = self.keys.get(&sealed.key_id).ok_or(IdentityError)?;
        let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| IdentityError)?;
        let plaintext = Zeroizing::new(
            cipher
                .decrypt(
                    Nonce::from_slice(&sealed.nonce),
                    Payload {
                        msg: &sealed.ciphertext,
                        aad: aad.as_bytes(),
                    },
                )
                .map_err(|_| IdentityError)?,
        );
        PersonalCpf::parse(std::str::from_utf8(&plaintext).map_err(|_| IdentityError)?)
    }
}

#[cfg(test)]
#[path = "identity_tests.rs"]
mod tests;
