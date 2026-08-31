import { spawn } from 'node:child_process';
import { createRequire as makeRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { chromium, firefox, webkit } from 'playwright';
import type { Browser, BrowserContext, Locator, Page } from 'playwright';
import { resolveUrl } from './config.js';
import { fold, keeps } from './logs.js';
import { describeStep, runStep } from './steps.js';
import type {
  Answer,
  Config,
  LogEntry,
  LogKind,
  Picture,
  Scenario,
  Side,
  SideConfig,
  Step,
  Viewport,
} from './types.js';

/** No browser to drive, and the run cannot get one. Named so the CLI can say so. */
export class BrowserError extends Error {}

/** What Playwright says when the browser binary was never downloaded. */
function missingBrowser(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Executable doesn't exist");
}

/**
 * Fetches the browser the run needs, once, and says so.
 *
 * It is the one piece of the install that cannot be bundled: Playwright ships
 * its browsers as a separate download of a few hundred megabytes. Leaving that
 * to the reader means a first run that fails with a wall of text and a command
 * to copy — a step that exists only because nobody fetched it yet. So the run
 * fetches it and carries on.
 *
 * PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD leaves it alone, which is what an image
 * that installs its own browsers wants.
 */
async function fetchBrowser(name: Config['browser']): Promise<void> {
  if (process.env['PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD']) {
    throw new BrowserError(
      `No ${name} to drive, and PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD is set.\n` +
        `Install it with: npx playwright install ${name}`
    );
  }

  const resolveModule = makeRequire(import.meta.url).resolve;
  let cli: string;
  try {
    cli = join(dirname(resolveModule('playwright/package.json')), 'cli.js');
  } catch {
    throw new BrowserError(
      `No ${name} to drive, and Playwright is not where this command can find it.\n` +
        `Install it with: npx playwright install ${name}`
    );
  }

  process.stderr.write(`\n  Fetching ${name} — Playwright ships its browsers separately, and this is\n  the first run that needs one. It is downloaded once.\n\n`);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'install', name], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0
        ? resolve()
        : reject(
            new BrowserError(
              `Could not fetch ${name}.\nTry it directly: npx playwright install ${name}`
            )
          )
    );
  });
}

/**
 * Records what the page says, as it says it.
 *
 * Three of these never reach the console but explain a picture just as well: an
 * uncaught exception that stopped a script before it laid anything out, a
 * request that never completed, and a response that came back an error — a 404
 * image is a difference you can see.
 *
 * The filtering happens here rather than at the end so a page in a loop cannot
 * fill memory with lines that were going to be dropped anyway.
 */
function listen(page: Page, config: Config): LogEntry[] {
  const entries: LogEntry[] = [];

  const add = (kind: LogKind, text: string, source: string | null) => {
    const single = text.replace(/\s+/g, ' ').trim();
    if (single === '' || !keeps(kind, single, config.logs)) return;
    // Room to fold repeats afterwards without keeping every copy of them.
    if (entries.length > config.logs.max * 20) return;
    entries.push({ kind, text: single.slice(0, 500), source, count: 1 });
  };

  page.on('console', (message) => {
    // Playwright reports more types than are worth a config option — table,
    // trace, startGroup. Anything not asked for is dropped by keeps().
    const where = message.location();
    add(message.type() as LogKind, message.text(), where.url ? `${where.url}:${where.lineNumber}` : null);
  });

  page.on('pageerror', (error) => {
    add('pageerror', error.message, error.stack?.split('\n')[1]?.trim() ?? null);
  });

  page.on('requestfailed', (request) => {
    const reason = request.failure()?.errorText ?? 'failed';
    // Playwright reports a navigation the run itself cut short this way; that
    // is the run's own doing, not something the page did.
    if (reason.includes('ERR_ABORTED')) return;
    add('requestfailed', `${reason} ${request.url()}`, request.url());
  });

  page.on('response', (response) => {
    if (response.status() < 400) return;
    add('httperror', `HTTP ${response.status()} ${response.url()}`, response.url());
  });

  return entries;
}

