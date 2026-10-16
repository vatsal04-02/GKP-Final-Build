// Minimal Grist REST client (records API). The API key stays in this process: it is never sent to the browser, never logged.
export type GristValue = string | number | boolean | null | undefined | unknown[];
export interface GristRecord { id: number; fields: Record<string, GristValue> }
export interface RecordsQuery { filter?: Record<string, unknown[]>; sort?: string; limit?: number }
export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string | FormData }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string>; arrayBuffer?(): Promise<ArrayBuffer>; headers?: { get(name: string): string | null } }>;

export class BackendError extends Error {
  constructor(public status: number, public code: string, message: string, public extra?: Record<string, unknown>) { super(message); }
}

export class GristClient {
  constructor(private baseUrl: string, private apiKey: string, private fetchImpl: FetchLike = fetch as unknown as FetchLike, private timeoutMs = 15000) {}

  private async call(method: string, path: string, body?: unknown, asBytes = false): Promise<unknown> {
    const url = `${this.baseUrl.replace(/\/+$/, '')}${path}`;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const form = typeof FormData !== 'undefined' && body instanceof FormData;   // multipart: fetch sets its own Content-Type + boundary
    if (body !== undefined && !form) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await Promise.race([
        this.fetchImpl(url, { method, headers, body: body === undefined ? undefined : form ? (body as FormData) : JSON.stringify(body) }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), this.timeoutMs)),
      ]);
    } catch (e) {
      throw new BackendError(502, 'backend_unreachable', `The data backend did not answer (${(e as Error).message === 'timeout' ? 'timeout' : 'network error'})`);
    }
    if (!res.ok) {
      // the backend's own error text stays in the server log (it can name documents); the browser gets the status only
      const text = (await res.text().catch(() => '')).slice(0, 300).replace(/Bearer\s+\S+/gi, 'Bearer [hidden]');
      const where = path.replace(/\/api\/docs\/[^/]+/, '/api/docs/[doc]').split('?')[0];
      console.error(`FLOW HQ: data backend answered ${res.status} to ${method} ${where}${text ? `: ${text.split(this.apiKey || '\u0000').join('[hidden]')}` : ''}`);
      throw new BackendError(res.status === 404 ? 404 : 502, `backend_${res.status}`, `The data backend refused the request (${res.status})`);
    }
    if (res.status === 204) return null;
    if (asBytes) return { bytes: new Uint8Array(await res.arrayBuffer!()), mime: res.headers?.get('content-type') || '' };
    const t = await res.text();
    return t ? JSON.parse(t) : null;
  }

  async records(doc: string, table: string, q: RecordsQuery = {}): Promise<GristRecord[]> {
    const p = new URLSearchParams();
    if (q.filter) p.set('filter', JSON.stringify(q.filter));
    if (q.sort) p.set('sort', q.sort);
    if (q.limit) p.set('limit', String(q.limit));
    const qs = p.toString();
    const r = (await this.call('GET', `/api/docs/${encodeURIComponent(doc)}/tables/${encodeURIComponent(table)}/records${qs ? `?${qs}` : ''}`)) as { records?: GristRecord[] } | null;
    return Array.isArray(r?.records) ? r!.records : [];
  }
  async add(doc: string, table: string, fields: Record<string, GristValue>[]): Promise<number[]> {
    const r = (await this.call('POST', `/api/docs/${encodeURIComponent(doc)}/tables/${encodeURIComponent(table)}/records`, { records: fields.map((f) => ({ fields: f })) })) as { records?: Array<{ id: number }> } | null;
    return (r?.records || []).map((x) => x.id);
  }
  async update(doc: string, table: string, records: GristRecord[]): Promise<void> {
    await this.call('PATCH', `/api/docs/${encodeURIComponent(doc)}/tables/${encodeURIComponent(table)}/records`, { records });
  }

  // Attachments (patient photos). The file lives in the Grist doc; a row keeps it by an Attachments-type cell (['L', id]).
  async uploadAttachment(doc: string, filename: string, mime: string, bytes: Uint8Array): Promise<number> {
    const fd = new FormData();
    fd.append('upload', new Blob([bytes], { type: mime }), filename);
    const r = (await this.call('POST', `/api/docs/${encodeURIComponent(doc)}/attachments`, fd)) as number[] | null;
    if (!Array.isArray(r) || typeof r[0] !== 'number') throw new BackendError(502, 'backend_upload', 'The data backend did not accept the file');
    return r[0];
  }
  async downloadAttachment(doc: string, id: number): Promise<{ bytes: Uint8Array; mime: string }> {
    return (await this.call('GET', `/api/docs/${encodeURIComponent(doc)}/attachments/${id}/download`, undefined, true)) as { bytes: Uint8Array; mime: string };
  }

  // Schema (used only by the provisioning tool, and only to ADD): list / create tables and columns.
  async tableIds(doc: string): Promise<string[]> {
    const r = (await this.call('GET', `/api/docs/${encodeURIComponent(doc)}/tables`)) as { tables?: Array<{ id: string }> } | null;
    return (r?.tables || []).map((t) => t.id);
  }
  async columnIds(doc: string, table: string): Promise<string[]> {
    const r = (await this.call('GET', `/api/docs/${encodeURIComponent(doc)}/tables/${encodeURIComponent(table)}/columns`)) as { columns?: Array<{ id: string }> } | null;
    return (r?.columns || []).map((c) => c.id);
  }
  async createTable(doc: string, id: string, columns: Array<{ id: string; fields: Record<string, unknown> }>): Promise<void> {
    await this.call('POST', `/api/docs/${encodeURIComponent(doc)}/tables`, { tables: [{ id, columns }] });
  }
  async addColumns(doc: string, table: string, columns: Array<{ id: string; fields: Record<string, unknown> }>): Promise<void> {
    await this.call('POST', `/api/docs/${encodeURIComponent(doc)}/tables/${encodeURIComponent(table)}/columns`, { columns });
  }
}

