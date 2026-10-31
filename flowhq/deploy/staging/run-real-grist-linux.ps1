# Runs the real-Grist suite (tests/real-grist) INSIDE a Linux container (node:20-alpine, the production base image), against the throwaway staging Grist container.
# Why Linux: the signal tests (SIGTERM / SIGINT / SIGKILL) need real signals, and the disk-full test needs a tiny tmpfs. Production is Linux too.
# Nothing here touches a clinic: the Grist is a local container with synthetic data (docs/staging-environment.md). The API key file is mounted read-only and never printed.
#
#   powershell -File flowhq\deploy\staging\run-real-grist-linux.ps1 -KeyFile <path to the staging Grist API key file> [-Grist gkp-staging-grist] [-Filter lifecycle]
param(
  [Parameter(Mandatory = $true)][string]$KeyFile,
  [string]$Grist = 'gkp-staging-grist',
  [string]$Network = 'gkp-staging',
  [string]$Filter = 'tests/real-grist'
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
if (-not (Test-Path $KeyFile)) { throw "key file not found: $KeyFile" }
$ErrorActionPreference = 'Continue'   # docker writes "already exists" to stderr, which is fine here
docker network inspect $Network *> $null; if ($LASTEXITCODE -ne 0) { docker network create $Network *> $null }
docker network connect $Network $Grist *> $null              # already connected = fine
$ErrorActionPreference = 'Stop'
$inner = @'
set -e
mkdir -p /work && cd /src && tar cf - --exclude=flowhq/node_modules --exclude=flowhq/dist --exclude=.git flowhq n8n/snippets | tar xf - -C /work
cd /work/flowhq && npm ci --no-audit --no-fund --loglevel=error
npx vitest run __FILTER__ --reporter=default
'@.Replace('__FILTER__', $Filter)
docker run --rm --network $Network `
  -v "${repo}:/src:ro" -v "gkp-npm-cache:/root/.npm" -v "${KeyFile}:/run/grist.key:ro" `
  --tmpfs /smalldisk:size=256k,mode=1777 `
  -e REAL_GRIST_URL="http://${Grist}:8484" -e REAL_GRIST_KEY_FILE=/run/grist.key -e REAL_SMALL_DISK_DIR=/smalldisk -e CI=1 `
  node:20-alpine sh -c $inner
exit $LASTEXITCODE
