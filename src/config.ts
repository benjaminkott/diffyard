import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type {
  BeforeEach,
  Config,
  LogKind,
  LogOptions,
  MarkupOptions,
  Mode,
  RawCookie,
  Scenario,
  Side,
  SideConfig,
  Step,
  Viewport,
} from './types.js';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const DEFAULT_VIEWPORT: Viewport = { name: 'desktop', width: 1440, height: 900, deviceScaleFactor: 1 };

/** Hidden, so a run does not clutter the project it is checking. */
export const DEFAULT_OUT_DIR = '.diffyard-report';

/** Every action key a step object may carry. Used to validate the config early. */
const STEP_KEYS = new Set([
  'click', 'dblclick', 'hover', 'focus', 'fill', 'press', 'select', 'check', 'uncheck',
  'waitFor', 'waitForHidden', 'waitForText', 'waitForTimeout', 'waitForUrl', 'waitForLoadState',
  'scrollTo', 'scrollToBottom', 'scrollToTop', 'scrollBy', 'goto', 'evaluate', 'addStyle',
  'setViewport', 'screenshot',
]);

/**
 * The keys each block reads, so that one it does not is said rather than
 * dropped. Older spellings that are still read are listed with the rest.
 */
const KEYS = {
  top: [
    'compare', 'output', 'browser', 'timeouts', 'diff', 'stability', 'reuse', 'logs', 'markup',
    'beforeEach', 'groups', 'scenarios', 'viewports', 'console',
  ],
  compare: ['a', 'b'],
  side: ['url', 'label', 'headers', 'cookies', 'basicAuth', 'storageState', 'name'],
  basicAuth: ['username', 'password'],
  cookie: ['name', 'value', 'domain', 'path', 'url'],
  output: ['dir', 'runFolder', 'runId', 'title', 'images'],
  browser: [
    'engine', 'headless', 'viewports', 'colorScheme', 'reducedMotion', 'locale', 'timezone',
    'userAgent', 'ignoreHTTPSErrors',
  ],
  viewport: ['width', 'height', 'w', 'h', 'deviceScaleFactor', 'dpr'],
  timeouts: ['action', 'comparison', 'run'],
  diff: ['threshold', 'pixelThreshold', 'ignoreAntialiasing', 'alignRows', 'mask', 'hide', 'remove'],
  stability: ['freeze', 'triggerLazyLoad', 'retries', 'workers', 'sequential'],
  reuse: ['side', 'from', 'maxAge', 'sides'],
  logs: ['enabled', 'levels', 'ignore', 'max', 'failOnDifference'],
  markup: [
    'enabled', 'failOnDifference', 'ignoreComments', 'normalizeWhitespace', 'sortAttributes',
    'ignoreBaseUrl', 'ignoreAttributes', 'ignoreSelectors', 'maxHunksInReport',
  ],
  beforeEach: ['name', 'when', 'timeout', 'required', 'once', 'side', 'steps'],
  group: ['name', 'compare', 'viewports', 'waitUntil', 'steps', 'fullPage', 'waitForTimeout', 'diff', 'scenarios'],
  groupDiff: ['threshold', 'mask', 'hide', 'remove'],
  scenario: [
    'name', 'path', 'a', 'b', 'viewports', 'steps', 'fullPage', 'clip', 'mask', 'hide', 'remove',
    'threshold', 'waitForTimeout', 'waitUntil', 'skip', 'only', 'viewport',
  ],
} as const;

export function loadConfig(file: string): Config {
  const path = resolve(file);
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch {
    throw new ConfigError(`Config file not found: ${path}`);
  }

  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (error) {
    throw new ConfigError(`Could not parse ${path}: ${(error as Error).message}`);
  }

  if (!isRecord(raw)) {
    throw new ConfigError(`Config must be a YAML mapping, got ${describe(raw)}`);
  }

  // The path as the caller gave it, not the resolved one: it goes into the
  // command printed beside every result, and that has to be runnable as-is.
  return normalise(raw, dirname(path), file);
}

/**
 * Turns the YAML into the flat, fully resolved config the rest of the code
 * works with.
 *
 * The file groups its options — `browser`, `timeouts`, `diff`, `output`,
 * `stability` — because a flat list of twenty unrelated keys is hard to read
 * and harder to extend. That grouping stops here: everything downstream sees
 * one flat object with no optionals left.
 */
