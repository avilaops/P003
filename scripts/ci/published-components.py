#!/usr/bin/env python3
"""Recover the immutable application contract and image digests of the published platform."""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
PUBLISHED = ROOT / "scripts/contracts/published"
MCP = ("apps/fiscal-mcp", ".dockerignore")


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True).strip()


def _baseline(manifest):
    baseline = manifest["source"]
    if not re.fullmatch(r"[0-9a-f]{40}", baseline):
        raise ValueError("Invalid published source")
    return baseline


def compatible(manifest, target):
    """The Rust API is no longer built; only the append-only SQL history must stay compatible.

    The published native server reads the database without migrating on startup. Only the
    TypeScript migrator applies new files, so existing SQLx history must remain byte-identical.
    """
    baseline = _baseline(manifest)
    return not git("diff", "--name-only", "--no-renames", "--diff-filter=DMRTUXB", baseline, target, "--", "migrations")


def mcp_unchanged(manifest, target):
    """The published fiscal MCP image can be reused only while its sources are untouched."""
    return not git("diff", "--name-only", _baseline(manifest), target, "--", *MCP)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["select", "restore"])
    parser.add_argument("--target", default="HEAD")
    parser.add_argument("--require", action="store_true")
    args = parser.parse_args()
    manifest = json.loads((PUBLISHED / "manifest.json").read_text())
    target = git("rev-parse", "--verify", args.target + "^{commit}")
    accepted = compatible(manifest, target)
    if not accepted and (args.command == "restore" or args.require):
        raise ValueError("Published SQL migration history differs from this checkout")
    outputs = {"typescript_only": str(accepted).lower(), "reuse_mcp": str(accepted and mcp_unchanged(manifest, target)).lower()}
    if set(manifest["images"]) != {"api", "fiscal-mcp"}:
        raise ValueError("Missing or unexpected published image component")
    for key, digest in manifest["images"].items():
        if key not in ("api", "fiscal-mcp") or not re.fullmatch(r"sha256:[a-f0-9]{64}", digest):
            raise ValueError("Invalid published image digest")
        outputs[key.replace("-", "_")] = digest
    if args.command == "restore":
        target_dir = ROOT / "artifacts/contracts"
        target_dir.mkdir(parents=True, exist_ok=True)
        for name in ("candidate.json", "company.json"):
            data = gzip.decompress((PUBLISHED / (name + ".gz")).read_bytes())
            if hashlib.sha256(data).hexdigest() != manifest["files"][name]:
                raise ValueError(f"Published {name} checksum mismatch")
            (target_dir / name).write_bytes(data)
        (target_dir / "published-source.json").write_text(json.dumps(manifest, indent=2) + "\n")
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
            for key, value in outputs.items():
                print(f"{key}={value}", file=output)
    print(json.dumps(outputs))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