// An in-memory Grist with the same records API: demo mode and tests run the real adapter against it.
export function memoryGrist(docs: Record<string, Record<string, GristRecord[]>>, opts: { columns?: Record<string, string[]>; failOn?: (method: string, table: string) => boolean } = {}): FetchLike & { docs: typeof docs; calls: Array<{ method: string; table: string; body?: unknown }> } {
  const calls: Array<{ method: string; table: string; body?: unknown }> = [];
  const nextId: Record<string, number> = {};
  const files: Array<{ bytes: Uint8Array; mime: string }> = [];
  const fn = (async (url: string, init: { method?: string; body?: string | FormData } = {}) => {
    const u = new URL(url, 'http://memory');
    const att = u.pathname.match(/\/api\/docs\/([^/]+)\/attachments(?:\/(\d+)\/download)?$/);
    if (att) {
      const method = (init.method || 'GET').toUpperCase();
      const raw = (status: number, bytes: Uint8Array | null, mime = '') => ({ ok: status < 400, status, json: async () => null, text: async () => '', arrayBuffer: async () => (bytes ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : new ArrayBuffer(0)) as ArrayBuffer, headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? mime : null) } });
      calls.push({ method, table: 'attachments' });
      if (opts.failOn && opts.failOn(method, 'attachments')) return raw(500, null);
      if (method === 'POST' && init.body instanceof FormData) {
        const f = init.body.get('upload') as File | null;
        if (!f) return raw(400, null);
        files.push({ bytes: new Uint8Array(await f.arrayBuffer()), mime: f.type });
        const id = files.length;
        return { ...raw(200, null), text: async () => JSON.stringify([id]), json: async () => [id] };
      }
      const f = method === 'GET' && att[2] ? files[Number(att[2]) - 1] : undefined;
      return f ? raw(200, f.bytes, f.mime) : raw(404, null);
    }
    const m = u.pathname.match(/\/api\/docs\/([^/]+)\/tables\/([^/]+)\/records$/);
    const method = (init.method || 'GET').toUpperCase();
    const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body, text: async () => (body === null ? '' : JSON.stringify(body)) });
    if (!m) return reply(404, { error: 'not found' });
    const doc = decodeURIComponent(m[1]); const table = decodeURIComponent(m[2]);
    calls.push({ method, table, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
    if (opts.failOn && opts.failOn(method, table)) return reply(500, { error: 'injected failure' });
    if (!docs[doc]) return reply(404, { error: `no doc ${doc}` });
    if (!docs[doc][table]) return reply(404, { error: `no table ${table}` });
    const rows = docs[doc][table];
    const cols = opts.columns && opts.columns[table];
    const checkCols = (f: Record<string, unknown>) => { if (cols) for (const k of Object.keys(f)) if (!cols.includes(k)) throw new Error(`invalid column ${table}.${k}`); };
    try {
      if (method === 'GET') {
        let out = rows.slice();
        const filter = u.searchParams.get('filter');
        if (filter) for (const [col, vals] of Object.entries(JSON.parse(filter) as Record<string, unknown[]>)) out = out.filter((r) => vals.includes(col === 'id' ? r.id : (r.fields[col] ?? null)));
        const sort = u.searchParams.get('sort');
        if (sort) { const desc = sort.startsWith('-'); const col = sort.replace(/^-/, ''); out.sort((a, b) => ((Number(a.fields[col]) || 0) - (Number(b.fields[col]) || 0)) * (desc ? -1 : 1)); }
        const limit = Number(u.searchParams.get('limit') || 0);
        if (limit) out = out.slice(0, limit);
        return reply(200, { records: JSON.parse(JSON.stringify(out)) });
      }
      const body = JSON.parse((init.body as string) || '{}') as { records: Array<{ id?: number; fields: Record<string, unknown> }> };
      if (method === 'POST') {
        const key = `${doc}.${table}`;
        const ids = body.records.map((r) => {
          checkCols(r.fields);
          nextId[key] = (nextId[key] || Math.max(0, ...rows.map((x) => x.id))) + 1;
          rows.push({ id: nextId[key], fields: { ...(r.fields as Record<string, GristValue>) } });
          return { id: nextId[key] };
        });
        return reply(200, { records: ids });
      }
      if (method === 'PATCH') {
        for (const r of body.records) {
          checkCols(r.fields);
          const row = rows.find((x) => x.id === r.id);
          if (!row) return reply(400, { error: `no row ${r.id}` });
          Object.assign(row.fields, r.fields);
        }
        return reply(200, null);
      }
      return reply(405, { error: method });
    } catch (e) {
      return reply(400, { error: (e as Error).message });
    }
  }) as FetchLike & { docs: typeof docs; calls: typeof calls };
  fn.docs = docs;
  fn.calls = calls;
  return fn;
}