function normalise(raw: Record<string, unknown>, configDir: string, file: string): Config {
  onlyKnown(raw, KEYS.top, '');
  const browser = block(raw, 'browser', KEYS.browser);
  const timeouts = block(raw, 'timeouts', KEYS.timeouts);
  const diff = block(raw, 'diff', KEYS.diff);
  const output = block(raw, 'output', KEYS.output);
  const stability = block(raw, 'stability', KEYS.stability);
  const reuse = block(raw, 'reuse', KEYS.reuse);

  // Viewports live with the browser, but the older top-level spelling is
  // accepted because nothing else could reasonably mean.
  const viewports = parseViewports(browser['viewports'] ?? raw['viewports'], 'browser.viewports');

  // The compare block may be left out entirely when every scenario names both
  // addresses in full, which is what a suite spanning several hosts looks like.
  const compare = raw['compare'] ?? {};
  if (!isRecord(compare)) {
    throw new ConfigError('`compare` must be a mapping with the two sides');
  }
  onlyKnown(compare, KEYS.compare, 'compare');

  // One site or two is not a setting, it is what the file names. A config
  // with no side B anywhere has nothing to compare against, and every page
  // in it is photographed once and judged on its own answer.
  const mode: Mode = namesSideB(raw) ? 'compare' : 'smoke';

  const a = parseSide(compare, 'a', configDir);
  const b = mode === 'compare' ? parseSide(compare, 'b', configDir) : null;

  const globalThreshold = num(diff['threshold'], 0, 'diff.threshold', SHARE);
  const rawScenarios = raw['scenarios'] ?? [];
  if (!Array.isArray(rawScenarios)) {
    throw new ConfigError('`scenarios` must be a list');
  }
  if (rawScenarios.length === 0 && raw['groups'] === undefined) {
    throw new ConfigError('Nothing to compare: add `scenarios`, `groups`, or both');
  }

  const globalMask = strList(diff['mask'], 'diff.mask');
  const globalHide = strList(diff['hide'], 'diff.hide');
  const globalRemove = strList(diff['remove'], 'diff.remove');

  const inherited: Inherited = {
    viewports,
    threshold: globalThreshold,
    mask: globalMask,
    hide: globalHide,
    remove: globalRemove,
    defaults: { waitUntil: 'networkidle', steps: [], fullPage: true, waitForTimeout: 0 },
  };

  const scenarios = [
    ...rawScenarios.map((entry, index) => parseOne(entry, `scenarios[${index}]`, index, inherited, null)),
    ...parseGroups(raw['groups'], inherited, configDir, mode),
  ];

  if (scenarios.length === 0) {
    throw new ConfigError('Nothing to compare: every group is empty');
  }

  const names = new Set<string>();
  // Keyed by what a comparison is filed under rather than by what the file
  // calls it: the shots, the report entry and a later reuse all go by the id,
  // so two names that make the same id would quietly write over each other.
  const ids = new Map<string, string>();
  for (const scenario of scenarios) {
    const full = qualify(scenario);
    if (names.has(full)) {
      throw new ConfigError(`Duplicate scenario: "${full}"`);
    }
    names.add(full);

    for (const viewport of scenario.viewports) {
      const id = comparisonId(scenario.group, scenario.name, viewport.name);
      const here = `"${full}" @ ${viewport.name}`;
      const there = ids.get(id);
      if (there !== undefined) {
        throw new ConfigError(
          `Scenarios ${there} and ${here} would both be filed as "${id}", and one would ` +
            "overwrite the other's screenshots. Names are compared without case or punctuation; rename one."
        );
      }
      ids.set(id, here);
    }

    assertAddressable(scenario, 'a', scenario.sideA ?? a);
    if (b) assertAddressable(scenario, 'b', scenario.sideB ?? b);
  }

  const beforeEach = parseBeforeEach(raw['beforeEach']);
  const reuseSides = parseSides(reuse['side'] ?? reuse['sides'], 'reuse.side');

  // Said here, at the option that names the side, rather than mid-run when
  // there is nothing to take: a smoke run has no side B to reuse, and no
  // side B for a notice to be limited to.
  if (b === null) {
    if (reuseSides.includes('b')) {
      throw new ConfigError(
        '`reuse.side` names side B, but this config has no side B: without `compare.b` ' +
          'every page is checked on its own. Reuse `a`, or add the other site.'
      );
    }
    const limited = beforeEach.find((entry) => entry.side === 'b');
    if (limited) {
      throw new ConfigError(
        `beforeEach "${limited.name}" is limited to side B, but this config has no side B: ` +
          'without `compare.b` every page is checked on its own. Drop `side`, or add the other site.'
      );
    }
  }

  return {
    file,
    mode,
    a,
    b,
    // Results belong to the project the run happens in, not to wherever the
    // config file is kept, so this resolves against the working directory.
    outDir: resolveOutput(str(output['dir'], DEFAULT_OUT_DIR, 'output.dir')),
    runFolder: bool(output['runFolder'], true, 'output.runFolder'),
    runId: optionalStr(output['runId'], 'output.runId'),
    images: enumValue(output['images'], ['png', 'webp'] as const, 'webp', 'output.images'),
    viewports,
    scenarios,
    beforeEach,
    pixelThreshold: num(diff['pixelThreshold'], 0.1, 'diff.pixelThreshold', SHARE),
    threshold: globalThreshold,
    ignoreAntialiasing: bool(diff['ignoreAntialiasing'], true, 'diff.ignoreAntialiasing'),
    alignRows: bool(diff['alignRows'], true, 'diff.alignRows'),
    browser: enumValue(browser['engine'], ['chromium', 'firefox', 'webkit'], 'chromium', 'browser.engine'),
    headless: bool(browser['headless'], true, 'browser.headless'),
    timeout: num(timeouts['action'], 30_000, 'timeouts.action', MILLISECONDS),
    comparisonTimeout: num(timeouts['comparison'], 180_000, 'timeouts.comparison', MILLISECONDS),
    runTimeout: num(timeouts['run'], 0, 'timeouts.run', MILLISECONDS),
    retries: num(stability['retries'], 0, 'stability.retries', { min: 0, whole: true }),
    freeze: bool(stability['freeze'], true, 'stability.freeze'),
    triggerLazyLoad: bool(stability['triggerLazyLoad'], true, 'stability.triggerLazyLoad'),
    sequential: bool(stability['sequential'], false, 'stability.sequential'),
    workers: Math.max(1, Math.floor(num(stability['workers'], 1, 'stability.workers'))),
    colorScheme: enumValue(
      browser['colorScheme'],
      ['light', 'dark', 'no-preference'],
      'light',
      'browser.colorScheme'
    ),
    reducedMotion: bool(browser['reducedMotion'], true, 'browser.reducedMotion'),
    locale: optionalStr(browser['locale'], 'browser.locale'),
    timezone: optionalStr(browser['timezone'], 'browser.timezone'),
    userAgent: optionalStr(browser['userAgent'], 'browser.userAgent'),
    ignoreHTTPSErrors: bool(browser['ignoreHTTPSErrors'], false, 'browser.ignoreHTTPSErrors'),
    mask: globalMask,
    hide: globalHide,
    remove: globalRemove,
    markup: parseMarkup(raw['markup']),
    logs: parseLogs(raw['logs'] ?? raw['console']),
    reuse: {
      sides: reuseSides,
      from: str(reuse['from'], 'latest', 'reuse.from'),
      maxAge: parseDuration(reuse['maxAge'], 24 * 60 * 60 * 1000, 'reuse.maxAge'),
    },
    reportTitle: str(output['title'], 'diffyard report', 'output.title'),
  };
}

