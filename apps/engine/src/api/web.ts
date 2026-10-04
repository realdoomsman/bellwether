/**
 * Serves the built web app (single-service deploy): every file is loaded and pre-compressed once at
 * startup, hashed `/assets/*` are cached forever, `index.html` is never cached and gets absolute
 * social-card URLs for the request's origin, unknown paths without an extension fall back to the SPA.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { brotliCompressSync, constants as zlib, gzipSync } from 'node:zlib';
import type { Context, Hono } from 'hono';
import { log } from '../log.ts';
import type { AppEnv } from './app.ts';

/** Placeholder in apps/web/index.html replaced with the site origin (e.g. `https://bellwether.fun`). */
export const ORIGIN_PLACEHOLDER = '__SITE_ORIGIN__';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.woff2': 'font/woff2',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.avif': 'image/avif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.vtt': 'text/vtt; charset=utf-8',
};
const COMPRESSIBLE = /^(text\/|application\/(json|manifest\+json|xml)|image\/svg\+xml)/;
/** Source maps are only fetched by devtools; brotli-11 on them would dominate startup time. */
const SKIP_PRECOMPRESS = /\.map$/;
const MIN_COMPRESS_BYTES = 1024;

/** Bodies are copied once into plain ArrayBuffer-backed arrays so responses can reuse them without copying. */
interface Asset {
  body: Uint8Array<ArrayBuffer>;
  br: Uint8Array<ArrayBuffer> | null;
  gzip: Uint8Array<ArrayBuffer> | null;
  type: string;
  etag: string;
  cacheControl: string;
}

export interface WebOptions {
  dir: string;
  /** Fixed public origin (PUBLIC_URL). Null = derive from each request. */
  publicUrl: string | null;
  trustProxy: boolean;
}