/** CSS that removes the usual sources of non-deterministic pixels. */
/** Upper bound for waiting on fonts and images, in milliseconds. */
const SETTLE_BUDGET = 4000;

/** Upper bound for what a scroll set off: lazy lists take longer than a font. */
const LAZY_SETTLE_BUDGET = 8000;

const FREEZE_CSS = `
*, *::before, *::after {
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  animation-iteration-count: 1 !important;
  transition-duration: 0s !important;
  transition-delay: 0s !important;
  scroll-behavior: auto !important;
}
input, textarea, [contenteditable] { caret-color: transparent !important; }
/*
 * Neither can be held still from here. A canvas is whatever a script last drew
 * on it. A video can be paused and wound back, which sounds like enough -- but
 * whether Chromium has painted that frame by the time the screenshot is taken
 * is not something waiting decides: photographing one page twice, with the
 * videos paused, came out 0.005% apart at one wait and 12% apart at another,
 * and the differing rows were inside the players every time.
 *
 * They keep their space, so a player that moved or changed size still shows as
 * everything around it moving. What is given up is the frame, which is the one
 * part that could not have been compared anyway.
 */
video, canvas { visibility: hidden !important; }
`;

export interface CaptureRequest {
  scenario: Scenario;
  viewport: Viewport;
  side: Side;
}

export interface CaptureOutcome {
  /** What was asked for. */
  url: string;
  /**
   * How the side answered, and where the answer came from. Null for a side
   * taken from an earlier run, which was not asked anything now.
   *
   * A page that answers 404 on one side and 200 on the other is not a page
   * that changed, and neither is one that redirects on one side only -- but
   * both come back as a screenshot of something, and comparing those pixels
   * says nothing about either.
   */
  answer: Answer | null;
  png: Buffer;
  /** Serialised DOM at screenshot time, or null when markup diffing is off. */
  html: string | null;
  /**
   * Where the page says its pictures are, in the coordinates of the shot.
   *
   * Two systems rarely serve a photograph as the same file, and the difference
   * between two encodings of one picture is not a difference in the page. It
   * takes a laid-out document to know where they are, so they are collected
   * here rather than read out of the markup afterwards.
   */
  pictures: Picture[];
  /** What the page said while it was being photographed. */
  logs: LogEntry[];
}

/**
 * Every rectangle on the page that holds a picture, in the coordinates of the
 * screenshot that was just taken.
 *
 * Elements first, then anything with a background image, because half the
 * photographs on a page are not <img> at all. Screenshots are taken at CSS
 * scale, so a CSS pixel is a pixel of the shot whatever the device ratio is;
 * a full-page shot starts at the top of the document and a viewport one at the
 * scroll position, which is the only difference between the two.
 *
 * A clipped scenario is left alone: its shot is of one element and these
 * coordinates would be of the page around it.
 */
async function picturesOf(page: Page, scenario: Scenario): Promise<Picture[]> {
  if (scenario.clip) return [];

  try {
    return await page.evaluate((fullPage: boolean) => {
      const found: { x: number; y: number; width: number; height: number; src: string }[] = [];
      const offsetX = fullPage ? window.scrollX : 0;
      const offsetY = fullPage ? window.scrollY : 0;

      // Smaller than this is an icon or a spacer: too little to average over,
      // and too little to be worth the doubt.
      const ENOUGH = 24;

      const add = (element: Element, src: string): void => {
        const rect = element.getBoundingClientRect();
        if (rect.width < ENOUGH || rect.height < ENOUGH) return;
        found.push({
          x: Math.round(rect.left + offsetX),
          y: Math.round(rect.top + offsetY),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          src,
        });
      };

      for (const element of document.querySelectorAll('img, video, canvas, svg')) {
        const image = element as HTMLImageElement;
        add(element, image.currentSrc || image.src || '');
      }

      for (const element of document.querySelectorAll('*')) {
        const background = window.getComputedStyle(element).backgroundImage;
        if (!background || background.indexOf('url(') === -1) continue;
        add(element, background);
      }

      return found;
    }, scenario.fullPage);
  } catch {
    // A page that navigated away or closed under us has no rectangles to give;
    // the comparison is still a comparison, just without them.
    return [];
  }
}