/**
 * Whether the file names a side B anywhere: the compare block, a group's own
 * compare block, or a scenario's `b:`. Without one there is nothing to hold
 * the pages against, and the run is a smoke run over the one site.
 *
 * Read off the raw file rather than the parsed scenarios because the parser
 * needs to know first: a scenario is parsed differently when there is no
 * other side for it to have an address on.
 */
function namesSideB(raw: Record<string, unknown>): boolean {
  const has = (block: unknown): boolean =>
    isRecord(block) && block['b'] !== undefined && block['b'] !== null;
  const among = (list: unknown): boolean => Array.isArray(list) && list.some(has);

  if (has(raw['compare']) || among(raw['scenarios'])) return true;

  const groups = raw['groups'];
  return (
    Array.isArray(groups) &&
    groups.some((group) => isRecord(group) && (has(group['compare']) || among(group['scenarios'])))
  );
}

/**
 * A relative path needs a base URL to hang off. Without one, say so here
 * rather than letting the URL fail to parse mid-run.
 */
function assertAddressable(scenario: Scenario, side: 'a' | 'b', config: SideConfig): void {
  const address = (side === 'a' ? scenario.pathA : scenario.pathB) ?? scenario.path;
  if (config.baseUrl !== '' || /^https?:\/\//i.test(address)) return;

  throw new ConfigError(
    `Scenario "${scenario.name}" gives \`${address}\` for side ${side.toUpperCase()}, ` +
      `but \`compare.${side}\` has no URL to resolve it against.\n` +
      `Either set \`compare.${side}\`, or give the scenario a full URL in \`${side}:\`.`
  );
}

/**
 * Which sides are taken from an earlier run: "a", "b", or both.
 *
 * Reusing both captures nothing at all, which is a legitimate way to re-diff an
 * earlier run under changed diff settings, so it is allowed rather than
 * second-guessed.
 */
export function parseSides(value: unknown, where: string): Side[] {
  if (value === undefined || value === null) return [];

  const given = Array.isArray(value) ? value : String(value).split(',');
  const sides: Side[] = [];

  for (const entry of given) {
    const name = String(entry).trim().toLowerCase();
    if (name === '') continue;
    if (name !== 'a' && name !== 'b') {
      throw new ConfigError(`\`${where}\` must be \`a\`, \`b\` or \`a,b\`, got ${describe(entry)}`);
    }
    if (!sides.includes(name)) sides.push(name);
  }

  return sides;
}

/** A plain number of milliseconds, or a readable "24h" / "90m" / "30s". */
export function parseDuration(value: unknown, fallback: number, where: string): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'number') return value;

  if (typeof value === 'string') {
    const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?\s*$/i.exec(value);
    if (match) {
      const scale = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
      return Number(match[1]) * scale[(match[2]?.toLowerCase() ?? 'ms') as keyof typeof scale];
    }
  }

  throw new ConfigError(`\`${where}\` must be a duration like 24h, 90m or a number of milliseconds`);
}

/** Reads one of the grouping blocks, tolerating its absence. */
function block(
  raw: Record<string, unknown>,
  name: string,
  keys: readonly string[],
  where = ''
): Record<string, unknown> {
  const value = raw[name];
  if (value === undefined || value === null) return {};
  const at = `${where ? `${where}.` : ''}${name}`;
  if (!isRecord(value)) throw new ConfigError(`\`${at}\` must be a mapping`);
  onlyKnown(value, keys, at);
  return value;
}

/**
 * Sides accept both the flat shorthand (`a: https://…`) and the object form
 * carrying a label, headers, cookies and credentials.
 */
