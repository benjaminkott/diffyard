/**
 * Public type definitions for the diffyard configuration file and its results.
 *
 * The YAML config is parsed into `RawConfig` and normalised into `Config`, so
 * every consumer downstream works with fully resolved values (no optionals).
 */

export type Side = 'a' | 'b';

/** A single browser viewport a scenario is captured in. */
export interface Viewport {
  name: string;
  width: number;
  height: number;
  deviceScaleFactor: number;
}

/** Modifiers every step accepts alongside its single action key. */
export interface StepModifiers {
  timeout?: number;
  /** Do not fail the scenario when this step cannot be performed. */
  optional?: boolean;
}

/**
 * One interaction performed on the page before the screenshot is taken.
 * Each step object carries exactly one action key.
 */
export type Step = StepAction & StepModifiers;

export type StepAction =
  | { click: string }
  | { dblclick: string }
  | { hover: string }
  | { focus: string }
  | { fill: { selector: string; value: string } }
  | { press: { selector?: string; key: string } }
  | { select: { selector: string; value: string | string[] } }
  | { check: string }
  | { uncheck: string }
  | { waitFor: string }
  | { waitForHidden: string }
  | { waitForText: { selector?: string; text: string } }
  | { waitForTimeout: number }
  | { waitForUrl: string }
  | { waitForLoadState: 'load' | 'domcontentloaded' | 'networkidle' }
  | { scrollTo: string }
  | { scrollToBottom: boolean }
  | { scrollToTop: boolean }
  | { scrollBy: number }
  | { goto: string }
  | { evaluate: string }
  | { addStyle: string }
  | { setViewport: { width: number; height: number } }
  | { screenshot: string };

/** Per-side connection details, e.g. when old and new environment differ. */
export interface SideConfig {
  /** Human-readable name shown in the report and the CLI, e.g. "live". */
  label: string;
  /** Empty when every scenario names this side's address in full. */
  baseUrl: string;
  headers: Record<string, string>;
  cookies: RawCookie[];
  basicAuth: { username: string; password: string } | null;
  /** A Playwright storage state file, for a session captured beforehand. */
  storageState: string | null;
}

/**
 * The settings a run actually used, as the report shows them.
 *
 * A number nobody can trace back to what produced it is not a measurement, so
 * the run records the settings beside the findings. Credentials are not among
 * them: a report is a file people zip and mail, and a password that rides
 * along has left the machine. Addresses, thresholds and selectors are
 * settings; header values, cookie values, a basic-auth password and whatever a
 * step types into a field are not.
 */
export interface RunSettings {
  a: SideSettings;
  b: SideSettings;
  viewports: Viewport[];
  /** How many scenarios the config resolved to; the comparisons are the list. */
  scenarios: number;
  beforeEach: BeforeEachSummary[];
  browser: 'chromium' | 'firefox' | 'webkit';
  headless: boolean;
  colorScheme: 'light' | 'dark' | 'no-preference';
  reducedMotion: boolean;
  locale: string | null;
  timezone: string | null;
  userAgent: string | null;
  ignoreHTTPSErrors: boolean;
  threshold: number;
  pixelThreshold: number;
  ignoreAntialiasing: boolean;
  alignRows: boolean;
  mask: string[];
  hide: string[];
  remove: string[];
  timeout: number;
  comparisonTimeout: number;
  runTimeout: number;
  retries: number;
  freeze: boolean;
  triggerLazyLoad: boolean;
  sequential: boolean;
  workers: number;
  markup: MarkupOptions;
  logs: LogOptions;
  reuse: ReuseConfig;
}

/** One side of the comparison, with everything secret reduced to its shape. */
export interface SideSettings {
  label: string;
  baseUrl: string;
  /** Header names only: a header value is as often as not a credential. */
  headers: string[];
  /** Cookie names only, for the same reason. */
  cookies: string[];
  /** Whether basic auth was set, never what it was set to. */
  basicAuth: boolean;
  storageState: string | null;
}

/** What a beforeEach entry does, without what it types. */
export interface BeforeEachSummary {
  name: string;
  when: string | null;
  once: boolean;
  required: boolean;
  side: Side | null;
  steps: number;
}

export interface RawCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  url?: string;
}

