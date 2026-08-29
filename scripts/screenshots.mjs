#!/usr/bin/env node
/**
 * Regenerates the screenshots the README shows.
 *
 * Everything it needs is in the repository: two copies of a small demo site
 * that differ on purpose, in `docs/demo`. So the pictures can be made again
 * from scratch whenever the report changes, and they always show a run that
 * really happened rather than a mock-up.
 *
 *   npm run screenshots
 */
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { chromium } from 'playwright';

const run = promisify(execFile);
const root = join(import.meta.dirname, '..');
const shotDir = join(root, 'docs', 'screenshots');
const cli = join(root, 'bin', 'diffyard.mjs');

/** The views the report offers, each worth a picture of its own. */
const MODES = [
  ['diff', 'diff'],
  ['side', 'side-by-side'],
  ['slider', 'slider'],
  ['onion', 'onion'],
  ['markup', 'markup'],
];

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8' };

/** Serves one of the two demo sites. */
function serve(dir) {
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    const name = path === '/' ? 'index' : path.replace(/^\/+/, '');
    const file = join(dir, extname(name) ? name : `${name}.html`);
    try {
      const body = readFileSync(file);
      response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'text/plain' });
      response.end(body);
    } catch {
      response.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}/`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

const ESC = String.fromCharCode(27);
const SGR = {
  1: 'font-weight:600', 2: 'opacity:.55',
  31: 'color:#ff6b6b', 32: 'color:#4fd3a2', 33: 'color:#f5b700',
  34: 'color:#7cb0ff', 90: 'color:#6e7679',
};

/** Turns one captured terminal frame into the HTML that will be photographed. */
function ansiToHtml(text) {
  const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let html = '';
  let open = 0;
  const pattern = new RegExp(`${ESC}\\[([0-9;]*)m`, 'g');
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    html += escape(text.slice(last, match.index));
    last = match.index + match[0].length;
    for (const code of match[1].split(';')) {
      if (code === '' || code === '0') { html += '</span>'.repeat(open); open = 0; }
      else if (SGR[code]) { html += `<span style="${SGR[code]}">`; open++; }
    }
  }
  html += escape(text.slice(last));
  return html + '</span>'.repeat(open);
}

/** Captures the command line as a terminal really renders it, PTY and all. */
async function captureTerminal(configDir, config) {
  const command = `stty rows 40 cols 96; ${process.execPath} ${cli} run ${config} --workers 4`;
  const { stdout } = await run('script', ['-qec', command, '/dev/null'], {
    cwd: configDir,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, FORCE_COLOR: '1' },
  }).catch((error) => error); // exit 1 only means something differs

  // Every redraw erases what it drew, so the stream splits into segments of
  // "lines that stay" followed by "the block being redrawn".
  const segments = (stdout ?? '').split(`${ESC}[0J`).map(split);

  // The fullest block: the moment the run has most to say about itself.
  let best = 0;
  segments.forEach((segment, index) => {
    if (segment.block.split('\n').length >= segments[best].block.split('\n').length) best = index;
  });

  const kept = segments.slice(0, best + 1).map((segment) => segment.printed).join('');
  return clean(kept + segments[best].block);
}

const SPINNER = /^[\u2800-\u28ff]/;

/** Separates the lines a frame leaves behind from the block it will erase. */
function split(segment) {
  const lines = segment.split('\n');
  const start = lines.findIndex((line) => SPINNER.test(plain(line).trimStart()) && plain(line).trim() !== '');
  if (start === -1) return { printed: segment, block: '' };
  return { printed: lines.slice(0, start).join('\n'), block: lines.slice(start).join('\n') };
}

/** Drops everything that positions the cursor; only the colours are kept. */
function clean(frame) {
  return frame
    .replace(new RegExp(`${ESC}\\[\\??[0-9;]*[A-Za-z]`, 'g'), (code) => (code.endsWith('m') ? code : ''))
    .replace(/\r/g, '')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

const plain = (line) => line.replace(new RegExp(`${ESC}\\[\\??[0-9;]*[A-Za-z]`, 'g'), '').replace(/\r/g, '');

async function shootTerminal(browser, frame, name) {
  const page = await browser.newPage({ viewport: { width: 900, height: 420 }, deviceScaleFactor: 1.5 });
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>
    body { margin: 0; background: #0f1112; }
    .window { padding: 26px 30px 30px; }
    .bar { display: flex; gap: 8px; padding: 0 0 20px; }
    .bar i { width: 11px; height: 11px; border-radius: 50%; background: #2a2f31; }
    pre {
      margin: 0; color: #e8eaea; white-space: pre; tab-size: 8;
      font: 13px/1.55 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    }
  </style>
  <div class="window"><div class="bar"><i></i><i></i><i></i></div><pre>${ansiToHtml(frame)}</pre></div>`);
  const box = await page.locator('.window').boundingBox();
  await page.setViewportSize({ width: 900, height: Math.ceil(box.height) });
  const png = await page.screenshot();
  await page.close();
  await save(browser, name, png);
}

async function shootReport(browser, reportFile) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 });
  await page.goto(`file://${reportFile}`);
  await page.waitForTimeout(400);

  // Trimmed to the last tile: a screenshot with half a screen of empty ground
  // below it reads as an empty report.
  const bottom = await page.evaluate(() => {
    const tiles = document.querySelectorAll('#tiles > .tile');
    return Math.ceil(tiles[tiles.length - 1].getBoundingClientRect().bottom + window.scrollY);
  });
  // Short of the 32px gap below the tiles: cutting level with it caught the
  // top border of the settings panel as a hairline across the foot.
  await page.setViewportSize({ width: 1440, height: bottom + 24 });
  await page.waitForTimeout(250);
  await save(browser, 'report-overview.webp', await page.screenshot());

  // What the run was told to do, which is what makes its numbers checkable.
  //
  // Photographed by clipping rather than by the element, and with a window
  // tall enough that the page does not scroll: the controls bar is sticky, and
  // scrolling an element into view puts that bar over the top of it.
  await page.locator('#open-settings').click();
  await page.waitForTimeout(400);
  const tall = await page.evaluate(() => Math.ceil(document.documentElement.scrollHeight));
  await page.setViewportSize({ width: 1440, height: tall });
  await page.waitForTimeout(300);
  const panel = await page.locator('#settings').boundingBox();
  await save(browser, 'report-settings.webp', await page.screenshot({
    clip: { x: panel.x, y: panel.y, width: panel.width, height: panel.height },
  }));
  await page.locator('#settings summary').click();
  await page.setViewportSize({ width: 1440, height: 900 });

  // One picture per way of looking at a difference. The comparison opened is
  // the one with most to show: the first tile, sorted by largest difference.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('#tiles > .tile').first().click();
  await page.waitForTimeout(400);

  // The picture pane is `100vh` minus the chrome, so a taller window makes a
  // taller card and the foot of it is never in frame. Pinned to a height, the
  // card stops moving and the window can be cut to it.
  await page.addStyleTag({ content: ':root { --shot-height: 560px; }' });

  for (const [mode, name] of MODES) {
    await page.locator(`#modes button[data-mode="${mode}"]`).click();
    await page.waitForTimeout(600);
    const bottom = await page.evaluate(() =>
      Math.ceil(document.querySelector('.card').getBoundingClientRect().bottom + window.scrollY)
    );
    await page.setViewportSize({ width: 1440, height: bottom + 14 });
    await page.waitForTimeout(250);
    await save(browser, `report-detail-${name}.webp`, await page.screenshot());
  }

  await page.close();
}

