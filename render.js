// Renders a showcase video: steps headless Chrome one frame at a time and pipes the frames to ffmpeg.
// Nothing is recorded in real time, so the result has no dropped frames however slow the machine is.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BAR, FPS, FRAME, RATIOS, ZOOM } from './director.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// scale: device pixels captured per CSS px. out: output pixels per CSS px.
export const QUALITY = {
  draft: { scale: 1, out: 1, jpeg: 92 },
  high: { scale: 2, out: 1, jpeg: 97 },  // supersampled: captured at 2x, scaled down
  '4k': { scale: 2, out: 2, jpeg: 100 },
};

const OWN = { '/__dm/stage.html': 'stage.html', '/__dm/director.js': 'director.js', '/__dm/inter.woff2': 'fonts/InterVariable.woff2' };
const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8',
};

function findChrome() {
  if (process.env.DEMOMAKER_CHROME) return process.env.DEMOMAKER_CHROME;
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache', 'ms-playwright');
  const builds = (existsSync(cache) ? readdirSync(cache) : [])
    .filter(d => d.startsWith('chromium_headless_shell-'))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const build of builds) {
    for (const sub of readdirSync(join(cache, build))) {
      const bin = ['chrome-headless-shell', 'headless_shell'].map(name => join(cache, build, sub, name)).find(existsSync);
      if (bin) return bin;
    }
  }
  throw new Error('Chrome headless shell not found. Install it with:  npx playwright install --only-shell chromium\n'
    + '(or set DEMOMAKER_CHROME to a chrome-headless-shell binary)');
}

// Serves the stage under /__dm/ and the page's own folder at the root, so its relative and root-absolute assets both resolve.
function serve(siteRoot) {
  const server = createServer((req, res) => {
    let path;
    try { path = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
    let file = OWN[path] ? join(HERE, OWN[path]) : resolve(siteRoot, '.' + path);
    if (!OWN[path] && file !== siteRoot && !file.startsWith(siteRoot + sep)) { res.writeHead(403).end(); return; }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
    createReadStream(file).pipe(res);
  });
  return new Promise((ok, fail) => server.once('error', fail).listen(0, '127.0.0.1', () => ok(server)));
}

// A minimal DevTools-protocol client over Node's built-in WebSocket.
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = () => fail(new Error('Could not connect to Chrome')); });
  let id = 0;
  const pending = new Map(), waiting = new Map();
  ws.onclose = () => { for (const p of pending.values()) p.reject(new Error('Chrome closed unexpectedly')); pending.clear(); };
  ws.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (!m.id) { waiting.get(m.method)?.(); waiting.delete(m.method); return; }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    clearTimeout(p.timer);
    m.error ? p.reject(new Error(`${p.method}: ${m.error.message}`)) : p.resolve(m.result);
  };
  return {
    send: (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(n); reject(new Error(`Chrome stopped responding (${method})`)); }, 30000);
      const n = ++id;
      pending.set(n, { resolve, reject, method, timer });
      ws.send(JSON.stringify({ id: n, method, params, sessionId }));
    }),
    next: event => new Promise(resolve => waiting.set(event, resolve)),  // one waiter per event name is all this needs
    close: () => { ws.onclose = null; for (const p of pending.values()) clearTimeout(p.timer); ws.close(); },
  };
}

/**
 * Fill in defaults and check every option, so mistakes are reported before any work starts.
 * Values may arrive as strings (command line, query string). Empty and undefined ones mean "default".
 */
