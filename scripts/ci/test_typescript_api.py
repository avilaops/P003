"""TypeScript changes must be checked before merging, including quick PR validation."""
from pathlib import Path
import unittest
import yaml

ROOT = Path(__file__).resolve().parents[2]


class TypeScriptApiGateTests(unittest.TestCase):
    def test_typescript_checks_always_run_and_native_comparison_respects_scope(self):
        workflow = yaml.safe_load((ROOT / '.github/workflows/_validate-api.yml').read_text())
        steps = workflow['jobs']['api']['steps']
        checks = [step for step in steps if 'pnpm --filter api-ts test:contracts' in step.get('run', '')]
        self.assertEqual(len(checks), 1)
        check = checks[0]
        self.assertEqual(check['if'], '!inputs.typescript_only || inputs.full || inputs.publish')
        self.assertIn('API_TS_TEST_ADMIN_URL', check['env'], 'PostgreSQL verification must not silently skip')
        basic = next(step for step in steps if 'api-ts typecheck' in step.get('run', ''))
        self.assertNotIn('if', basic)
        self.assertIn('api-ts test', basic['run'])
        self.assertIn('API_TS_TEST_ADMIN_URL', basic['env'])
        for step in steps:
            if step.get('uses', '').startswith(('dtolnay/rust-toolchain@', 'Swatinem/rust-cache@')) or 'cargo fmt --all --check' in step.get('run', '') or 'cargo test --locked --workspace' in step.get('run', ''):
                self.assertEqual(step['if'], "steps.native_cache.outputs.reuse != 'true' && (!inputs.typescript_only || inputs.full || inputs.publish)")
        for tool in ('pnpm/action-setup@', 'actions/setup-node@'):
            setup = next(step for step in steps if step.get('uses', '').startswith(tool))
            self.assertNotIn('if', setup)

    def test_native_reuse_keeps_protocol_gate_and_is_limited_to_trusted_releases(self):
        workflow = yaml.safe_load((ROOT / '.github/workflows/_validate-api.yml').read_text())
        steps = workflow['jobs']['api']['steps']
        key = next(step for step in steps if step.get('id') == 'native_key')
        self.assertEqual(key['if'], 'inputs.publish && inputs.full')
        for required in ('apps/api/**', '**/*.rs', '**/Cargo.toml', '**/Cargo.lock', '.cargo/**', 'migrations/**', 'queries/**', 'apps/contract-signature-validator/**', 'deploy/**', '.github/workflows/**', 'scripts/ci/**', 'scripts/contracts/**'):
            self.assertIn(required, key['env']['NATIVE_INPUT_HASH'])
        for step in steps:
            if step.get('uses', '').startswith('actions/cache/'):
                self.assertIn('steps.native_key.outputs.prefix', step['if'])
                self.assertEqual(step['with']['path'], 'artifacts/native-release-cache')
        protocol = next(step for step in steps if 'api-ts test:contracts' in step.get('run', ''))
        self.assertNotIn('reuse', protocol['if'])
        self.assertIn('steps.native_cache.outputs.reference', protocol['env']['API_TS_TEST_RUST_BINARY'])
        self.assertIn('steps.native_cache.outputs.gateway', protocol['env']['API_TS_TEST_GATEWAY_BINARY'])
        save = next(step for step in steps if step.get('uses', '').startswith('actions/cache/save@'))
        image = next(step for step in steps if step.get('id') == 'image')
        self.assertGreater(steps.index(save), steps.index(image))
        self.assertGreater(steps.index(save), steps.index(protocol))
        for step in steps:
            if step.get('id') == 'native_cache' or 'native-release-cache.mjs save' in step.get('run', ''):
                self.assertEqual(step['env']['NATIVE_INPUT_HASH'], '${{ steps.native_key.outputs.input_hash }}')


if __name__ == '__main__':
    unittest.main()
