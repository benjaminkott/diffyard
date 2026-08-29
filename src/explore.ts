import { chromium, firefox, webkit } from 'playwright';
import type { Page } from 'playwright';

/** What a page offers that is relevant for building a diffyard config. */
export interface PageReport {
  url: string;
  title: string;
  status: number | null;
  consent: Candidate[];
  interactive: Candidate[];
  navigation: { path: string; label: string }[];
  dynamic: Candidate[];
  notes: string[];
}

export interface Candidate {
  selector: string;
  label: string;
  /** Why this element was surfaced, in the wording of the config it belongs to. */
  hint: string;
}

export interface ExploreOptions {
  browser: 'chromium' | 'firefox' | 'webkit';
  viewport: { width: number; height: number };
  ignoreHTTPSErrors: boolean;
  timeout: number;
  /** Accept a consent banner first, so the page behind it can be inspected. */
  acceptConsent: string[];
}

/**
 * Opens a page and reports what a comparison config would need to know about
 * it: which button accepts the consent banner, which elements open a menu,
 * which links are worth turning into scenarios, and which content changes on
 * every load and should therefore be masked.
 *
 * This is the counterpart to taking a snapshot before writing a test: the
 * caller is expected to look at the result and then write the config.
 */
export async function explorePage(url: string, options: ExploreOptions): Promise<PageReport> {
  const engine = { chromium, firefox, webkit }[options.browser];
  const browser = await engine.launch({ headless: true });

  try {
    const context = await browser.newContext({
      viewport: options.viewport,
      ignoreHTTPSErrors: options.ignoreHTTPSErrors,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(options.timeout);

    const response = await page.goto(url, { waitUntil: 'networkidle', timeout: options.timeout });
    const status = response?.status() ?? null;

    const notes: string[] = [];
    const consentBefore = await findConsent(page);

    if (options.acceptConsent.length > 0) {
      const clicked = await clickFirst(page, options.acceptConsent, options.timeout);
      notes.push(clicked ? `Accepted the consent banner via ${clicked}.` : 'None of the given consent selectors matched.');
      await page.waitForTimeout(600);
    }

    const [interactive, navigation, dynamic, title] = await Promise.all([
      findInteractive(page),
      findNavigation(page, url),
      findDynamic(page),
      page.title(),
    ]);

    if (consentBefore.length > 0 && options.acceptConsent.length === 0) {
      notes.push(
        'A consent banner is present. Accept it from a beforeEach entry with a `when` trigger ' +
          'rather than removing it, so both sides are captured as a visitor sees them. An overlay ' +
          'left in place also swallows the clicks of every later step.'
      );
    }

    if (interactive.some((entry) => entry.hint.includes('mobile'))) {
      notes.push('The navigation collapses on small viewports, so an "open menu" scenario belongs in the mobile viewport.');
    }

    return {
      url: page.url(),
      title,
      status,
      consent: consentBefore,
      interactive,
      navigation,
      dynamic,
      notes,
    };
  } finally {
    await browser.close();
  }
}

async function clickFirst(page: Page, selectors: string[], timeout: number): Promise<string | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (!(await locator.isVisible().catch(() => false))) continue;
    await locator.click({ timeout }).catch(() => undefined);
    return selector;
  }
  return null;
}

function findConsent(page: Page): Promise<Candidate[]> {
  return page.evaluate(() => {
    const ACCEPT = /^(accept|allow|agree|ok|got it|alle akzeptieren|akzeptieren|zustimmen|einverstanden|alle erlauben)/i;
    const CONTAINER = /consent|cookie|usercentrics|onetrust|cookiebot|gdpr|privacy/i;

    const results: { selector: string; label: string; hint: string }[] = [];
    const seen = new Set<string>();

    const clickable = document.querySelectorAll<HTMLElement>('button, a[role=button], [role=button], input[type=button], input[type=submit]');

    for (const element of clickable) {
      const label = (element.textContent ?? (element as HTMLInputElement).value ?? '').replace(/\s+/g, ' ').trim();
      const inConsent = element.closest('[id],[class]');
      const context = `${inConsent?.id ?? ''} ${inConsent?.className ?? ''} ${element.id} ${element.className}`;

      const looksLikeAccept = ACCEPT.test(label);
      const insideConsentUi = CONTAINER.test(context);
      if (!looksLikeAccept && !(insideConsentUi && /accept|allow|agree/i.test(context))) continue;

      const box = element.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;

      const selector = buildSelector(element);
      if (seen.has(selector)) continue;
      seen.add(selector);

      results.push({
        selector,
        label: label.slice(0, 60) || '(no text)',
        hint: insideConsentUi
          ? 'beforeEach with a when trigger — inside a consent container'
          : 'beforeEach with a when trigger — button text reads as accepting',
      });
    }

    return results.slice(0, 8);

    function buildSelector(element: Element): string {
      if (element.id) return `#${CSS.escape(element.id)}`;

      const testId = element.getAttribute('data-testid');
      if (testId) return `[data-testid="${testId}"]`;

      const classes = Array.from(element.classList)
        .filter((name) => !/^(is-|has-|js-)/.test(name))
        .slice(0, 3)
        .map((name) => `.${CSS.escape(name)}`)
        .join('');

      const tag = element.tagName.toLowerCase();
      if (classes) return `${tag}${classes}`;

      const parent = element.parentElement;
      if (!parent) return tag;
      const index = Array.from(parent.children).indexOf(element) + 1;
      return `${buildSelector(parent)} > ${tag}:nth-child(${index})`;
    }
  });
}

