// End to end: render the fixture twice and judge the finished MP4s.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '../render.js';
import { layout, shot, BAR } from '../director.js';

const W = 640, H = 360, SITE = 800;
const dir = mkdtempSync(join(tmpdir(), 'demomaker-test-'));
const opts = { input: fileURLToPath(new URL('./fixture.html', import.meta.url)), width: W, height: H, siteWidth: SITE, quality: 'draft' };
const L = layout({ width: W, height: H, siteWidth: SITE, bar: BAR.safari });
let a, b;

before(async () => {
  [a, b] = await Promise.all([render({ ...opts, output: join(dir, 'a.mp4') }), render({ ...opts, output: join(dir, 'b.mp4') })]);
}, { timeout: 180000 });
after(() => rmSync(dir, { recursive: true, force: true }));

const probe = file => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames',
  '-show_entries', 'stream=codec_name,pix_fmt,width,height,r_frame_rate,nb_read_frames,color_space', '-of', 'json', file])).streams[0];
const frame = (file, n) => execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${n})`, '-frames:v', '1',
  '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 26 });
// Colour of the frame pixel showing the site point (x, y).
const pixel = (buf, x, y) => {
  const i = (Math.round(L.y + (BAR.safari + y) * L.scale) * W + Math.round(L.x + x * L.scale)) * 3;
  return [buf[i], buf[i + 1], buf[i + 2]];
};
const near = (px, rgb, tol = 4) => px.every((v, i) => Math.abs(v - rgb[i]) <= tol);

// First frame on which the window has fully arrived, straight from the director.
const settled = (() => {
  const ctx = { layout: L, frame: { w: W, h: H }, scout: { viewW: SITE, viewH: L.viewH, maxScroll: 0, blocks: [], targets: [], inset: 0 }, rect: () => null, busy: () => false };
  let i = 0;
  for (const s of shot(ctx)) { if (s.win === 1) break; i++; }
  return i;
})();
// A frame inside the final hold: page at the bottom, camera at rest, window still fully there.
const late = () => a.frames - 75;

test('encodes H.264 yuv420p BT.709 at 60fps in the size asked for', () => {
  const s = probe(a.output);
  assert.deepEqual(
    { codec: s.codec_name, pix: s.pix_fmt, w: s.width, h: s.height, fps: s.r_frame_rate, space: s.color_space },
    { codec: 'h264', pix: 'yuv420p', w: W, h: H, fps: '60/1', space: 'bt709' });
});

test('every frame the director produced is in the file', () => {
  assert.ok(a.frames > 300, `${a.frames} frames`);
  assert.equal(Number(probe(a.output).nb_read_frames), a.frames);
});

test('colours survive capture and encoding, and files next to the page are served', () => {
  const px = pixel(frame(a.output, late()), 60, 60);
  assert.ok(near(px, [0x33, 0x66, 0xcc]), `#3366cc came out as rgb(${px})`);
});

test('the page clock waits for the window, so entrance animations are seen from their start', () => {
  const early = pixel(frame(a.output, settled + 4), 360, 80);
  assert.ok(early.every(v => v > 200), `1s fade-in already at rgb(${early}) four frames after the window arrived`);
  const done = pixel(frame(a.output, settled + 70), 360, 80);
  assert.ok(done.every(v => v < 30), `fade-in never finished: rgb(${done})`);
});

test('the cursor really hovers: CSS :hover fired inside the page', () => {
  const px = pixel(frame(a.output, late()), 60, 190);
  assert.ok(near(px, [0, 200, 0], 6), `hover marker is rgb(${px})`);
});

test('the page is really scrolled to its end', () => {
  const px = pixel(frame(a.output, late()), 60, 320);
  assert.ok(near(px, [0, 0, 255], 6), `scroll marker is rgb(${px})`);
});

// Renders are not bit-identical: Chrome's rasteriser resamples edges a little differently from run to run, most of all
// on the graphics card while the camera moves (about 48 dB at worst). Anything happening a frame early or late
// (a hover, a scroll step) would drop that frame to 30 dB or below.
test('two renders of the same page match frame for frame', () => {
  assert.equal(a.frames, b.frames);
  const stats = execFileSync('ffmpeg', ['-v', 'error', '-i', a.output, '-i', b.output, '-lavfi', 'psnr=stats_file=-', '-f', 'null', '-']).toString();
  const psnr = [...stats.matchAll(/psnr_avg:(inf|[\d.]+)/g)].map(m => (m[1] === 'inf' ? Infinity : Number(m[1])));
  assert.equal(psnr.length, a.frames);
  assert.ok(Math.min(...psnr) >= 40, `worst frame PSNR ${Math.min(...psnr)} dB`);
});

test('a missing input is reported plainly', async () => {
  await assert.rejects(render({ ...opts, input: join(dir, 'nope.html'), output: join(dir, 'c.mp4') }), /not found|no such file/i);
});

test('an encoder that dies mid-render ends the render with its error, not a hang', async () => {
  process.env.DEMOMAKER_FFMPEG = 'false';  // the shell utility: exits at once without reading a frame
  try {
    await assert.rejects(render({ ...opts, output: join(dir, 'dead.mp4') }), /ffmpeg failed/);
  } finally {
    delete process.env.DEMOMAKER_FFMPEG;
  }
  assert.ok(!existsSync(join(dir, 'dead.mp4')));
}, { timeout: 60000 });

test('an output path that cannot hold the video is refused before any work starts', async () => {
  mkdirSync(join(dir, 'taken.mp4'));
  await assert.rejects(render({ ...opts, output: join(dir, 'taken.mp4') }), /folder/i);
  assert.ok(existsSync(join(dir, 'taken.mp4')), 'the folder in the way is left alone');
  await assert.rejects(render({ ...opts, output: join(dir, 'clip.mov') }), /\.mp4/);
});

test('a resource that never answers delays the render but does not sink it', async () => {
  const sockets = [];
  const silent = createServer(socket => sockets.push(socket)).listen(0, '127.0.0.1');  // accepts, then says nothing
  await new Promise(ok => silent.once('listening', ok));
  try {
    writeFileSync(join(dir, 'stuck.html'), `<!doctype html><title>Stuck</title><body style="margin:0;height:900px">
      <h1>Still renders</h1><img src="http://127.0.0.1:${silent.address().port}/never.png" width="100" height="100">`);
    const done = await render({ ...opts, input: join(dir, 'stuck.html'), output: join(dir, 'stuck.mp4') });
    assert.ok(done.frames > 200, `${done.frames} frames`);
  } finally {
    sockets.forEach(s => s.destroy());
    silent.close();
  }
}, { timeout: 90000 });

test('a browser that cannot start is reported plainly', async () => {
  process.env.DEMOMAKER_CHROME = 'false';
  try {
    await assert.rejects(render({ ...opts, output: join(dir, 'nochrome.mp4') }), /Chrome exited/);
  } finally {
    delete process.env.DEMOMAKER_CHROME;
  }
});