/**
 * Writes one shot, as WebP.
 *
 * These pictures are read in a README at about 900 px wide, so a 2880 px PNG
 * spends three quarters of its bytes on detail nobody sees. Captured at 1.5x
 * and encoded through the browser that already took them: no second tool to
 * install, and the repository carries a third of what it did.
 */
async function save(browser, name, png) {
  const page = await browser.newPage();
  await page.setContent('<body></body>');
  const encoded = await page.evaluate(async ({ data, quality }) => {
    const bitmap = await createImageBitmap(await (await fetch(data)).blob());
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    return canvas.toDataURL('image/webp', quality).split(',')[1];
  }, { data: `data:image/png;base64,${png.toString('base64')}`, quality: 0.92 });
  await page.close();

  const file = join(shotDir, name);
  writeFileSync(file, Buffer.from(encoded, 'base64'));
  console.log(`  docs/screenshots/${name} (${Math.round(Buffer.from(encoded, 'base64').length / 1024)} KB)`);
}

const a = await serve(join(root, 'docs', 'demo', 'site-a'));
const b = await serve(join(root, 'docs', 'demo', 'site-b'));
const workDir = mkdtempSync(join(tmpdir(), 'diffyard-shots-'));

try {
  writeFileSync(
    join(workDir, 'diffyard.yaml'),
    `compare:
  a: { url: ${a.url}, label: staging }
  b: { url: ${b.url}, label: live }
output:
  dir: out
browser:
  viewports:
    desktop: { width: 1280, height: 900 }
    mobile:  { width: 375, height: 812 }
scenarios:
  - /
  - /pricing
  - /about
`
  );

  console.log('running diffyard against the demo site…');
  const live = await captureTerminal(workDir, 'diffyard.yaml');

  const out = join(workDir, 'out');
  const runId = readdirSync(out).filter((name) => name.startsWith('20')).sort().at(-1);

  const browser = await chromium.launch();
  await shootTerminal(browser, live, 'cli-run.webp');
  await shootReport(browser, join(out, runId, 'index.html'));
  await browser.close();
} finally {
  await a.close();
  await b.close();
  // KEEP=1 leaves the run behind, for opening the report and looking at it.
  if (process.env['KEEP']) console.log(`kept ${workDir}`);
  else rmSync(workDir, { recursive: true, force: true });
}
