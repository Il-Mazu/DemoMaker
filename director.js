// Choreography for a showcase shot, and the presets everything shares.
// Pure logic, no DOM: the stage page, the upload page and the tests all import it.

export const FPS = 60;
export const FRAME = 1000 / FPS;  // site-clock ms per video frame
export const FROZEN = 0.1;        // near-zero step: the compositor only redraws if time moves, the site barely notices
export const MIN_SCORE = 3;       // below this a hover is not worth a cursor trip
export const BAR = { safari: 52, minimal: 38 };  // title bar height per window style, in site px
export const ZOOM = { off: 1, subtle: 1.12, close: 1.4 };  // how far the camera pushes in on a hovered detail
// Frame size in CSS px, and the browser width the page is laid out at.
export const RATIOS = {
  '16:9': { width: 1920, height: 1080, siteWidth: 1440 },
  '4:3': { width: 1440, height: 1080, siteWidth: 1280 },
  '1:1': { width: 1080, height: 1080, siteWidth: 1100 },
  '4:5': { width: 1080, height: 1350, siteWidth: 1100 },
};
export const BACKGROUNDS = {
  aurora: 'radial-gradient(60% 80% at 8% 10%, #b9a2ff 0%, transparent 62%), radial-gradient(52% 72% at 94% 6%, #ffb3d9 0%, transparent 60%), radial-gradient(70% 85% at 82% 100%, #7cc4ff 0%, transparent 62%), radial-gradient(60% 70% at 10% 100%, #6a5cf0 0%, transparent 65%), #8473f2',
  dusk: 'radial-gradient(62% 82% at 6% 100%, #ffb36b 0%, transparent 62%), radial-gradient(56% 74% at 96% 4%, #c26bff 0%, transparent 62%), radial-gradient(60% 70% at 92% 96%, #ff6f91 0%, transparent 62%), radial-gradient(50% 60% at 10% 6%, #ff8f70 0%, transparent 65%), #e0608f',
  ocean: 'radial-gradient(62% 82% at 6% 8%, #6ff0d6 0%, transparent 62%), radial-gradient(58% 78% at 96% 96%, #3b6cff 0%, transparent 62%), radial-gradient(52% 66% at 92% 6%, #7fc8ff 0%, transparent 64%), radial-gradient(56% 70% at 6% 98%, #1f9fb8 0%, transparent 64%), #3f9ae0',
  graphite: 'radial-gradient(70% 90% at 12% 6%, #666c7a 0%, transparent 62%), radial-gradient(62% 82% at 92% 98%, #2f323b 0%, transparent 62%), #23252b',
  paper: 'radial-gradient(70% 90% at 10% 6%, #ffffff 0%, transparent 62%), radial-gradient(62% 82% at 94% 98%, #d3d7e2 0%, transparent 62%), #e8eaf0',
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lerp = (a, b, u) => (u === 1 ? b : a + (b - a) * u);

// Minimum-jerk profile: the shape of a human point-to-point reach.
export const minJerk = u => u * u * u * (10 - 15 * u + 6 * u * u);

// Critically damped spring step response (no overshoot). `response` is roughly its period in seconds.
export function springAt(t, response) {
  const x = (2 * Math.PI / response) * t;
  return 1 - (1 + x) * Math.exp(-x);
}

// Seconds until a spring travelling `distance` px is within `eps` px of its target.
export function springTime(distance, response, eps = 0.5) {
  if (distance <= eps) return 0;
  let lo = 0, hi = 40;
  for (let i = 0; i < 50; i++) { const x = (lo + hi) / 2; ((1 + x) * Math.exp(-x) > eps / distance) ? lo = x : hi = x; }
  return hi * response / (2 * Math.PI);
}

const springEase = (T, response) => u => (u === 1 ? 1 : springAt(u * T, response) / springAt(T, response));

// Where the browser window sits in the frame, and the site viewport it gives the page.
export function layout({ width, height, siteWidth, bar }) {
  const w = Math.round(width * 0.86), scale = w / siteWidth;
  const viewH = Math.floor(height * 0.83 / scale - bar), h = (viewH + bar) * scale;
  return { scale, x: (width - w) / 2, y: (height - h) / 2, w, h, viewW: siteWidth, viewH };
}

function splitTop(selectorText) {
  const parts = [];
  let depth = 0, start = 0;
  for (let i = 0; i < selectorText.length; i++) {
    const ch = selectorText[i];
    if (ch === '\\') i++;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) { parts.push(selectorText.slice(start, i)); start = i + 1; }
  }
  parts.push(selectorText.slice(start));
  return parts.map(p => p.trim()).filter(Boolean);
}

// Resolve a nested rule's selector against its parent rule (CSS nesting).
export function nest(selectorText, parent) {
  if (!parent) return selectorText;
  return splitTop(selectorText).map(p => (p.includes('&') ? p.replaceAll('&', `:is(${parent})`) : `:is(${parent}) ${p}`)).join(', ');
}

