#!/usr/bin/env python3
"""Plan bounded PR checks and attest their exact outcomes; fail closed."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

DOMAINS = ("web", "api", "fiscal")
def signature_path(path):
    return path.startswith(('apps/contract-signature-validator/', 'apps/contract-signature-service/',
                            'deploy/contracts-validator/')) or path in (
        'scripts/contracts/verify-signature-validator.py', 'scripts/contracts/verify-signature-service.py',
        'scripts/contracts/validator-release.py')


def plan(paths):
    scope = dict.fromkeys(DOMAINS, False)
    for path in paths:
        if signature_path(path):
            # The mandatory shared project job verifies this independent Python core.
            continue
        if path.startswith(("docs/", "context/")) or ("/" not in path and path.endswith(".md")):
            continue
        if path.startswith(("apps/web/", "packages/")):
            scope["web"] = True
        elif path.startswith(("apps/api/", "apps/api-ts/", "migrations/", "queries/")) or path in (
            "Cargo.toml", "Cargo.lock", "rust-toolchain.toml"
        ):
            scope["api"] = True
        elif path.startswith(("apps/fiscal-engine/", "apps/fiscal-mcp/", "scripts/fiscal/", "integrations/fiscal/")):
            scope["fiscal"] = True
        else:
            # Unknown/new infrastructure must not silently bypass validation.
            scope = dict.fromkeys(DOMAINS, True)
    return scope


def native_api_required(paths):
    # SQL migrations are applied and checked by the TypeScript image. Changes to
    # native tooling, native queries or unknown build inputs retain the native gate.
    typescript_paths = ("apps/api-ts/", "apps/web/", "apps/fiscal-engine/", "apps/fiscal-mcp/",
                        "migrations/", "docs/", "architecture/", "packages/", "scripts/fiscal/",
                        "scripts/deploy/", "scripts/contracts/published/")
    platform_files = {
        "pnpm-lock.yaml", "pnpm-workspace.yaml", "package.json", "deploy/web.Dockerfile", "deploy/CI-CD.md", "deploy/README.md",
        "deploy/migrate-release.py", "deploy/release-retention.py", "deploy/production-deploy.sh", "deploy/compose.yaml",
        "deploy/fiscal-compose.yaml", "deploy/api-ts.env.example", "scripts/ci/pr-gate.py",
        "scripts/architecture/report-model.test.mjs",
        "verification/contracts.json", "verification/discovery.mjs",
        "verification/test/contracts.test.mjs", "verification/test/product-context.test.mjs",
        "scripts/ci/published-components.py", "scripts/ci/test_pr_gate.py", "scripts/ci/test_workflows.py",
        "scripts/ci/test_typescript_api.py", "scripts/ci/test_published_components.py",
        ".github/workflows/ci.yml", ".github/workflows/_validate-project.yml",
        ".github/workflows/_validate-api.yml", ".github/workflows/_validate-fiscal.yml", ".github/workflows/_validate-web.yml",
        ".github/workflows/release.yml", ".github/workflows/regression.yml",
    }
    for path in paths:
        if path == "apps/api-ts/scripts/contract-tests.mjs":
            return True
        # The project gate executes the source catalogue, scanners and their tests.
        # The suite runners can invoke the native toolchain and retain its validation.
        if (path.startswith(("verification/", "scripts/verification/"))
                and path.endswith((".md", ".json", ".mjs", ".ts", ".py"))
                and path not in ("verification/suites.mjs", "verification/run.mjs")):
            continue
        if path.startswith(typescript_paths) or path in platform_files:
            continue
        if plan([path])["api"]:
            return True
    return False


def signature_check_required(paths, *, full=False):
    paths = tuple(paths)
    return full or any(signature_path(path) for path in paths) or all(plan(paths).values())


def changed_paths():
    base = os.environ.get('BASE_SHA') or subprocess.check_output(
        ['git', 'rev-parse', 'HEAD^'], text=True).strip()
    if not re.fullmatch(r'[a-f0-9]{40}', base):
        raise ValueError('Invalid comparison base SHA')
    return [path for path in subprocess.check_output([
        'git', 'diff', '--name-only', '--no-renames', '-z', base, 'HEAD'
    ]).decode().split('\0') if path]


def verdict(jobs):
    if not isinstance(jobs, dict) or set(jobs) != {"changes", *DOMAINS}:
        raise ValueError("Missing or unexpected validation jobs")
    changes = jobs["changes"]
    outputs = changes.get("outputs", {})
    if set(outputs) != set(DOMAINS) or any(value not in ("true", "false") for value in outputs.values()):
        raise ValueError("Missing or invalid scope")
    scope = {key: outputs[key] == "true" for key in DOMAINS}
    outcomes = {key: value["result"] for key, value in jobs.items()}
    passed = changes["result"] == "success" and all(
        outcomes[key] == ("success" if scope[key] else "skipped") for key in DOMAINS
    )
    return passed, scope, outcomes


def attest(jobs, env):
    passed, scope, outcomes = verdict(jobs)
    for key in ("SOURCE_HEAD_SHA", "GITHUB_SHA"):
        if not re.fullmatch(r"[a-f0-9]{40}", env[key]):
            raise ValueError(f"Invalid {key}")
    data = {
        "schema": "avila-mlops-ci-attestation/2",
        "repository": env["GITHUB_REPOSITORY"],
        "sourceSha": env["SOURCE_HEAD_SHA"],
        "testedSha": env["GITHUB_SHA"],
        "workflow": env["GITHUB_WORKFLOW"],
        "event": env["GITHUB_EVENT_NAME"],
        "runId": int(env["GITHUB_RUN_ID"]),
        "runAttempt": int(env["GITHUB_RUN_ATTEMPT"]),
        "ciGate": "passed" if passed else "failed",
        "validationScope": scope,
        "validationJobs": outcomes,
        "note": "Scoped PR checks only; skipped domains were not tested. No production or full regression attestation.",
    }
    data["evidenceSha256"] = hashlib.sha256(json.dumps(data, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return data


def main():
    if sys.argv[1] == "plan":
        paths = changed_paths()
        scope = plan(paths)
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
            for domain, selected in scope.items():
                output.write(f"{domain}={str(selected).lower()}\n")
            output.write(f"native_api={str(native_api_required(paths)).lower()}\n")
        print(json.dumps(scope, sort_keys=True))
    elif sys.argv[1] == 'signatures':
        full = os.environ.get('VALIDATE_FULL', 'false')
        if full not in ('true', 'false'):
            raise ValueError('Invalid full validation flag')
        required = signature_check_required(() if full == 'true' else changed_paths(), full=full == 'true')
        with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as output:
            output.write(f'required={str(required).lower()}\n')
        print(json.dumps({'signatureCoreRequired': required}))
    elif sys.argv[1] == "gate":
        data = attest(json.loads(os.environ["VALIDATION_JOBS"]), os.environ)
        target = Path(sys.argv[2])
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        print(data["ciGate"], json.dumps(data["validationJobs"], sort_keys=True))
        return 0 if data["ciGate"] == "passed" else 1
    else:
        raise ValueError("Expected plan, signatures or gate")
    return 0


if __name__ == "__main__":
    sys.exit(main())
