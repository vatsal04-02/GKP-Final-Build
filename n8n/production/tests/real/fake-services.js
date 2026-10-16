// Local stand-ins for the outside world, used by the real-n8n test: Grist (records + schema endpoints, backed by the simulator's FakeGrist),
// Meta Graph API, an AI provider, and (if the binary is present) Mailpit. Everything listens on 127.0.0.1 on a random port. Nothing leaves this computer.
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const sim = require('../sim');
const F = require('../../../tests/ai-fixtures');

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const readBody = (req) => new Promise((resolve) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => resolve(Buffer.concat(c).toString('utf8'))); });
const send = (res, status, body) => { const t = body === undefined || body === null ? '' : JSON.stringify(body); res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(t); };

// ---------------------------------------------------------------- Grist
async function startGrist({ docs, apiKey }) {
  const grist = new sim.FakeGrist(docs);
  const log = [];
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.headers.authorization !== `Bearer ${apiKey}`) { log.push({ method: req.method, path: u.pathname, status: 401 }); return send(res, 401, { error: 'unauthorized' }); }
    const body = req.method === 'GET' ? null : JSON.parse((await readBody(req)) || 'null');
    const query = Object.fromEntries(u.searchParams.entries());
    try {
      let m;
      if ((m = u.pathname.match(/^\/api\/docs\/([^/]+)\/tables$/))) {
        const doc = docs[m[1]]; if (!doc) return send(res, 404, { error: 'no such doc' });
        if (req.method === 'GET') return send(res, 200, { tables: Object.keys(doc).filter((t) => sim.COLUMNS[t]).map((id) => ({ id })) });
        if (req.method === 'POST') { for (const t of body.tables) { doc[t.id] = doc[t.id] || []; sim.COLUMNS[t.id] = sim.COLUMNS[t.id] || t.columns.map((c) => c.id); } log.push({ method: 'POST', path: u.pathname, tables: body.tables.map((t) => t.id) }); return send(res, 200, { tables: body.tables.map((t) => ({ id: t.id })) }); }
      }
      if ((m = u.pathname.match(/^\/api\/docs\/([^/]+)\/tables\/([^/]+)\/columns$/))) {
        if (!docs[m[1]] || !sim.COLUMNS[m[2]]) return send(res, 404, { error: 'no such table' });
        if (req.method === 'GET') return send(res, 200, { columns: sim.COLUMNS[m[2]].map((id) => ({ id })) });
        if (req.method === 'POST') { for (const c of body.columns) if (!sim.COLUMNS[m[2]].includes(c.id)) sim.COLUMNS[m[2]].push(c.id); log.push({ method: 'POST', path: u.pathname, columns: body.columns.map((c) => c.id) }); return send(res, 200, { columns: body.columns.map((c) => ({ id: c.id })) }); }
      }
      const r = grist.handle(req.method, req.url.split('?')[0], query, body);
      log.push({ method: req.method, path: u.pathname, status: 200 });
      return send(res, 200, r === null ? {} : r);
    } catch (e) { log.push({ method: req.method, path: u.pathname, status: 400, error: e.message }); return send(res, 400, { error: e.message }); }
  });
  const port = await listen(server);
  return { port, url: `http://127.0.0.1:${port}`, grist, docs, log, close: () => server.close() };
}

// ---------------------------------------------------------------- Meta
async function startMeta() {
  const state = { calls: [], mode: 'ok', n: 0 };
  const server = http.createServer(async (req, res) => {
    const body = JSON.parse((await readBody(req)) || '{}');
    state.calls.push({ method: req.method, path: req.url, auth: req.headers.authorization, body });
    if (state.mode === 'hang') return;                                      // never answers: W12 times out (15 s) -> uncertain
    if (state.mode === 'reject') return send(res, 400, { error: { message: '(#132001) Template name does not exist in the translation', type: 'OAuthException', code: 132001, fbtrace_id: 'x' } });
    state.n++;
    send(res, 200, { messaging_product: 'whatsapp', contacts: [{ input: body.to, wa_id: body.to }], messages: [{ id: `wamid.REAL${state.n}` }] });
  });
  const port = await listen(server);
  return Object.assign(state, { port, url: `http://127.0.0.1:${port}`, close: () => { server.closeAllConnections && server.closeAllConnections(); server.close(); } });
}

// ---------------------------------------------------------------- AI provider (OpenRouter-shaped), the same fake model the simulator tests use
async function startAi() {
  const claude = F.fakeClaude();
  const fake = F.fakeOpenRouter(claude);
  const state = { calls: [] };
  const server = http.createServer(async (req, res) => {
    const body = JSON.parse((await readBody(req)) || '{}');
    state.calls.push({ path: req.url, auth: req.headers.authorization, body });
    const r = fake(req.method, `https://openrouter.ai${req.url}`, req.headers, body);
    send(res, r.status, r.body);
  });
  const port = await listen(server);
  return Object.assign(state, { port, url: `http://127.0.0.1:${port}`, close: () => server.close() });
}

// ---------------------------------------------------------------- Mailpit (real SMTP server + API), if the binary is available
async function startMailpit(bin) {
  if (!bin || !fs.existsSync(bin)) return null;
  const free = () => new Promise((resolve) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const smtp = await free(); const ui = await free();
  const proc = spawn(bin, ['--smtp', `127.0.0.1:${smtp}`, '--listen', `127.0.0.1:${ui}`, '--database', path.join(require('os').tmpdir(), `mailpit-${process.pid}-${smtp}.db`)], { stdio: 'ignore' });
  const get = (p) => new Promise((resolve, reject) => http.get(`http://127.0.0.1:${ui}${p}`, (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); }).on('error', reject));
  for (let i = 0; i < 50; i++) { try { await get('/api/v1/info'); break; } catch (e) { await new Promise((r) => setTimeout(r, 100)); } }
  return { smtpPort: smtp, uiPort: ui, messages: async () => ((await get('/api/v1/messages')).messages || []), message: (id) => get(`/api/v1/message/${id}`), close: () => proc.kill('SIGTERM') };
}

module.exports = { startGrist, startMeta, startAi, startMailpit, F, sim };