function parseSide(
  raw: Record<string, unknown>,
  side: 'a' | 'b',
  configDir: string,
  where = 'compare'
): SideConfig {
  const value = raw[side];
  const at = `${where}.${side}`;
  // No side at all is fine; the scenarios then have to carry the full URLs.
  if (value === undefined || value === null) {
    return emptySide('', side.toUpperCase());
  }

  if (typeof value === 'string') {
    return emptySide(assertUrl(value, at), side.toUpperCase());
  }

  if (!isRecord(value)) {
    throw new ConfigError(`\`${at}\` must be a URL string or a mapping, got ${describe(value)}`);
  }

  if (value['baseUrl'] !== undefined) {
    throw new ConfigError(`\`${at}.baseUrl\` is called \`url\` now`);
  }

  // Steps for one side are what a beforeEach entry limited to that side
  // does; a side's own `steps` was never read, which is worse than refused.
  if (value['steps'] !== undefined) {
    throw new ConfigError(
      `\`${at}.steps\` is not an option. Steps for one side go under \`beforeEach\`, as an entry ` +
        `with \`side: ${side}\` and the steps in its \`steps\`.`
    );
  }

  onlyKnown(value, KEYS.side, at);

  const baseUrl = value['url'];
  if (baseUrl !== undefined && baseUrl !== null && typeof baseUrl !== 'string') {
    throw new ConfigError(`\`${at}.url\` must be a string`);
  }

  const basicAuth = value['basicAuth'];
  let auth: SideConfig['basicAuth'] = null;
  if (basicAuth !== undefined && basicAuth !== null) {
    if (!isRecord(basicAuth) || typeof basicAuth['username'] !== 'string' || typeof basicAuth['password'] !== 'string') {
      throw new ConfigError(`\`${at}.basicAuth\` must have \`username\` and \`password\``);
    }
    onlyKnown(basicAuth, KEYS.basicAuth, `${at}.basicAuth`);
    auth = { username: basicAuth['username'], password: basicAuth['password'] };
  }

  const storageState = optionalStr(value['storageState'], `${at}.storageState`);

  return {
    label: str(value['label'] ?? value['name'], side.toUpperCase(), `${at}.label`),
    baseUrl: typeof baseUrl === 'string' ? assertUrl(baseUrl, `${at}.url`) : '',
    headers: parseHeaders(value['headers'], `${at}.headers`),
    cookies: parseCookies(value['cookies'], `${at}.cookies`),
    basicAuth: auth,
    storageState: storageState === null ? null : resolvePath(storageState, configDir),
  };
}

function emptySide(baseUrl: string, label: string): SideConfig {
  return { label, baseUrl, headers: {}, cookies: [], basicAuth: null, storageState: null };
}

/** Scenario options a group may set once for all of its pages. */
interface ScenarioDefaults {
  waitUntil: Scenario['waitUntil'];
  steps: Step[];
  fullPage: boolean;
  waitForTimeout: number;
}

interface Inherited {
  viewports: Viewport[];
  threshold: number;
  mask: string[];
  hide: string[];
  remove: string[];
  defaults: ScenarioDefaults;
}

/** Parses one entry and folds the inherited defaults into it. */
function parseOne(
  entry: unknown,
  where: string,
  index: number,
  inherited: Inherited,
  group: string | null,
  sides: { a: SideConfig | null; b: SideConfig | null } = { a: null, b: null }
): Scenario {
  const scenario = parseScenario(entry, where, index, inherited.viewports, inherited.threshold);
  const stated = isRecord(entry) ? entry : {};

  return {
    ...scenario,
    group,
    sideA: sides.a,
    sideB: sides.b,
    // A scenario states its own or takes the group's; steps of both run, the
    // group's first, because that is the order they read in.
    waitUntil: stated['waitUntil'] === undefined ? inherited.defaults.waitUntil : scenario.waitUntil,
    fullPage: stated['fullPage'] === undefined ? inherited.defaults.fullPage : scenario.fullPage,
    waitForTimeout:
      stated['waitForTimeout'] === undefined ? inherited.defaults.waitForTimeout : scenario.waitForTimeout,
    steps: [...inherited.defaults.steps, ...scenario.steps],
    mask: [...inherited.mask, ...scenario.mask],
    hide: [...inherited.hide, ...scenario.hide],
    remove: [...inherited.remove, ...scenario.remove],
  };
}

/**
 * Reads the `groups` block.
 *
 * A group is a site: its own pair of URLs and the pages to check on it. What
 * it does not set — viewports, thresholds, masks — it inherits from the top
 * level, so a group only says what makes it different.
 */
function parseGroups(value: unknown, inherited: Inherited, configDir: string, mode: Mode): Scenario[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ConfigError('`groups` must be a list');
  }

  return value.flatMap((entry, index) => {
    const at = `groups[${index}]`;
    if (!isRecord(entry)) {
      throw new ConfigError(`${at} must be a mapping with a \`name\` and \`scenarios\``);
    }
    onlyKnown(entry, KEYS.group, at);

    const name = entry['name'];
    if (typeof name !== 'string' || name === '') {
      throw new ConfigError(`${at} needs a \`name\``);
    }

    const rawScenarios = entry['scenarios'];
    if (!Array.isArray(rawScenarios) || rawScenarios.length === 0) {
      throw new ConfigError(`${at} ("${name}") needs a non-empty \`scenarios\` list`);
    }

    const compare = entry['compare'];
    if (compare !== undefined && !isRecord(compare)) {
      throw new ConfigError(`${at}.compare must be a mapping with the two sides`);
    }
    if (compare) onlyKnown(compare, KEYS.compare, `${at}.compare`);

    const sides = compare
      ? {
          a: parseSide(compare, 'a', configDir, `${at}.compare`),
          b: mode === 'compare' ? parseSide(compare, 'b', configDir, `${at}.compare`) : null,
        }
      : { a: null, b: null };

    const diff = block(entry, 'diff', KEYS.groupDiff, at);

    // A group may set what its pages have in common: two production sites hold
    // a sub-resource open and need waitUntil: domcontentloaded, and writing
    // that out per page means giving up the bare-path shorthand.
    const defaults: ScenarioDefaults = {
      waitUntil:
        entry['waitUntil'] === undefined
          ? inherited.defaults.waitUntil
          : enumValue(
              entry['waitUntil'],
              ['load', 'domcontentloaded', 'networkidle', 'commit'],
              'networkidle',
              `${at}.waitUntil`
            ),
      steps: [...inherited.defaults.steps, ...parseSteps(entry['steps'], `${at}.steps`)],
      fullPage: bool(entry['fullPage'], inherited.defaults.fullPage, `${at}.fullPage`),
      waitForTimeout: num(
        entry['waitForTimeout'],
        inherited.defaults.waitForTimeout,
        `${at}.waitForTimeout`,
        MILLISECONDS
      ),
    };

    const own: Inherited = {
      defaults,
      viewports:
        entry['viewports'] === undefined
          ? inherited.viewports
          : resolveViewportNames(entry['viewports'], inherited.viewports, `${at}.viewports`),
      threshold: num(diff['threshold'], inherited.threshold, `${at}.diff.threshold`, SHARE),
      mask: [...inherited.mask, ...strList(diff['mask'], `${at}.diff.mask`)],
      hide: [...inherited.hide, ...strList(diff['hide'], `${at}.diff.hide`)],
      remove: [...inherited.remove, ...strList(diff['remove'], `${at}.diff.remove`)],
    };

    return rawScenarios.map((scenario, position) =>
      parseOne(scenario, `${at}.scenarios[${position}]`, position, own, name, sides)
    );
  });
}

