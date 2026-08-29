import { relative } from 'node:path';

/**
 * The pieces the command line output is built from.
 *
 * Terminal output is a design surface like any other: the same few decisions —
 * a colour set, a symbol set, one bar, one rule — applied everywhere are what
 * separate a tool that looks finished from one that prints whatever each call
 * site felt like.
 */

const ESC = String.fromCharCode(27);

const CODES = {
  reset: '0',
  bold: '1',
  dim: '2',
  red: '31',
  green: '32',
  yellow: '33',
  blue: '34',
  grey: '90',
} as const;

export type Style = keyof Omit<typeof CODES, 'reset'>;

/** Colour is opt-in: a pipe, a log file or NO_COLOR gets plain text. */
export const colourful = process.stdout.isTTY === true && !process.env['NO_COLOR'];

export function paint(style: Style, text: string): string {
  if (!colourful) return text;
  return `${ESC}[${CODES[style]}m${text}${ESC}[${CODES.reset}m`;
}

/** Marks a state at a glance; the word next to it carries the meaning. */
export const MARK = {
  pass: () => paint('green', '✓'),
  fail: () => paint('red', '✗'),
  error: () => paint('yellow', '!'),
  skip: () => paint('grey', '–'),
} as const;

/** Eight steps per cell, so a small difference is still a visible sliver. */
const BLOCKS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'];

/**
 * A bar for a share of something, drawn against the largest value in the run
 * rather than against 100%: on a suite where everything sits under 2%, an
 * absolute scale draws twenty identical slivers.
 */
export function bar(value: number, scale: number, width: number): string {
  if (value <= 0) return paint('grey', '·'.padEnd(width));

  const filled = Math.max(0, Math.min(1, value / Math.max(scale, Number.EPSILON))) * width;
  const whole = Math.floor(filled);
  const remainder = Math.round((filled - whole) * 8);

  const body = '█'.repeat(Math.min(whole, width));
  const tip = whole < width ? BLOCKS[remainder] ?? '' : '';

  // Anything above zero gets at least a sliver: rounding a 0.04% difference
  // away to blank makes it look identical to one that is genuinely zero.
  const drawn = body || tip ? `${body}${tip}` : BLOCKS[1]!;

  return drawn.padEnd(width);
}

export function rule(width: number): string {
  return paint('grey', '─'.repeat(Math.max(1, width)));
}

/** Paths are shown from the working directory: absolute ones bury the line. */
export function shortPath(path: string): string {
  const from = relative(process.cwd(), path);
  if (from && !from.startsWith('..')) return from;

  const home = process.env['HOME'];
  if (home && path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`;
  return path;
}

/** Pads to a visible width, ignoring the escape sequences colour adds. */
export function pad(text: string, width: number): string {
  const visible = text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
  return text + ' '.repeat(Math.max(0, width - [...visible].length));
}

/** Right-aligns, so a column of numbers lines up on the decimal point. */
export function padLeft(text: string, width: number): string {
  const visible = text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
  return ' '.repeat(Math.max(0, width - [...visible].length)) + text;
}

/** Cuts to a visible width, keeping the end where the meaning usually is. */
export function truncate(text: string, width: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return [...single].length <= width ? single : `${[...single].slice(0, width - 1).join('')}…`;
}

export function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;

  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(Math.round(seconds % 60)).padStart(2, '0')}s`;
}

/**
 * How long ago something happened, in the roundest terms that still say it.
 *
 * "41 minutes ago" is what decides whether a reused reference can be trusted;
 * the exact seconds never do.
 */
export function formatAge(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;

  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function percent(ratio: number): string {
  return `${(ratio * 100).toFixed(2)}%`;
}

/** Terminal width, clamped to something a line still reads well at. */
export function columns(): number {
  // A pipe or a pseudo-terminal reports 0, not undefined, so `??` is not enough.
  return Math.max(60, Math.min(process.stdout.columns || 100, 120));
}
