"""Create dedicated validator transport and identity keys on the Linux host, once."""
import base64
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile


def write(path, data, uid):
    path.write_bytes(data)
    os.chmod(path, 0o400)
    os.chown(path, uid, uid)


def certificate(*args):
    subprocess.run(['openssl', *map(str, args)], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def prepare():
    if os.geteuid() != 0:
        raise SystemExit('root required')
    parent = Path('/etc/erp-next')
    dest = parent / 'contract-signatures'
    if parent.is_symlink() or parent.stat().st_uid != 0 or parent.stat().st_mode & 0o077:
        raise SystemExit('private ERP configuration directory required')
    if dest.exists() or dest.is_symlink():
        raise SystemExit('dedicated key directory already exists; preserve existing keys')
    os.umask(0o077)
    tmp = Path(tempfile.mkdtemp(prefix='.contract-signatures-', dir=parent))
    try:
        issuer, gateway, client = (tmp / name for name in ('issuer', 'gateway', 'client'))
        for directory in (issuer, gateway, client):
            directory.mkdir(mode=0o700)
        certificate('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
                    '-keyout', issuer/'ca.key', '-out', issuer/'ca.pem', '-days', '3650', '-sha256',
                    '-subj', '/CN=Avila private contract validation transport',
                    '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0',
                    '-addext', 'keyUsage=critical,keyCertSign,cRLSign')
        certificate('req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
                    '-keyout', gateway/'tls-key.pem', '-out', issuer/'gateway.csr',
                    '-subj', '/CN=contract-signature-gateway')
        extensions = issuer/'gateway.ext'
        extensions.write_text('basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n'
                              'extendedKeyUsage=serverAuth\nsubjectAltName=DNS:contract-signature-gateway\n')
        certificate('x509', '-req', '-in', issuer/'gateway.csr', '-CA', issuer/'ca.pem', '-CAkey', issuer/'ca.key',
                    '-CAcreateserial', '-days', '365', '-sha256', '-extfile', extensions, '-out', gateway/'tls.pem')
        certificate('verify', '-CAfile', issuer/'ca.pem', '-purpose', 'sslserver', '-verify_hostname',
                    'contract-signature-gateway', gateway/'tls.pem')
        encode = lambda: base64.b64encode(secrets.token_bytes(32)).decode('ascii')
        transport = json.dumps({'schemaVersion': 'avila-validator-keys/1', 'keys': {'gateway-1': encode()}}).encode()
        write(gateway/'hmac.json', transport, 10001)
        write(client/'hmac.json', transport, 1000)
        write(client/'identity.json', json.dumps({'active': 'identity-1', 'keys': {'identity-1': encode()}}).encode(), 1000)
        write(client/'tls-ca.pem', (issuer/'ca.pem').read_bytes(), 1000)
        for file in gateway.iterdir():
            os.chown(file, 10001, 10001)
            file.chmod(0o400)
        for directory, uid in ((gateway,10001), (client,1000)):
            os.chown(directory, uid, uid)
            directory.chmod(0o500)
        # rename fails if another invocation has already populated this directory.
        tmp.rename(dest)
    finally:
        if tmp.exists():
            shutil.rmtree(tmp)
    print('Dedicated files prepared; TLS name and issuer verified.')


if __name__ == '__main__':
    prepare()
