# Runs the STAGING JOURNEY (flowhq/tests/real-grist/staging-n8n.real.test.ts) in the n8n runner image: a REAL n8n imports the repo's 4C workflow candidate, talks to the throwaway
# staging Grist and to the real FLOW HQ server process; WhatsApp (Meta) and the AI model are local STUBS (no authorised test number or credential exists: nothing reaches WhatsApp).
#   1. docker build -f flowhq/deploy/staging/Dockerfile.n8n-runner -t gkp-staging-n8n:local flowhq/deploy/staging     (once; installs n8n)
#   2. a staging Grist container on the Docker network (docs/staging-environment.md) and its API key in a file
#   3. powershell -File flowhq\deploy\staging\run-staging-n8n.ps1 -KeyFile <staging Grist API key file>
param(
  [Parameter(Mandatory = $true)][string]$KeyFile,
  [string]$Grist = 'gkp-staging-grist',
  [string]$Network = 'gkp-staging',
  [string]$Image = 'gkp-staging-n8n:local',
  [string]$Filter = 'tests/real-grist/staging-n8n'
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
if (-not (Test-Path $KeyFile)) { throw "key file not found: $KeyFile" }
$ErrorActionPreference = 'Continue'
docker network inspect $Network *> $null; if ($LASTEXITCODE -ne 0) { docker network create $Network *> $null }
docker network connect $Network $Grist *> $null
$ErrorActionPreference = 'Stop'
$inner = @'
set -e
mkdir -p /work && cd /src && tar cf - --exclude=node_modules --exclude=dist --exclude=.git flowhq n8n apps/clinic-website/api apps/clinic-website/src/lib scripts/4d | tar xf - -C /work
cd /work/flowhq && npm ci --no-audit --no-fund --loglevel=error
npx vitest run __FILTER__ --reporter=default
'@.Replace('__FILTER__', $Filter)
docker run --rm --network $Network `
  -v "${repo}:/src:ro" -v "gkp-npm-cache:/root/.npm" -v "${KeyFile}:/run/grist.key:ro" `
  -e REAL_GRIST_URL="http://${Grist}:8484" -e REAL_GRIST_KEY_FILE=/run/grist.key -e CI=1 -e STAGING_WORKFLOW="$env:STAGING_WORKFLOW" `
  $Image sh -c $inner
exit $LASTEXITCODE