/**
 * Owns the browser and one context per (side, deviceScaleFactor) pair, so
 * headers, cookies and auth are applied once instead of per navigation.
 */
export class Capturer {
  private constructor(
    private readonly browser: Browser,
    private readonly config: Config,
    private readonly contexts = new Map<string, Promise<BrowserContext>>(),
    /** Keys of `once` beforeEach entries already performed for a context. */
    private readonly completed = new Set<string>()
  ) {}

  static async launch(config: Config): Promise<Capturer> {
    const engine = { chromium, firefox, webkit }[config.browser];
    const options = {
      headless: config.headless,
      args: config.browser === 'chromium' ? ['--font-render-hinting=none', '--disable-lcd-text'] : undefined,
    };

    try {
      return new Capturer(await engine.launch(options), config);
    } catch (error) {
      if (!missingBrowser(error)) throw error;
      await fetchBrowser(config.browser);
      return new Capturer(await engine.launch(options), config);
    }
  }

  async capture({ scenario, viewport, side }: CaptureRequest): Promise<CaptureOutcome> {
    const { config } = this;
    const path = (side === 'a' ? scenario.pathA : scenario.pathB) ?? scenario.path;
    // A grouped scenario carries the site it belongs to; everything else uses
    // the run's own sides.
    const sideConfig = (side === 'a' ? scenario.sideA : scenario.sideB) ?? config[side];
    const url = resolveUrl(sideConfig.baseUrl, path);

    const contextKey = `${side}:${viewport.deviceScaleFactor}:${sideConfig.baseUrl}`;
    const context = await this.contextFor(sideConfig, viewport, contextKey);
    const page = await context.newPage();
    page.setDefaultTimeout(config.timeout);

    // Attached before the navigation, or everything the first paint reports is
    // gone before anyone is listening.
    const logs = config.logs.enabled ? listen(page, config) : [];

    try {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const response = await page.goto(url, { waitUntil: scenario.waitUntil, timeout: config.timeout });

      // Read before anything on the page can navigate away from it.
      const answer = answerOf(response ? response.status() : null, url, page.url(), sideConfig.baseUrl);

      if (config.freeze) await page.addStyleTag({ content: FREEZE_CSS });

      await this.runBeforeEach(page, side, contextKey);

      // Applied before the scenario's steps as well: an overlay left in place
      // intercepts pointer events and makes every later click time out.
      await hideElements(page, scenario.hide);
      await removeElements(page, scenario.remove);

      await this.runSteps(page, scenario.steps, `scenario "${scenario.name}"`);

      if (config.triggerLazyLoad && scenario.fullPage) await scrollThroughPage(page, config.timeout);
      if (scenario.waitForTimeout > 0) await page.waitForTimeout(scenario.waitForTimeout);

      // Again before the screenshot, in case scripts re-inserted them.
      await hideElements(page, scenario.hide);
      await removeElements(page, scenario.remove);
      await settle(page, config.timeout);

      const target: Page | Locator = scenario.clip ? page.locator(scenario.clip).first() : page;
      const png = await target.screenshot({
        // A locator screenshot is always element-scoped, so fullPage only applies to the page.
        ...(scenario.clip ? {} : { fullPage: scenario.fullPage }),
        mask: scenario.mask.map((selector) => page.locator(selector)),
        maskColor: '#ff00ff',
        animations: 'disabled',
        caret: 'hide',
        scale: 'css',
        timeout: config.timeout,
      });

      const html = config.markup.enabled ? await page.content() : null;
      // After the screenshot, from the same page in the same state, so the
      // rectangles are the rectangles in the picture that was just taken.
      const pictures = await picturesOf(page, scenario);

      return { url, answer, png, html, pictures, logs: fold(logs, config.logs.max) };
    } finally {
      await page.close();
    }
  }

