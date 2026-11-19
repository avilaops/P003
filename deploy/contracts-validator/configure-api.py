"""Apply only the private signer integration to the candidate ERP release's generated Compose JSON."""
import argparse
import json
import os
from pathlib import Path
import re
import tempfile

ROOT = Path('/etc/erp-next/contract-signatures')


def configure(data, source):
    services = data['services']
    app = services['api']
    env = provider = app['environment']
    if not isinstance(env, dict):
        raise ValueError('unexpected_erp_service_layout')
    if provider.get('DOCUSEAL_URL', '').rstrip('/') != 'https://contrato.avilaops.com' or not provider.get('DOCUSEAL_API_TOKEN'):
        raise ValueError('confirmed_docuseal_integration_required')
    prefix = '/run/secrets/contract-signatures'
    public = '/etc/contract-validation'
    env.update({
        'ERP_CONTRACT_VALIDATOR_URL': 'https://contract-signature-gateway:8443',
        'ERP_CONTRACT_VALIDATOR_KEY_ID': 'gateway-1',
        'ERP_CONTRACT_VALIDATOR_KEYRING_FILE': prefix + '/hmac.json',
        'ERP_CONTRACT_VALIDATOR_TLS_CA_FILE': prefix + '/tls-ca.pem',
        'ERP_CONTRACT_VALIDATOR_ROOTS_FILE': public + '/roots.pem',
        'ERP_CONTRACT_VALIDATOR_INTERMEDIATES_FILE': public + '/intermediates.pem',
        'ERP_CONTRACT_IDENTITY_KEYRING_FILE': prefix + '/identity.json',
        'DOCUSEAL_URL': 'https://contrato.avilaops.com',
        'DOCUSEAL_API_TOKEN': provider['DOCUSEAL_API_TOKEN'],
    })
    mounts = app.setdefault('volumes', [])
    # Retain every unrelated bind. Older immutable trust files remain on the host for rollback.
    def target(mount):
        if isinstance(mount, dict):
            return mount.get('target')
        pieces = mount.split(':')
        return pieces[1] if len(pieces) > 1 else pieces[0]
    mounts[:] = [m for m in mounts if target(m) not in (prefix, public)]
    for src, dst in ((ROOT/'client', prefix), (ROOT/'releases'/source/'public', public)):
        mounts.append({'type': 'bind', 'source': str(src), 'target': dst, 'read_only': True,
                       'bind': {'create_host_path': False}})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('candidate', type=Path)
    parser.add_argument('source')
    parser.add_argument('--previous', type=Path)
    args = parser.parse_args()
    if not re.fullmatch(r'[0-9a-f]{40}', args.source):
        raise SystemExit('expected reviewed commit SHA')
    path = args.candidate
    if path.is_symlink() or not path.is_file() or path.stat().st_uid != 0:
        raise SystemExit('expected root-owned candidate compose JSON')
    source = args.source
    if not (ROOT/'releases'/source/'public'/'roots.pem').is_file() and args.previous:
        previous = args.previous
        if previous.is_symlink() or not previous.is_file() or previous.stat().st_uid != 0:
            raise SystemExit('expected previous root-owned compose JSON')
        services = json.loads(previous.read_bytes())['services']
        # A release anterior ao PR 02 ainda tinha o serviço privado `api-ts` ao lado do Rust.
        service = services.get('api-ts', services['api'])
        mounts = [m for m in service.get('volumes',[]) if isinstance(m,dict)
                  and m.get('target') == '/etc/contract-validation' and m.get('type') == 'bind' and m.get('read_only') is True]
        if len(mounts) != 1:
            raise SystemExit('stage the new validator before first activation')
        match = re.fullmatch(re.escape(str(ROOT/'releases')) + r'/([0-9a-f]{40})/public', mounts[0].get('source',''))
        if not match:
            raise SystemExit('unexpected prior trust mount')
        source = match[1]
    for p in (ROOT/'client'/'identity.json', ROOT/'releases'/source/'public'/'roots.pem'):
        if not p.is_file() or p.is_symlink():
            raise SystemExit('stage the dedicated files and release trust snapshot first')
    data = json.loads(path.read_bytes())
    configure(data, source)
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as out:
        json.dump(data, out, indent=2)
        out.write('\n')
        out.flush()
        os.fsync(out.fileno())
    os.replace(out.name, path)


if __name__ == '__main__':
    main()