/** A single page to compare, expanded across every configured viewport. */
export interface Scenario {
  name: string;
  /**
   * The group this belongs to, when it came from one. Groups exist because a
   * suite is usually several sites checked the same way, and repeating both
   * URLs on every page of every site is unreadable.
   */
  group: string | null;
  /** Its own sides, when the group or the scenario named them. */
  sideA: SideConfig | null;
  sideB: SideConfig | null;
  /** Address used for both sides: a path, or a full URL. */
  path: string;
  /**
   * Address of this side, when the two do not sit at the same place. A path is
   * resolved against the side's base URL; a full URL is used as it is, which is
   * how two unrelated addresses — different hosts included — get compared.
   */
  pathA: string | null;
  pathB: string | null;
  steps: Step[];
  viewports: Viewport[];
  fullPage: boolean;
  /** CSS selector limiting the screenshot to one element. */
  clip: string | null;
  /** Selectors painted over before the screenshot (dynamic content). */
  mask: string[];
  /** Selectors set to `visibility: hidden` before the screenshot. */
  hide: string[];
  /** Selectors removed from the DOM before the screenshot. */
  remove: string[];
  threshold: number;
  waitForTimeout: number;
  waitUntil: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
  skip: boolean;
  only: boolean;
}

export interface Config {
  /** The config file as the caller named it, so a printed command can be run. */
  file: string;
  a: SideConfig;
  b: SideConfig;
  /** Base directory. Each run gets its own folder inside it unless disabled. */
  outDir: string;
  /** Create a timestamped sub-folder per run inside outDir. */
  runFolder: boolean;
  /** Fixed name for that sub-folder; a timestamp is used when null. */
  runId: string | null;
  viewports: Viewport[];
  scenarios: Scenario[];
  /** Pixel colour distance tolerance handed to pixelmatch (0..1). */
  pixelThreshold: number;
  /** Share of differing pixels (0..1) a scenario may have and still pass. */
  threshold: number;
  /** Ignore differences caused solely by anti-aliasing. */
  ignoreAntialiasing: boolean;
  /**
   * Match rows up before comparing, so a page that only moved is not reported
   * as one that changed everywhere. The raw number is still recorded; this is
   * the one a scenario passes or fails on.
   */
  alignRows: boolean;
  browser: 'chromium' | 'firefox' | 'webkit';
  headless: boolean;
  /** Per Playwright action, in milliseconds. */
  timeout: number;
  /** Hard limit for a single comparison, in milliseconds. 0 disables it. */
  comparisonTimeout: number;
  /** Hard limit for the whole run, in milliseconds. 0 disables it. */
  runTimeout: number;
  retries: number;
  /** Disable CSS animations, transitions and caret blinking. */
  freeze: boolean;
  /** Scroll the full page once to trigger lazy loading before capturing. */
  triggerLazyLoad: boolean;
  /** Capture the two sides one after another instead of at the same time. */
  sequential: boolean;
  /**
   * How many comparisons run at once. More is faster and less deterministic:
   * browsers competing for the machine render at slightly different moments,
   * which animation- and timing-sensitive pages can pick up.
   */
  workers: number;
  colorScheme: 'light' | 'dark' | 'no-preference';
  reducedMotion: boolean;
  locale: string | null;
  timezone: string | null;
  userAgent: string | null;
  ignoreHTTPSErrors: boolean;
  /** Run on every page of both sides, before the scenario's own steps. */
  beforeEach: BeforeEach[];
  /** Applied to every scenario, merged with the scenario's own selectors. */
  mask: string[];
  hide: string[];
  remove: string[];
  markup: MarkupOptions;
  /** What the page says while it is photographed: console, errors, failures. */
  logs: LogOptions;
  /** Which side, if any, is taken from an earlier run instead of captured. */
  reuse: ReuseConfig;
  reportTitle: string;
}

/**
 * Taking one side from an earlier run.
 *
 * While a regression is being chased only the local side moves; the reference
 * is production and unchanged, and it is the slower of the two because it goes
 * over the network. Capturing it every time is what stands between measuring
 * after each change and not bothering.
 */
export interface ReuseConfig {
  /** Sides taken from an earlier run. Empty means everything is captured. */
  sides: Side[];
  /** Which run to take them from: a run id, or "latest". */
  from: string;
  /**
   * Warn when the reused shots are older than this, in milliseconds. Reusing
   * says the other side has not changed, and that claim gets weaker with time.
   * 0 disables the warning.
   */
  maxAge: number;
}

/**
 * Something that has to happen before a page can be compared: accepting a
 * consent banner, logging in, dismissing a staging notice, switching a
 * language. They run in order on every page, before the scenario's
 * own steps.
 */
