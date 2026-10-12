import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FPS, FRAME, FROZEN, minJerk, springAt, springTime, layout, nest, hoverBases, scoreTarget,
  pickStops, pickTargets, zoomOrigin, cursorPath, shot,
} from '../director.js';

test('minJerk eases from 0 to 1 without overshoot', () => {
  assert.equal(minJerk(0), 0);
  assert.equal(minJerk(1), 1);
  let prev = 0;
  for (let u = 0.01; u <= 1; u += 0.01) { const v = minJerk(u); assert.ok(v >= prev && v <= 1); prev = v; }
});

test('spring starts at rest, never overshoots, and lands within half a pixel at springTime', () => {
  assert.equal(springAt(0, 1), 0);
  let prev = 0;
  for (let t = 0; t <= 3; t += 1 / FPS) { const v = springAt(t, 1); assert.ok(v >= prev && v <= 1); prev = v; }
  for (const d of [40, 700, 3000]) {
    const t = springTime(d, 1);
    assert.ok(d * (1 - springAt(t, 1)) <= 0.5, `within 0.5px for ${d}px`);
    assert.ok(d * (1 - springAt(t - 0.1, 1)) > 0.5, `not padded for ${d}px`);
  }
});

test('layout fits the window inside the frame with margins on every side', () => {
  for (const [width, height] of [[1920, 1080], [1440, 1080], [1080, 1080], [1080, 1350]]) {
    const L = layout({ width, height, siteWidth: 1440, bar: 52 });
    assert.ok(L.x > 0 && L.y > 0);
    assert.ok(Math.abs(L.x * 2 + L.w - width) < 1, 'centred horizontally');
    assert.ok(Math.abs(L.y * 2 + L.h - height) < 1, 'centred vertically');
    assert.ok(Math.abs(L.scale - L.w / 1440) < 1e-9);
    assert.equal(L.viewW, 1440);
    assert.ok(L.viewH > 200 && Number.isInteger(L.viewH));
    assert.ok((L.viewH + 52) * L.scale <= L.h + 1, 'bar + viewport fit the window height');
  }
});

test('hoverBases finds the element whose hover triggers a rule', () => {
  assert.deepEqual(hoverBases('.card:hover'), ['.card']);
  assert.deepEqual(hoverBases('.nav a:hover'), ['.nav a']);
  assert.deepEqual(hoverBases('.card:hover .img'), ['.card']);
  assert.deepEqual(hoverBases('a:hover, button.primary:hover > span'), ['a', 'button.primary']);
  assert.deepEqual(hoverBases('.hover\\:scale-105:hover'), ['.hover\\:scale-105']);
  assert.deepEqual(hoverBases('.x:is(.a, .b):hover'), ['.x:is(.a, .b)']);
});

test('hoverBases follows CSS nesting and :hover buried in :is()/:where()', () => {
  assert.deepEqual(hoverBases(nest('&:hover', '.card')), [':is(.card)']);
  assert.deepEqual(hoverBases(nest('.title', '.card:hover')), ['.card'], 'a rule nested under a hover rule is triggered by the parent');
  assert.deepEqual(hoverBases(nest('&:is(:where(.group):hover *)', '.child')), [':where(.group)']);
  assert.deepEqual(hoverBases('.md\\:hover\\:lift:hover'), ['.md\\:hover\\:lift'], 'escaped colons in class names are not pseudo-classes');
});

test('hoverBases ignores selectors where :hover is not a trigger we can aim at', () => {
  assert.deepEqual(hoverBases('.btn:not(:hover)'), []);
  assert.deepEqual(hoverBases(':hover'), []);
  assert.deepEqual(hoverBases('*:hover'), []);
  assert.deepEqual(hoverBases('.plain'), []);
});

test('scoreTarget prefers rich hover effects and penalises chrome and giant wrappers', () => {
  const base = { rich: false, plain: false, transition: false, pointer: false, buttonLike: false, area: 20000, viewArea: 1e6, inChrome: false };
  const rich = scoreTarget({ ...base, rich: true, transition: true });
  const plain = scoreTarget({ ...base, plain: true });
  assert.ok(rich > plain);
  assert.ok(scoreTarget({ ...base, rich: true }) > scoreTarget({ ...base, rich: true, inChrome: true }));
  assert.ok(scoreTarget({ ...base, rich: true, area: 800000 }) < plain, 'a hover on a near-full-viewport wrapper is not worth showing');
});

