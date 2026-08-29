import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { bar, formatAge, formatDuration, pad, padLeft, percent, shortPath, truncate } from '../dist/ui.js';

const ESC = String.fromCharCode(27);
const coloured = `${ESC}[31mfail${ESC}[0m`;

describe('bar', () => {
  it('fills the width at the top of the scale', () => {
    assert.equal(bar(0.5, 0.5, 10), '██████████');
  });

  it('scales against the largest value, not against 100%', () => {
    // Half of the worst comparison is half a bar, however small it is.
    assert.match(bar(0.01, 0.02, 10), /^█████/);
  });

  it('draws a sliver for anything above zero', () => {
    // A rounded-away difference must not look like no difference at all.
    const tiny = bar(0.00001, 0.5, 10);
    assert.notEqual(tiny.trim(), '');
    assert.notEqual(tiny.trim(), '·');
  });

  it('marks a true zero differently from a tiny difference', () => {
    assert.notEqual(bar(0, 0.5, 10).trim(), bar(0.00001, 0.5, 10).trim());
  });

  it('always occupies the requested width', () => {
    for (const value of [0, 0.0001, 0.25, 0.5]) {
      const drawn = bar(value, 0.5, 10).replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
      assert.equal([...drawn].length, 10, `width wrong for ${value}`);
    }
  });

  it('does not overflow when a value exceeds the scale', () => {
    const drawn = bar(2, 0.5, 10).replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
    assert.equal([...drawn].length, 10);
  });
});

describe('padding', () => {
  it('measures visible characters, not escape sequences', () => {
    // Colour codes have no width on screen; counting them misaligns columns.
    assert.equal(pad(coloured, 10).replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), ''), 'fail      ');
    assert.equal(padLeft(coloured, 10).replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), ''), '      fail');
  });

  it('leaves text longer than the width alone', () => {
    assert.equal(pad('abcdef', 3), 'abcdef');
  });
});

describe('truncate', () => {
  it('keeps text that fits', () => {
    assert.equal(truncate('speakers', 20), 'speakers');
  });

  it('marks what it cut', () => {
    assert.equal(truncate('awards-winners-of-the-typo3', 10), 'awards-wi…');
  });

  it('collapses whitespace first', () => {
    assert.equal(truncate('a   b', 10), 'a b');
  });
});

describe('shortPath', () => {
  it('shows a path inside the working directory relative to it', () => {
    assert.equal(shortPath(join(process.cwd(), 'a', 'b.html')), join('a', 'b.html'));
  });

  it('shortens a path in the home directory with a tilde', () => {
    const path = join(homedir(), 'projects', 'x');
    // Only meaningful when the test does not already run from inside it.
    if (!process.cwd().startsWith(homedir())) {
      assert.equal(shortPath(path), join('~', 'projects', 'x'));
    }
  });

  it('leaves an unrelated absolute path as it is', () => {
    assert.equal(shortPath('/etc/hosts'), '/etc/hosts');
  });
});

describe('formatDuration', () => {
  it('uses seconds below a minute', () => {
    assert.equal(formatDuration(4500), '4.5s');
  });

  it('switches to minutes above one', () => {
    assert.equal(formatDuration(125_000), '2m 05s');
  });
});

describe('percent', () => {
  it('renders a ratio with two decimals', () => {
    assert.equal(percent(0.1392), '13.92%');
    assert.equal(percent(0), '0.00%');
  });
});

describe('formatAge', () => {
  it('says how long ago in the terms that decide trust', () => {
    assert.equal(formatAge(20_000), 'just now');
    assert.equal(formatAge(60_000), '1 minute ago');
    assert.equal(formatAge(41 * 60_000), '41 minutes ago');
    assert.equal(formatAge(90 * 60_000), '2 hours ago');
    assert.equal(formatAge(3 * 86_400_000), '3 days ago');
  });
});