export function resolveOptions(options) {
  const given = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined && v !== ''));
  const ratio = given.ratio ?? '16:9';
  const oneOf = (what, value, choices) => { if (!Object.hasOwn(choices, value)) throw new Error(`Unknown ${what} "${value}". Use one of: ${Object.keys(choices).join(', ')}`); };
  oneOf('ratio', ratio, RATIOS);
  const o = { ...RATIOS[ratio], quality: 'high', chrome: 'safari', background: 'aurora', scheme: 'light', pace: 1, zoom: 'subtle', ...given };
  oneOf('quality', o.quality, QUALITY);
  oneOf('window style', o.chrome, BAR);
  oneOf('colour scheme', o.scheme, { light: 1, dark: 1 });
  for (const k of ['width', 'height', 'siteWidth', 'pace']) o[k] = Number(o[k]);
  for (const k of ['width', 'height']) {
    if (!Number.isInteger(o[k]) || o[k] % 2 || o[k] < 320 || o[k] > 3840) throw new Error(`${k} must be an even whole number between 320 and 3840`);
  }
  if (!Number.isInteger(o.siteWidth) || o.siteWidth < 320 || o.siteWidth > 3840) throw new Error('site width must be a whole number between 320 and 3840');
  if (!(o.pace >= 0.25 && o.pace <= 4)) throw new Error('pace must be between 0.25 and 4');
  o.zoom = Object.hasOwn(ZOOM, o.zoom) ? ZOOM[o.zoom] : Number(o.zoom);
  if (!(o.zoom >= 1 && o.zoom <= 2)) throw new Error(`zoom must be ${Object.keys(ZOOM).join(', ')} or a number between 1 and 2`);
  if (!o.input || !o.output) throw new Error('An input page and an output file are both needed');
  o.input = resolve(o.input);
  o.output = resolve(o.output);
  if (!existsSync(o.input) || !statSync(o.input).isFile()) throw new Error(`Input not found: ${o.input}`);
  if (extname(o.output).toLowerCase() !== '.mp4') throw new Error('The output file name must end in .mp4');
  if (existsSync(o.output) && statSync(o.output).isDirectory()) throw new Error(`The output path is a folder: ${o.output}`);
  return o;
}

/**
 * Render `input` (an HTML file) to `output` (an .mp4). Resolves to { output, frames, seconds }.
 * Options: ratio (16:9 | 4:3 | 1:1 | 4:5), quality (draft | high | 4k), background (preset name or any CSS background),
 * chrome (safari | minimal), scheme (light | dark), zoom (off | subtle | close | 1..2), pace (dwell multiplier),
 * address (text for the address bar), width / height / siteWidth (override the ratio), onProgress({ frames, progress }).
 */