function findInteractive(page: Page): Promise<Candidate[]> {
  return page.evaluate(() => {
    const results: { selector: string; label: string; hint: string }[] = [];
    const seen = new Set<string>();

    const candidates = document.querySelectorAll<HTMLElement>(
      '[aria-expanded], [aria-haspopup], [data-bs-toggle], [data-toggle], .navbar-toggler, ' +
        '[class*="hamburger"], [class*="burger"], [class*="menu-toggle"], [class*="nav-toggle"], ' +
        'details > summary, dialog + button'
    );

    for (const element of candidates) {
      const selector = buildSelector(element);
      if (seen.has(selector)) continue;
      seen.add(selector);

      const box = element.getBoundingClientRect();
      const visible = box.width > 0 && box.height > 0;
      const label =
        (element.getAttribute('aria-label') ?? element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) ||
        element.tagName.toLowerCase();

      const target =
        element.getAttribute('data-bs-target') ??
        element.getAttribute('data-target') ??
        (element.getAttribute('aria-controls') ? `#${element.getAttribute('aria-controls')}` : null);

      const expands = element.getAttribute('aria-expanded') !== null;
      const hint = [
        `steps: - click: "${selector}"`,
        target ? `then - waitFor: "${target}.show" (or whatever class marks it open)` : null,
        expands ? 'aria-expanded flips when it opens' : null,
        visible ? null : 'not visible at this viewport — likely mobile-only',
      ]
        .filter(Boolean)
        .join(' · ');

      results.push({ selector, label, hint });
    }

    return results.slice(0, 15);

    function buildSelector(element: Element): string {
      if (element.id) return `#${CSS.escape(element.id)}`;
      const testId = element.getAttribute('data-testid');
      if (testId) return `[data-testid="${testId}"]`;

      const classes = Array.from(element.classList)
        .filter((name) => !/^(is-|has-|js-|active|open|show|collapsed)$/.test(name))
        .slice(0, 3)
        .map((name) => `.${CSS.escape(name)}`)
        .join('');

      const tag = element.tagName.toLowerCase();
      if (classes) return `${tag}${classes}`;

      const parent = element.parentElement;
      if (!parent) return tag;
      const index = Array.from(parent.children).indexOf(element) + 1;
      return `${buildSelector(parent)} > ${tag}:nth-child(${index})`;
    }
  });
}

function findNavigation(page: Page, baseUrl: string): Promise<{ path: string; label: string }[]> {
  return page.evaluate((base) => {
    const origin = new URL(base).origin;
    const found = new Map<string, string>();

    for (const link of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      const href = link.getAttribute('href') ?? '';
      if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) continue;

      let resolved: URL;
      try {
        resolved = new URL(href, document.baseURI);
      } catch {
        continue;
      }
      if (resolved.origin !== origin) continue;
      // Assets are not pages worth comparing as scenarios.
      if (/\.(jpe?g|png|gif|svg|webp|avif|pdf|zip|css|js|ico)$/i.test(resolved.pathname)) continue;

      const path = resolved.pathname + resolved.search;
      if (found.has(path)) continue;
      found.set(path, (link.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 50) || path);
    }

    return Array.from(found, ([path, label]) => ({ path, label })).slice(0, 60);
  }, baseUrl);
}

function findDynamic(page: Page): Promise<Candidate[]> {
  return page.evaluate(() => {
    const results: { selector: string; label: string; hint: string }[] = [];
    const seen = new Set<string>();

    const RELATIVE_TIME = /\b(\d+\s+(second|minute|hour|day|week|month|year)s?\s+ago|vor\s+\d+\s+(Sekunde|Minute|Stunde|Tag|Woche|Monat|Jahr))/i;

    const timed = Array.from(
      document.querySelectorAll<HTMLElement>(
        'time, [datetime], [class*="timestamp"], [class*="countdown"], [class*="random"], [class*="carousel"], [class*="slider"]'
      )
    );

    // Masking the outermost element covers its children, so a carousel should
    // be suggested once instead of once per nested wrapper.
    const outermost = timed.filter(
      (element) => !timed.some((other) => other !== element && other.contains(element))
    );

    for (const element of outermost) {
      const selector = buildSelector(element);
      if (seen.has(selector)) continue;
      seen.add(selector);
      const label = (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 50);
      const rotating = /carousel|slider/i.test(element.className);
      results.push({
        selector,
        label: label || element.tagName.toLowerCase(),
        hint: rotating
          ? 'mask — rotates on its own, so the two sides rarely show the same slide'
          : 'mask — time-dependent content',
      });
    }

    for (const element of document.querySelectorAll<HTMLElement>('p, span, div, li')) {
      if (element.children.length > 0) continue;
      const text = (element.textContent ?? '').trim();
      if (!RELATIVE_TIME.test(text)) continue;
      const selector = buildSelector(element);
      if (seen.has(selector)) continue;
      seen.add(selector);
      results.push({ selector, label: text.slice(0, 50), hint: 'mask — relative time drifts between the two captures' });
    }

    return results.slice(0, 12);

    function buildSelector(element: Element): string {
      if (element.id) return `#${CSS.escape(element.id)}`;
      const classes = Array.from(element.classList).slice(0, 2).map((name) => `.${CSS.escape(name)}`).join('');
      const tag = element.tagName.toLowerCase();
      return classes ? `${tag}${classes}` : tag;
    }
  });
}

