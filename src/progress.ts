import type { Comparison } from './types.js';
import { colourful, columns, formatDuration, pad, paint, truncate } from './ui.js';

const ESC = String.fromCharCode(27);
const CLEAR_LINE = `${ESC}[2K\r`;
const CLEAR_BELOW = `${ESC}[0J`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** More in flight than this and the list is longer than it is useful. */
const MOST_SHOWN = 8;

export type Phase = 'capture' | 'compare';

export interface ProgressState {
  /** Which comparison this is about; several are in flight at once. */
  id: string;
  index: number;
  total: number;
  label: string;
  phase: Phase;
}

export interface ProgressOptions {
  stream: NodeJS.WriteStream;
  /** Falls back to plain, line-based output when the stream is not a terminal. */
  interactive: boolean;
  labelA: string;
  labelB: string;
  /** How many comparisons may run at once, which is the cap on the list below. */
  workers: number;
}

interface Running {
  label: string;
  phase: Phase;
  since: number;
}

/**
 * What is happening while the run is in flight.
 *
 * A comparison takes several seconds and a suite takes minutes, so silence
 * reads as a hang. With one worker that is one line saying which pair is being
 * captured. With several it has to be a list: a single line can only show
 * whichever comparison reported last, which is the one piece of information
 * nobody asked for — it looks like the run is jumping about at random.
 *
 * Without a terminal it prints nothing of its own; the finished lines are all
 * a log needs.
 */
export class Progress {
  private timer: NodeJS.Timeout | null = null;
  private frame = 0;
  private index = 0;
  private total = 0;
  private startedAt = Date.now();
  private readonly running = new Map<string, Running>();
  private active = false;
  /** Height of the block last drawn, so it can be erased before the next one. */
  private drawn = 0;

  constructor(private readonly options: ProgressOptions) {}

  start(total: number): void {
    this.startedAt = Date.now();
    this.total = total;
    this.active = true;

    if (!this.options.interactive) return;

    this.options.stream.write(HIDE_CURSOR);
    this.timer = setInterval(() => {
      this.frame += 1;
      this.draw();
    }, 90);
    this.timer.unref();
  }

  update(state: ProgressState): void {
    this.index = state.index;
    this.total = state.total;

    const existing = this.running.get(state.id);
    // The first report for a comparison is it starting; later ones only move
    // it along, and its own clock keeps running.
    this.running.set(state.id, {
      label: state.label,
      phase: state.phase,
      since: existing ? existing.since : Date.now(),
    });

    this.draw();
  }

  /** Prints a finished comparison above the live block. */
  complete(line: string, comparison: Comparison): void {
    this.running.delete(comparison.id);

    this.erase();
    this.options.stream.write(`${line}\n`);
    this.draw();
  }

  stop(): void {
    this.active = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.erase();
    if (this.options.interactive) this.options.stream.write(SHOW_CURSOR);
  }

  private draw(): void {
    if (!this.options.interactive || !this.active) return;
    if (this.running.size === 0 && this.index === 0) return;

    const width = columns();
    const lines = [this.headline(width), ...this.workerLines(width)];

    this.erase();
    this.options.stream.write(lines.map((line) => this.fit(line, width)).join('\n'));
    this.drawn = lines.length;
  }

  /** How far the run has come, and how much of the machine is busy. */
  private headline(width: number): string {
    const spinner = paint('blue', SPINNER[this.frame % SPINNER.length]!);
    const counter = paint('grey', `${Math.min(this.index + 1, this.total)}/${this.total}`);
    const track = this.track(this.index / Math.max(1, this.total), 12);

    if (this.options.workers <= 1) {
      // One at a time: the list below would be one line saying what this line
      // already says, so the work goes on this line instead.
      const [only] = this.running.values();
      const room = width - 26 - this.visible(counter) - this.visible(track);
      const name = only ? truncate(only.label, Math.max(12, room)) : '';
      const action = only ? this.describe(only.phase) : 'starting';
      return `  ${spinner} ${counter} ${track} ${name} ${paint('grey', `${action}${this.timing()}`)}`;
    }

    const busy = `${this.running.size} of ${this.options.workers} workers`;
    return `  ${spinner} ${counter} ${track} ${paint('grey', `${busy}${this.timing()}`)}`;
  }

  /** One line per comparison in flight, oldest first so the list holds still. */
  private workerLines(width: number): string[] {
    if (this.options.workers <= 1) return [];

    const running = [...this.running.values()].sort((left, right) => left.since - right.since);
    const shown = running.slice(0, MOST_SHOWN);
    // Cut and padded to the same width, or a long name pushes its own row out
    // of a column the others keep.
    const column = Math.max(16, Math.min(46, width - 40));

    const lines = shown.map((entry) => {
      const elapsed = formatDuration(Date.now() - entry.since);
      const name = pad(truncate(entry.label, column), column);
      return `    ${paint('grey', '│')} ${name} ${paint('grey', pad(this.describe(entry.phase), 22))} ${paint('grey', elapsed)}`;
    });

    if (running.length > shown.length) {
      lines.push(`    ${paint('grey', `│ and ${running.length - shown.length} more`)}`);
    }

    return lines;
  }

  private describe(phase: Phase): string {
    if (phase === 'compare') return 'comparing';
    const { labelA, labelB } = this.options;
    if (labelA === 'A' && labelB === 'B') return 'capturing both sides';
    return `capturing ${labelA} and ${labelB}`;
  }

  /** A quiet track: done is solid, the rest a rule, so it never shouts. */
  private track(ratio: number, width: number): string {
    const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
    return paint('blue', '━'.repeat(filled)) + paint('grey', '━'.repeat(width - filled));
  }

  /**
   * Elapsed time, plus an estimate once one is worth showing.
   *
   * The estimate is the run's own throughput -- the time it has taken, over
   * what it has got through -- rather than the average comparison divided by
   * the workers. Both land within about a tenth of the truth, measured over a
   * nine-hundred page run; the difference is that this one assumes nothing.
   * Four workers on a site that serves two at a time are not four, and the
   * time spent packing the pictures is not in a comparison's duration at all.
   *
   * What made the old estimate read as a guess was not its accuracy but its
   * footing: shown from the first comparison, an average of one multiplied by
   * nine hundred, it moved by as much as five minutes between two lines. Held
   * back until a twentieth of the run is behind it, the largest step it takes
   * is under a minute.
   */
  private timing(): string {
    const elapsed = Date.now() - this.startedAt;
    const enough = Math.max(2 * Math.max(1, this.options.workers), Math.ceil(this.total / 20));
    if (this.index < enough) return ` · ${formatDuration(elapsed)}`;

    const left = (this.total - this.index) * (elapsed / this.index);
    return ` · ${formatDuration(elapsed)} · ${formatDuration(left)} left`;
  }

  private visible(text: string): number {
    if (!colourful) return [...text].length;
    return [...text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '')].length;
  }

  private fit(line: string, width: number): string {
    if (this.visible(line) <= width - 1) return line;
    const plain = line.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
    return `${[...plain].slice(0, width - 2).join('')}…`;
  }

  /**
   * Erases the block, whatever its height.
   *
   * The cursor sits at the end of the last line drawn, so this walks back up
   * to the first and clears from there down.
   */
  private erase(): void {
    if (!this.options.interactive) return;

    if (this.drawn > 1) this.options.stream.write(`${ESC}[${this.drawn - 1}A`);
    this.options.stream.write(CLEAR_LINE + CLEAR_BELOW);
    this.drawn = 0;
  }
}
