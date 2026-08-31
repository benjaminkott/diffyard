import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Progress } from '../dist/progress.js';
import type { Comparison } from '../dist/types.js';

/**
 * What the run says about itself while it is going.
 *
 * A suite takes minutes, so silence reads as a hang — and with several
 * comparisons in flight, one line can only show whichever reported last, which
 * looks like the run jumping about at random.
 */

/** A stream that keeps what was written instead of drawing it. */
function collector(): { stream: NodeJS.WriteStream; written: () => string; frames: () => string[] } {
  const chunks: string[] = [];
  const stream = {
    write(text: string) {
      chunks.push(text);
      return true;
    },
  } as unknown as NodeJS.WriteStream;

  const ESC = String.fromCharCode(27);
  const plain = () => chunks.join('').replace(new RegExp(`${ESC}\\[[0-9;?]*[a-zA-Z]`, 'g'), '');

  return {
    stream,
    written: plain,
    // Everything the caller drew, split into the blocks it drew them as.
    frames: () => plain().split('\r').filter((frame) => frame.trim() !== ''),
  };
}

function progress(workers: number) {
  const sink = collector();
  const bar = new Progress({
    stream: sink.stream,
    interactive: true,
    labelA: 'A',
    labelB: 'B',
    workers,
  });
  return { bar, ...sink };
}

const done = (id: string, durationMs: number) => ({ id, durationMs }) as Comparison;

describe('with several comparisons in flight', () => {
  it('lists what each one is doing', () => {
    const { bar, written } = progress(4);
    bar.start(20);

    bar.update({ id: 'a--desktop', index: 0, total: 20, label: 'shop/home @ desktop', phase: 'capture' });
    bar.update({ id: 'b--mobile', index: 0, total: 20, label: 'shop/cart @ mobile', phase: 'capture' });
    bar.update({ id: 'a--desktop', index: 0, total: 20, label: 'shop/home @ desktop', phase: 'compare' });
    bar.stop();

    const last = written().split('\n').slice(-3).join('\n');
    assert.match(last, /2 of 4 workers/);
    assert.match(last, /shop\/home @ desktop\s+comparing/);
    assert.match(last, /shop\/cart @ mobile\s+capturing both sides/);
  });

  it('drops one from the list when it finishes', () => {
    const { bar, written } = progress(4);
    bar.start(20);
    bar.update({ id: 'a', index: 0, total: 20, label: 'shop/home @ desktop', phase: 'capture' });
    bar.update({ id: 'b', index: 0, total: 20, label: 'shop/cart @ mobile', phase: 'capture' });

    bar.complete('  ✓ shop/home', done('a', 4000));
    const after = written().split('shop/home').pop() ?? '';
    bar.stop();

    assert.match(after, /1 of 4 workers/);
    assert.doesNotMatch(after, /shop\/home @ desktop/);
    assert.match(after, /shop\/cart @ mobile/);
  });

  it('keeps the list in the order things started', () => {
    // A list that reorders itself is a list nobody can read while it moves.
    const { bar, written } = progress(4);
    bar.start(20);
    bar.update({ id: 'first', index: 0, total: 20, label: 'aaa @ desktop', phase: 'capture' });
    bar.update({ id: 'second', index: 0, total: 20, label: 'bbb @ desktop', phase: 'capture' });
    // The one that started first reports again; it must not jump to the end.
    bar.update({ id: 'first', index: 0, total: 20, label: 'aaa @ desktop', phase: 'compare' });
    bar.stop();

    const block = written().split('\n').slice(-2).join('\n');
    assert.ok(block.indexOf('aaa') < block.indexOf('bbb'), block);
  });
});