export interface BeforeEach {
  /** Shown in errors and previews. */
  name: string;
  /**
   * Selector that decides whether this applies. The entry runs once it
   * becomes visible; if it never does, the entry is skipped. Without a
   * trigger, it always runs.
   */
  when: string | null;
  /** How long to wait for `when`, in milliseconds. */
  timeout: number;
  /** Fail the capture when `when` never appeared. */
  required: boolean;
  /**
   * Run at most once per browser context. Decisions that stick — a consent
   * cookie, a session — need no repeating, and waiting for their trigger on
   * every later page only costs time.
   */
  once: boolean;
  /** Limit to one side, for a notice only one system shows. */
  side: Side | null;
  steps: Step[];
}

/**
 * A kind of thing the page can say.
 *
 * The console levels the browser reports, plus the three failures that never
 * reach the console but explain a picture just as well: an uncaught exception,
 * a request that never completed, and a response that came back an error.
 */
export type LogKind =
  | 'error'
  | 'warning'
  | 'info'
  | 'log'
  | 'debug'
  | 'pageerror'
  | 'requestfailed'
  | 'httperror';

/** One line the page wrote, or one failure it ran into. */
export interface LogEntry {
  kind: LogKind;
  text: string;
  /** Where the browser said it came from, when it said. */
  source: string | null;
  /** How often this same line appeared. */
  count: number;
}

export interface LogOptions {
  enabled: boolean;
  /** Which kinds to record. Anything else is dropped as it arrives. */
  levels: LogKind[];
  /** Lines containing any of these are dropped: consent tools, analytics. */
  ignore: string[];
  /** Cap on distinct lines kept per side. */
  max: number;
  /**
   * Mark a comparison as failed when one side logs something serious the other
   * does not. Off by default: a console error is a lead, not a verdict.
   */
  failOnDifference: boolean;
}

/** The two sides' output, and what differs between them. */
export interface LogSummary {
  a: LogEntry[];
  b: LogEntry[];
  /** Lines one side logged and the other did not. */
  onlyA: number;
  onlyB: number;
  /** Errors, exceptions and failed requests, per side. */
  errorsA: number;
  errorsB: number;
  differs: boolean;
  /** Of the one-sided lines, how many mean something is broken. */
  seriousOnOneSide: number;
}

/** How the serialised DOM of both sides is normalised before diffing. */
export interface MarkupOptions {
  enabled: boolean;
  /** Attribute names to drop; supports `prefix-*` wildcards. */
  ignoreAttributes: string[];
  /** Tag names whose subtree is removed before comparing. */
  ignoreSelectors: string[];
  ignoreComments: boolean;
  normalizeWhitespace: boolean;
  sortAttributes: boolean;
  /** Mark a comparison as failed when the markup differs at all. */
  failOnDifference: boolean;
  /** Cap on hunks embedded into the report; the full patch is always written. */
  maxHunksInReport: number;
}

/** One contiguous block of changed markup lines plus surrounding context. */
export interface Hunk {
  startA: number;
  startB: number;
  lines: HunkLine[];
}

export interface HunkLine {
  type: 'context' | 'add' | 'remove';
  text: string;
}

export interface MarkupResult {
  identical: boolean;
  added: number;
  removed: number;
  linesA: number;
  linesB: number;
  hunks: number;
}

export interface DiffResult {
  diffPixels: number;
  totalPixels: number;
  /**
   * Where the differences sit, as bands from top to bottom, each the share of
   * differing pixels in that slice of the page (0..1). A full-page screenshot
   * is thousands of pixels tall and usually opens on an unchanged header, so
   * this is what lets a reader be taken to the part that actually differs.
   */
  profile: number[];
  /**
   * The differing stretches of the page, in pixels: enough to say "y 1616 to
   * 1827" rather than only "13.92% of it".
   */
  regions: DiffRegion[];
  /**
   * How much of the page merely moved, when rows were matched up.
   *
   * With alignment on — the default — the numbers above are already the
   * comparison of matched rows, so a page that shifted down by fourteen pixels
   * reads as a page that shifted, not as one that changed everywhere below.
   */
  aligned: AlignedDiff | null;
  /** The same pages compared where the pixels sit, for reference. */
  unaligned: { ratio: number; diffPixels: number } | null;
  /** Share of differing pixels, 0..1. */
  ratio: number;
  width: number;
  height: number;
  /** True when A and B had different dimensions and were padded to match. */
  sizeMismatch: boolean;
  sizeA: { width: number; height: number };
  sizeB: { width: number; height: number };
}

/** A contiguous stretch of rows that differ. */
export interface DiffRegion {
  /** First differing row, in pixels from the top of the compared image. */
  from: number;
  /** One past the last differing row. */
  to: number;
  height: number;
  /** Share of the pixels within this stretch that differ, 0..1. */
  ratio: number;
}

