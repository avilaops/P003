"""Stage or activate the CI-tested validator over the applications SSH connection."""
import argparse
import hashlib
import io
import json
import re
import shlex
import subprocess
import tarfile
import zipfile

REPO = 'avilaops/P003'
SSH = ['ssh','-T','-o','BatchMode=yes','-o','ConnectTimeout=10','applications']
DEPLOY = 'deploy/contracts-validator/'


def github(path):
    return subprocess.check_output(['gh','api','--allow-escape-sequences',f'repos/{REPO}/'+path])


def source_file(sha,name):
    return subprocess.check_output(['git','show',sha+':'+name])


def receipt(sha,run):
    data = json.loads(github(f'actions/runs/{run}'))
    workflow_id = json.loads(github('actions/workflows/regression.yml'))['id']
    if (data['workflow_id'] != workflow_id or data['event'] != 'workflow_dispatch' or data['head_branch'] != 'main'
            or data['conclusion'] != 'success' or data['head_repository']['full_name'].lower() != REPO.lower()):
        raise ValueError('expected successful main regression workflow')
    attempt = data['run_attempt']
    artifact_name = f'contract-validator-release-{sha}-{attempt}'
    artifacts = json.loads(github(f'actions/runs/{run}/artifacts?per_page=100'))['artifacts']
    found, = (a for a in artifacts if a['name'] == artifact_name and not a['expired'])
    archive = github(f"actions/artifacts/{found['id']}/zip")
    if 'sha256:'+hashlib.sha256(archive).hexdigest() != found['digest']:
        raise ValueError('artifact digest mismatch')
    with zipfile.ZipFile(io.BytesIO(archive)) as zipped:
        if zipped.namelist() != ['contract-validator-release.json'] or zipped.infolist()[0].file_size > 16384:
            raise ValueError('unexpected release artifact')
        raw = zipped.read('contract-validator-release.json')
    value = json.loads(raw)
    if (value['schema'] != 'erp-contract-validator-release/1' or value['sourceSha'] != sha or value['run'] != run
            or value['attempt'] != attempt or not re.fullmatch(r'ghcr\.io/avilaops/erp-next-contract-validator-private@sha256:[a-f0-9]{64}',value['image'])):
        raise ValueError('registry receipt mismatch')
    proof = value['verification']
    if (proof['wheelCorpus'] is not True or proof['cases'] <= 0 or proof['skipped'] != 0
            or proof['docker']['productionRejectsSyntheticTrust'] is not True or proof['docker']['restrictedTlsUnixPipeline'] is not True):
        raise ValueError('missing container verification')
    return raw


def bundle(sha,verified):
    files = {name:source_file(sha,DEPLOY+name) for name in ('compose.yml','erp-network.yml','seccomp.json','smoke.py',
                                                            'route-portal.py','configure-api.py')}
    files.update({'release.json':verified,'public/roots.pem':source_file(sha,'deploy/fiscal/icp-brasil-roots.pem'),
                  'public/intermediates.pem':source_file(sha,'deploy/fiscal/icp-brasil-intermediates.pem'),
                  'public/evidence-origins.json':source_file(sha,DEPLOY+'evidence-origins.json')})
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream,mode='w:gz') as archive:
        for name,content in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(content)
            archive.addfile(info,io.BytesIO(content))
    return stream.getvalue()


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument('operation',choices=('stage','start','smoke','check-route','activate-route','rollback-route'))
    cli.add_argument('source')
    cli.add_argument('--run',type=int,help='successful regression workflow run, required to stage')
    args = cli.parse_args()
    if not re.fullmatch(r'[0-9a-f]{40}',args.source):
        raise SystemExit('supply exact reviewed SHA')
    if args.operation == 'stage' and not args.run:
        raise SystemExit('stage requires a successful --run')
    data = bundle(args.source,receipt(args.source,args.run)) if args.operation == 'stage' else None
    if args.operation.endswith('-route'):
        script = 'route-portal.py'
        parameters = [args.operation.removesuffix('-route'),'--source',args.source]
    else:
        script = 'host-release.py'
        parameters = [args.operation,args.source]
    program = source_file(args.source,DEPLOY+script).decode('utf-8')
    command = shlex.join(['python3','-c',program,*parameters])
    subprocess.run([*SSH,command],input=data,check=True)


if __name__ == '__main__':
    main()
