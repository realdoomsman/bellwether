import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { brotliDecompressSync } from 'node:zlib';
import { Hono } from 'hono';
import type { AppEnv } from './app.ts';
import { serveWeb } from './web.ts';

const dir = mkdtempSync(path.join(tmpdir(), 'bellwether-web-'));
after(() => rmSync(dir, { recursive: true, force: true }));
mkdirSync(path.join(dir, 'assets'));
writeFileSync(path.join(dir, 'index.html'), '<meta property="og:image" content="__SITE_ORIGIN__/og.png">');
const bundle = `console.log(${JSON.stringify('x'.repeat(4000))});`;
writeFileSync(path.join(dir, 'assets', 'index-abc123.js'), bundle);
writeFileSync(path.join(dir, 'og.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

function web(opts: { publicUrl?: string; trustProxy?: boolean } = {}) {
  const app = new Hono<AppEnv>();
  serveWeb(app, { dir, publicUrl: opts.publicUrl ?? null, trustProxy: opts.trustProxy ?? false });
  return app;
}

test('SPA routes get index.html with the request origin; file-like misses are real 404s', async () => {
  const app = web();
  const page = await app.request('http://bellwether.test/t/0xabc');
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-cache');
  assert.equal(await page.text(), '<meta property="og:image" content="http://bellwether.test/og.png">');

  for (const miss of ['/assets/index-old999.js', '/missing.png']) {
    const res = await app.request(`http://bellwether.test${miss}`);
    assert.equal(res.status, 404, miss);
    assert.doesNotMatch(res.headers.get('content-type') ?? '', /html/);
  }
});

test('hashed assets are immutable, compressed on request, and revalidate by ETag', async () => {
  const app = web();
  const br = await app.request('http://bellwether.test/assets/index-abc123.js', { headers: { 'accept-encoding': 'gzip, br' } });
  assert.equal(br.headers.get('content-encoding'), 'br');
  assert.equal(br.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(brotliDecompressSync(Buffer.from(await br.arrayBuffer())).toString(), bundle);

  const plain = await app.request('http://bellwether.test/assets/index-abc123.js');
  assert.equal(plain.headers.get('content-encoding'), null);
  assert.equal(await plain.text(), bundle);

  const again = await app.request('http://bellwether.test/assets/index-abc123.js', { headers: { 'if-none-match': plain.headers.get('etag')! } });
  assert.equal(again.status, 304);
});

test('origin comes from PUBLIC_URL, trusted proxy headers, or a validated Host; never raw attacker input', async () => {
  const fixed = await web({ publicUrl: 'https://bellwether.fun' }).request('http://internal:8080/', { headers: { host: 'evil.test' } });
  assert.match(await fixed.text(), /content="https:\/\/bellwether\.fun\/og\.png"/);

  const proxied = await web({ trustProxy: true }).request('http://internal:8080/', {
    headers: { 'x-forwarded-host': 'bellwether-production.up.railway.app', 'x-forwarded-proto': 'https' },
  });
  assert.match(await proxied.text(), /content="https:\/\/bellwether-production\.up\.railway\.app\/og\.png"/);

  const untrusted = await web().request('http://internal:8080/', { headers: { 'x-forwarded-host': 'evil.test' } });
  assert.doesNotMatch(await untrusted.text(), /evil/);

  const injected = await web({ trustProxy: true }).request('http://internal:8080/', { headers: { 'x-forwarded-host': '"><script>alert(1)</script>' } });
  assert.equal(await injected.text(), '<meta property="og:image" content="/og.png">');
});