  /**
   * Drops every context, killing any page still stuck in an operation. Used
   * after a comparison timed out, where the browser state is no longer
   * trustworthy. New contexts are created lazily on the next capture.
   */
  async recycle(): Promise<void> {
    const open = [...this.contexts.values()];
    this.contexts.clear();
    this.completed.clear();
    await Promise.all(
      open.map(async (pending) => {
        const context = await pending.catch(() => null);
        await context?.close().catch(() => undefined);
      })
    );
  }

  async close(): Promise<void> {
    for (const pending of this.contexts.values()) {
      const context = await pending.catch(() => null);
      await context?.close().catch(() => undefined);
    }
    this.contexts.clear();
    await this.browser.close();
  }

  /**
   * Runs the beforeEach entries in order.
   *
   * An entry with a trigger only applies once its element shows up; if it does
   * not, the entry is skipped rather than failing, because a consent banner or
   * a staging notice may legitimately be absent. Entries marked `once` are
   * skipped after they have run for this context — a decision that stuck in a
   * cookie need not be repeated, and waiting for its trigger on every later
   * page only costs time.
   */
  private async runBeforeEach(page: Page, side: Side, contextKey: string): Promise<void> {
    for (const [index, entry] of this.config.beforeEach.entries()) {
      if (entry.side !== null && entry.side !== side) continue;

      const doneKey = `${contextKey}:${index}`;
      const alreadyDone = entry.once && this.completed.has(doneKey);

      if (entry.when !== null) {
        // Once it has run, the trigger is looked for but not waited for: the
        // decision is stored in the context, so waiting again would cost the
        // full timeout on every remaining page for a banner that will not come.
        const appeared = alreadyDone
          ? await page.locator(entry.when).first().isVisible().catch(() => false)
          : await waitForVisible(page, entry.when, entry.timeout);

        if (!appeared) {
          if (entry.required && !alreadyDone) {
            throw new Error(
              `beforeEach "${entry.name}" never saw "${entry.when}" within ${entry.timeout}ms`
            );
          }
          continue;
        }
      } else if (alreadyDone) {
        continue;
      }

      await this.runSteps(page, entry.steps, `beforeEach "${entry.name}"`);
      if (entry.once) this.completed.add(doneKey);
    }
  }

  private async runSteps(page: Page, steps: readonly Step[], origin: string): Promise<void> {
    for (const [index, step] of steps.entries()) {
      try {
        await runStep(page, step, this.config.timeout);
      } catch (error) {
        if (step.optional === true) continue;
        throw new Error(
          `Step ${index + 1} of ${origin} failed (${describeStep(step)}): ${(error as Error).message}`
        );
      }
    }
  }

  /**
   * One context per side, scale and base URL, created once.
   *
   * The map holds the promise rather than the context: with workers running
   * side by side, two captures asking at the same time would otherwise each
   * create one, and the second would replace the first mid-run.
   */
  private async contextFor(
    sideConfig: SideConfig,
    viewport: Viewport,
    key: string
  ): Promise<BrowserContext> {
    const existing = this.contexts.get(key);
    if (existing) return existing;

    const creating = this.create(sideConfig, viewport);
    this.contexts.set(key, creating);
    return creating;
  }

