"""Validate the principal TypeScript API stack using Compose's actual config parser."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
COMMAND = [os.environ['ERP_TEST_COMPOSE_BINARY']] if os.environ.get('ERP_TEST_COMPOSE_BINARY') else ['docker', 'compose']


class TypeScriptComposeTests(unittest.TestCase):
    def test_api_is_the_typescript_image_with_a_restricted_private_environment(self):
        if not shutil.which(COMMAND[0]):
            self.skipTest('Compose CLI is unavailable; no container is required')
        version = subprocess.run([*COMMAND, 'version'], capture_output=True, timeout=15)
        if version.returncode:
            self.skipTest('Compose CLI plugin is unavailable')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'web.env').write_text('SMTP_PASSWORD=mail-fixture\nERP_SESSION_SECRET=session-fixture\n')
            (root / 'api-ts.env').write_text('DATABASE_URL=postgresql://app:fixture@db/test\nAUTH_ISSUER=https://auth.test\n')
            values = {'ERP_API_IMAGE': 'ghcr.io/avilaops/erp-next-api@sha256:' + 'a' * 64,
                      'ERP_WEB_IMAGE': 'ghcr.io/avilaops/erp-next-web@sha256:' + 'b' * 64,
                      'ERP_RELEASE_SHA': 'c' * 40}
            envfile = root / 'release.env'
            envfile.write_text('\n'.join(key + '=' + value for key, value in values.items()))
            command = [*COMMAND, '--project-directory', str(root), '--env-file', str(envfile),
                       '--file', str(ROOT / 'deploy/compose.yaml'), 'config', '--format', 'json']
            result = subprocess.run(command, capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)
            config = json.loads(result.stdout)
            services = config['services']
            self.assertNotIn('api-ts', services)
            api = services['api']
            self.assertEqual(api['image'], values['ERP_API_IMAGE'])
            self.assertEqual(api['environment']['API_TS_HOST'], '0.0.0.0')
            self.assertEqual(api['environment']['API_TS_PORT'], '8080')
            self.assertEqual(api['environment']['DATABASE_URL'], 'postgresql://app:fixture@db/test')
            self.assertNotIn('SMTP_PASSWORD', api['environment'])
            self.assertNotIn('ERP_SESSION_SECRET', api['environment'])
            self.assertEqual({(p['host_ip'], p['published'], p['target']) for p in api['ports']},
                             {('127.0.0.1', '3141', 8080), ('127.0.0.1', '3140', 3000)})
            self.assertEqual(services['web']['image'], values['ERP_WEB_IMAGE'])
            self.assertEqual(services['web']['environment']['ERP_API_URL'], 'http://127.0.0.1:8080')
            self.assertEqual(services['web']['environment']['ERP_TYPESCRIPT_API_URL'], 'http://127.0.0.1:8080')

if __name__ == '__main__':
    unittest.main()
