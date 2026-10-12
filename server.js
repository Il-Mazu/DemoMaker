// The upload page's server: post an HTML page, poll the job, fetch the video. Listens on this machine only.
import { randomUUID } from 'node:crypto';
import { createReadStream, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, resolveOptions } from './render.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAX_UPLOAD = 40 * 1024 * 1024;
const OPTIONS = ['ratio', 'quality', 'background', 'chrome', 'scheme', 'pace', 'zoom', 'address', 'siteWidth'];
const PAGES = { '/': ['ui.html', 'text/html; charset=utf-8'], '/director.js': ['director.js', 'text/javascript'] };

const json = (res, status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

/** Start the upload UI. Videos are written to `outDir`. Resolves to the listening http.Server. */
export function serve({ port = 4173, outDir = join(process.cwd(), 'output') } = {}) {
  const jobs = new Map();
  let queue = Promise.resolve();  // one render at a time

  async function upload(req, res, url) {
    // A custom header cannot be sent from another site without a CORS preflight, which is never granted here.
    if (req.headers['x-demomaker'] !== '1') return json(res, 403, { error: 'Forbidden' });
    const chunks = [];
    let size = Number(req.headers['content-length']) > MAX_UPLOAD ? Infinity : 0;
    if (size === 0) for await (const chunk of req) { chunks.push(chunk); if ((size += chunk.length) > MAX_UPLOAD) break; }
    if (size > MAX_UPLOAD) { res.writeHead(413, { 'content-type': 'application/json', connection: 'close' }).end(JSON.stringify({ error: 'That file is too large to be a page (40 MB limit)' })); return; }
    if (!size) return json(res, 400, { error: 'No file received' });

    const name = basename(url.searchParams.get('name') || '').replace(/\.html?$/i, '').replace(/[^\w.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'page';
    const now = new Date(), two = n => String(n).padStart(2, '0');  // local time: it is the user reading these names
    const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
    const job = { id: randomUUID(), state: 'queued', progress: 0, frames: 0, file: `${name}-${stamp}.mp4` };
    const dir = mkdtempSync(join(tmpdir(), 'demomaker-upload-'));
    let options;
    try {
      writeFileSync(join(dir, `${name}.html`), Buffer.concat(chunks));
      options = resolveOptions({
        ...Object.fromEntries(OPTIONS.map(k => [k, url.searchParams.get(k) ?? undefined])),
        input: join(dir, `${name}.html`), output: join(outDir, job.file),
      });
    } catch (e) {
      rmSync(dir, { recursive: true, force: true });
      return json(res, 400, { error: e.message });
    }

    jobs.set(job.id, job);
    queue = queue.then(async () => {
      job.state = 'rendering';
      try {
        const done = await render({ ...options, onProgress: p => { job.frames = p.frames; job.progress = Math.min(p.progress, 0.99); } });
        Object.assign(job, { state: 'done', progress: 1, frames: done.frames, seconds: done.seconds, path: done.output });
      } catch (e) {
        Object.assign(job, { state: 'error', error: e.message });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
    json(res, 202, { id: job.id });
  }

  // Byte ranges, so the browser's player can seek.
  function video(req, res, job, url) {
    const size = statSync(job.path).size;
    const head = { 'content-type': 'video/mp4', 'accept-ranges': 'bytes' };
    if (url.searchParams.has('download')) head['content-disposition'] = `attachment; filename="${job.file}"`;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (!range || (!range[1] && !range[2])) {
      res.writeHead(200, { ...head, 'content-length': size });
      return createReadStream(job.path).pipe(res);
    }
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end) return res.writeHead(416, { 'content-range': `bytes */${size}` }).end();
    res.writeHead(206, { ...head, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
    createReadStream(job.path, { start, end }).pipe(res);
  }

  const server = createServer(async (req, res) => {
    try {
      // Answer only when addressed as this machine: a foreign Host means another site is being pointed here (DNS rebinding).
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(req.headers.host || '')) return json(res, 403, { error: 'Forbidden' });
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'POST' && url.pathname === '/api/render') return await upload(req, res, url);
      if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
      if (PAGES[url.pathname]) {
        res.writeHead(200, { 'content-type': PAGES[url.pathname][1], 'cache-control': 'no-store' });
        return createReadStream(join(HERE, PAGES[url.pathname][0])).pipe(res);
      }
      const [, id, wantsVideo] = /^\/api\/jobs\/([\w-]+)(\/video)?$/.exec(url.pathname) || [];
      const job = jobs.get(id);
      if (!job || (wantsVideo && job.state !== 'done')) return json(res, 404, { error: 'Not found' });
      if (wantsVideo) return video(req, res, job, url);
      const { path, ...shown } = job;
      json(res, 200, shown);
    } catch (e) {
      if (!res.headersSent) json(res, 500, { error: e.message });
    }
  });

  mkdirSync(outDir, { recursive: true });
  return new Promise((ok, fail) => server.once('error', fail).listen(port, '127.0.0.1', () => ok(server)));
}
