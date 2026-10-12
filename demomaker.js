#!/usr/bin/env node
// demomaker            start the upload page
// demomaker page.html  render straight to a video
import { basename, extname } from 'node:path';
import { parseArgs } from 'node:util';
import { BACKGROUNDS, BAR, RATIOS, ZOOM } from './director.js';
import { QUALITY, render } from './render.js';
import { serve } from './server.js';

const list = choices => Object.keys(choices).join(' | ');
const HELP = `DemoMaker: turn an HTML page into a macOS-style showcase video.

  demomaker                      open the upload page (http://127.0.0.1:4173)
  demomaker page.html [options]  render page.html to a video

Options
  -o, --output <file>   where to write the video (default: <page>.mp4 in the current folder)
      --ratio <r>       ${list(RATIOS)}   (default 16:9)
      --quality <q>     ${list(QUALITY)}   (default high; draft is about 3x faster)
      --background <b>  ${list(BACKGROUNDS)}, or any CSS background
      --chrome <c>      ${list(BAR)}   (window style)
      --zoom <z>        ${list(ZOOM)}   (camera push-in on hovered details)
      --pace <n>        how long to dwell: 0.5 brisk, 1 normal, 1.5 relaxed
      --scheme <s>      light | dark   (what the page sees as the system theme)
      --address <text>  text for the address bar (default: the page title)
      --site-width <px> browser width the page is laid out at
      --port <n>        port for the upload page (default 4173)
  -h, --help
`;

try {
  const { values: v, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      output: { type: 'string', short: 'o' }, ratio: { type: 'string' }, quality: { type: 'string' }, background: { type: 'string' },
      chrome: { type: 'string' }, zoom: { type: 'string' }, pace: { type: 'string' }, scheme: { type: 'string' }, address: { type: 'string' },
      'site-width': { type: 'string' }, port: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    },
  });

  if (v.help) {
    process.stdout.write(HELP);
  } else if (positionals.length > 1) {
    throw new Error('One page at a time, please');
  } else if (positionals.length === 0) {
    const port = Number(v.port ?? 4173);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('port must be a number between 0 and 65535');
    const server = await serve({ port }).catch(e => {
      throw e.code === 'EADDRINUSE' ? new Error(`Port ${port} is already in use. Try: demomaker --port ${port + 1}`) : e;
    });
    console.log(`DemoMaker is ready: http://127.0.0.1:${server.address().port}\nVideos are saved to ./output. Press Ctrl+C to stop.`);
  } else {
    const input = positionals[0];
    const live = process.stdout.isTTY;
    const started = Date.now();
    const done = await render({
      input, output: v.output ?? basename(input, extname(input)) + '.mp4', ratio: v.ratio, quality: v.quality, background: v.background,
      chrome: v.chrome, zoom: v.zoom, pace: v.pace, scheme: v.scheme, address: v.address, siteWidth: v['site-width'],
      onProgress: live ? p => process.stdout.write(`\rRendering ${String(Math.round(p.progress * 100)).padStart(3)}%  ${p.frames} frames`) : undefined,
    });
    if (live) process.stdout.write('\r\x1b[K');
    console.log(`${done.output}\n${done.seconds.toFixed(1)}s of video, rendered in ${Math.round((Date.now() - started) / 1000)}s`);
  }
} catch (e) {
  if (process.stdout.isTTY) process.stdout.write('\r\x1b[K');
  console.error(`demomaker: ${e.message}`);
  process.exitCode = 1;
}
