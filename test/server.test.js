// The upload UI's server: post a page, poll the job, fetch the video.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '../server.js';

const outDir = mkdtempSync(join(tmpdir(), 'demomaker-out-'));
const fixture = readFileSync(fileURLToPath(new URL('./fixture.html', import.meta.url)));
let server, base;

before(async () => {
  server = await serve({ port: 0, outDir });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); server.closeAllConnections(); rmSync(outDir, { recursive: true, force: true }); });

const post = (query, body, headers = { 'x-demomaker': '1' }) => fetch(`${base}/api/render?${query}`, { method: 'POST', body, headers });
async function finished(id) {
  for (;;) {
    const job = await (await fetch(`${base}/api/jobs/${id}`)).json();
    if (job.state === 'done' || job.state === 'error') return job;
    await new Promise(r => setTimeout(r, 300));
  }
}

test('serves the upload page', async () => {
  const res = await fetch(base);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(await res.text(), /DemoMaker/);
});

test('turns an uploaded page into a playable, seekable video saved in the output folder', async () => {
  const res = await post('name=My%20Site.html&quality=draft&ratio=1:1&pace=0.5', fixture);
  assert.equal(res.status, 202);
  const job = await finished((await res.json()).id);
  assert.equal(job.state, 'done', job.error);
  assert.equal(job.progress, 1);
  assert.match(job.file, /^My-Site-.*\.mp4$/);
  assert.ok(existsSync(join(outDir, job.file)));

  const video = await fetch(`${base}/api/jobs/${job.id}/video`);
  assert.equal(video.status, 200);
  assert.equal(video.headers.get('content-type'), 'video/mp4');
  const bytes = Buffer.from(await video.arrayBuffer());
  assert.equal(bytes.subarray(4, 8).toString(), 'ftyp');

  const part = await fetch(`${base}/api/jobs/${job.id}/video`, { headers: { range: 'bytes=100-199' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 100-199/${bytes.length}`);
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), bytes.subarray(100, 200));
}, { timeout: 180000 });

test('rejects bad requests with a reason, before any rendering starts', async () => {
  const bad = await post('name=a.html&quality=nope', fixture);
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /quality/i);
  assert.equal((await post('name=a.html', '')).status, 400, 'empty upload');
  assert.equal((await fetch(`${base}/api/jobs/nope`)).status, 404);
  assert.equal((await fetch(`${base}/api/jobs/nope/video`)).status, 404);
  assert.equal(readdirSync(outDir).filter(f => f.startsWith('a-')).length, 0);
});

test('only takes uploads from its own page', async () => {
  assert.equal((await post('name=a.html&quality=draft', fixture, {})).status, 403, 'a cross-site form post carries no custom header');
  // fetch will not send a made-up Host header, so this one goes out by hand.
  const status = await new Promise((ok, fail) => {
    const req = request(`${base}/api/render?name=a.html&quality=draft`, { method: 'POST', headers: { 'x-demomaker': '1', host: 'evil.example' } }, res => { res.resume(); ok(res.statusCode); });
    req.on('error', fail).end(fixture);
  });
  assert.equal(status, 403, 'DNS rebinding arrives with a foreign Host');
});

test('refuses uploads too large to be a page', async () => {
  const res = await post('name=a.html&quality=draft', Buffer.alloc(41 * 1024 * 1024, 32)).catch(e => e);
  assert.ok(res instanceof Error || res.status === 413, 'either the server answers 413 or it cuts the connection');
});
