# Verifies the reverse-proxy rules against a REAL Caddy (the caddy:2 image) with stub upstreams. Nothing leaves this computer; no certificate is requested (the test sites use http://).
# It rewrites ONLY the site addresses of a Caddyfile (the {$..._DOMAIN} lines) to http://<name>.test; every handler, matcher, header and limit is the file's own.
#   powershell -File flowhq\deploy\staging\verify-caddy.ps1
$ErrorActionPreference = 'Continue'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$net = 'gkp-caddy-test'
function Cleanup { docker rm -f gkp-caddy-proxy gkp-stub-n8n gkp-stub-grist gkp-stub-flowhq *> $null; docker network rm $net *> $null }
Cleanup; docker network create $net *> $null
$stub = "const http=require('http');const n=process.env.NAME;http.createServer((q,s)=>{q.resume();q.on('end',()=>s.end('upstream='+n+' '+q.method+' '+q.url))}).listen(Number(process.env.PORT))"
foreach ($u in @(@('n8n', 5678), @('grist', 8484), @('flowhq', 8787))) { docker run -d --name "gkp-stub-$($u[0])" --network $net --network-alias "$($u[0])" -e "NAME=$($u[0])" -e "PORT=$($u[1])" node:20-alpine node -e $stub *> $null }
function Test-Caddyfile($file, $mode, $cidr, $adminAllowed) {
  $tmp = Join-Path $env:TEMP "caddy-test-$mode.Caddyfile"
  $text = (Get-Content $file -Raw)
  $text = $text -replace '\{\$N8N_DOMAIN\} \{', 'http://n8n.test {' -replace '\{\$N8N_ADMIN_DOMAIN\} \{', 'http://admin.test {' -replace '\{\$GRIST_DOMAIN\} \{', 'http://grist.test {' -replace '\{\$FLOWHQ_DOMAIN\} \{', 'http://flowhq.test {'
  $text = $text -replace '(?s)\{\s*email \{\$ACME_EMAIL\}', '{ auto_https off' -replace '(?m)^\s*email .*$', ''
  [IO.File]::WriteAllText($tmp, $text, (New-Object Text.UTF8Encoding($false)))
  docker rm -f gkp-caddy-proxy *> $null
  docker run -d --name gkp-caddy-proxy --network $net --network-alias proxy -e ACME_EMAIL=x@example.test -e "ADMIN_ALLOW_CIDR=$cidr" -v "${tmp}:/etc/caddy/Caddyfile:ro" caddy:2 *> $null
  Start-Sleep -Seconds 3
  $logs = (cmd /c "docker logs gkp-caddy-proxy 2>&1") -join "`n"
  if ($logs -match '"level":"error"') { Write-Host "Caddy did not start with $file :`n$($logs.Substring(0,[Math]::Min(600,$logs.Length)))"; return 1 }
  $out = docker run --rm --network $net -v "$PSScriptRoot\caddy-check.js:/c.js:ro" node:20-alpine node /c.js $mode $adminAllowed
  $code = $LASTEXITCODE
  $out | ForEach-Object { Write-Host $_ }       # printed here: a function's pipeline output would become its return value
  return [int]$code
}
# 0. both files are valid Caddyfiles (the real file, real directives)
foreach ($f in @('flowhq/deploy/Caddyfile', 'flowhq/deploy/Caddyfile.production')) {
  $r = docker run --rm -e ACME_EMAIL=x@example.test -e N8N_DOMAIN=n8n.example.test -e N8N_ADMIN_DOMAIN=admin.example.test -e GRIST_DOMAIN=grist.example.test -e FLOWHQ_DOMAIN=flowhq.example.test -e ADMIN_ALLOW_CIDR=203.0.113.7/32 -v "${repo}\${f}:/etc/caddy/Caddyfile:ro" caddy:2 caddy validate --config /etc/caddy/Caddyfile 2>&1 | Out-String
  Write-Host ("validate {0}: {1}" -f $f, $(if ($r -match 'Valid configuration') { 'Valid configuration' } else { "FAILED`n$r" }))
}
Write-Host "`n--- the Caddyfile mounted TODAY by flowhq/deploy/docker-compose.flowhq.yml"
$null = Test-Caddyfile (Join-Path $repo 'flowhq/deploy/Caddyfile') 'current' '0.0.0.0/0' 'yes'
Write-Host "`n--- flowhq/deploy/Caddyfile.production, admin address ALLOWED"
$a = Test-Caddyfile (Join-Path $repo 'flowhq/deploy/Caddyfile.production') 'production' '0.0.0.0/0' 'yes'
Write-Host "`n--- flowhq/deploy/Caddyfile.production, admin address NOT allowed"
$b = Test-Caddyfile (Join-Path $repo 'flowhq/deploy/Caddyfile.production') 'production' '192.0.2.1/32' 'no'
Cleanup
if ($a -ne 0 -or $b -ne 0) { exit 1 }
