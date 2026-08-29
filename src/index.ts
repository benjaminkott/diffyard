/**
 * Library entry point - the CLI is a thin wrapper around these exports, so a
 * caller can embed a comparison run in its own script.
 */
export { loadConfig, resolveUrl, ConfigError } from './config.js';
export { run } from './runner.js';
export type { RunEvents, Phase } from './runner.js';
export { renderReport } from './report.js';
export type { ReportOptions } from './report.js';
export { Progress } from './progress.js';
export type { ProgressState, ProgressOptions } from './progress.js';
export { zipDirectory, formatBytes } from './artifact.js';
export { diffImages } from './diff.js';
export { diffMarkup, normalise as normaliseMarkup } from './markup.js';
export type { MarkupDiff } from './markup.js';
export { Capturer } from './capture.js';
export type { CaptureOutcome, CaptureRequest } from './capture.js';
export { EXAMPLE_CONFIG } from './example.js';
export type {
  BeforeEach,
  Comparison,
  ComparisonStatus,
  Config,
  DiffResult,
  Hunk,
  HunkLine,
  MarkupOptions,
  MarkupResult,
  RunResult,
  Scenario,
  Side,
  SideConfig,
  Step,
  StepAction,
  StepModifiers,
  Viewport,
} from './types.js';
