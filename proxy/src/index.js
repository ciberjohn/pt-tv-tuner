// PT TV Tuner — zero-dependency HLS proxy (hardened).
// Fetches a channel's upstream playlist with browser-like headers, rewrites every
// child URI back through /seg, and streams segments through. Same-origin for the
// browser, so no CORS/Referer problems.
//
// Hardening applied after an independent DevSecOps review:
//  - redirects handled manually and re-validated on every hop (no allowlist bypass)
//  - https only, allowlisted hosts only, private/link-local IPs refused
//  - malformed input can never crash the process (per-request try/catch + handlers)
//  - upstream body size caps; content-type allowlist
//  - GET/HEAD only; no wildcard CORS (same-origin app does not need it)
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';

const PORT = Number(process.env.PORT || 3000);
const CHANNELS_FILE = process.env.CHANNELS_FILE || '/app/data/channels.json';
const UA =
  process.env.UPSTREAM_UA ||
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const REFERER = process.env.UPSTREAM_REFERER || 'https://www.rtp.pt/play/direto';
const TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 15000);
const MAX_REDIRECTS = 3;
const MAX_PLAYLIST = 4 * 1024 * 1024;
const MAX_SEGMENT = 64 * 1024 * 1024;

// Only these registrable domains may be fetched (SSRF guard).
const ALLOW = (process.env.ALLOW_HOSTS || 'rtp.pt,iol.pt,impresa.pt,githubusercontent.com,bauermedia.pt,sharp-stream.com,streamtheworld.com,tsf.pt')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const PLAYLIST_TYPES = ['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl'];
const SAFE_TYPES = new Set([
  ...PLAYLIST_TYPES,
  'video/mp2t',
  'video/mp4',
  'audio/aac',
  'audio/mp4',
  'audio/mpeg',
  'image/jpeg',
  'image/png',
  'application/octet-stream',
]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function hostAllowed(host) {
  host = (host || '').toLowerCase();
  return ALLOW.some((s) => host === s || host.endsWith('.' + s));
}

function isPrivateIp(host) {
  if (!isIP(host)) return false;
  if (host.includes(':')) {
    const h = host.toLowerCase();
    return h === '::' || h === '::1' || h.startsWith('fe80') || h.startsWith('fc') || h.startsWith('fd');
  }
  const p = host.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return false;
  if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true;
  if (p[0] === 169 && p[1] === 254) return true; // link-local + 169.254.169.254 metadata
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT
  return false;
}

function validate(urlStr) {
  let u;
  try {
    u = new URL(urlStr);
  } catch {
    return { err: 'bad url', status: 400 };
  }
  if (u.protocol !== 'https:') return { err: 'https only', status: 403 };
  if (u.port && u.port !== '443') return { err: 'bad port', status: 403 };
  if (!hostAllowed(u.hostname)) return { err: 'host not allowed', status: 403 };
  if (isPrivateIp(u.hostname)) return { err: 'host not allowed', status: 403 };
  return { u };
}

let CATALOG = [];
try {
  const raw = JSON.parse(readFileSync(CHANNELS_FILE, 'utf8'));
  CATALOG = Array.isArray(raw) ? raw : raw.channels || [];
  console.log(`[catalog] loaded ${CATALOG.length} channels`);
} catch (e) {
  console.error('[catalog] failed to load:', e.message);
}
const BY_ID = new Map(CATALOG.map((c) => [c.id, c]));

const enc = (u) => Buffer.from(u, 'utf8').toString('base64url');
const dec = (s) => Buffer.from(s, 'base64url').toString('utf8');
const toProxy = (abs) => '/seg?u=' + enc(abs);

function absolutize(uri, base) {
  try {
    const abs = new URL(uri, base);
    const b = new URL(base);
    // Some broadcasters (e.g. bauermedia) carry a session token in the playlist
    // query; a relative child URL would drop it and get a 403. Carry it forward
    // when the child has no query of its own.
    if (b.search && !abs.search && abs.host === b.host) abs.search = b.search;
    return abs.href;
  } catch {
    return null;
  }
}

function rewritePlaylist(text, base) {
  return text
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) {
        // Rewrite URI="..." inside tags (EXT-X-KEY, EXT-X-MAP, EXT-X-MEDIA, ...)
        return line.replace(/URI="([^"]+)"/g, (m, u) => {
          const abs = absolutize(u, base);
          return abs ? `URI="${toProxy(abs)}"` : m;
        });
      }
      const abs = absolutize(t, base);
      return abs ? toProxy(abs) : line;
    })
    .join('\n');
}

function upstreamHeaders() {
  return {
    'User-Agent': UA,
    Referer: REFERER,
    Accept: '*/*',
    'Accept-Language': 'pt-PT,pt;q=0.9,en;q=0.8',
  };
}

