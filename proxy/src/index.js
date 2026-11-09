// PT TV Tuner — zero-dependency HLS proxy.
// Fetches a channel's upstream playlist with browser-like headers, rewrites every
// child URI (variant playlists, keys, maps, segments) to route back through /seg,
// and streams segments through. Same-origin for the browser, so no CORS/Referer
// problems, and the upstream host allowlist keeps it from being an SSRF gadget.
import http from 'node:http';
import { readFileSync } from 'node:fs';

const PORT = Number(process.env.PORT || 3000);
const CHANNELS_FILE = process.env.CHANNELS_FILE || '/app/data/channels.json';
const UA =
  process.env.UPSTREAM_UA ||
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const REFERER = process.env.UPSTREAM_REFERER || 'https://www.rtp.pt/play/direto';
const TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 15000);

// Only these registrable domains may be fetched (SSRF guard).
const ALLOW = (process.env.ALLOW_HOSTS ||
  'rtp.pt,iol.pt,impresa.pt,githubusercontent.com')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

function hostAllowed(host) {
  host = (host || '').toLowerCase();
  return ALLOW.some((s) => host === s || host.endsWith('.' + s));
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
    return new URL(uri, base).href;
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

async function fetchUpstream(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { headers: upstreamHeaders(), redirect: 'follow', signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function send(res, status, headers, body) {
  res.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
    ...headers,
  });
  res.end(body);
}

// Core: fetch a URL and either rewrite it as a playlist or stream it as bytes.
async function serveUrl(rawUrl, res) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return send(res, 400, { 'Content-Type': 'text/plain' }, 'bad url');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return send(res, 400, { 'Content-Type': 'text/plain' }, 'bad protocol');
  }
  if (!hostAllowed(parsed.hostname)) {
    return send(res, 403, { 'Content-Type': 'text/plain' }, 'host not allowed');
  }

  let up;
  try {
    up = await fetchUpstream(parsed.href);
  } catch (e) {
    return send(res, 502, { 'Content-Type': 'text/plain' }, 'upstream error: ' + e.message);
  }
  if (!up.ok) {
    return send(res, 502, { 'Content-Type': 'text/plain' }, 'upstream status ' + up.status);
  }

  const ct = (up.headers.get('content-type') || '').toLowerCase();
  const buf = Buffer.from(await up.arrayBuffer());
  const head = buf.subarray(0, 7).toString('latin1');

  const isPlaylist =
    ct.includes('mpegurl') || ct.includes('m3u') || head === '#EXTM3U' || buf.includes('#EXTM3U');

  if (isPlaylist) {
    const text = buf.toString('utf8');
    const out = rewritePlaylist(text, up.url || parsed.href);
    return send(res, 200, { 'Content-Type': 'application/vnd.apple.mpegurl' }, out);
  }

  // Segment / key / binary — pass through, preserving type.
  return send(res, 200, { 'Content-Type': ct || 'application/octet-stream' }, buf);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  if (req.method === 'OPTIONS') {
    return send(res, 204, {
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    });
  }

  if (path === '/health') {
    return send(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: true, channels: CATALOG.length }));
  }

  if (path === '/channels') {
    const pub = CATALOG.map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      group: c.group,
      region: c.region,
    }));
    return send(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify(pub));
  }

  if (path.startsWith('/stream/')) {
    const id = decodeURIComponent(path.slice('/stream/'.length));
    const ch = BY_ID.get(id);
    if (!ch) return send(res, 404, { 'Content-Type': 'text/plain' }, 'unknown channel: ' + id);
    return serveUrl(ch.source, res);
  }

  if (path === '/seg') {
    const u = url.searchParams.get('u');
    if (!u) return send(res, 400, { 'Content-Type': 'text/plain' }, 'missing u');
    let abs;
    try {
      abs = dec(u);
    } catch {
      return send(res, 400, { 'Content-Type': 'text/plain' }, 'bad u');
    }
    return serveUrl(abs, res);
  }

  if (path === '/') return send(res, 200, { 'Content-Type': 'text/plain' }, 'PT TV Tuner proxy');
  return send(res, 404, { 'Content-Type': 'text/plain' }, 'not found');
});

server.listen(PORT, '0.0.0.0', () => console.log(`[proxy] listening on :${PORT}`));
