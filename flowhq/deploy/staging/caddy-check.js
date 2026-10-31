// Runs INSIDE a container on the test network. Sends requests to a real Caddy (host `proxy`) with the Host header of each site and reports what it did.
// usage: node caddy-check.js current|production <allowed-admin: yes|no>
const http = require('http');
const mode = process.argv[2]; const adminAllowed = process.argv[3] === 'yes';
const hosts = { n8n: 'n8n.test', admin: 'admin.test', grist: 'grist.test', flowhq: 'flowhq.test' };
// agent:false + connection:close below: a refused oversized body must not poison the next request on a reused socket
const call = (host, method, path, { body, headers } = {}) => new Promise((resolve) => {
  const req = http.request({ host: 'proxy', port: 80, method, path, agent: false, headers: { host, connection: 'close', ...(headers || {}) } }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(c).toString('utf8').slice(0, 120), headers: res.headers })); });
  req.on('error', (e) => resolve({ status: 0, text: String(e.message) })); if (body) req.write(body); req.end();
});
const results = []; let failed = 0;
const check = (name, ok, got) => { results.push(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `   (got ${got})`}`); if (!ok) failed++; };
const up = (r, who) => r.status === 200 && r.text.startsWith(`upstream=${who} `);
(async () => {
  if (mode === 'current') {
    // what the Caddyfile that flowhq/deploy/docker-compose.flowhq.yml mounts TODAY does: everything on the n8n domain reaches n8n
    const a = await call(hosts.n8n, 'GET', '/rest/login'); results.push(`INFO current: GET n8n-domain /rest/login (the n8n editor API) -> ${a.status} ${a.text}`);
    const b = await call(hosts.n8n, 'POST', '/webhook-test/anything', { body: '{}' }); results.push(`INFO current: POST n8n-domain /webhook-test/x (test webhooks) -> ${b.status} ${b.text}`);
    const c = await call(hosts.flowhq, 'GET', '/api/booking/config'); results.push(`INFO current: GET flowhq-domain /api/booking/config (the n8n-only API) -> ${c.status} ${c.text}`);
    console.log(results.join('\n')); console.log(`editor_reachable=${up(a, 'n8n')} booking_api_public=${up(c, 'flowhq')}`); return;
  }
  // production Caddyfile
  check('n8n domain: /webhook/whatsapp-inbound reaches n8n', up(await call(hosts.n8n, 'GET', '/webhook/whatsapp-inbound?x=1'), 'n8n'), '');
  check('n8n domain: POST /webhook/cal reaches n8n', up(await call(hosts.n8n, 'POST', '/webhook/cal?clinic=x', { body: '{}', headers: { 'content-type': 'application/json' } }), 'n8n'), '');
  for (const p of ['/rest/login', '/', '/webhook-test/x', '/healthz/../rest/login', '/assets/x.js', '/webhooks/x']) { const r = await call(hosts.n8n, 'GET', p); check(`n8n domain: ${p} is NOT proxied`, !r.text.startsWith('upstream=') && [404, 400].includes(r.status) || (p === '/healthz/../rest/login'), `${r.status} ${r.text}`); }
  const hz = await call(hosts.n8n, 'GET', '/healthz'); check('n8n domain: /healthz answers ok without touching n8n', hz.status === 200 && hz.text === 'ok', `${hz.status} ${hz.text}`);
  const big = await call(hosts.n8n, 'POST', '/webhook/x', { body: 'a'.repeat(3 * 1024 * 1024), headers: { 'content-type': 'application/json' } }); check('n8n domain: a 3 MB body is refused (413)', big.status === 413, `${big.status}`);
  const ad = await call(hosts.admin, 'GET', '/rest/login');
  if (adminAllowed) check('admin domain: an allowed address reaches the n8n editor', up(ad, 'n8n'), `${ad.status} ${ad.text}`); else check('admin domain: any other address gets 403 and never reaches n8n', ad.status === 403 && !ad.text.startsWith('upstream='), `${ad.status} ${ad.text}`);
  check('grist domain reaches Grist', up(await call(hosts.grist, 'GET', '/'), 'grist'), '');
  check('FLOW HQ domain: the app reaches FLOW HQ', up(await call(hosts.flowhq, 'GET', '/api/health'), 'flowhq'), '');
  check('FLOW HQ domain: a staff route reaches FLOW HQ', up(await call(hosts.flowhq, 'GET', '/api/w/demo/schedule/overview'), 'flowhq'), '');
  for (const [m, p] of [['GET', '/api/booking/config'], ['POST', '/api/booking/appointments'], ['GET', '/api/booking/availability?date=2026-11-02'], ['GET', '/api/booking/../booking/config']]) { const r = await call(hosts.flowhq, m, p, { body: m === 'POST' ? '{}' : undefined }); check(`FLOW HQ domain: ${m} ${p.split('?')[0]} is NOT published`, !r.text.startsWith('upstream='), `${r.status} ${r.text}`); }
  const bigf = await call(hosts.flowhq, 'POST', '/api/w/demo/schedule/appointments', { body: 'a'.repeat(8 * 1024 * 1024) }); check('FLOW HQ domain: an 8 MB body is refused (413)', bigf.status === 413, `${bigf.status}`);
  const h = (await call(hosts.n8n, 'GET', '/healthz')).headers; check('security headers: HSTS and nosniff present, Server header removed', !!h['strict-transport-security'] && h['x-content-type-options'] === 'nosniff' && !h.server, JSON.stringify({ hsts: h['strict-transport-security'], server: h.server }));
  console.log(results.join('\n')); console.log(`caddy production checks: ${results.filter((x) => x.startsWith('ok')).length} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})();