// Follow up to MAX_REDIRECTS, re-validating scheme/host/port on EVERY hop.
async function fetchFollow(urlStr) {
  let cur = urlStr;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const v = validate(cur);
    if (v.err) throw new HttpError(v.status, v.err);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let up;
    try {
      up = await fetch(cur, { headers: upstreamHeaders(), redirect: 'manual', signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if ([301, 302, 303, 307, 308].includes(up.status)) {
      const loc = up.headers.get('location');
      if (!loc) throw new HttpError(502, 'bad redirect');
      cur = new URL(loc, cur).href; // re-validated at the top of the next loop
      continue;
    }
    return { up, finalUrl: cur };
  }
  throw new HttpError(502, 'too many redirects');
}

function send(res, status, headers, body, method) {
  res.writeHead(status, { 'Cache-Control': 'no-cache', ...headers });
  res.end(method === 'HEAD' ? undefined : body);
}

function safeContentType(ct) {
  const base = (ct || '').split(';')[0].trim().toLowerCase();
  return SAFE_TYPES.has(base) ? ct : 'application/octet-stream';
}

// Core: fetch a URL and either rewrite it as a playlist or stream it as bytes.
async function serveUrl(rawUrl, res, method) {
  try {
    const { up, finalUrl } = await fetchFollow(rawUrl);
    if (!up.ok) throw new HttpError(502, 'upstream status ' + up.status);

    const ct = (up.headers.get('content-type') || '').toLowerCase();
    const isPlaylistHint = PLAYLIST_TYPES.some((t) => ct.includes(t)) || ct.includes('m3u');
    const declared = Number(up.headers.get('content-length') || 0);
    const cap = isPlaylistHint ? MAX_PLAYLIST : MAX_SEGMENT;
    if (declared && declared > cap) throw new HttpError(502, 'upstream too large');

    const buf = Buffer.from(await up.arrayBuffer());
    if (buf.length > cap) throw new HttpError(502, 'upstream too large');

    const head = buf.subarray(0, 7).toString('latin1');
    const isPlaylist = isPlaylistHint || head === '#EXTM3U' || buf.includes('#EXTM3U');
    if (isPlaylist) {
      const out = rewritePlaylist(buf.toString('utf8'), up.url || finalUrl);
      return send(res, 200, { 'Content-Type': 'application/vnd.apple.mpegurl' }, out, method);
    }
    return send(res, 200, { 'Content-Type': safeContentType(ct) }, buf, method);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 502;
    // Never leak internal hostnames / resolver text to the client.
    if (!(e instanceof HttpError)) console.error('[proxy] upstream error:', e.message);
    return send(
      res,
      status,
      { 'Content-Type': 'text/plain' },
      status === 403 ? 'forbidden' : 'upstream error',
      method,
    );
  }
}

// Streaming passthrough for non-HLS stations (ICY/MP3), piped rather than buffered.
async function serveLive(rawUrl, res, method) {
  try {
    const { up } = await fetchFollow(rawUrl);
    if (!up.ok || !up.body) throw new HttpError(502, 'upstream status ' + up.status);
    let ct = up.headers.get('content-type') || 'audio/mpeg';
    if (/aacp/i.test(ct)) ct = 'audio/aac';
    res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'no-cache', 'Accept-Ranges': 'none' });
    if (method === 'HEAD') {
      res.end();
      return;
    }
    const body = Readable.fromWeb(up.body);
    body.on('error', () => {
      try {
        res.destroy();
      } catch {
        /* gone */
      }
    });
    res.on('close', () => {
      try {
        body.destroy();
      } catch {
        /* gone */
      }
    });
    body.pipe(res);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 502;
    if (!(e instanceof HttpError)) console.error('[proxy] live error:', e.message);
    try {
      send(res, status, { 'Content-Type': 'text/plain' }, status === 403 ? 'forbidden' : 'upstream error', method);
    } catch {
      /* gone */
    }
  }
}

const server = http.createServer(async (req, res) => {
  const method = req.method || 'GET';
  try {
    if (method === 'OPTIONS') {
      return send(res, 204, {}, '', method);
    }
    if (method !== 'GET' && method !== 'HEAD') {
      return send(res, 405, { 'Content-Type': 'text/plain', Allow: 'GET, HEAD' }, 'method not allowed', method);
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname;

    if (path === '/health') {
      return send(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: true, channels: CATALOG.length }), method);
    }

    if (path === '/channels') {
      const pub = CATALOG.map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        group: c.group,
        region: c.region,
        kind: c.kind || 'hls',
      }));
      return send(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify(pub), method);
    }

    if (path.startsWith('/stream/')) {
      let id;
      try {
        id = decodeURIComponent(path.slice('/stream/'.length));
      } catch {
        return send(res, 400, { 'Content-Type': 'text/plain' }, 'bad channel id', method);
      }
      const ch = BY_ID.get(id);
      if (!ch) return send(res, 404, { 'Content-Type': 'text/plain' }, 'unknown channel', method);
      return await serveUrl(ch.source, res, method);
    }

    if (path === '/seg') {
      const u = url.searchParams.get('u');
      if (!u) return send(res, 400, { 'Content-Type': 'text/plain' }, 'missing u', method);
      let abs;
      try {
        abs = dec(u);
      } catch {
        return send(res, 400, { 'Content-Type': 'text/plain' }, 'bad u', method);
      }
      return await serveUrl(abs, res, method);
    }

    if (path.startsWith('/live/')) {
      let id;
      try {
        id = decodeURIComponent(path.slice('/live/'.length));
      } catch {
        return send(res, 400, { 'Content-Type': 'text/plain' }, 'bad channel id', method);
      }
      const ch = BY_ID.get(id);
      if (!ch) return send(res, 404, { 'Content-Type': 'text/plain' }, 'unknown channel', method);
      return await serveLive(ch.source, res, method);
    }

    if (path === '/') return send(res, 200, { 'Content-Type': 'text/plain' }, 'PT TV Tuner proxy', method);
    return send(res, 404, { 'Content-Type': 'text/plain' }, 'not found', method);
  } catch (e) {
    console.error('[proxy] handler error:', e && e.message);
    try {
      send(res, 500, { 'Content-Type': 'text/plain' }, 'internal error', method);
    } catch {
      /* response already gone */
    }
  }
});

// A single bad request must never terminate the whole streaming service.
process.on('unhandledRejection', (e) => console.error('[proxy] unhandledRejection:', e && e.message));
process.on('uncaughtException', (e) => console.error('[proxy] uncaughtException:', e && e.message));

server.listen(PORT, '0.0.0.0', () => console.log(`[proxy] listening on :${PORT}`));