test('pickStops covers the page from top to bottom in viewport-sized glides', () => {
  assert.deepEqual(pickStops({ viewH: 800, maxScroll: 0, blocks: [], inset: 0 }), [0]);
  const stops = pickStops({ viewH: 800, maxScroll: 4000, blocks: [], inset: 0 });
  assert.equal(stops[0], 0);
  assert.equal(stops.at(-1), 4000);
  for (let i = 1; i < stops.length; i++) {
    const gap = stops[i] - stops[i - 1];
    assert.ok(gap >= 800 * 0.25 && gap <= 800 * 1.05, `gap ${gap}`);
  }
});

test('pickStops lands on section tops, leaving room for a sticky header', () => {
  const stops = pickStops({ viewH: 800, maxScroll: 3000, blocks: [{ top: 700 }, { top: 1420 }, { top: 2100 }], inset: 64 });
  assert.ok(stops.includes(700 - 64));
  assert.ok(stops.includes(1420 - 64));
  assert.ok(stops.includes(2100 - 64));
});

test('pickStops prefers a section top just over a viewport away to stopping mid-section', () => {
  const stops = pickStops({ viewH: 800, maxScroll: 3000, blocks: [{ top: 660 }], inset: 0 });
  assert.equal(stops[1], 660);
  const far = pickStops({ viewH: 800, maxScroll: 3000, blocks: [{ top: 660 }, { top: 660 + 820 }], inset: 0 });
  assert.equal(far[2], 660 + 820, 'a glide of 1.03 viewports beats cutting the next section in half');
});

test('pickStops keeps very long pages to a watchable number of stops', () => {
  const stops = pickStops({ viewH: 800, maxScroll: 40000, blocks: [], inset: 0 });
  assert.ok(stops.length <= 13, `${stops.length} stops`);
  assert.equal(stops.at(-1), 40000);
});

const target = (id, x, y, extra = {}) => ({ id, x, y, w: 200, h: 60, fixed: false, score: 5, rich: true, ...extra });

test('pickTargets returns the best fully visible targets for a stop, each used once', () => {
  const scout = { viewW: 1440, viewH: 800, inset: 0, targets: [
    target(0, 100, 300, { score: 3 }), target(1, 600, 400, { score: 9 }), target(2, 900, 500, { score: 6 }),
    target(3, 100, 1500),                       // below the fold at stop 0
    target(4, 100, 780),                        // cut off by the bottom edge at stop 0
  ] };
  const used = new Set();
  const first = pickTargets(0, scout, used, 2);
  assert.deepEqual(first.map(t => t.id).sort(), [1, 2]);
  assert.deepEqual(pickTargets(0, scout, used, 2).map(t => t.id), [0], 'used targets are not repeated');
  assert.deepEqual(pickTargets(1200, scout, used, 2).map(t => t.id), [3]);
});

test('pickTargets shows fixed chrome only at the first stop and skips what a sticky header covers', () => {
  const scout = { viewW: 1440, viewH: 800, inset: 64, targets: [target(0, 20, 10, { fixed: true }), target(1, 100, 1020)] };
  assert.deepEqual(pickTargets(0, scout, new Set(), 2).map(t => t.id), [0]);
  assert.deepEqual(pickTargets(1000, scout, new Set(), 2).map(t => t.id), [], 'target sits under the 64px header');
  assert.deepEqual(pickTargets(900, scout, new Set(), 2).map(t => t.id), [1]);
});

test('zoomOrigin stays inside the frame and nudges the focus toward the centre', () => {
  const frame = { w: 1920, h: 1080 }, c = { x: 960, y: 540 };
  for (const e of [{ x: 300, y: 200 }, { x: 1800, y: 1000 }, { x: 960, y: 540 }, { x: 20, y: 20 }]) {
    const z = 1.25, o = zoomOrigin(e, frame, z);
    assert.ok(o.x >= 0 && o.x <= frame.w && o.y >= 0 && o.y <= frame.h, 'origin inside frame, so the zoom never reveals outside it');
    const mapped = { x: o.x + z * (e.x - o.x), y: o.y + z * (e.y - o.y) };
    assert.ok(Math.hypot(mapped.x - c.x, mapped.y - c.y) <= Math.hypot(e.x - c.x, e.y - c.y) + 1e-9);
  }
});