// Selectors for the elements whose :hover triggers this rule.
// ponytail: string heuristics, not a CSS parser. Misses `:is(:hover, :focus)` lists; swap in a real parser if that matters.
export function hoverBases(selectorText) {
  const out = [];
  for (const p of splitTop(selectorText)) {
    const i = p.search(/(?<!\\):hover(?![\w-])/);
    if (i < 0) continue;
    let base = p.slice(0, i);
    if (base.split('(').length !== base.split(')').length) {
      // :hover sits inside :is()/:where()/:not(), so take just its own compound selector
      let j = i, depth = 0;
      for (; j > 0; j--) {
        const ch = p[j - 1];
        if (ch === ')') depth++;
        else if (ch === '(') { if (depth === 0) break; depth--; }
        else if (depth === 0 && /[\s>+~,]/.test(ch)) break;
      }
      base = p.slice(0, j).endsWith(':not(') ? '' : p.slice(j, i);
    }
    base = base.trim();
    if (base && base !== '*') out.push(base);
  }
  return out;
}

// How much a hover is worth showing. Rich = it moves, lifts, recolours a surface; plain = text colour and the like.
export const scoreTarget = f =>
  (f.rich ? 4 : 0) + (f.plain ? 1 : 0) + (f.transition ? 1 : 0) + (f.pointer ? 1 : 0) + (f.buttonLike ? 1 : 0)
  + (f.area > f.viewArea * 0.5 ? -6 : f.area >= 2000 ? 1 : 0) + (f.inChrome ? -2 : 0);

// Scroll positions to rest at: section tops where the page has them, viewport-sized glides where it does not.
export function pickStops({ viewH, maxScroll, blocks, inset }, maxStops = 12) {
  if (maxScroll <= 0) return [0];
  const stride = Math.max(0.8, maxScroll / viewH / maxStops) * viewH;
  const tops = blocks.map(b => Math.round(b.top - inset));
  const stops = [0];
  for (let cur = 0; cur < maxScroll;) {
    const ideal = cur + stride;
    let next = tops.filter(y => y >= cur + stride * 0.45 && y <= cur + stride * 1.3)
      .sort((a, b) => Math.abs(a - ideal) - Math.abs(b - ideal))[0] ?? Math.round(ideal);
    if (maxScroll - next < viewH * 0.25) next = maxScroll;
    stops.push(next);
    cur = next;
  }
  return stops;
}

// The best hover targets fully visible when the page rests at `stopY`. Marks them used.
export function pickTargets(stopY, { viewW, viewH, inset, targets }, used, perStop = 2) {
  const picked = targets.filter(t => {
    if (used.has(t.id) || t.score < MIN_SCORE || (t.fixed && stopY !== 0)) return false;
    const y = t.fixed ? t.y : t.y - stopY;
    return y >= (t.fixed ? 0 : inset) + 4 && y + t.h <= viewH - 4 && t.x >= 4 && t.x + t.w <= viewW - 4;
  }).sort((a, b) => b.score - a.score).slice(0, perStop);
  picked.forEach(t => used.add(t.id));
  return picked;
}

// Scale origin for a push-in on `focus`: pulls the focus slightly toward the frame centre. When the zoom is gentle
// enough, the origin is held where the `keep` box (the window) stays wholly in frame; it always stays inside the
// frame itself, so a zoom can never reveal anything beyond the wallpaper.
export function zoomOrigin(focus, frame, z, keep, pull = 0.15) {
  if (z <= 1) return { ...focus };
  const axis = (f, size, lo, len) => {
    const want = f - pull / (z - 1) * (size / 2 - f);
    const min = (z * (lo + len) - size * 0.988) / (z - 1), max = (z * lo - size * 0.012) / (z - 1);
    return keep && min <= max ? clamp(want, min, max) : clamp(want, 0, size);
  };
  return { x: axis(focus.x, frame.w, keep?.x, keep?.w), y: axis(focus.y, frame.h, keep?.y, keep?.h) };
}

// A gently bowed path between two points, like a wrist arc.
export function cursorPath(a, b) {
  const bow = 0.12 * (b.x >= a.x ? 1 : -1);
  const c = { x: (a.x + b.x) / 2 - (b.y - a.y) * bow, y: (a.y + b.y) / 2 + (b.x - a.x) * bow };
  return u => ({
    x: (1 - u) * (1 - u) * a.x + 2 * (1 - u) * u * c.x + u * u * b.x,
    y: (1 - u) * (1 - u) * a.y + 2 * (1 - u) * u * c.y + u * u * b.y,
  });
}

