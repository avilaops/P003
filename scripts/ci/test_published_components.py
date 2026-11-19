import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("published", Path(__file__).with_name("published-components.py"))
published = importlib.util.module_from_spec(spec)
spec.loader.exec_module(published)


class PublishedComponentsTests(unittest.TestCase):
    manifest = json.loads((published.PUBLISHED / "manifest.json").read_text())

    def test_contract_files_match_attested_bytes_and_have_synthetic_company_data(self):
        for name in ("candidate.json", "company.json"):
            data = gzip.decompress((published.PUBLISHED / (name + ".gz")).read_bytes())
            self.assertEqual(hashlib.sha256(data).hexdigest(), self.manifest["files"][name])
            self.assertTrue(json.loads(data).get("openapi") if name == "candidate.json" else json.loads(data)["synthetic"])

    def test_reuse_requires_only_append_only_sql_history_and_ignores_rust_sources(self):
        with patch.object(published, "git", side_effect=[""]) as git:
            self.assertTrue(published.compatible(self.manifest, "HEAD"))
            (migrations,) = [call.args for call in git.call_args_list]
            self.assertIn("--no-renames", migrations)
            self.assertIn("--diff-filter=DMRTUXB", migrations)
            self.assertIn("migrations", migrations)
            for path in ("apps/api", "queries", "Cargo.lock"):
                self.assertNotIn(path, migrations, "the Rust API is no longer built, so its sources cannot invalidate reuse")
        with patch.object(published, "git", side_effect=["migrations/old.sql"]):
            self.assertFalse(published.compatible(self.manifest, "HEAD"))

    def test_fiscal_mcp_reuse_depends_only_on_its_own_sources(self):
        with patch.object(published, "git", side_effect=[""]) as git:
            self.assertTrue(published.mcp_unchanged(self.manifest, "HEAD"))
            (inputs,) = [call.args for call in git.call_args_list]
            self.assertIn("apps/fiscal-mcp", inputs)
            self.assertNotIn("apps/api", inputs)
        with patch.object(published, "git", side_effect=["apps/fiscal-mcp/src/index.ts"]):
            self.assertFalse(published.mcp_unchanged(self.manifest, "HEAD"))