export async function render(options) {
  const o = resolveOptions(options), q = QUALITY[o.quality];
  const { input, output } = o;
  mkdirSync(dirname(output), { recursive: true });

  const cleanup = [];
  let encoding = false, finished = false;
  try {
    const server = await serve(dirname(input));
    cleanup.push(() => server.close());

    const profile = mkdtempSync(join(tmpdir(), 'demomaker-'));
    cleanup.push(() => rmSync(profile, { recursive: true, force: true, maxRetries: 5 }));
    const chrome = spawn(findChrome(), [
      '--remote-debugging-port=0', `--user-data-dir=${profile}`,
      // Deterministic rendering: a frame is drawn only when asked for, at the time we say it is.
      '--deterministic-mode', '--enable-begin-frame-control', '--run-all-compositor-stages-before-draw',
      '--disable-new-content-rendering-timeout', '--disable-threaded-animation', '--disable-threaded-scrolling',
      '--disable-checker-imaging', '--disable-image-animation-resync', '--enable-surface-synchronization',
      `--force-device-scale-factor=${q.scale}`, '--hide-scrollbars', '--mute-audio', '--no-first-run',
      '--password-store=basic', '--use-mock-keychain',  // never wait on the desktop keyring
      // Rasterise on the graphics card when there is one (about twice as fast); Chrome falls back to software by itself.
      '--use-gl=angle', '--use-angle=gl-egl', '--ignore-gpu-blocklist',
      // Headless Chrome reports no mouse, which switches off `@media (hover: hover)` styles.
      '--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4',
      // Escape hatch for odd machines; later flags win, e.g. DEMOMAKER_CHROME_FLAGS=--use-angle=swiftshader for software.
      ...(process.env.DEMOMAKER_CHROME_FLAGS?.split(' ').filter(Boolean) ?? []),
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    const gone = once(chrome, 'exit').catch(() => {});
    cleanup.push(() => { chrome.kill('SIGKILL'); return gone; });
    const wsUrl = await new Promise((ok, fail) => {
      let log = '';
      const timer = setTimeout(() => fail(new Error('Chrome did not start within 30s')), 30000);
      chrome.stderr.on('data', d => {
        log += d;
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(log);
        if (m) { clearTimeout(timer); chrome.stderr.removeAllListeners('data').resume(); ok(m[1]); }
      });
      chrome.once('error', e => { clearTimeout(timer); fail(e); });
      chrome.once('exit', code => { clearTimeout(timer); fail(new Error(`Chrome exited (${code}) before starting:\n${log.slice(-1500)}`)); });
    });

    const cdp = await connect(wsUrl);
    cleanup.push(() => cdp.close());
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', width: o.width, height: o.height, enableBeginFrameControl: true });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const S = (method, params) => cdp.send(method, params, sessionId);
    // Never awaits a page promise: without a frame being drawn many of them would not settle.
    const evaluate = async expression => {
      const r = await S('Runtime.evaluate', { expression, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };

    await S('Emulation.setEmulatedMedia', { features: [
      { name: 'prefers-reduced-motion', value: 'no-preference' }, { name: 'prefers-color-scheme', value: o.scheme },
    ] });
    // The page clock is ours from here on: timers, Date, requestAnimationFrame and CSS animations move only when advanced.
    const { virtualTimeTicksBase } = await S('Emulation.setVirtualTimePolicy', { policy: 'pause' });
    // Kept in whole microseconds, Chrome's own resolution, so the frame clock and the page clock never drift apart.
    let clock = 0, patient = true;
    // While the page is fetching, its clock stands still, so slow assets never arrive late on video.
    const advance = async us => {
      if (us <= 0) return;
      const budget = (us + 0.25) / 1000;  // ms; the quarter-microsecond survives Chrome rounding either way
      const expired = cdp.next('Emulation.virtualTimeBudgetExpired').then(() => false);
      await S('Emulation.setVirtualTimePolicy', { policy: patient ? 'pauseIfNetworkFetchesPending' : 'advance', budget });
      if (patient) {
        let timer;
        const stuck = await Promise.race([expired, new Promise(r => { timer = setTimeout(r, 8000, true); })]);
        clearTimeout(timer);
        if (stuck) {  // a request that never finishes (analytics, live reload): stop waiting on the network
          patient = false;
          await S('Emulation.setVirtualTimePolicy', { policy: 'advance', budget });
        }
      }
      await expired;
      clock += us;
    };
    const beginFrame = async screenshot => (await S('HeadlessExperimental.beginFrame', {
      frameTimeTicks: virtualTimeTicksBase + (clock + 0.25) / 1000, interval: FRAME, noDisplayUpdates: false, screenshot,
    })).screenshotData;

    const capture = () => beginFrame({ format: 'jpeg', quality: q.jpeg, optimizeForSpeed: true });
    // Move the page clock on by `us` and capture one video frame. Chrome delivers input with the next frame it draws.
    // The event is sent before the clock moves so it is queued in time; if it still misses the frame, redraw until
    // Chrome confirms it landed. A hover then always starts on the same video frame.
    const drawFrame = async (us, mouse) => {
      let landed = !mouse;
      const sent = mouse && S('Input.dispatchMouseEvent', { type: 'mouseMoved', ...mouse }).then(() => { landed = true; });
      sent?.catch(() => {});  // if Chrome dies, the failure surfaces through the calls below, not as a stray rejection
      await advance(us);
      let shot = await capture();
      while (mouse) {
        let timer;
        await Promise.race([sent, new Promise(r => { timer = setTimeout(r, 50); })]);
        clearTimeout(timer);
        if (landed) break;
        await advance(1);  // a frame at an unchanged time is never drawn
        shot = await capture() || shot;
      }
      return shot;
    };

    const config = {
      site: '/' + encodeURIComponent(basename(input)), width: o.width, height: o.height, siteWidth: o.siteWidth,
      chrome: o.chrome, background: o.background, address: o.address, pace: o.pace, zoom: o.zoom,
    };
    S('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/__dm/stage.html#${encodeURIComponent(JSON.stringify(config))}` }).catch(() => {});
    // Loading costs the page clock only microseconds, so its animations start with the video and not before.
    // The page load is started, and capture begun, on exact half-millisecond marks, so every render of a page puts
    // its animations on the same frames.
    const deadline = Date.now() + 60000;
    const reach = async (wanted, hurryAfter = Infinity) => {
      const hurryAt = Date.now() + hurryAfter;
      for (let state, hurried = false; state !== wanted;) {
        if (Date.now() > deadline) throw new Error('The page did not finish loading within 60s');
        // A resource that never answers must not hold the video hostage: after a while, go on without it.
        if (!hurried && Date.now() > hurryAt) { hurried = true; await evaluate('__dm.hurry()'); }
        if (!patient) await new Promise(r => setTimeout(r, 20));  // nothing to wait on but real time: do not spin
        await advance(1);
        state = await evaluate('window.__dm?.state').catch(() => undefined);  // the context is replaced mid-navigation
        if (state?.startsWith('error')) throw new Error(`Could not prepare the page: ${state.slice(7)}`);
      }
      await advance(500 - clock % 500);
    };
    await reach('idle');
    await evaluate('__dm.load()');
    await reach('ready', 12000);

    const ffmpeg = spawn(process.env.DEMOMAKER_FFMPEG || 'ffmpeg', [
      '-y', '-loglevel', 'error', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(FPS), '-i', '-',
      // Chrome's JPEGs are full-range BT.601; video players expect limited-range BT.709. Convert explicitly or colours drift.
      '-vf', `scale=${o.width * q.out}:${o.height * q.out}:flags=lanczos+accurate_rnd+full_chroma_int`
        + ':in_color_matrix=bt601:in_range=pc:out_color_matrix=bt709:out_range=tv,format=yuv420p',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '14',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
      '-movflags', '+faststart', output,
    ], { stdio: ['pipe', 'ignore', 'pipe'] });
    encoding = true;
    cleanup.push(() => ffmpeg.kill('SIGKILL'));
    let ffLog = '', ffFailed = false;
    ffmpeg.stderr.on('data', d => { ffLog += d; });
    ffmpeg.stdin.on('error', () => {});  // a dead ffmpeg is reported through `encoded` below
    const encoded = new Promise((ok, fail) => { ffmpeg.once('error', fail); ffmpeg.once('close', ok); });
    encoded.catch(() => { ffFailed = true; });

    let frames = 0, last, due = clock / 1000;
    for (;;) {
      const s = await evaluate('__dm.tick()');
      if (s.done || ffFailed || ffmpeg.exitCode !== null) break;
      due += s.dt;
      const shot = await drawFrame(Math.round(due * 1000) - clock, s.mouse);
      if (shot) last = Buffer.from(shot, 'base64');  // no screenshot means nothing changed: repeat the previous frame
      if (!last) continue;
      // A dead ffmpeg never drains its pipe, so its end releases the wait too; the next pass then stops the loop.
      if (!ffmpeg.stdin.write(last)) await Promise.race([once(ffmpeg.stdin, 'drain'), encoded]).catch(() => {});
      frames++;
      o.onProgress?.({ frames, progress: s.progress });
    }
    ffmpeg.stdin.end();
    const code = await encoded.catch(e => { throw new Error(e.code === 'ENOENT' ? 'ffmpeg not found. Install ffmpeg and try again' : `ffmpeg failed: ${e.message}`); });
    if (code !== 0) throw new Error(`ffmpeg failed:\n${ffLog.trim()}`);
    finished = true;
    return { output, frames, seconds: frames / FPS };
  } finally {
    // Tidying up must never replace the error that brought us here.
    for (const fn of cleanup.reverse()) await Promise.resolve().then(fn).catch(() => {});
    if (encoding && !finished) rmSync(output, { force: true });  // never leave a half-written video behind
  }
}
