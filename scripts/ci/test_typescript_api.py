"""TypeScript changes must be checked before merging, including quick PR validation."""
from pathlib import Path
import unittest
import yaml

ROOT = Path(__file__).resolve().parents[2]


class TypeScriptApiGateTests(unittest.TestCase):
    def test_api_contract_verification_is_not_limited_to_full_releases(self):
        workflow = yaml.safe_load((ROOT / '.github/workflows/_validate-api.yml').read_text())
        steps = workflow['jobs']['api']['steps']
        checks = [step for step in steps if 'pnpm --filter api-ts test:contracts' in step.get('run', '')]
        self.assertEqual(len(checks), 1)
        check = checks[0]
        self.assertNotIn('if', check, 'PR validation must exercise the API being migrated')
        self.assertIn('API_TS_TEST_ADMIN_URL', check['env'], 'PostgreSQL verification must not silently skip')
        for command in ('api-ts typecheck', 'api-ts test', 'api-ts test:contracts'):
            self.assertIn(command, check['run'])
        for tool in ('pnpm/action-setup@', 'actions/setup-node@'):
            setup = next(step for step in steps if step.get('uses', '').startswith(tool))
            self.assertNotIn('if', setup)


if __name__ == '__main__':
    unittest.main()