  private async create(sideConfig: SideConfig, viewport: Viewport): Promise<BrowserContext> {
    const { config } = this;
    const context = await this.browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: viewport.deviceScaleFactor,
      colorScheme: config.colorScheme,
      reducedMotion: config.reducedMotion ? 'reduce' : 'no-preference',
      ignoreHTTPSErrors: config.ignoreHTTPSErrors,
      extraHTTPHeaders: sideConfig.headers,
      ...(sideConfig.basicAuth ? { httpCredentials: sideConfig.basicAuth } : {}),
      ...(sideConfig.storageState ? { storageState: sideConfig.storageState } : {}),
      ...(config.locale ? { locale: config.locale } : {}),
      ...(config.timezone ? { timezoneId: config.timezone } : {}),
      ...(config.userAgent ? { userAgent: config.userAgent } : {}),
    });

    if (sideConfig.cookies.length > 0) {
      await context.addCookies(
        sideConfig.cookies.map((cookie) => ({
          name: cookie.name,
          value: cookie.value,
          ...(cookie.url ? { url: cookie.url } : {}),
          ...(cookie.domain ? { domain: cookie.domain } : {}),
          path: cookie.path ?? '/',
        })) as Parameters<BrowserContext['addCookies']>[0]
      );
    }

    return context;
  }
}

/** Polls until the selector is visible, or the budget runs out. */
async function waitForVisible(page: Page, selector: string, timeout: number): Promise<boolean> {
  const deadline = Date.now() + timeout;

  do {
    if (await page.locator(selector).first().isVisible().catch(() => false)) return true;
    await page.waitForTimeout(120);
  } while (Date.now() < deadline);

  return false;
}

/**
 * Walks the whole document and waits for what that started.
 *
 * Two things a first version gets wrong, both of which leave a page
 * photographed with holes in it where the images should be:
 *
 * An image that has not begun loading reports `complete === true` — there is
 * nothing in flight — so counting incomplete images to decide when a page has
 * settled reads a page full of untriggered lazy images as a page with nothing
 * left to do. On one real page that ended the walk after three screens of
 * eight thousand pixels, and twenty-one sponsor logos were never fetched.
 *
 * And a page with `scroll-behavior: smooth` animates every scrollTo, so a walk
 * that asks for the next screen every twenty-five milliseconds keeps restarting
 * the animation and never leaves the top: asked for 8120, arrived at 148.
 *
 * So the walk covers the whole page under a time budget, scrolls instantly
 * whatever the page would prefer, and then waits for every image that has a
 * source to be painted rather than merely fetched.
 */
async function scrollThroughPage(page: Page, timeout: number): Promise<void> {
  const budget = Math.min(LAZY_SETTLE_BUDGET, timeout);

  await page.evaluate(async (limit) => {
    const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
    const height = () => Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);

    // Both the property and the option: the option is ignored by older
    // engines, the property is what a page's own smooth scrolling reads.
    const root = document.documentElement;
    const previous = root.style.scrollBehavior;
    root.style.scrollBehavior = 'auto';
    const jump = (y: number) => window.scrollTo({ top: y, left: 0, behavior: 'instant' as ScrollBehavior });

    const deadline = Date.now() + limit;
    const step = Math.max(window.innerHeight, 200);

    // A full viewport per step: anything using IntersectionObserver or
    // loading="lazy" starts fetching once it has been on screen. The page is
    // re-measured every step because loading things into it makes it grow.
    for (let y = 0; y < height() && Date.now() < deadline; y += step) {
      jump(y);
      await pause(25);
    }

    jump(0);
    await pause(60);
    root.style.scrollBehavior = previous;
  }, budget);

  // Requests the walk set off are still on the wire at this point.
  await page.waitForLoadState('networkidle', { timeout: budget }).catch(() => {
    // A page that never goes quiet must not fail the capture; the wait below
    // still gives its images their chance.
  });

  await page
    .evaluate(async (limit) => {
      const deadline = Date.now() + limit;

      // Still on the way, which `complete` answers exactly: it is false while
      // the browser is fetching, and true once it has finished either way.
      //
      // It used to also count an image with no intrinsic width, on the idea
      // that a picture without a size had not arrived. But that is what a 404
      // looks like -- complete, and nothing to show -- so one broken image
      // held the capture until the budget above ran out. Measured on a real
      // page with three missing files: the whole budget spent, for a
      // screenshot identical to the one taken three milliseconds in. It is
      // spent on both sides and at every viewport, so one broken image cost
      // the scenario four times over.
      //
      // currentSrc, because a lazy image the browser has not been asked for
      // yet is not complete either, and never will be.
      const outstanding = () =>
        Array.from(document.images).filter((image) => image.currentSrc && !image.complete).length;

      while (outstanding() > 0 && Date.now() < deadline) {
        await new Promise((done) => setTimeout(done, 100));
      }

      // decode() resolves when the image is ready to paint, which is what the
      // screenshot needs — complete only says the bytes arrived.
      const painted = Array.from(document.images)
        .filter((image) => image.currentSrc)
        .map((image) => image.decode().catch(() => undefined));

      const left = new Promise((done) => setTimeout(done, Math.max(0, deadline - Date.now())));
      await Promise.race([Promise.all(painted), left]);
    }, budget)
    .catch(() => undefined);
}

