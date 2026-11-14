use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use std::{collections::BTreeMap, path::PathBuf};
use uuid::Uuid;
const PREFIX: &str = "ERP_CONTRACT_VALIDATOR_";
const CA: &[u8] = include_bytes!("../../../../tests/fixtures/contract-wire/tls-test-ca.pem");
const ROOTS: &[u8] = include_bytes!("../../../../../../deploy/fiscal/icp-brasil-roots.pem");
struct Files {
    root: PathBuf,
    names: Vec<&'static str>,
}
impl Files {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("contract-config-{}", Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        Self {
            root,
            names: vec![],
        }
    }
    fn put(&mut self, name: &'static str, bytes: &[u8]) -> String {
        let path = self.root.join(name);
        if !self.names.contains(&name) {
            self.names.push(name);
        }
        std::fs::write(&path, bytes).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        path.to_str().unwrap().into()
    }
}
impl Drop for Files {
    fn drop(&mut self) {
        for name in &self.names {
            let _ = std::fs::remove_file(self.root.join(name));
        }
        let _ = std::fs::remove_dir(&self.root);
    }
}
fn config(files: &mut Files) -> BTreeMap<String, String> {
    let key = STANDARD.encode(b"SYNTHETIC-TRANSPORT-TEST-KEY-ONLY!!");
    let json = format!(r#"{{"schemaVersion":"avila-validator-keys/1","keys":{{"test":"{key}"}}}}"#);
    BTreeMap::from([
        (format!("{PREFIX}URL"), "https://validator.local".into()),
        (format!("{PREFIX}KEY_ID"), "test".into()),
        (
            format!("{PREFIX}KEYRING_FILE"),
            files.put("hmac.json", json.as_bytes()),
        ),
        (format!("{PREFIX}TLS_CA_FILE"), files.put("tls.pem", CA)),
        (format!("{PREFIX}ROOTS_FILE"), files.put("roots.pem", ROOTS)),
    ])
}
fn load(map: &BTreeMap<String, String>) -> Result<Option<Arc<ValidatorClient>>, WireError> {
    load_with(|name| Ok(map.get(name).cloned()))
}
#[test]
fn configuration_absent_is_disabled_but_partial_or_empty_is_rejected() {
    assert!(load(&BTreeMap::new()).unwrap().is_none());
    let mut files = Files::new();
    let map = config(&mut files);
    assert!(load(&map).unwrap().is_some());
    for name in map.keys() {
        let mut missing = map.clone();
        missing.remove(name);
        assert!(load(&missing).is_err(), "{name}");
        missing.insert(name.clone(), " ".into());
        assert!(load(&missing).is_err(), "{name}");
    }
    assert!(load_with(|_| Err(WireError)).is_err());
}
#[test]
fn keyring_schema_rotation_duplicates_and_diagnostics_are_strict() {
    let mut files = Files::new();
    let mut map = config(&mut files);
    let key = STANDARD.encode(b"SYNTHETIC-TRANSPORT-TEST-KEY-ONLY!!");
    let good = format!(
        r#"{{"schemaVersion":"avila-validator-keys/1","keys":{{"test":"{key}","next":"{key}"}}}}"#
    );
    files.put("hmac.json", good.as_bytes());
    let client = load(&map).unwrap().unwrap();
    assert_eq!(format!("{client:?}"), "ValidatorClient([REDACTED])");
    let bad = [
        good.replace("avila-validator-keys/1", "avila-validator-keys/2"),
        good.replace("\"next\"", "\"test\""),
        good.replace("\"next\"", "\"te\\u0073t\""),
        good.replace("\"next\"", "\"BAD!\""),
        good.replace(
            "\"schemaVersion\":",
            "\"active\":\"test\",\"schemaVersion\":",
        ),
        good.replace(
            "\"schemaVersion\":",
            "\"schemaVersion\":\"avila-validator-keys/1\",\"schemaVersion\":",
        ),
        good.replace(&key, "YQ=="),
        good.replace("\"next\":", &format!("\"third\":\"{key}\",\"next\":")),
        "{\"schemaVersion\":\"avila-validator-keys/1\",\"keys\":{}}".into(),
        " ".repeat(4097),
    ];
    for json in bad {
        files.put("hmac.json", json.as_bytes());
        let error = load(&map).unwrap_err();
        assert_eq!(
            error.to_string(),
            "Resposta de validação indisponível ou incompatível"
        );
    }
    files.put("hmac.json", good.as_bytes());
    map.insert(format!("{PREFIX}KEY_ID"), "missing".into());
    assert!(load(&map).is_err());
}
#[test]
fn configuration_rejects_missing_oversize_symlink_and_public_secret_files() {
    let mut files = Files::new();
    let mut map = config(&mut files);
    map.insert(
        format!("{PREFIX}TLS_CA_FILE"),
        files.root.join("absent").to_str().unwrap().into(),
    );
    assert!(load(&map).is_err());
    map.insert(
        format!("{PREFIX}TLS_CA_FILE"),
        files.put("tls.pem", &vec![b'x'; 256 * 1024 + 1]),
    );
    assert!(load(&map).is_err());
    files.put("tls.pem", CA);
    map.insert(
        format!("{PREFIX}INTERMEDIATES_FILE"),
        files.put("intermediates.pem", b"not PEM"),
    );
    assert!(load(&map).is_err());
    map.remove(&format!("{PREFIX}INTERMEDIATES_FILE"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::{PermissionsExt, symlink};
        std::fs::set_permissions(
            files.root.join("hmac.json"),
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        assert!(load(&map).is_err());
        std::fs::set_permissions(
            files.root.join("hmac.json"),
            std::fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        symlink(files.root.join("hmac.json"), files.root.join("link.json")).unwrap();
        files.names.push("link.json");
        map.insert(
            format!("{PREFIX}KEYRING_FILE"),
            files.root.join("link.json").to_str().unwrap().into(),
        );
        assert!(load(&map).is_err());
    }
}
