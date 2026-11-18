"""Install an immutable validator release and optionally start it, on applications."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile
import time

ROOT = Path('/etc/erp-next/contract-signatures')
FILES = {'release.json','compose.yml','erp-network.yml','seccomp.json','public/roots.pem',
         'public/intermediates.pem','public/evidence-origins.json','smoke.py','route-portal.py','configure-api.py'}


LEGACY_SHA = '47b8805d384d21b8ce656d19d270d4aae775dc61'
LEGACY_IMAGE = ('ghcr.io/avilaops/erp-next-contract-validator@'
                'sha256:8752ac2dff496a68d87293f4359168023dcfeb61393301571c75a2438c3842a4')


def reference(directory):
    data = json.loads((directory/'release.json').read_bytes())
    image = data['image']
    if data['sourceSha'] != directory.name:
        raise ValueError('invalid release identity')
    if directory.name == LEGACY_SHA and image == LEGACY_IMAGE:
        return image
    if not re.fullmatch(r'ghcr\.io/avilaops/erp-next-contract-validator-private@sha256:[a-f0-9]{64}', image):
        raise ValueError('invalid image origin')
    return image


def compose(directory,*args):
    env = {**os.environ,'VALIDATOR_IMAGE':reference(directory),'VALIDATOR_SECRETS':str(ROOT/'gateway'),
           'VALIDATOR_PUBLIC_CONFIG':str(directory/'public')}
    subprocess.run(['docker','compose','--project-name','avilaops-erp-contracts-validator','-f','compose.yml',
                    '-f','erp-network.yml',*args],cwd=directory,env=env,check=True)


def stage(directory):
    directory.parent.mkdir(mode=0o700,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.incoming-',dir=directory.parent) as tmp:
        incoming = Path(tmp)/directory.name
        (incoming/'public').mkdir(parents=True)
        found, total = set(), 0
        with tarfile.open(fileobj=sys.stdin.buffer,mode='r|gz') as tar:
            for item in tar:
                total += item.size
                if item.name not in FILES or item.name in found or not item.isfile() or not 0 < item.size <= 4*1024*1024 or total>8*1024*1024:
                    raise ValueError('unexpected release entry')
                found.add(item.name)
                path = incoming/item.name
                path.write_bytes(tar.extractfile(item).read())
                path.chmod(0o444)
        if found != FILES:
            raise ValueError('incomplete release')
        (incoming/'public').chmod(0o555)
        reference(incoming)
        compose(incoming,'config','--quiet')
        if directory.exists():
            if any((directory/name).read_bytes() != (incoming/name).read_bytes() for name in FILES):
                raise ValueError('release sha already staged with different bytes')
        else:
            incoming.rename(directory)
    print('Immutable validator release staged.')


def smoke(directory):
    args = ['docker','run','--rm','--network','erp-next_erp','--user','1000:1000','--read-only','--cap-drop','ALL',
            '--security-opt','no-new-privileges:true','--pids-limit','32','--memory','256m','--cpus','1']
    for source,target in ((ROOT/'client'/'tls-ca.pem','/probe/tls-ca.pem'), (ROOT/'client'/'hmac.json','/probe/hmac.json'),
                          (directory/'public','/config/public'), (directory/'smoke.py','/probe/smoke.py')):
        args.extend(['--mount',f'type=bind,src={source},dst={target},readonly'])
    args.extend(['--entrypoint','/opt/validator/bin/python',reference(directory),'-I','/probe/smoke.py'])
    subprocess.run(args,check=True,timeout=65)


def start(directory):
    pointer = ROOT/'active-validator'
    previous = pointer.read_text().strip() if pointer.exists() else None
    if previous and not re.fullmatch(r'[0-9a-f]{40}',previous):
        raise ValueError('invalid previous validator release')
    compose(directory,'pull')
    try:
        compose(directory,'up','--detach','--no-build')
        for attempt in range(5):
            try:
                smoke(directory)
                break
            except subprocess.CalledProcessError:
                if attempt == 4:
                    raise
                time.sleep(2)
    except BaseException:
        if previous and previous != directory.name:
            compose(directory.parent/previous,'up','--detach','--no-build')
        elif not previous:
            compose(directory,'down')
        raise
    with tempfile.NamedTemporaryFile('w',dir=ROOT,delete=False) as output:
        output.write(directory.name+'\n')
    os.replace(output.name,pointer)


if __name__ == '__main__':
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument('operation',choices=('stage','start','smoke'))
    cli.add_argument('source')
    args = cli.parse_args()
    if os.geteuid() != 0 or not re.fullmatch(r'[0-9a-f]{40}',args.source):
        raise SystemExit('expected root and exact SHA')
    import fcntl
    with (ROOT/'.validator-release.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        location = ROOT/'releases'/args.source
        {'stage':stage,'start':start,'smoke':smoke}[args.operation](location)