/**
 * What came back, in the two terms both sides can be held to.
 *
 * The landing is kept relative to that side's own base URL, because the two
 * sides differ in host by definition: comparing absolute addresses would call
 * every page a redirect.
 */
function answerOf(status: number | null, asked: string, landed: string, baseUrl: string): Answer {
  const relative = (address: string): string => {
    try {
      const base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
      const at = new URL(address);
      if (at.origin !== base.origin) return address;
      const prefix = base.pathname.replace(/\/$/, '');
      const path = at.pathname.startsWith(prefix) ? at.pathname.slice(prefix.length) : at.pathname;
      return (path || '/') + at.search;
    } catch {
      return address;
    }
  };

  const from = relative(asked);
  const to = relative(landed);

  return { status, landed, path: to, redirected: from !== to };
}

async function hideElements(page: Page, selectors: string[]): Promise<void> {
  if (selectors.length === 0) return;
  await page.addStyleTag({
    content: `${selectors.join(', ')} { visibility: hidden !important; }`,
  });
}

async function removeElements(page: Page, selectors: string[]): Promise<void> {
  if (selectors.length === 0) return;
  await page.evaluate((list) => {
    for (const selector of list) {
      document.querySelectorAll(selector).forEach((element) => element.remove());
    }
  }, selectors);
}

/**
 * Waits for fonts and images so text and media are not captured mid-load.
 *
 * The wait is capped: a lazy-loading image below the fold never fires `load`
 * because it is never scrolled into view, and waiting for it would otherwise
 * stall every viewport-only capture until the evaluate timeout expires.
 */
async function settle(page: Page, timeout: number): Promise<void> {
  const budget = Math.min(SETTLE_BUDGET, timeout);

  await page
    .evaluate(async (limit) => {
      const deadline = new Promise((done) => setTimeout(done, limit));

      const images = Array.from(document.images).filter((image) => {
        if (image.complete) return false;
        // Images the browser has not been asked to load yet never settle.
        if (image.loading === 'lazy') {
          const box = image.getBoundingClientRect();
          const onScreen = box.top < window.innerHeight && box.bottom > 0;
          if (!onScreen) return false;
        }
        return true;
      });

      const loaded = images.map(
        (image) =>
          new Promise<void>((done) => {
            image.addEventListener('load', () => done(), { once: true });
            image.addEventListener('error', () => done(), { once: true });
          })
      );

      await Promise.race([Promise.all([document.fonts.ready, ...loaded]), deadline]);
      await new Promise((done) => requestAnimationFrame(() => done(null)));
    }, budget)
    .catch(() => {
      // A page that navigates or blocks scripting must not fail the capture.
    });

  await page.waitForTimeout(Math.min(150, timeout));
}
