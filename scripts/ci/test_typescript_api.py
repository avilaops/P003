"""TypeScript changes must be checked before merging; no workflow compiles or runs the Rust API."""
from pathlib import Path
import unittest
import yaml

ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / '.github/workflows'


def jobs(name):
    return yaml.safe_load((WORKFLOWS / name).read_text())['jobs']


class TypeScriptApiGateTests(unittest.TestCase):
    def test_no_workflow_compiles_or_runs_the_rust_api(self):
        for path in sorted(WORKFLOWS.glob('*.yml')):
            text = path.read_text()
            for forbidden in ('cargo ', 'dtolnay/rust-toolchain', 'Swatinem/rust-cache', 'native-release-cache',
                              'test:contracts', 'typescript_only', 'force_native_rebuild'):
                self.assertNotIn(forbidden, text, f'{path.name} still references {forbidden}')

    def test_typescript_checks_always_run_against_postgresql(self):
        steps = jobs('_validate-api.yml')['api']['steps']
        basic = next(step for step in steps if 'api-ts typecheck' in step.get('run', ''))
        self.assertNotIn('if', basic)
        self.assertIn('api-ts test', basic['run'])
        self.assertIn('API_TS_TEST_ADMIN_URL', basic['env'], 'PostgreSQL verification must not silently skip')
        migrate = next(s for s in steps if 'node apps/api-ts/dist/migrate.js migrations' in s.get('run', ''))
        self.assertNotIn('if', migrate)
        restore = next(s for s in steps if s.get('id') == 'published')
        self.assertNotIn('if', restore)
        self.assertIn('published-components.py restore', restore['run'])
        for tool in ('pnpm/action-setup@', 'actions/setup-node@'):
            setup = next(step for step in steps if step.get('uses', '').startswith(tool))
            self.assertNotIn('if', setup)

    def test_release_runs_the_published_images_and_keeps_environment_approval(self):
        api = jobs('_validate-api.yml')['api']['steps']
        self.assertTrue(any('health/ready' in s.get('run', '') and 'steps.published.outputs.api' in s.get('env', {}).get('API_DIGEST', '') for s in api))
        project = jobs('_validate-project.yml')
        for job in ('baseline', 'contracts'):
            self.assertNotIn(job, project, f'{job} captured a baseline by compiling Rust')
        fiscal = jobs('_validate-fiscal.yml')['fiscal-mcp']['steps']
        self.assertTrue(any('docker pull "$reference"' in s.get('run', '') and 'inputs.reuse_mcp_digest' in s.get('if', '') for s in fiscal))
        self.assertTrue(any('scripts/smoke_runtime.py' in s.get('run', '') and s.get('if') == 'inputs.full' for s in fiscal))
        release = jobs('release.yml')
        self.assertEqual(release['deploy']['environment'], 'production')
        self.assertIn('evidence', release['deploy']['needs'])
        self.assertNotIn('if', release['deploy'])
        select = release['select']['steps']
        self.assertTrue(any('published-components.py select --require' in s.get('run', '') for s in select))


if __name__ == '__main__':
    unittest.main()
