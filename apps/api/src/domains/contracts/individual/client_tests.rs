//! Actual loopback TLS with CONSTRUCTED protocol reports, not ICP validation.
use super::super::{bundle::Verdict, identity::PersonalCpf, transport::Signer};
use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::Value;
use std::{
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
};
use uuid::Uuid;

const ROOTS: &[u8] = include_bytes!("../../../../../../deploy/fiscal/icp-brasil-roots.pem");
const CA: &[u8] = include_bytes!("../../../../tests/fixtures/contract-wire/tls-test-ca.pem");
const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/contract-wire");
fn vector(operation: &str) -> Value {
    serde_json::from_str(if operation == "preflight" {
        include_str!("../../../../tests/fixtures/contract-wire/preflight.json")
    } else {
        include_str!("../../../../tests/fixtures/contract-wire/increment.json")
    })
    .unwrap()
}
fn context(v: &Value) -> RequestContext {
    RequestContext {
        request_id: Uuid::new_v4(),
        tenant_id: v["tenantId"].as_str().unwrap().parse().unwrap(),
        envelope_id: v["envelopeId"].as_str().unwrap().parse().unwrap(),
        document_id: v["documentId"].as_str().unwrap().parse().unwrap(),
        policy_sha256: v["policySha256"].as_str().unwrap().into(),
        trust_bundle_sha256: v["trustBundleSha256"].as_str().unwrap().into(),
    }
}
fn client(origin: &str, ca: &[u8]) -> Result<ValidatorClient, WireError> {
    let v = vector("preflight");
    ValidatorClient::new(
        origin,
        ca,
        ServiceKey::new(
            "test",
            &STANDARD.decode(v["keyBase64"].as_str().unwrap()).unwrap(),
        )
        .unwrap(),
        ApprovedTrust::new(ROOTS, b"").unwrap(),
    )
}
struct Server {
    process: Child,
    origin: String,
}
impl Server {
    fn start(mode: &str) -> Self {
        let python = std::env::var("ERP_CONTRACT_TEST_PYTHON")
            .unwrap_or_else(|_| if cfg!(windows) { "python" } else { "python3" }.into());
        let process = Command::new(python)
            .args(["-u", &format!("{FIXTURES}/https_fixture.py"), mode])
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        // Own the guard before any startup assertion can panic.
        let mut server = Self {
            process,
            origin: String::new(),
        };
        let mut line = String::new();
        BufReader::new(server.process.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        let port: u16 = line.trim().parse().expect("fixture server started");
        server.origin = format!("https://127.0.0.1:{port}");
        server
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.process.kill();
        let _ = self.process.wait();
    }
}

#[test]
fn origin_and_explicit_ca_are_required() {
    for origin in [
        "http://localhost",
        "https://user:pass@localhost",
        "https://localhost/path",
        "https://localhost?token=x",
        "https://localhost/#fragment",
    ] {
        assert!(client(origin, CA).is_err(), "{origin}");
    }
    assert!(client("https://localhost", b"").is_err());
    assert!(client("https://localhost", b"not a certificate").is_err());
    assert!(client("https://localhost", CA).is_ok());
}
#[tokio::test]
async fn real_tls_round_trips_preflight_and_increment_bound_to_fresh_request() {
    let server = Server::start("ok");
    let c = client(&server.origin, CA).unwrap();
    for operation in ["preflight", "increment"] {
        let v = vector(operation);
        let ctx = context(&v);
        let nonce = ctx.request_id;
        let part = |name: &str| STANDARD.decode(v["parts"][name].as_str().unwrap()).unwrap();
        let base = part("base");
        let parent = if operation == "increment" {
            part("parent")
        } else {
            vec![]
        };
        let candidate = if operation == "increment" {
            part("candidate")
        } else {
            vec![]
        };
        let cpf = PersonalCpf::parse("52998224725").unwrap();
        let prior = PersonalCpf::parse("11144477735").unwrap();
        let input = if operation == "preflight" {
            Input::Preflight { base: &base }
        } else {
            Input::Increment {
                base: &base,
                parent: &parent,
                candidate: &candidate,
                signer: Signer {
                    participant_id: v["signer"]["participantId"]
                        .as_str()
                        .unwrap()
                        .parse()
                        .unwrap(),
                    cpf: &cpf,
                },
                previous_signers: vec![Signer {
                    participant_id: v["previousSigners"][0]["participantId"]
                        .as_str()
                        .unwrap()
                        .parse()
                        .unwrap(),
                    cpf: &prior,
                }],
            }
        };
        let proof = if operation == "preflight" {
            c.preflight(ctx, &base).await.unwrap()
        } else {
            c.validate(ctx, input).await.unwrap()
        };
        assert_eq!(proof.verdict(), Verdict::Accepted);
        assert_eq!(proof.context().request_id, nonce);
        assert!(
            (time::OffsetDateTime::now_utc() - proof.checked_at())
                .whole_seconds()
                .abs()
                < 5
        );
    }
}
#[tokio::test]
async fn tls_redirect_status_headers_mac_and_stream_fail_closed() {
    for mode in [
        "redirect",
        "html",
        "unavailable",
        "wrong_mac",
        "oversize",
        "short",
        "stall",
    ] {
        let server = Server::start(mode);
        let c = client(&server.origin, CA)
            .unwrap()
            .with_deadline(Duration::from_millis(600));
        let v = vector("preflight");
        let base = STANDARD
            .decode(v["parts"]["base"].as_str().unwrap())
            .unwrap();
        let start = std::time::Instant::now();
        assert!(
            c.validate(context(&v), Input::Preflight { base: &base })
                .await
                .is_err(),
            "{mode}"
        );
        assert!(start.elapsed() < Duration::from_secs(3), "{mode}");
        if mode == "oversize" {
            assert!(
                start.elapsed() < Duration::from_millis(350),
                "must reject headers before waiting for body"
            );
        }
        if mode == "stall" {
            assert!(
                start.elapsed() >= Duration::from_millis(400),
                "must actually exercise request deadline"
            );
        }
    }
    let server = Server::start("ok");
    let c = client(&server.origin, ROOTS).unwrap();
    let v = vector("preflight");
    let base = STANDARD
        .decode(v["parts"]["base"].as_str().unwrap())
        .unwrap();
    assert!(
        c.validate(context(&v), Input::Preflight { base: &base })
            .await
            .is_err()
    );
}