/** The name a scenario is known by once its group is taken into account. */
export function qualify(scenario: Scenario): string {
  return scenario.group ? `${scenario.group}/${scenario.name}` : scenario.name;
}

function parseScenario(
  entry: unknown,
  where: string,
  index: number,
  defaultViewports: Viewport[],
  defaultThreshold: number
): Scenario {

  // Shorthand: a bare path stands for a scenario named after it. Most pages
  // need nothing else, and spelling out name and path for each one is noise.
  if (typeof entry === 'string') {
    return {
      name: slug(entry),
      group: null,
      sideA: null,
      sideB: null,
      path: entry,
      pathA: null,
      pathB: null,
      steps: [],
      viewports: defaultViewports,
      fullPage: true,
      clip: null,
      mask: [],
      hide: [],
      remove: [],
      threshold: defaultThreshold,
      waitForTimeout: 0,
      waitUntil: 'networkidle',
      skip: false,
      only: false,
    };
  }

  if (!isRecord(entry)) {
    throw new ConfigError(
      `${where} must be a path like "/about", or a mapping with at least a \`path\`, got ${describe(entry)}`
    );
  }

  // One spelling: `path` for both sides, `a`/`b` when they differ — the same
  // two letters the compare block uses. Each is a path resolved against that
  // side's base URL, or a full URL used as it is.
  for (const [old, use] of [
    ['url', 'path'],
    ['urlA', 'a'],
    ['urlB', 'b'],
    ['pathA', 'a'],
    ['pathB', 'b'],
  ] as const) {
    if (entry[old] !== undefined) {
      throw new ConfigError(`${where}.${old} is called \`${use}\` now`);
    }
  }
  onlyKnown(entry, KEYS.scenario, where);

  const path = entry['path'];
  const pathA = optionalStr(entry['a'], `${where}.a`);
  const pathB = optionalStr(entry['b'], `${where}.b`);

  if (typeof path !== 'string' && (pathA === null || pathB === null)) {
    throw new ConfigError(
      `${where} needs a \`path\`, or an address for both sides in \`a\` and \`b\``
    );
  }

  const resolvedPath = typeof path === 'string' ? path : '';
  const name = str(entry['name'], slug(resolvedPath || pathA || `scenario-${index + 1}`), `${where}.name`);

  const viewportOverride = entry['viewports'] ?? entry['viewport'];
  const viewports =
    viewportOverride === undefined || viewportOverride === null
      ? defaultViewports
      : resolveViewportNames(viewportOverride, defaultViewports, `${where}.viewports`);

  return {
    name,
    group: null,
    sideA: null,
    sideB: null,
    path: resolvedPath,
    pathA,
    pathB,
    steps: parseSteps(entry['steps'], `${where}.steps`),
    viewports,
    fullPage: bool(entry['fullPage'], true, `${where}.fullPage`),
    clip: optionalStr(entry['clip'], `${where}.clip`),
    mask: strList(entry['mask'], `${where}.mask`),
    hide: strList(entry['hide'], `${where}.hide`),
    remove: strList(entry['remove'], `${where}.remove`),
    threshold: num(entry['threshold'], defaultThreshold, `${where}.threshold`, SHARE),
    waitForTimeout: num(entry['waitForTimeout'], 0, `${where}.waitForTimeout`, MILLISECONDS),
    waitUntil: enumValue(
      entry['waitUntil'],
      ['load', 'domcontentloaded', 'networkidle', 'commit'],
      'networkidle',
      `${where}.waitUntil`
    ),
    skip: bool(entry['skip'], false, `${where}.skip`),
    only: bool(entry['only'], false, `${where}.only`),
  };
}

/**
 * Viewports are declared once at the top level, either as a mapping keyed by
 * name (preferred) or as a list of objects carrying a `name`. Scenarios then
 * refer to them by name only.
 */
function parseViewports(value: unknown, where: string): Viewport[] {
  if (value === undefined || value === null) return [DEFAULT_VIEWPORT];

  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return [DEFAULT_VIEWPORT];
    return widestFirst(
      distinctViewports(
        entries.map(([name, entry]) => parseViewport(entry, name, `${where}.${name}`)),
        where
      )
    );
  }

  if (!Array.isArray(value)) {
    throw new ConfigError(`\`${where}\` must be a mapping of names to sizes, or a list`);
  }
  if (value.length === 0) return [DEFAULT_VIEWPORT];

  const listed = value.map((entry, index) => {
    const at = `${where}[${index}]`;
    if (!isRecord(entry)) {
      throw new ConfigError(`${at} must be a mapping like { name: mobile, width: 375, height: 812 }`);
    }
    const name = entry['name'];
    if (typeof name !== 'string') {
      throw new ConfigError(`${at} needs a \`name\`, or declare viewports as a mapping keyed by name`);
    }
    return parseViewport(entry, name, at, [...KEYS.viewport, 'name']);
  });
  return widestFirst(distinctViewports(listed, where));
}