// The shot, one yielded state per video frame.
// ctx: { layout, frame: {w,h}, scout, busy() -> page still animating,
//        rect(id) -> live {x,y,w,h} in site viewport coords, optionally with a preferred aim point {ax,ay}; null if not hoverable }
// options: pace (dwell multiplier), zoom (camera scale when pushing in on a hover; 1 = never), perStop (hovers per stop)
// state: { dt, scroll, win (0 hidden..1 settled), cursor {x,y,o} in site viewport coords, cam {z,ox,oy} in frame coords,
//          mouse: 'move' | 'park' | null, progress }
export function* shot(ctx, { pace = 1, zoom = ZOOM.subtle, perStop = 2 } = {}) {
  const { scout, layout: L, frame } = ctx;
  const n = seconds => Math.max(1, Math.round(seconds * FPS));
  const st = {
    dt: FROZEN, scroll: 0, win: 0, progress: 0, mouse: null,
    cursor: { x: scout.viewW * 0.72, y: scout.viewH * 0.78, o: 0 },
    cam: { z: 1, ox: frame.w / 2, oy: frame.h / 2 },
  };

  const tweens = new Map();
  const tween = (key, seconds, fn, ease = minJerk) => tweens.set(key, { fn, n: n(seconds), i: 0, ease });
  const step = () => {
    for (const [key, t] of tweens) { t.fn(t.ease(++t.i / t.n)); if (t.i >= t.n) tweens.delete(key); }
    const out = { ...st, cursor: { ...st.cursor }, cam: { ...st.cam } };
    st.mouse = null;
    return out;
  };
  function* wait(seconds) { for (let i = n(seconds); i > 0; i--) yield step(); }
  function* until(...keys) { while (keys.some(k => tweens.has(k))) yield step(); }
  // Hold while the page is still animating, for at least `min` and at most `max` seconds.
  function* settle(min, max) { for (let i = 0; i < n(min) || (i < n(max) && ctx.busy()); i++) yield step(); }

  // Intro: bare wallpaper, then the window arrives. The site clock stays frozen so entrance animations are not missed.
  const arrive = springEase(0.9, 0.55);
  yield* wait(0.15);
  tween('win', 0.9, u => { st.win = u; }, arrive);
  yield* until('win');
  st.dt = FRAME;
  yield* settle(1.2 * pace, 4);

  // Everything is chosen up front so progress can be reported in beats: the intro, each glide, each hover, the outro.
  const stops = pickStops(scout), used = new Set();
  const picks = stops.map(y => pickTargets(y, scout, used, perStop));
  const beats = stops.length + picks.flat().length + 1;
  let beat = 0;
  const beatDone = () => { st.progress = ++beat / beats; };
  beatDone();

  for (let i = 0; i < stops.length; i++) {
    if (i > 0) {
      st.mouse = 'park';  // hover lets go as the page starts to move, and nothing flickers as it passes underneath
      const from = st.scroll, to = stops[i], d = Math.abs(to - from);
      const response = Math.max(1, d / 1168), T = springTime(d, response);  // long glides slow down rather than strobe
      tween('scroll', T, u => { st.scroll = lerp(from, to, u); }, springEase(T, response));
      yield* until('scroll');
      yield* settle(0.7 * pace, 2.5);
      beatDone();
    }

    const dist = t => Math.hypot(t.x - st.cursor.x, t.y - stops[i] - st.cursor.y);
    let pushed = false;
    for (const t of picks[i].sort((a, b) => dist(a) - dist(b))) {
      const r = ctx.rect(t.id);
      if (!r) { beatDone(); continue; }
      // Aim at the clear spot the page found, or right of and below centre so the arrow does not sit on the label.
      const from = { x: st.cursor.x, y: st.cursor.y };
      const to = { x: r.ax ?? r.x + r.w / 2 + Math.min(r.w * 0.18, 40), y: r.ay ?? r.y + r.h * 0.6 };
      const path = cursorPath(from, to);
      const T = Math.min(1.1, 0.45 + Math.hypot(to.x - from.x, to.y - from.y) / 1600);
      if (st.cursor.o < 1) { const o = st.cursor.o; tween('fade', 0.3, u => { st.cursor.o = lerp(o, 1, u); }, u => u); }
      tween('cursor', T, u => {
        const p = path(u);
        st.cursor.x = clamp(p.x, 0, scout.viewW);
        st.cursor.y = clamp(p.y, 0, scout.viewH);
        st.mouse = 'move';
      });
      if (zoom > 1 && t.rich && !pushed) {
        pushed = true;
        yield* wait(T * 0.5);
        yield* until('cam');
        const focus = { x: L.x + (r.x + r.w / 2) * L.scale, y: L.y + (L.h - L.viewH * L.scale) + (r.y + r.h / 2) * L.scale };
        const origin = zoomOrigin(focus, frame, zoom, L);
        st.cam.ox = origin.x;
        st.cam.oy = origin.y;
        tween('cam', 1.1, u => { st.cam.z = lerp(1, zoom, u); });
      }
      yield* until('cursor');
      yield* settle(1.0 * pace, 2.4);  // let the hover animation play out
      yield* until('cam');
      if (st.cam.z > 1) { const z = st.cam.z; tween('cam', 0.9, u => { st.cam.z = lerp(z, 1, u); }); }
      beatDone();
    }
    yield* until('cam');
  }

  // Outro: the entrance in reverse, ending on the bare wallpaper so the video loops cleanly.
  yield* wait(0.8 * pace);
  st.progress = 1;
  const o = st.cursor.o;
  tween('fade', 0.35, u => { st.cursor.o = lerp(o, 0, u); }, u => u);
  tween('win', 0.7, u => { st.win = arrive(1 - u); }, u => u);
  yield* until('win', 'fade');
  yield* wait(0.15);
}
