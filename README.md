# DemoMaker

Turn an HTML page into a showcase video: a macOS-style browser window on a wallpaper, a cursor that hovers what is worth hovering, smooth section-by-section scrolling, and a subtle camera push-in on details.

The video is rendered frame by frame, not screen-recorded. The page's clock is stepped 1/60 s at a time, so there are no dropped frames however slow the machine is, and the page's own animations play exactly as written.

## Use it

```sh
npm start                 # opens the upload page at http://127.0.0.1:4173
```

Drop an `.html` file, pick a look, press **Render video**. The video plays in the page and is saved to `output/`.

From the command line:

```sh
node demomaker.js page.html                       # writes page.mp4
node demomaker.js page.html -o demo.mp4 --ratio 1:1 --background paper --zoom close
node demomaker.js --help
```

Try it on the sample: `node demomaker.js examples/landing.html`.

### Pages with local files

The command line serves the folder the page is in, so images, CSS and scripts next to it just work. The upload page receives only the one HTML file: use it for self-contained pages, or pages whose assets load from the web.

## Options

| Option | Values | Default |
| --- | --- | --- |
| `--ratio` | `16:9`, `4:3`, `1:1`, `4:5` | `16:9` |
| `--quality` | `draft` (fast preview), `high` (1080p, supersampled), `4k` | `high` |
| `--background` | `aurora`, `dusk`, `ocean`, `graphite`, `paper`, or any CSS background | `aurora` |
| `--chrome` | `safari`, `minimal` | `safari` |
| `--zoom` | `off`, `subtle` (window stays in frame), `close` | `subtle` |
| `--pace` | dwell time multiplier, `0.25` to `4` | `1` |
| `--scheme` | `light`, `dark`: what the page sees as the system theme | `light` |
| `--address` | text for the address bar | the page title |
| `--site-width` | browser width the page is laid out at, in px | per ratio |

Rough render times for a 20 s video on a 12-core machine with a mid-range graphics card: draft about 40 s, high about 2 min.

## How a shot is directed

1. The window arrives while the page clock is frozen, so entrance animations start once it has settled.
2. Scrolling stops at section tops (wide, tall blocks), or every 0.8 screens where there are none, and waits at each stop for running animations to finish.
3. Hover targets come from the page's own CSS: elements with `:hover` rules that change more than text colour, plus button-like links. Up to two are hovered per stop, the best first.
4. The toolbar takes the page's background colour (or its `theme-color`), as Safari does.

## Requirements

- Linux, Node 22 or newer, `ffmpeg` on the PATH.
- Chrome's headless shell. If it is missing: `npx playwright install --only-shell chromium`.

No npm packages are needed.

## Limits

- **System fonts.** macOS fonts are not on Linux: a design set in `-apple-system` or `system-ui` renders in your Linux system font. Webfonts are fine.
- **Scroll libraries that hijack the wheel** (transform-based "smooth scroll") are not driven. Native scrolling, `position: sticky`, scroll-linked CSS and IntersectionObserver reveals all work.
- **Hover detection reads same-origin CSS.** Hover effects defined only in a stylesheet loaded from another domain, or only in JavaScript, are not found; button-like elements are still hovered.
- **Not bit-identical.** Two renders of a page match frame for frame, but Chrome's rasteriser leaves invisible differences in edge antialiasing.
- **No audio**, and `<video>` or WebGL content is untested.

## Knobs for unusual machines

| Variable | Use |
| --- | --- |
| `DEMOMAKER_CHROME` | path to a `chrome-headless-shell` binary |
| `DEMOMAKER_CHROME_FLAGS` | extra Chrome flags; `--use-angle=swiftshader` forces software rendering |
| `DEMOMAKER_FFMPEG` | path to an `ffmpeg` binary |

## Tests

```sh
npm test
```

The end-to-end tests render a fixture page and judge the finished MP4: codec and frame rate, colour accuracy, that CSS `:hover` really fired, that the page really scrolled, and that two renders match frame for frame.

## Credits

The window chrome is set in [Inter](https://rsms.me/inter/), bundled under the SIL Open Font License (`fonts/Inter-LICENSE.txt`). The cursors and toolbar icons are drawn for this project in the style of macOS.
