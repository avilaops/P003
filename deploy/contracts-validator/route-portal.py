"""Validate or switch only /icp/* within the existing DocuSeal virtual host."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

HOST = 'contrato.avilaops.com'
CURRENT = b'  reverse_proxy 127.0.0.1:3111\n'
FORWARD = (b'  handle /icp/* {\n'
           b'    reverse_proxy 127.0.0.1:3140 {\n'
           b'      header_up Host contrato.avilaops.com\n'
           b'    }\n'
           b'  }\n'
           b'  handle {\n'
           b'    reverse_proxy 127.0.0.1:3111\n'
           b'  }\n')


def patch(original, rollback=False):
    start = HOST.encode() + b' {\n'
    if original.count(start) != 1:
        raise ValueError('expected one DocuSeal virtual host')
    before, _, tail = original.partition(start)
    region, end, after = tail.partition(b'\n}\n')
    if not end:
        raise ValueError('unrecognized DocuSeal virtual host')
    old, new = (FORWARD, CURRENT) if rollback else (CURRENT, FORWARD)
    if FORWARD in region and not rollback or FORWARD not in region and rollback and CURRENT in region:
        return original
    if region.count(old) != 1 or b'/icp/' in region.replace(old, b''):
        raise ValueError('unexpected DocuSeal route; review the origin configuration')
    return before + start + region.replace(old, new, 1) + end + after


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=('check','activate','rollback'))
    parser.add_argument('--source')
    args = parser.parse_args()
    if args.operation == 'activate':
        active = json.loads(Path('/mnt/HC_Volume_106542212/erp-next/deployment-state.json').read_bytes())['active']
        if not re.fullmatch('[0-9a-f]{40}', args.source or '') or active != args.source:
            raise SystemExit('ERP has not activated the selected SHA')
    path = Path('/etc/caddy/Caddyfile')
    if path.is_symlink() or not path.is_file() or path.stat().st_uid != 0:
        raise SystemExit('expected root-owned Caddyfile')
    original = path.read_bytes()
    updated = patch(original, args.operation == 'rollback')
    if updated == original and args.operation != 'check':
        print('Requested route already configured.')
        return
    with tempfile.TemporaryDirectory(prefix='.erp-icp-',dir=path.parent) as directory:
        staged = tempfile.NamedTemporaryFile(prefix='.erp-icp-', suffix='.tmp', dir=path.parent, delete=False)
        tmp = Path(staged.name)
        with staged:
            staged.write(updated)
        os.chown(tmp, path.stat().st_uid, path.stat().st_gid)
        os.chmod(tmp, path.stat().st_mode & 0o777)
        # Preserve the location for relative Caddy imports when adapting the candidate.
        try:
            subprocess.run(['caddy','validate','--adapter','caddyfile','--config',str(tmp)],check=True,
                           cwd=path.parent, stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        finally:
            # All further operations can use the same validated bytes from the private staging directory.
            tmp.replace(Path(directory)/'validated')
        tmp = Path(directory)/'validated'
        if args.operation != 'check':
            if path.read_bytes() != original:
                raise SystemExit('Caddy configuration changed during review')
            backup = Path(directory)/'previous'
            backup.write_bytes(original)
            os.chown(backup,path.stat().st_uid,path.stat().st_gid)
            os.chmod(backup,path.stat().st_mode & 0o777)
            os.replace(tmp,path)
            try:
                subprocess.run(['systemctl','reload','caddy'],check=True)
            except BaseException:
                if path.read_bytes() == updated:
                    os.replace(backup,path)
                    subprocess.run(['systemctl','reload','caddy'],check=True)
                raise
    print('Caddy route ' + ('validated' if args.operation == 'check' else 'updated') + '.')


if __name__ == '__main__':
    main()