// ---------------------------------------------------------------- rendering

export function renderExploration(
  report: PageReport,
  requestedUrl: string,
  compareWith: string | undefined,
  ignoreHTTPSErrors: boolean
): string {
  const sections: string[] = [
    `${report.title || '(untitled)'} — ${report.url}${report.status ? ` (HTTP ${report.status})` : ''}`,
  ];

  sections.push(
    section(
      'Consent',
      report.consent.length === 0
        ? ['  none found — either there is no banner, or it was already accepted']
        : report.consent.map((entry) => `  ${entry.selector}\n      "${entry.label}" — ${entry.hint}`)
    )
  );

  sections.push(
    section(
      'Interactive elements (candidates for steps)',
      report.interactive.length === 0
        ? ['  none found']
        : report.interactive.map((entry) => `  ${entry.selector}\n      "${entry.label}"\n      ${entry.hint}`)
    )
  );

  sections.push(
    section(
      'Content that changes on its own (candidates for mask)',
      report.dynamic.length === 0
        ? ['  none found']
        : report.dynamic.map((entry) => `  ${entry.selector} — ${entry.hint}`)
    )
  );

  const pages = report.navigation.slice(0, 25);
  sections.push(
    section(
      `Internal links (${report.navigation.length} found, showing ${pages.length})`,
      pages.map((entry) => `  ${entry.path.padEnd(44).slice(0, 44)} ${entry.label}`)
    )
  );

  if (report.notes.length > 0) sections.push(section('Notes', report.notes.map((note) => `  ${note}`)));

  sections.push(
    section('Config draft', [draftConfig(report, requestedUrl, compareWith, ignoreHTTPSErrors)])
  );

  sections.push(
    [
      'Next:',
      '  - explore the same page at a narrow viewport to find the mobile navigation',
      '  - diffyard_create_config with the draft (adjust the scenarios first)',
      '  - diffyard_preview_scenario for any scenario with steps, before running the whole suite',
    ].join('\n')
  );

  return sections.join('\n\n');
}

function draftConfig(
  report: PageReport,
  requestedUrl: string,
  compareWith: string | undefined,
  ignoreHTTPSErrors: boolean
): string {
  const origin = new URL(requestedUrl).origin;
  const consent = report.consent[0];
  const mask = report.dynamic.slice(0, 5).map((entry) => `  - ${JSON.stringify(entry.selector)}`);

  const paths = ['/', ...report.navigation.map((entry) => entry.path)]
    .filter((path, index, all) => all.indexOf(path) === index)
    .slice(0, 8);

  // Bare paths: the scenario is named after the path, which is all most need.
  const scenarios = paths.map((path) => `  - ${JSON.stringify(path)}`);

  const toggle = report.interactive.find((entry) => /toggler|burger|menu|nav/i.test(entry.selector));
  if (toggle) {
    scenarios.push(
      [
        '  - name: home-with-menu-open',
        '    path: "/"',
        '    viewports: [mobile]',
        '    fullPage: false',
        '    steps:',
        `      - click: ${JSON.stringify(toggle.selector)}`,
        '      # then wait for whatever marks the menu as open, e.g.:',
        '      # - waitFor: "#mainnavigation.show"',
        '      - waitForTimeout: 400',
      ].join('\n')
    );
  }

  return [
    'compare:',
    `  a: ${origin}/`,
    `  b: ${compareWith ?? 'https://REPLACE-ME.example.com/'}`,
    '',
    'output:',
    '  dir: .diffyard-report',
    '',
    'browser:',
    ...(ignoreHTTPSErrors ? ['  ignoreHTTPSErrors: true'] : []),
    '  viewports:',
    '    mobile:  { width: 375, height: 812 }',
    '    desktop: { width: 1440, height: 900 }',
    '',
    'diff:',
    '  threshold: 0.001',
    ...(mask.length > 0 ? ['  mask:', ...mask.map((entry) => `  ${entry}`)] : []),
    '',
    ...(consent
      ? [
          'beforeEach:',
          `  - name: accept consent`,
          `    when: ${JSON.stringify(consent.selector)}`,
          '    once: true',
          '    steps:',
          `      - click: ${JSON.stringify(consent.selector)}`,
          '      - waitForTimeout: 500',
          '',
        ]
      : []),
    'scenarios:',
    ...scenarios,
  ].join('\n');
}

function section(title: string, body: string[]): string {
  return `${title}:\n${body.join('\n')}`;
}
