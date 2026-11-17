"""Exercise executable cache integrity in the existing policy job, without Rust builds."""
from pathlib import Path
import hashlib
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[2]


class NativeReleaseCacheTests(unittest.TestCase):
    def test_cache_integrity(self):
        subprocess.run(['node', '--test', 'scripts/ci/native-release-cache.test.mjs'], cwd=ROOT, check=True)

    def test_published_nfse_migration_keeps_its_sqlx_checksum(self):
        source = (ROOT / 'migrations/202611170001_outgoing_nfse.sql').read_bytes().replace(b'\r\n', b'\n')
        self.assertEqual(hashlib.sha384(source).hexdigest(),
                         'a7b9af8edb26817c43bc5223ad4a314bd0b8103ab056574f0283908bbea922cabdf3a0f0e781d1f8ba38ce72b74e35cf',
                         'Published migrations are immutable; new privileges belong in the additive migration')


if __name__ == '__main__':
    unittest.main()
