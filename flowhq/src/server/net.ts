// Who is calling, for rate limits. Behind the production reverse proxy (Caddy) the socket address is always the proxy, so the real client is the
// LAST entry of X-Forwarded-For: the address the proxy itself appended (Caddy replaces a client-supplied header; anything a client puts BEFORE
// that entry is ignored, so rotating a fake address does not dodge a limit). With no proxy in front (FLOWHQ_TRUST_PROXY=false) the header is ignored
// entirely and the socket address is used. Calls from inside the Docker network (n8n -> flowhq) carry no header: they share the container address.
import type { Context } from 'hono';

export function clientKey(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const last = (c.req.header('x-forwarded-for') || '').split(',').map((s) => s.trim()).filter(Boolean).pop();
    if (last) return last.slice(0, 64);
  }
  const sock = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress;
  return typeof sock === 'string' && sock ? sock : 'local';
}

/**
 * Reads a request body as text, but never more than `max` bytes. Returns null when the body is bigger (the caller answers 413).
 * The limit is enforced on the bytes actually RECEIVED, not on the Content-Length header: a chunked request has no such header, and a client can lie in it.
 * (Found in the Slice 4 security review: the earlier check trusted the header, so a chunked body was read without any cap.)
 */
export async function readBodyLimited(c: Context, max: number): Promise<string | null> {
  if (Number(c.req.header('content-length') || 0) > max) return null;          // an honest oversized request is refused without reading it
  const stream = c.req.raw.body;
  if (!stream) return '';
  const reader = stream.getReader();
  const chunks: Uint8Array[] = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => undefined); return null; }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