/**
 * Desktop before mobile, however the file lists them.
 *
 * The order the viewports are declared in is the order everything downstream
 * shows them in: the lines of the run, the rows of a tile, the picture on it.
 * A config tends to list the small one first because that is how responsive
 * CSS is written, and the run then leads with the narrowest shot of every
 * page. The widest one is the one a reader wants first, so that is the order,
 * and it is decided here rather than left to how the file happened to be
 * typed. Stable, so two of one width keep their own order.
 */
function widestFirst(viewports: Viewport[]): Viewport[] {
  return [...viewports].sort((left, right) => right.width - left.width);
}

/**
 * A viewport's name ends up in the id of every comparison taken in it, so
 * two that differ only in case or punctuation would share every id there is.
 * Said once, here, rather than once per page.
 */
function distinctViewports(viewports: Viewport[], where: string): Viewport[] {
  const seen = new Map<string, string>();
  for (const { name } of viewports) {
    const other = seen.get(slug(name));
    if (other !== undefined) {
      throw new ConfigError(
        `\`${where}\` declares "${other}" and "${name}", which are filed under the same name. ` +
          'Names are compared without case or punctuation; rename one.'
      );
    }
    seen.set(slug(name), name);
  }
  return viewports;
}

function parseViewport(entry: unknown, name: string, at: string, keys: readonly string[] = KEYS.viewport): Viewport {
  if (!isRecord(entry)) {
    throw new ConfigError(`${at} must be a mapping like { width: 375, height: 812 }`);
  }
  onlyKnown(entry, keys, at);

  // `w`/`h` are accepted as shorthand so inline flow-style entries stay short.
  const width = num(entry['width'] ?? entry['w'], NaN, `${at}.width`, PIXELS);
  const height = num(entry['height'] ?? entry['h'], NaN, `${at}.height`, PIXELS);
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new ConfigError(`${at} needs numeric \`width\` and \`height\``);
  }

  return {
    name,
    width,
    height,
    deviceScaleFactor: num(entry['deviceScaleFactor'] ?? entry['dpr'], 1, `${at}.deviceScaleFactor`, {
      above: 0,
    }),
  };
}

/** Resolves a scenario's `viewports` list of names against the declared ones. */
function resolveViewportNames(value: unknown, declared: Viewport[], where: string): Viewport[] {
  const names = Array.isArray(value) ? value : [value];
  const known = new Map(declared.map((viewport) => [viewport.name, viewport]));

  const picked = names.map((name, index) => {
    const at = `${where}[${index}]`;
    if (typeof name !== 'string') {
      throw new ConfigError(
        `${at} must be the name of a viewport declared at the top level (one of: ${[...known.keys()].join(', ')})`
      );
    }
    const viewport = known.get(name);
    if (!viewport) {
      throw new ConfigError(`${at} refers to unknown viewport "${name}". Declared: ${[...known.keys()].join(', ')}`);
    }
    if (names.indexOf(name) !== index) {
      throw new ConfigError(`${where} names "${name}" twice`);
    }
    return viewport;
  });

  // An empty list is not "all of them": it is no comparison at all, and a run
  // with nothing in it reports that nothing differs.
  if (picked.length === 0) {
    throw new ConfigError(
      `\`${where}\` must name at least one viewport, or be left out to take all of them. ` +
        `Declared: ${[...known.keys()].join(', ')}`
    );
  }

  return widestFirst(picked);
}

function parseSteps(value: unknown, where: string): Step[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ConfigError(`\`${where}\` must be a list of steps, got ${describe(value)}`);
  }

  return value.map((entry, index) => {
    const at = `${where}[${index}]`;
    if (!isRecord(entry)) {
      throw new ConfigError(`${at} must be a mapping like { click: "button.nav-toggle" }`);
    }
    const actions = Object.keys(entry).filter((key) => key !== 'timeout' && key !== 'optional');
    if (actions.length !== 1) {
      throw new ConfigError(
        `${at} must carry exactly one action key, found: ${actions.join(', ') || '(none)'}`
      );
    }
    const action = actions[0]!;
    if (!STEP_KEYS.has(action)) {
      throw new ConfigError(`${at} has unknown action "${action}". Known: ${[...STEP_KEYS].join(', ')}`);
    }
    return entry as unknown as Step;
  });
}

function parseHeaders(value: unknown, where: string): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) {
    throw new ConfigError(`\`${where}\` must be a mapping of header names to values`);
  }
  const headers: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    headers[key] = String(entry);
  }
  return headers;
}

function parseCookies(value: unknown, where: string): RawCookie[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ConfigError(`\`${where}\` must be a list of cookies`);
  }
  return value.map((entry, index) => {
    const at = `${where}[${index}]`;
    if (!isRecord(entry) || typeof entry['name'] !== 'string') {
      throw new ConfigError(`${at} must be a mapping with at least \`name\` and \`value\``);
    }
    onlyKnown(entry, KEYS.cookie, at);
    return {
      name: entry['name'],
      value: String(entry['value'] ?? ''),
      ...(typeof entry['domain'] === 'string' ? { domain: entry['domain'] } : {}),
      ...(typeof entry['path'] === 'string' ? { path: entry['path'] } : {}),
      ...(typeof entry['url'] === 'string' ? { url: entry['url'] } : {}),
    };
  });
}


