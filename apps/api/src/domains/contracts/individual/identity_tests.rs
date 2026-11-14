use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};

fn ring(active: &str, include_old: bool) -> IdentityKeyring {
    let mut keys = serde_json::Map::new();
    keys.insert("new".into(), STANDARD.encode([71u8; 32]).into());
    if include_old {
        keys.insert("old".into(), STANDARD.encode([43u8; 32]).into());
    }
    IdentityKeyring::from_json(&serde_json::json!({"active":active,"keys":keys}).to_string())
        .unwrap()
}

#[test]
fn contract_individual_cpf_requires_personal_check_digits_and_masks_plaintext() {
    for valid in ["52998224725", "529.982.247-25", "11144477735"] {
        let cpf = PersonalCpf::parse(valid).unwrap();
        assert!(!format!("{cpf:?}").contains("529"));
        assert_eq!(cpf.masked().len(), 14);
    }
    assert_eq!(
        PersonalCpf::parse("529.982.247-25").unwrap().masked(),
        "***.***.***-25"
    );
    for invalid in [
        "",
        "11111111111",
        "52998224726",
        "04252011000110",
        "52998224725x",
        "５２９９８２２４７２５",
        "529 982 24725",
        "52998224725\n",
        "529-982-247.25",
    ] {
        assert!(
            PersonalCpf::parse(invalid).is_err(),
            "invalid shape/check digits"
        );
    }
}

#[test]
fn contract_individual_identity_cipher_binds_tenant_envelope_participant_and_key() {
    let keys = ring("new", true);
    let tenant = Uuid::now_v7();
    let envelope = Uuid::now_v7();
    let participant = Uuid::now_v7();
    let cpf = PersonalCpf::parse("52998224725").unwrap();
    let sealed = keys.seal(tenant, envelope, participant, &cpf).unwrap();
    let again = keys.seal(tenant, envelope, participant, &cpf).unwrap();
    assert_ne!(sealed.nonce, again.nonce);
    assert_ne!(sealed.ciphertext, again.ciphertext);
    assert_eq!(sealed.ciphertext.len(), 27);
    assert_eq!(sealed.nonce.len(), 12);
    assert!(!sealed.ciphertext.windows(11).any(|v| v == b"52998224725"));
    assert_eq!(
        keys.open(tenant, envelope, participant, &sealed)
            .unwrap()
            .expose(),
        "52998224725"
    );
    for ids in [
        (Uuid::now_v7(), envelope, participant),
        (tenant, Uuid::now_v7(), participant),
        (tenant, envelope, Uuid::now_v7()),
    ] {
        assert!(keys.open(ids.0, ids.1, ids.2, &sealed).is_err());
    }
    let mut corrupted = sealed.clone();
    corrupted.ciphertext[0] ^= 1;
    assert!(
        keys.open(tenant, envelope, participant, &corrupted)
            .is_err()
    );
    corrupted = sealed.clone();
    corrupted.nonce.pop();
    assert!(
        keys.open(tenant, envelope, participant, &corrupted)
            .is_err()
    );
    corrupted = sealed.clone();
    corrupted.key_id = "unknown".into();
    assert!(
        keys.open(tenant, envelope, participant, &corrupted)
            .is_err()
    );
    let alias = IdentityKeyring::from_json(&serde_json::json!({"active":"new","keys":{"new":STANDARD.encode([71u8;32]),"alias":STANDARD.encode([71u8;32])}}).to_string()).unwrap();
    corrupted = sealed.clone();
    corrupted.key_id = "alias".into();
    assert!(
        alias
            .open(tenant, envelope, participant, &corrupted)
            .is_err(),
        "key identifier is authenticated even for aliases"
    );
    assert!(keys.seal(Uuid::nil(), envelope, participant, &cpf).is_err());
}

#[test]
fn contract_individual_identity_key_rotation_keeps_old_read_without_fiscal_vault() {
    let old = ring("old", true);
    let rotated = ring("new", true);
    let removed = ring("new", false);
    let ids = (Uuid::now_v7(), Uuid::now_v7(), Uuid::now_v7());
    let sealed = old
        .seal(
            ids.0,
            ids.1,
            ids.2,
            &PersonalCpf::parse("11144477735").unwrap(),
        )
        .unwrap();
    assert_eq!(
        rotated.open(ids.0, ids.1, ids.2, &sealed).unwrap().masked(),
        "***.***.***-35"
    );
    assert!(removed.open(ids.0, ids.1, ids.2, &sealed).is_err());
    assert!(!format!("{rotated:?}").contains(&STANDARD.encode([71u8; 32])));
    for invalid in [
        "{}",
        "{\"active\":\"missing\",\"keys\":{}}",
        "{\"active\":\"a\",\"keys\":{\"a\":\"short\"}}",
    ] {
        assert!(IdentityKeyring::from_json(invalid).is_err());
    }
    let duplicate = format!(
        "{{\"active\":\"new\",\"keys\":{{\"new\":\"{}\",\"new\":\"{}\"}}}}",
        STANDARD.encode([71u8; 32]),
        STANDARD.encode([43u8; 32])
    );
    assert!(IdentityKeyring::from_json(&duplicate).is_err());
    assert!(IdentityKeyring::from_json(&" ".repeat(16 * 1024 + 1)).is_err());
}
