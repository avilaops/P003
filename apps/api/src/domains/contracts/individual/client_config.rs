//! Dedicated validator configuration • no fiscal or participant signing keys.
use super::{
    client::ValidatorClient,
    transport::{ServiceKey, WireError},
    trust::ApprovedTrust,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{
    Deserialize, Deserializer,
    de::{MapAccess, Visitor},
};
use std::{collections::BTreeMap, io::Read, path::Path, sync::Arc};
use zeroize::Zeroizing;

const NAMES: [&str; 6] = [
    "ERP_CONTRACT_VALIDATOR_URL",
    "ERP_CONTRACT_VALIDATOR_KEY_ID",
    "ERP_CONTRACT_VALIDATOR_KEYRING_FILE",
    "ERP_CONTRACT_VALIDATOR_TLS_CA_FILE",
    "ERP_CONTRACT_VALIDATOR_ROOTS_FILE",
    "ERP_CONTRACT_VALIDATOR_INTERMEDIATES_FILE",
];
pub(super) fn load_with(
    mut lookup: impl FnMut(&str) -> Result<Option<String>, WireError>,
) -> Result<Option<Arc<ValidatorClient>>, WireError> {
    let values = NAMES
        .iter()
        .map(|name| lookup(name))
        .collect::<Result<Vec<_>, _>>()?;
    if values.iter().all(Option::is_none) {
        return Ok(None);
    }
    let required = |index: usize| {
        values[index]
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .ok_or(WireError)
    };
    let origin = required(0)?;
    let active = required(1)?;
    let key = keyring(&read_file(Path::new(required(2)?), 4096, true)?, active)?;
    let ca = read_file(Path::new(required(3)?), 256 * 1024, false)?;
    let roots = read_file(Path::new(required(4)?), 4 * 1024 * 1024, false)?;
    let intermediates = if values[5].is_some() {
        read_file(Path::new(required(5)?), 4 * 1024 * 1024, false)?
    } else {
        Zeroizing::new(Vec::new())
    };
    let trust = ApprovedTrust::new(&roots, &intermediates)?;
    ValidatorClient::new(origin, &ca, key, trust).map(|client| Some(Arc::new(client)))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Keyring {
    schema_version: String,
    #[serde(deserialize_with = "unique_keys")]
    keys: BTreeMap<String, Zeroizing<String>>,
}
fn unique_keys<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<BTreeMap<String, Zeroizing<String>>, D::Error> {
    struct Unique;
    impl<'de> Visitor<'de> for Unique {
        type Value = BTreeMap<String, Zeroizing<String>>;
        fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("one or two unique validator keys")
        }
        fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Self::Value, M::Error> {
            let mut keys = BTreeMap::new();
            while let Some((id, value)) = map.next_entry::<String, Zeroizing<String>>()? {
                if keys.len() == 2 || keys.insert(id, value).is_some() {
                    return Err(serde::de::Error::custom("invalid validator keys"));
                }
            }
            Ok(keys)
        }
    }
    deserializer.deserialize_map(Unique)
}
fn keyring(bytes: &[u8], active: &str) -> Result<ServiceKey, WireError> {
    if bytes.is_empty() || bytes.len() > 4096 {
        return Err(WireError);
    }
    let raw: Keyring = serde_json::from_slice(bytes).map_err(|_| WireError)?;
    if raw.schema_version != "avila-validator-keys/1" || raw.keys.is_empty() {
        return Err(WireError);
    }
    let mut selected = None;
    for (id, value) in raw.keys {
        let decoded = Zeroizing::new(STANDARD.decode(value.as_bytes()).map_err(|_| WireError)?);
        if STANDARD.encode(&decoded) != *value {
            return Err(WireError);
        }
        let key = ServiceKey::new(&id, &decoded)?;
        if id == active {
            selected = Some(key);
        }
    }
    selected.ok_or(WireError)
}
fn read_file(path: &Path, max: usize, private: bool) -> Result<Zeroizing<Vec<u8>>, WireError> {
    let before = std::fs::symlink_metadata(path).map_err(|_| WireError)?;
    if !before.is_file() || before.file_type().is_symlink() {
        return Err(WireError);
    }
    let file = std::fs::File::open(path).map_err(|_| WireError)?;
    let metadata = file.metadata().map_err(|_| WireError)?;
    if !metadata.is_file() || metadata.len() > max as u64 {
        return Err(WireError);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if before.dev() != metadata.dev()
            || before.ino() != metadata.ino()
            || private && metadata.permissions().mode() & 0o077 != 0
        {
            return Err(WireError);
        }
        #[cfg(target_os = "linux")]
        if private
            && metadata.uid()
                != std::fs::metadata("/proc/self")
                    .map_err(|_| WireError)?
                    .uid()
        {
            return Err(WireError);
        }
    }
    #[cfg(not(unix))]
    let _ = private; // Windows ACLs are supplied by deployment; no Unix mode emulation.
    let mut bytes = Zeroizing::new(Vec::new());
    file.take(max as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| WireError)?;
    if bytes.len() > max {
        return Err(WireError);
    }
    Ok(bytes)
}

#[cfg(test)]
#[path = "client_config_tests.rs"]
mod tests;