export function serveWeb(app: Hono<AppEnv>, opts: WebOptions): void {
  const indexPath = path.join(opts.dir, 'index.html');
  if (!existsSync(indexPath)) return;

  const assets: Record<string, Asset> = {};
  for (const file of walk(opts.dir)) {
    const rel = `/${path.relative(opts.dir, file).split(path.sep).join('/')}`;
    if (rel === '/index.html') continue;
    const type = CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    const cacheControl = rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600';
    assets[rel] = asset(readFileSync(file), type, cacheControl, !SKIP_PRECOMPRESS.test(rel));
  }

  // index.html varies only by origin. Memoize a few (custom domain + railway URL); the Host header is
  // client-controlled, so the cache is capped rather than keyed by arbitrary input forever, and origins
  // past the cap are served uncompressed (2 KB, no-cache) instead of paying brotli-11 per request.
  const indexTemplate = readFileSync(indexPath, 'utf8');
  const indexByOrigin: Record<string, Asset> = {};
  let memoized = 0;
  const indexFor = (origin: string): Asset => {
    const hit = indexByOrigin[origin];
    if (hit) return hit;
    const memoize = memoized < 16;
    const built = asset(Buffer.from(indexTemplate.replaceAll(ORIGIN_PLACEHOLDER, origin)), CONTENT_TYPES['.html']!, 'no-cache', memoize);
    if (memoize) {
      indexByOrigin[origin] = built;
      memoized++;
    }
    return built;
  };

  // With a fixed public origin, page requests on any other host (www, the Railway URL) redirect to it: one
  // address in the bar, in shared links and in the settings message creators sign. API routes are mounted
  // before this handler, so health checks and clients on other hosts are unaffected; assets stay served.
  const canonicalHost = opts.publicUrl ? new URL(opts.publicUrl).host : null;
  app.on(['GET', 'HEAD'], '*', (c) => {
    const found = Object.hasOwn(assets, c.req.path) ? assets[c.req.path] : undefined;
    if (found) return send(c, found);
    // Missing hashed asset or any other file-looking path: a real 404, never the SPA shell
    // (a stale chunk served as HTML fails with a confusing MIME error instead of a clean retry).
    if (c.req.path.startsWith('/assets/') || path.extname(c.req.path) !== '') return c.text('Not found', 404);
    if (canonicalHost) {
      const host = (opts.trustProxy ? c.req.header('x-forwarded-host')?.split(',')[0]?.trim() : undefined) || c.req.header('host') || new URL(c.req.url).host;
      if (host.toLowerCase() !== canonicalHost && HOST.test(host)) {
        const url = new URL(c.req.url);
        return c.redirect(`${opts.publicUrl}${url.pathname}${url.search}`, 301);
      }
    }
    return send(c, indexFor(requestOrigin(c, opts)));
  });
  log.info('serving web app', { dir: opts.dir, files: Object.keys(assets).length + 1 });
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

function asset(body: Buffer, type: string, cacheControl: string, precompress = true): Asset {
  const compress = precompress && COMPRESSIBLE.test(type) && body.length >= MIN_COMPRESS_BYTES;
  return {
    body: new Uint8Array(body),
    br: compress ? new Uint8Array(brotliCompressSync(body, { params: { [zlib.BROTLI_PARAM_QUALITY]: 11, [zlib.BROTLI_PARAM_SIZE_HINT]: body.length } })) : null,
    gzip: compress ? new Uint8Array(gzipSync(body, { level: 9 })) : null,
    type,
    etag: `"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`,
    cacheControl,
  };
}

function send(c: Context<AppEnv>, a: Asset): Response {
  const headers: Record<string, string> = { 'Content-Type': a.type, 'Cache-Control': a.cacheControl, ETag: a.etag };
  if (a.br || a.gzip) headers.Vary = 'Accept-Encoding';
  else headers['Accept-Ranges'] = 'bytes';
  if (c.req.header('if-none-match') === a.etag) return c.body(null, 304, headers);
  const accept = c.req.header('accept-encoding') ?? '';
  let body = a.body;
  if (a.br && /\bbr\b/.test(accept)) {
    body = a.br;
    headers['Content-Encoding'] = 'br';
  } else if (a.gzip && /\bgzip\b/.test(accept)) {
    body = a.gzip;
    headers['Content-Encoding'] = 'gzip';
  }

  // Byte ranges (media seeking; Safari refuses to play video without them). Only for identity-encoded assets,
  // only a single range, and only when If-Range (if sent) still matches.
  const rangeHeader = !headers['Content-Encoding'] ? c.req.header('range') : undefined;
  const ifRange = c.req.header('if-range');
  if (rangeHeader && (!ifRange || ifRange === a.etag)) {
    const range = parseRange(rangeHeader, body.length);
    if (range === 'unsatisfiable') {
      headers['Content-Range'] = `bytes */${body.length}`;
      return c.body(null, 416, headers);
    }
    if (range) {
      headers['Content-Range'] = `bytes ${range.start}-${range.end}/${body.length}`;
      headers['Content-Length'] = String(range.end - range.start + 1);
      if (c.req.method === 'HEAD') return c.body(null, 206, headers);
      return c.body(body.subarray(range.start, range.end + 1), 206, headers);
    }
  }

  headers['Content-Length'] = String(body.length);
  if (c.req.method === 'HEAD') return c.body(null, 200, headers);
  return c.body(body, 200, headers);
}

/** Parses a single `bytes=` range (RFC 9110 §14.1.2). Null means "ignore and send the whole body" (multi-range, other units, garbage). */
export function parseRange(header: string, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || end < start) return 'unsatisfiable';
  return { start, end };
}

const HOST = /^[a-z0-9.-]+(:\d{1,5})?$/i;

/** Origin for absolute social-card URLs. Host headers are client-controlled, so they are validated before use. */
export function requestOrigin(c: Context<AppEnv>, opts: Pick<WebOptions, 'publicUrl' | 'trustProxy'>): string {
  if (opts.publicUrl) return opts.publicUrl;
  const forwardedHost = opts.trustProxy ? c.req.header('x-forwarded-host')?.split(',')[0]?.trim() : undefined;
  const forwardedProto = opts.trustProxy ? c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() : undefined;
  const url = new URL(c.req.url);
  const host = forwardedHost || c.req.header('host') || url.host;
  const proto = forwardedProto === 'https' || forwardedProto === 'http' ? forwardedProto : url.protocol.slice(0, -1);
  return HOST.test(host) ? `${proto}://${host}` : '';
}