describe('the estimate', () => {
  /** Finishes `count` comparisons of `total`, and says what the bar wrote. */
  function afterFinishing(count: number, total: number, workers = 4): string {
    const { bar, written } = progress(workers);
    bar.start(total);
    for (let at = 0; at < count; at += 1) {
      bar.update({ id: `c${at}`, index: at, total, label: 'x @ desktop', phase: 'capture' });
      bar.complete(`  ✓ c${at}`, done(`c${at}`, 4000));
    }
    bar.update({ id: 'next', index: count, total, label: 'y @ desktop', phase: 'capture' });
    bar.stop();
    return written();
  }

  it('waits for a second wave of workers', () => {
    // Four workers finishing their first four say nothing about the pace: they
    // all started together, so those four times are one measurement, not four.
    assert.doesNotMatch(afterFinishing(4, 200), /left/);
    assert.doesNotMatch(afterFinishing(7, 200), /left/);
    assert.match(afterFinishing(8, 200), /left/, 'twice the workers is a second reading');
  });

  it('does not wait for a wave that is most of a short run', () => {
    // Eight of twenty is nearly half the run; by then the estimate has little
    // left to estimate. A quarter will do where a wave would be too much.
    assert.match(afterFinishing(5, 20), /left/);
    assert.doesNotMatch(afterFinishing(4, 20), /left/);
  });

  it('keeps saying it once it has started', () => {
    // The number eases towards each new reading rather than being set to it,
    // so it must not vanish again when a slow comparison lands.
    assert.match(afterFinishing(8, 200), /left/);
    assert.match(afterFinishing(50, 200), /left/);
    assert.match(afterFinishing(199, 200), /left/);
  });

  it('says nothing until something has finished', () => {
    const { bar, written } = progress(4);
    bar.start(20);
    bar.update({ id: 'a', index: 0, total: 20, label: 'x @ desktop', phase: 'capture' });
    bar.stop();

    assert.doesNotMatch(written(), /left/);
  });
});

describe('with one worker', () => {
  it('says what it is doing on the one line, without a list', () => {
    // A list of one repeats the line above it.
    const { bar, written } = progress(1);
    bar.start(20);
    bar.update({ id: 'a', index: 0, total: 20, label: 'shop/home @ desktop', phase: 'capture' });
    bar.stop();

    const text = written();
    assert.match(text, /shop\/home @ desktop capturing both sides/);
    assert.doesNotMatch(text, /workers/);
    assert.equal(text.split('\n').length, 1, 'one line, not a block');
  });
});

describe('without a terminal', () => {
  it('draws nothing of its own', () => {
    // The finished lines are all a log needs; a redrawn block in a log file is
    // thousands of lines of cursor movement.
    const sink = collector();
    const bar = new Progress({
      stream: sink.stream,
      interactive: false,
      labelA: 'A',
      labelB: 'B',
      workers: 4,
    });

    bar.start(20);
    bar.update({ id: 'a', index: 0, total: 20, label: 'shop/home @ desktop', phase: 'capture' });
    bar.complete('  ✓ shop/home', done('a', 4000));
    bar.stop();

    assert.equal(sink.written(), '  ✓ shop/home\n');
  });
});

describe('redrawing', () => {
  it('walks back up over the block it drew before writing the next', () => {
    // Without that the terminal fills with every frame it ever drew.
    const chunks: string[] = [];
    const stream = { write: (text: string) => (chunks.push(text), true) } as unknown as NodeJS.WriteStream;
    const bar = new Progress({ stream, interactive: true, labelA: 'A', labelB: 'B', workers: 4 });

    bar.start(20);
    bar.update({ id: 'a', index: 0, total: 20, label: 'x @ desktop', phase: 'capture' });
    bar.update({ id: 'b', index: 0, total: 20, label: 'y @ desktop', phase: 'capture' });
    const before = chunks.length;
    bar.update({ id: 'c', index: 0, total: 20, label: 'z @ desktop', phase: 'capture' });
    bar.stop();

    // Three lines were standing, so the cursor goes up two to reach the first.
    const since = chunks.slice(before).join('');
    assert.match(since, new RegExp(`${String.fromCharCode(27)}\\[2A`));
  });
});
