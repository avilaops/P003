#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly ROOT=/mnt/HC_Volume_106542212/erp-next
readonly APPLICATION=erp-next

fail() { printf '%s\n' "$*" >&2; exit 1; }

[[ $# == 0 ]] || fail 'invalid dispatcher arguments'
original_command=${SSH_ORIGINAL_COMMAND:-}
[[ "$original_command" =~ ^deploy\ erp-next\ ([0-9a-f]{40})$ ]] || fail 'invalid deploy command'
source_sha=${BASH_REMATCH[1]}
[[ $EUID == 0 ]] || fail 'dispatcher requires root'

exec 9>"$ROOT/.deploy.lock"
flock -n 9 || fail 'another ERP deployment is running'

previous_release=$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' erp-next-web-1)
[[ "$previous_release" == "$ROOT/releases/"* ]] || fail 'active release is not managed by this dispatcher'

staging=$(mktemp -d "$ROOT/.incoming.XXXXXX")
release="$ROOT/releases/$source_sha"
validated_bundle=false
cleanup() {
  local status=$?
  if [[ "$status" != 0 && "$validated_bundle" == true ]]; then
    # Container inspection in retention protects even a partially restored release.
    local previous_sha="${previous_release##*/}"
    local rollback_sha
    if rollback_sha=$(python3 -c '
import json, re, sys
from pathlib import Path
path = Path(sys.argv[1]) / "deployment-state.json"
if path.is_symlink() or not path.is_file(): raise SystemExit(1)
state = json.loads(path.read_text())
if state.get("active") != sys.argv[2]: raise SystemExit(1)
rollback = state.get("rollback", "")
if not isinstance(rollback, str) or not re.fullmatch("[a-f0-9]{40}", rollback): raise SystemExit(1)
print(rollback)
' "$ROOT" "$previous_sha"); then
      python3 "$staging/release-retention.py" "$previous_sha" "$rollback_sha" --root "$ROOT" --apply ||
        printf '%s\n' '::warning::Failed release cleanup needs attention.' >&2
    else
      printf '%s\n' '::warning::Prior rollback is unconfirmed; retaining images and releases.' >&2
    fi
  fi
  rm -rf -- "$staging"
}
trap cleanup EXIT

# The bundle contains small configuration/helpers only. Reject links, traversal,
# unexpected members and oversized files before they can reach the filesystem.
python3 -c '
import os, sys, tarfile
from pathlib import Path
destination = Path(sys.argv[1])
allowed = {"release.json", "compose.yaml", "fiscal-compose.yaml", "migrate-release.py", "release-retention.py",
           "grant-fiscal-monitor.sql", "grant-cte-distribution.sql"}
seen, size = set(), 0
with tarfile.open(fileobj=sys.stdin.buffer, mode="r|gz") as archive:
    for member in archive:
        name = member.name
        while name.startswith("./"): name = name[2:]
        if name in ("", ".") and member.isdir(): continue
        size += member.size
        if name not in allowed | {"configure-api.py"} or name in seen or not member.isfile() or member.size < 1 or size > 524288:
            raise SystemExit("Invalid release bundle member")
        seen.add(name)
        with (destination / name).open("xb") as output:
            os.chmod(output.name, 0o600)
            source = archive.extractfile(member)
            output.write(source.read())
if not allowed.issubset(seen): raise SystemExit("Incomplete release bundle")
' "$staging"

for file in release.json compose.yaml fiscal-compose.yaml migrate-release.py release-retention.py grant-fiscal-monitor.sql grant-cte-distribution.sql; do
  [[ -s "$staging/$file" ]] || fail "missing artifact: $file"
done
[[ ! -e "$release" ]] || fail 'release already exists'

python3 "$staging/release-retention.py" "$source_sha" --manifest "$staging/release.json" > "$staging/images.txt"
validated_bundle=true
while read -r component reference; do
  docker pull "$reference" >/dev/null
  # Compatibility alias for the migration helper; Compose uses registry digests.
  docker tag "$reference" "erp-next-$component:sha-$source_sha"
done < "$staging/images.txt"

mkdir -m 700 "$release"
cp -p "$staging/migrate-release.py" "$staging/release-retention.py" "$staging/release.json" "$staging/grant-fiscal-monitor.sql" "$staging/grant-cte-distribution.sql" "$release/"

compose_overlay_args=()
if [[ -f "$previous_release/compose.json" ]]; then
  # Current production still uses a generated, self-contained Compose JSON.
  # Keep its private runtime configuration on the server and replace only the
  # three immutable image references.
  cp -p "$previous_release/compose.json" "$release/compose.json"
  python3 - "$release/compose.json" "$source_sha" <<'PY'
import json
from pathlib import Path
import sys

target = Path(sys.argv[1])
config = json.loads(target.read_text())
config["services"]["fiscal-engine"]["healthcheck"]["test"] = ["CMD", "node", "scripts/healthcheck.mjs"]

def environment(service):
    value = service.get("environment", {})
    if isinstance(value, list):
        value = dict(entry.split("=", 1) for entry in value if "=" in entry)
    service["environment"] = value
    return value

api = environment(config["services"]["api"])
fiscal = environment(config["services"]["fiscal-engine"])
previous_api_ts = environment(config["services"]["api-ts"]) if "api-ts" in config["services"] else {}
token = api.get("ERP_FISCAL_ENGINE_TOKEN") or fiscal.get("ERP_FISCAL_ENGINE_TOKEN")
if not token or len(token) < 24:
    raise SystemExit("Private fiscal token missing")
api.update({"ERP_CNPJ_WS_ENABLED": "true", "DANFE_MCP_URL": "http://127.0.0.1:8091/mcp/danfe", "DANFE_MCP_TOKEN": token,
            "DANFE_MCP_TOOL_PREFIX": "bare", "DANFE_CA_BUNDLE_FILE": "/etc/ssl/certs/erp-icp-brasil-roots.pem"})
config["services"]["fiscal-mcp"] = {
    "image": "erp-next-fiscal-mcp:sha-" + sys.argv[2], "restart": "unless-stopped",
    "network_mode": "service:api", "depends_on": {"api": {"condition": "service_healthy"}},
    "read_only": True, "tmpfs": ["/tmp:rw,noexec,nosuid,size=64m,mode=1777"],
    "environment": {"XDG_CACHE_HOME": "/tmp/cache"},
    "security_opt": ["no-new-privileges:true"], "cap_drop": ["ALL"],
    "mem_limit": "512m", "pids_limit": 128,
}

web = environment(config["services"]["web"])
# Migrated handlers are absent from production Rust. Always start their private
# process from the validated web image; recovery selects a whole prior release.
settings = {key: api[key] for key in ("DATABASE_URL", "DATABASE_MAX_CONNECTIONS", "AUTH_ISSUER", "AUTH_USERINFO_URL", "ERP_MCP_ORIGIN") if api.get(key)}
settings.setdefault("AUTH_ISSUER", web.get("AUTH_ISSUER", ""))
settings.update({"NODE_ENV": "production", "API_TS_HOST": "0.0.0.0", "API_TS_PORT": "8081"})
fiscal_url = previous_api_ts.get("ERP_FISCAL_ENGINE_URL") or api.get("ERP_FISCAL_ENGINE_URL")
fiscal_token = previous_api_ts.get("ERP_FISCAL_ENGINE_TOKEN") or token
fiscal_keyring = previous_api_ts.get("FISCAL_A1_KEYRING") or api.get("FISCAL_A1_KEYRING")
if fiscal_url and fiscal_token and fiscal_keyring:
    settings.update({"ERP_FISCAL_ENGINE_URL": fiscal_url, "ERP_FISCAL_ENGINE_TOKEN": fiscal_token,
                     "FISCAL_A1_KEYRING": fiscal_keyring,
                     "NFSE_ISSUANCE_ENABLED": previous_api_ts.get("NFSE_ISSUANCE_ENABLED") or api.get("NFSE_ISSUANCE_ENABLED", "false")})
# Optional third-party key for the Browser Use route; kept across releases.
browser_use_key = previous_api_ts.get("BROWSER_USE_API_KEY") or api.get("BROWSER_USE_API_KEY")
if browser_use_key:
    settings["BROWSER_USE_API_KEY"] = browser_use_key
# Catalog publication (Worker media gateway): the api-ts reads all three or none; kept across releases.
catalog_keys = ("CATALOG_MEDIA_ORIGIN", "CATALOG_MEDIA_TOKEN", "CATALOG_MEDIA_TENANT")
catalog = {key: previous_api_ts.get(key) or api.get(key) for key in catalog_keys}
if all(catalog.values()):
    settings.update(catalog)
config["services"]["api-ts"] = {
    "image": "erp-next-web:sha-" + sys.argv[2], "restart": "unless-stopped",
    "command": ["node", "apps/api-ts/dist/server.js"], "environment": settings,
    "network_mode": "service:api", "depends_on": {"api": {"condition": "service_healthy"}},
    "healthcheck": {"test": ["CMD", "node", "-e", "fetch('http://127.0.0.1:8081/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], "interval": "15s", "timeout": "5s", "start_period": "30s"},
    "security_opt": ["no-new-privileges:true"], "cap_drop": ["ALL"], "mem_limit": "384m", "pids_limit": 128,
}
mail_env = Path("/etc/erp-next/document-mail-n8n.env")
if mail_env.is_symlink():
    raise SystemExit("Unexpected document mail configuration symlink")
if mail_env.exists():
    stat = mail_env.stat()
    if not mail_env.is_file() or stat.st_uid != 0 or stat.st_mode & 0o777 != 0o600:
        raise SystemExit("Document mail configuration must be root-owned with mode 0600")
    config["services"]["api-ts"]["env_file"] = [str(mail_env)]
api["ERP_TYPESCRIPT_API_URL"] = "http://127.0.0.1:8081"
web["ERP_TYPESCRIPT_API_URL"] = "http://127.0.0.1:8081"
web.pop("ERP_TYPESCRIPT_MODULES", None)

for service in config["services"].values():
    service["logging"] = {"driver": "json-file", "options": {"max-size": "10m", "max-file": "3"}}
target.write_text(json.dumps(config, indent=2))
PY
  if [[ -d "/etc/erp-next/contract-signatures/releases/$source_sha/public" ]] || grep -q '"ERP_CONTRACT_VALIDATOR_ROOTS_FILE"' "$previous_release/compose.json"; then
    [[ -s "$staging/configure-api.py" ]] || fail 'missing contract signature configuration helper'
    python3 "$staging/configure-api.py" "$release/compose.json" "$source_sha" --previous "$previous_release/compose.json"
  fi
  # The generated JSON carries the public release marker in the web
  # environment; update it together with the immutable image references.
  sed -i "s|\"ERP_RELEASE_SHA\": \"[0-9a-f]*\"|\"ERP_RELEASE_SHA\": \"$source_sha\"|g" "$release/compose.json"
  previous_api=$(docker inspect --format '{{.Config.Image}}' erp-next-api-1)
  previous_web=$(docker inspect --format '{{.Config.Image}}' erp-next-web-1)
  previous_fiscal=$(docker inspect --format '{{.Config.Image}}' erp-next-fiscal-engine-1)
  for pair in \
    "$previous_api|erp-next-api:sha-$source_sha" \
    "$previous_web|erp-next-web:sha-$source_sha" \
    "$previous_fiscal|erp-next-fiscal:sha-$source_sha"; do
    old=${pair%%|*}
    new=${pair#*|}
    escaped_old=$(printf '%s' "$old" | sed 's/[.[\*^$()+?{|\\]/\\&/g')
    sed -i "s|$escaped_old|$new|g" "$release/compose.json"
  done
  grep -q "erp-next-api:sha-$source_sha" "$release/compose.json" || fail 'API image was not pinned'
  grep -q "erp-next-web:sha-$source_sha" "$release/compose.json" || fail 'web image was not pinned'
  grep -q "erp-next-fiscal:sha-$source_sha" "$release/compose.json" || fail 'fiscal image was not pinned'
  grep -q "erp-next-fiscal-mcp:sha-$source_sha" "$release/compose.json" || fail 'MCP image was not pinned'
  grep -q "\\\"ERP_RELEASE_SHA\\\": \\\"$source_sha\\\"" "$release/compose.json" || fail 'release SHA was not pinned'
  compose_file=compose.json
  compose_env_args=()
else
  [[ -f "$previous_release/compose.yaml" && -f "$previous_release/api.env" && -f "$previous_release/web.env" && -f "$previous_release/.env" ]] || fail 'active release has an unknown layout'
  cp -p "$staging/compose.yaml" "$staging/fiscal-compose.yaml" "$release/"
  cp -p "$previous_release/api.env" "$previous_release/web.env" "$previous_release/.env" "$release/"
  chmod 600 "$release/api.env" "$release/web.env" "$release/.env"
  if [[ -f "$previous_release/api-ts.env" && ! -L "$previous_release/api-ts.env" ]]; then
    cp -p "$previous_release/api-ts.env" "$release/api-ts.env"
    chmod 600 "$release/api-ts.env"
  fi
  sed -i \
    -e "s|^ERP_API_IMAGE=.*|ERP_API_IMAGE=erp-next-api:sha-$source_sha|" \
    -e "s|^ERP_WEB_IMAGE=.*|ERP_WEB_IMAGE=erp-next-web:sha-$source_sha|" \
    -e "s|^ERP_FISCAL_ENGINE_IMAGE=.*|ERP_FISCAL_ENGINE_IMAGE=erp-next-fiscal:sha-$source_sha|" \
    -e "s|^ERP_RELEASE_SHA=.*|ERP_RELEASE_SHA=$source_sha|" \
    "$release/.env"
  sed -i '/^ERP_FISCAL_MCP_IMAGE=/d' "$release/.env"
  printf '\nERP_FISCAL_MCP_IMAGE=erp-next-fiscal-mcp:sha-%s\n' "$source_sha" >> "$release/.env"
  grep -q "^ERP_API_IMAGE=erp-next-api:sha-$source_sha$" "$release/.env" || fail 'API image was not pinned'
  grep -q "^ERP_WEB_IMAGE=erp-next-web:sha-$source_sha$" "$release/.env" || fail 'web image was not pinned'
  grep -q "^ERP_RELEASE_SHA=$source_sha$" "$release/.env" || fail 'release SHA was not pinned'
  compose_file=compose.yaml
  compose_overlay_args=(--file "$release/fiscal-compose.yaml")
  compose_env_args=(--env-file "$release/.env")
fi

# Substitute only validated registry digests, preserving private configuration.
python3 - "$release" "$compose_file" <<'PY'
import json, sys
from pathlib import Path
directory = Path(sys.argv[1])
manifest = json.loads((directory / "release.json").read_text())
images = manifest["images"]
mapping = {"api": "api", "web": "web", "fiscal-engine": "fiscal", "fiscal-mcp": "fiscal-mcp"}
if sys.argv[2] == "compose.json":
    path = directory / "compose.json"
    config = json.loads(path.read_text())
    if "api-ts" in config["services"]: mapping["api-ts"] = "web"
    for service, component in mapping.items(): config["services"][service]["image"] = images[component]
    path.write_text(json.dumps(config, indent=2))
else:
    path = directory / ".env"
    variables = {"ERP_API_IMAGE": images["api"], "ERP_WEB_IMAGE": images["web"],
                 "ERP_FISCAL_ENGINE_IMAGE": images["fiscal"], "ERP_FISCAL_MCP_IMAGE": images["fiscal-mcp"]}
    lines = [line for line in path.read_text().splitlines() if line.split("=", 1)[0] not in variables]
    path.write_text("\n".join(lines + [key + "=" + value for key, value in variables.items()]) + "\n")
PY

compose() {
  docker compose --project-name "$APPLICATION" --project-directory "$1" \
    "${compose_env_args[@]}" --file "$1/$compose_file" "${compose_overlay_args[@]}" "${@:2}"
}

rollback() {
  local status=$?
  trap - ERR
  printf '%s\n' 'ERP deploy failed; restoring previous release' >&2
  if [[ -f "$previous_release/compose.json" ]]; then
    docker compose --project-name "$APPLICATION" --project-directory "$previous_release" \
      --file "$previous_release/compose.json" up --detach --no-build --remove-orphans --wait --wait-timeout 120 || true
  else
    docker compose --project-name "$APPLICATION" --project-directory "$previous_release" \
      --env-file "$previous_release/.env" --file "$previous_release/compose.yaml" \
      --file "$previous_release/fiscal-compose.yaml" up --detach --no-build --remove-orphans --wait --wait-timeout 120 || true
  fi
  exit "$status"
}

compose "$release" config --quiet
python3 "$release/migrate-release.py" "$source_sha" "$release"
trap rollback ERR
compose "$release" up --detach --no-build --wait --wait-timeout 120

curl --fail --silent --show-error --connect-timeout 5 --max-time 15 \
  http://127.0.0.1:3141/health/ready >/dev/null

python3 - "$source_sha" "$ROOT" "${previous_release##*/}" <<'PY'
import json
import os
from pathlib import Path
import sys
import tempfile
import urllib.request

expected = sys.argv[1]
with urllib.request.urlopen("http://127.0.0.1:3140/api/health", timeout=10) as response:
    health = json.load(response)
if health.get("commit") != expected or health.get("ok") is not True:
    raise SystemExit("ERP health does not match the requested release")
for path in ("/entrar", "/erp-preview.webp"):
    with urllib.request.urlopen("http://127.0.0.1:3140" + path, timeout=10) as response:
        if response.status != 200:
            raise SystemExit(f"ERP public path failed: {path}")
print(json.dumps({"application": health.get("application"), "commit": health.get("commit")}))
root = Path(sys.argv[2])
with tempfile.NamedTemporaryFile(mode="w", dir=root, prefix=".deployment-state-", delete=False) as output:
    os.chmod(output.name, 0o600)
    json.dump({"active": expected, "rollback": sys.argv[3]}, output)
    temporary = output.name
os.replace(temporary, root / "deployment-state.json")
PY

trap - ERR
if ! python3 "$release/release-retention.py" "$source_sha" "${previous_release##*/}" --root "$ROOT" --apply; then
  printf '%s\n' '::warning::Release is healthy; storage cleanup needs attention.' >&2
fi
printf 'ERP deploy completed: %s\n' "$source_sha"