/** What matching the rows up found: how much of the page merely moved. */
export interface AlignedDiff {
  /** Rows present only in A, and only in B. */
  removedRows: number;
  addedRows: number;
  /** Net vertical movement in pixels; negative means B moved up. */
  shift: number;
}

/** How one side of a comparison was obtained. */
export interface SideCapture {
  /**
   * Hash of everything that decided what this screenshot shows — address,
   * viewport, steps, masks, browser options. A shot whose fingerprint no longer
   * matches the config is taken again rather than reused.
   */
  fingerprint: string;
  /** The run this shot came from, or null when it was captured for this one. */
  reusedFrom: { runId: string; capturedAt: string } | null;
  /**
   * Why this side was captured although the run was told to reuse it. Null
   * when it was reused, or when reuse was not asked for.
   */
  recapturedBecause: string | null;
}

/**
 * What kind of difference a comparison found.
 *
 * A comparison usually carries several: a rewritten heading that made the page
 * taller is text, markup and size at once. Each is read off something already
 * established -- the markup diff, the alignment, what the page said -- rather
 * than guessed at from the pixels.
 */
export type DiffKind = 'image' | 'text' | 'markup' | 'moved' | 'size' | 'rendering';

export type ComparisonStatus = 'pass' | 'fail' | 'error' | 'skipped' | 'timeout';

export interface Comparison {
  id: string;
  scenario: string;
  /** The group it came from, when it came from one. */
  group: string | null;
  viewport: Viewport;
  urlA: string;
  urlB: string;
  status: ComparisonStatus;
  threshold: number;
  diff: DiffResult | null;
  markup: MarkupResult | null;
  /** Report-embedded excerpt of the markup diff; the full patch is on disk. */
  markupHunks: Hunk[] | null;
  /** What each side said while it was photographed, and what differs. */
  logs: LogSummary | null;
  /** What kinds of difference this is, so a long list can be filtered. */
  kinds: DiffKind[];
  /** Paths relative to outDir. */
  files: {
    a: string | null;
    b: string | null;
    diff: string | null;
    htmlA: string | null;
    htmlB: string | null;
    patch: string | null;
    /**
     * This comparison on its own, beside its screenshots. results.json holds
     * the whole run, which is the wrong shape for looking at one case: a
     * scenario is a directory listing, not a search through nine hundred.
     */
    result: string | null;
    /**
     * The part of this comparison the report loads only when it is opened.
     * Named here rather than worked out from the id, so the report follows a
     * path the run wrote instead of one it guessed.
     */
    detail: string | null;
  };
  /** How each side was obtained; null when the comparison never ran. */
  capture: { a: SideCapture; b: SideCapture } | null;
  /**
   * What to run to do this one comparison again, into this same report.
   *
   * Working through a list of findings means fixing one thing and looking at
   * one view again; without this that means re-running everything, or working
   * out the flags by hand for each of nine hundred cases.
   */
  command: string;
  /** When this comparison finished, which a refreshed one no longer shares. */
  ranAt: string;
  error: string | null;
  durationMs: number;
}

export interface RunResult {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  total: number;
  passed: number;
  failed: number;
  errored: number;
  skipped: number;
  comparisons: Comparison[];
  /** Absolute path the artifact of this run was written to. */
  outDir: string;
  runId: string;
  /**
   * When comparisons were last run into this report after it was finished, or
   * null for a report that is all of one run. startedAt, finishedAt and
   * durationMs keep describing the original run; a comparison whose `ranAt` is
   * later than `finishedAt` is one that was refreshed since.
   */
  refreshedAt: string | null;
  /**
   * Markup differences that turned up on nearly every page of the run.
   *
   * On two builds of the same site these are the build rather than the
   * content, and they are left out of the kinds for that reason. Named here
   * because they are worth an ignore rule, not worth hiding.
   */
  commonMarkup: string[];
  /**
   * What to run to do this whole run again, into this same report.
   *
   * The per-comparison `command` refreshes one finding; this refreshes all of
   * them. Both are here for the same reason: the flags that matter are the
   * ones nobody would reconstruct by hand -- where the config file was, which
   * report to write back into, and which side came from an earlier run.
   */
  command: string;
  /**
   * Set when a side was taken from an earlier run, so a reader of the numbers
   * can tell whether they were measured against a fresh reference.
   */
  reuse: {
    sides: Side[];
    runId: string;
    capturedAt: string;
    reused: number;
    recaptured: number;
  } | null;
  config: {
    /** The config file as the caller named it. */
    file: string;
    a: string;
    b: string;
    labelA: string;
    labelB: string;
    browser: string;
    outDir: string;
  };
  /** Everything else the run was told to do, so a finding can be traced back. */
  settings: RunSettings;
}