test('zoomOrigin keeps a window in frame when the zoom is small enough to allow it', () => {
  const frame = { w: 1920, h: 1080 }, L = layout({ width: 1920, height: 1080, siteWidth: 1440, bar: 52 }), z = 1.12;
  for (const e of [{ x: 300, y: 200 }, { x: 1800, y: 1000 }, { x: 960, y: 540 }, { x: 200, y: 900 }]) {
    const o = zoomOrigin(e, frame, z, L);
    const left = o.x + z * (L.x - o.x), right = o.x + z * (L.x + L.w - o.x), top = o.y + z * (L.y - o.y), bottom = o.y + z * (L.y + L.h - o.y);
    assert.ok(left > 0 && top > 0 && right < frame.w && bottom < frame.h, `window spans ${left},${top} to ${right},${bottom}`);
  }
});

test('cursorPath starts and ends exactly on its endpoints with a gentle bow', () => {
  const a = { x: 100, y: 600 }, b = { x: 900, y: 200 }, path = cursorPath(a, b);
  assert.deepEqual(path(0), a);
  assert.deepEqual(path(1), b);
  const dist = Math.hypot(b.x - a.x, b.y - a.y), mid = path(0.5);
  const off = Math.abs((b.y - a.y) * mid.x - (b.x - a.x) * mid.y + b.x * a.y - b.y * a.x) / dist;
  assert.ok(off > 0 && off <= dist * 0.15, `bow ${off}`);
});

// A page three screens tall with a sticky header and a few hover targets, nothing animating.
function fakeCtx(over = {}) {
  const L = layout({ width: 1920, height: 1080, siteWidth: 1440, bar: 52 });
  const scout = {
    viewW: L.viewW, viewH: L.viewH, maxScroll: L.viewH * 3, inset: 60, blocks: [{ top: 760 }, { top: 1500 }],
    targets: [target(0, 200, 400), target(1, 800, 500, { rich: false }), target(2, 300, 1100), target(3, 700, 1900)],
    ...over.scout,
  };
  let scroll = 0;
  return {
    layout: L, scout, frame: { w: 1920, h: 1080 },
    seen: s => { scroll = s.scroll; },
    rect: id => { const t = scout.targets[id]; return { x: t.x, y: t.fixed ? t.y : t.y - scroll, w: t.w, h: t.h }; },
    busy: over.busy || (() => false),
  };
}
const run = (ctx, opts) => { const frames = []; for (const s of shot(ctx, opts)) { ctx.seen(s); frames.push(structuredClone(s)); } return frames; };

test('shot opens on the bare wallpaper with the site clock frozen, and closes the same way', () => {
  const frames = run(fakeCtx());
  assert.ok(frames[0].win < 0.05);
  assert.equal(frames.at(-1).win, 0);
  assert.equal(frames.at(-1).cursor.o, 0);
  const settled = frames.findIndex(f => f.win === 1);
  assert.ok(settled > FPS * 0.4, 'the window takes a moment to arrive');
  assert.ok(frames.slice(0, settled).every(f => f.dt === FROZEN), 'entrance animations wait for the window');
  assert.ok(frames.slice(settled + 1, settled + 20).every(f => f.dt === FRAME));
});

test('shot scrolls the whole page smoothly: monotonic, no jumps, no velocity kinks', () => {
  const ctx = fakeCtx(), frames = run(ctx);
  assert.equal(frames[0].scroll, 0);
  assert.equal(Math.max(...frames.map(f => f.scroll)), ctx.scout.maxScroll);
  let v = 0;
  for (let i = 1; i < frames.length; i++) {
    const nv = frames[i].scroll - frames[i - 1].scroll;
    assert.ok(nv >= 0, 'never scrolls back');
    assert.ok(nv < 60, `scroll step ${nv}px at frame ${i}`);
    assert.ok(Math.abs(nv - v) < 12, `scroll velocity kink ${nv - v} at frame ${i}`);
    v = nv;
  }
});

