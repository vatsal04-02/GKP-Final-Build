// The only way the web app talks to anything: its own server (/api). No backend URL or key exists in the browser.
export class ApiError extends Error { constructor(public status: number, public code: string, message: string, public data: Record<string, unknown> | null = null) { super(message); } }

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method || 'GET',
    credentials: 'same-origin',
    headers: { Accept: 'application/json', ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(init.method && init.method !== 'GET' ? { 'x-flowhq-csrf': '1' } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = (data && data.error) || {};
    if (res.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new CustomEvent('fhq:signed-out'));
    throw new ApiError(res.status, e.code || 'error', e.message || `Request failed (${res.status})`, data);
  }
  return data as T;
}
// A file upload (multipart). Still only talks to our own /api.
export async function apiUpload<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(`/api${path}`, { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json', 'x-flowhq-csrf': '1' }, body: form });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) { const e = (data && data.error) || {}; throw new ApiError(res.status, e.code || 'error', e.message || `Upload failed (${res.status})`, data); }
  return data as T;
}
export const ws = (id: string, path: string) => `/w/${encodeURIComponent(id)}${path}`;