/**
 * Markup diffing is on by default: it is cheap compared to a screenshot and
 * usually explains what the pixel diff only shows.
 */
function parseMarkup(value: unknown): MarkupOptions {
  const raw = value === undefined || value === null ? {} : value;
  if (!isRecord(raw)) {
    throw new ConfigError('`markup` must be a mapping');
  }
  onlyKnown(raw, KEYS.markup, 'markup');

  return {
    enabled: bool(raw['enabled'], true, 'markup.enabled'),
    ignoreAttributes: strList(raw['ignoreAttributes'], 'markup.ignoreAttributes'),
    ignoreSelectors: strList(raw['ignoreSelectors'], 'markup.ignoreSelectors').map((tag) => tag.toLowerCase()),
    ignoreComments: bool(raw['ignoreComments'], false, 'markup.ignoreComments'),
    normalizeWhitespace: bool(raw['normalizeWhitespace'], true, 'markup.normalizeWhitespace'),
    sortAttributes: bool(raw['sortAttributes'], false, 'markup.sortAttributes'),
    ignoreBaseUrl: bool(raw['ignoreBaseUrl'], true, 'markup.ignoreBaseUrl'),
    failOnDifference: bool(raw['failOnDifference'], false, 'markup.failOnDifference'),
    maxHunksInReport: num(raw['maxHunksInReport'], 200, 'markup.maxHunksInReport', { min: 1, whole: true }),
  };
}

const LOG_KINDS: LogKind[] = [
  'error',
  'warning',
  'info',
  'log',
  'debug',
  'pageerror',
  'requestfailed',
  'httperror',
];

/**
 * What of the page's own output to keep.
 *
 * The default is what explains a picture: errors, warnings, uncaught
 * exceptions, requests that failed and responses that came back an error. Not
 * `log` and `info` — a chatty site writes thousands of those, and none of
 * them ever explained a screenshot.
 */
function parseLogs(value: unknown): LogOptions {
  const raw = value === undefined || value === null ? {} : value;
  if (!isRecord(raw)) {
    throw new ConfigError('`logs` must be a mapping');
  }
  onlyKnown(raw, KEYS.logs, 'logs');

  const levels =
    raw['levels'] === undefined
      ? (['error', 'warning', 'pageerror', 'requestfailed', 'httperror'] as LogKind[])
      : strList(raw['levels'], 'logs.levels').map((level) => {
          const kind = level.toLowerCase();
          if (!LOG_KINDS.includes(kind as LogKind)) {
            throw new ConfigError(
              `\`logs.levels\` has no \`${level}\`. Available: ${LOG_KINDS.join(', ')}`
            );
          }
          return kind as LogKind;
        });

  return {
    enabled: bool(raw['enabled'], true, 'logs.enabled'),
    levels,
    ignore: strList(raw['ignore'], 'logs.ignore'),
    max: num(raw['max'], 50, 'logs.max', { min: 0, whole: true }),
    failOnDifference: bool(raw['failOnDifference'], false, 'logs.failOnDifference'),
  };
}

/**
 * Parses the `beforeEach` list.
 *
 * An entry is either a step on its own — the common case, run on every page —
 * or a named group with a trigger, which is what a consent banner or a login
 * needs: it only applies when its element shows up, and once accepted it need
 * not be repeated. The two forms are told apart by the presence of `steps`.
 */
function parseBeforeEach(value: unknown): BeforeEach[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ConfigError('`beforeEach` must be a list of steps or named groups');
  }

  return value.map((entry, index) => {
    const at = `beforeEach[${index}]`;

    if (!isRecord(entry)) {
      throw new ConfigError(`${at} must be a mapping, got ${describe(entry)}`);
    }

    if (entry['steps'] === undefined) {
      const step = parseSteps([entry], at)[0]!;
      return {
        name: describeStepBriefly(step),
        when: null,
        timeout: 5000,
        required: false,
        once: false,
        side: null,
        steps: [step],
      };
    }

    onlyKnown(entry, KEYS.beforeEach, at);
    const side = optionalStr(entry['side'], `${at}.side`);
    if (side !== null && side !== 'a' && side !== 'b') {
      throw new ConfigError(`${at}.side must be "a" or "b"`);
    }

    const steps = parseSteps(entry['steps'], `${at}.steps`);
    if (steps.length === 0) {
      throw new ConfigError(`${at}.steps must contain at least one step`);
    }

    const when = optionalStr(entry['when'], `${at}.when`);

    return {
      name: str(entry['name'], when ?? `beforeEach ${index + 1}`, `${at}.name`),
      when,
      timeout: num(entry['timeout'], 5000, `${at}.timeout`, MILLISECONDS),
      required: bool(entry['required'], false, `${at}.required`),
      once: bool(entry['once'], false, `${at}.once`),
      side,
      steps,
    };
  });
}

/** A short label for an unnamed entry, e.g. `click .cookie-accept`. */
function describeStepBriefly(step: Step): string {
  const [key, value] = Object.entries(step).find(([name]) => name !== 'timeout' && name !== 'optional') ?? ['step', ''];
  const detail = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return `${key} ${detail}`.slice(0, 60);
}