test('shot moves the cursor continuously, keeps it in the viewport, and reaches rich targets', () => {
  const ctx = fakeCtx(), frames = run(ctx), { viewW, viewH } = ctx.scout;
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1].cursor, b = frames[i].cursor;
    assert.ok(Math.hypot(b.x - a.x, b.y - a.y) < 60, `cursor teleport at frame ${i}`);
    assert.ok(b.x >= 0 && b.x <= viewW && b.y >= 0 && b.y <= viewH);
  }
  const t = ctx.scout.targets[0];
  assert.ok(frames.some(f => f.scroll === 0 && f.cursor.o === 1 && f.cursor.x > t.x && f.cursor.x < t.x + t.w && f.cursor.y > t.y && f.cursor.y < t.y + t.h), 'cursor rests on the first target');
});

test('shot rests the cursor on the clear spot the page reports for a target', () => {
  const ctx = fakeCtx(), plain = ctx.rect;
  ctx.rect = id => ({ ...plain(id), ...(id === 0 ? { ax: 231, ay: 417 } : {}) });
  assert.ok(run(ctx).some(f => f.cursor.x === 231 && f.cursor.y === 417));
});

test('shot pushes in subtly by default, keeping the whole window in frame', () => {
  const ctx = fakeCtx(), frames = run(ctx), L = ctx.layout;
  const maxZ = Math.max(...frames.map(f => f.cam.z));
  assert.ok(maxZ > 1.08 && maxZ <= 1.14, `max zoom ${maxZ}`);
  for (const { cam: { z, ox, oy } } of frames) {
    assert.ok(ox + z * (L.x - ox) > 0 && oy + z * (L.y - oy) > 0 && ox + z * (L.x + L.w - ox) < 1920 && oy + z * (L.y + L.h - oy) < 1080, 'window left the frame');
  }
});

test('shot never scrolls while zoomed, and the zoom strength can be chosen or turned off', () => {
  const frames = run(fakeCtx(), { zoom: 1.4 });
  assert.equal(Math.max(...frames.map(f => f.cam.z)), 1.4);
  for (let i = 1; i < frames.length; i++) if (frames[i].scroll !== frames[i - 1].scroll) assert.equal(frames[i].cam.z, 1, `zoomed while scrolling at frame ${i}`);
  assert.equal(Math.max(...run(fakeCtx(), { zoom: 1 }).map(f => f.cam.z)), 1);
});

test('shot parks the mouse while scrolling so passing elements do not flicker their hover', () => {
  const frames = run(fakeCtx());
  for (let i = 1; i < frames.length; i++) if (frames[i].scroll !== frames[i - 1].scroll) assert.notEqual(frames[i].mouse, 'move');
  const firstScroll = frames.findIndex((f, i) => i > 0 && f.scroll !== frames[i - 1].scroll);
  assert.ok(frames.slice(0, firstScroll + 1).some(f => f.mouse === 'park'));
});

test('shot waits for running animations before moving on, but not forever', () => {
  const calm = run(fakeCtx()).length;
  let n = 0;
  const briefly = run(fakeCtx({ busy: () => n++ < 90 })).length;
  const forever = run(fakeCtx({ busy: () => true })).length;
  assert.ok(briefly > calm, 'dwells longer while the page is animating');
  assert.ok(forever < calm + FPS * 60, 'an endlessly animating page still finishes');
});

test('shot handles a page with nothing to scroll or hover', () => {
  const frames = run(fakeCtx({ scout: { maxScroll: 0, blocks: [], targets: [] } }));
  assert.ok(frames.length > FPS * 2);
  assert.ok(frames.every(f => f.scroll === 0 && f.cam.z === 1));
});

test('shot reports progress from 0 to 1, moving with every scroll and hover', () => {
  const ctx = fakeCtx(), frames = run(ctx);
  assert.ok(frames[0].progress < 0.1);
  assert.equal(frames.at(-1).progress, 1);
  for (let i = 1; i < frames.length; i++) assert.ok(frames[i].progress >= frames[i - 1].progress);
  const steps = new Set(frames.map(f => f.progress)).size;
  assert.ok(steps >= pickStops(ctx.scout).length + ctx.scout.targets.length, `only ${steps} distinct progress values`);
  const longestStall = Math.max(...[...new Set(frames.map(f => f.progress))].map(p => frames.filter(f => f.progress === p).length));
  assert.ok(longestStall < frames.length / 4, `progress stood still for ${longestStall} of ${frames.length} frames`);
});