/** Resolves the scenario path against/** Resolves the scenario path against a side's base URL; absolute URLs win. */
export function resolveUrl(baseUrl: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(path.replace(/^\//, ''), base).toString();
}

function assertUrl(value: string, where: string): string {
  try {
    new URL(value);
  } catch {
    throw new ConfigError(`\`${where}\` is not a valid URL: ${value}`);
  }
  return value;
}

function resolvePath(value: string, configDir: string): string {
  return isAbsolute(value) ? value : resolve(configDir, value);
}

/**
 * Output goes where the tool is run, not next to the config: a config kept
 * centrally must still leave its results in the project being checked.
 */
function resolveOutput(value: string): string {
  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

/**
 * What a comparison is filed under: its shots, its entry in the report, and
 * what a later run reuses it by.
 */
export function comparisonId(group: string | null, name: string, viewport: string): string {
  return `${group ? `${slug(group)}--` : ''}${slug(name)}--${slug(viewport)}`;
}

/**
 * A name as it can appear in a file name and an address.
 *
 * Plain ASCII comes out as it always has, because every report and every
 * reuse on disk is filed under it. Only letters outside ASCII are treated
 * differently from how they once were — they used to vanish, so "Über uns"
 * became "ber-uns" and every Japanese page title became "index". Accented
 * Latin is spelled without its accents now, and a name that still loses
 * letters after that carries a short hash of itself, so two names in a script
 * with no ASCII spelling do not come out the same.
 */
export function slug(value: string): string {
  const text = value.replace(/^https?:\/\//, '');
  const latin = transliterate(text);
  const cleaned = latin
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();

  if (!/[\p{L}\p{N}]/u.test(latin.replace(/[\x00-\x7f]+/g, ''))) {
    return cleaned || 'index';
  }

  const tag = createHash('sha256').update(text.normalize('NFC')).digest('hex').slice(0, 8);
  return cleaned ? `${cleaned}-${tag}` : tag;
}

/** The Latin letters that are more than a base letter and an accent. */
const LATIN: Record<string, string> = {
  ß: 'ss', ẞ: 'SS', æ: 'ae', Æ: 'AE', œ: 'oe', Œ: 'OE', ø: 'o', Ø: 'O',
  ł: 'l', Ł: 'L', đ: 'd', Đ: 'D', ð: 'd', Ð: 'D', þ: 'th', Þ: 'TH', ı: 'i',
};

function transliterate(value: string): string {
  if (!/[^\x00-\x7f]/.test(value)) return value;
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[ßẞæÆœŒøØłŁđĐðÐþÞı]/g, (letter) => LATIN[letter] ?? letter);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  return typeof value;
}

function str(value: unknown, fallback: string, where: string): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') throw new ConfigError(`\`${where}\` must be a string`);
  return value;
}

function optionalStr(value: unknown, where: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new ConfigError(`\`${where}\` must be a string`);
  return value;
}

function strList(value: unknown, where: string): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) throw new ConfigError(`\`${where}\` must be a string or a list of strings`);
  return value.map((entry, index) => {
    if (typeof entry !== 'string') throw new ConfigError(`\`${where}[${index}]\` must be a string`);
    return entry;
  });
}

/**
 * What a number may be. The same bounds the schema states, because a value
 * the parser takes without a word is a value the run then acts on: a negative
 * retry count left nothing to attempt, and a threshold of 7 passed everything.
 */
interface Range {
  min?: number;
  max?: number;
  /** Has to be greater than this, not equal to it. */
  above?: number;
  whole?: boolean;
}

const SHARE: Range = { min: 0, max: 1 };
const MILLISECONDS: Range = { min: 0 };
const PIXELS: Range = { min: 1 };

function num(value: unknown, fallback: number, where: string, range: Range = {}): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ConfigError(`\`${where}\` must be a number`);
  }

  const { min, max, above, whole } = range;
  if (
    (whole === true && !Number.isInteger(value)) ||
    (min !== undefined && value < min) ||
    (max !== undefined && value > max) ||
    (above !== undefined && value <= above)
  ) {
    const kind = whole ? 'a whole number' : 'a number';
    const bounds =
      min !== undefined && max !== undefined
        ? ` from ${min} to ${max}`
        : min !== undefined
          ? ` of ${min} or more`
          : above !== undefined
            ? ` above ${above}`
            : '';
    throw new ConfigError(`\`${where}\` must be ${kind}${bounds}, got ${value}`);
  }
  return value;
}

/**
 * Refuses a key the parser does not read.
 *
 * A misspelt option is otherwise dropped without a word, and the run goes on
 * under the default the file meant to change — `diff.treshold: 0.05` and a
 * run that fails on every page for a reason the file seems to have dealt
 * with. Said with the nearest real key when there is one.
 */
function onlyKnown(value: Record<string, unknown>, keys: readonly string[], where: string): void {
  for (const key of Object.keys(value)) {
    if (keys.includes(key)) continue;
    const at = where ? `${where}.${key}` : key;
    const near = closest(key, keys);
    throw new ConfigError(
      near
        ? `\`${at}\` is not an option; did you mean \`${near}\`?`
        : `\`${at}\` is not an option. Known${where ? ` under \`${where}\`` : ' at the top level'}: ${keys.join(', ')}`
    );
  }
}

function closest(key: string, keys: readonly string[]): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const candidate of keys) {
    const distance =
      candidate.toLowerCase() === key.toLowerCase() ? 0 : editDistance(key.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  // A guess at a one-letter key from another one-letter key is no help.
  return bestDistance <= 2 && bestDistance < key.length / 2 ? best : null;
}

function editDistance(left: string, right: string): number {
  let row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const next = [i];
    for (let j = 1; j <= right.length; j++) {
      next[j] = Math.min(
        row[j]! + 1,
        next[j - 1]! + 1,
        row[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1)
      );
    }
    row = next;
  }
  return row[right.length]!;
}

function bool(value: unknown, fallback: boolean, where: string): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw new ConfigError(`\`${where}\` must be true or false`);
  return value;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T, where: string): T {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ConfigError(`\`${where}\` must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}
