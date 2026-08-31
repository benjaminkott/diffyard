import { KIND_LABELS } from '../classify.js';

/**
 * Everything the report does once it is open.
 *
 * It ships as a string rather than a bundled module because the report is one
 * file that has to run from a file:// URL with nothing beside it -- no import
 * map, no server, no build step at the far end.
 */
export const SCRIPT = `
(() => {
  const NEWLINE = String.fromCharCode(10);

  // Filled by diffyard.run(), which is what data/run.js calls. Nothing below
  // runs before that: the page is a shell until the run is handed to it.
  let result = null;
  let sources = {};

  const list = document.getElementById('list');
  const template = document.getElementById('card-template');

  /**
   * Templates are written to be read, which means indented, which means text
   * nodes between their elements. Those are not part of the structure and they
   * are not free -- between inline elements a browser renders them as a space
   * -- so they come out once, here, rather than in every clone.
   */
  for (const held of document.querySelectorAll('template')) {
    const walk = document.createTreeWalker(held.content, NodeFilter.SHOW_TEXT);
    const blank = [];
    while (walk.nextNode()) if (!walk.currentNode.nodeValue.trim()) blank.push(walk.currentNode);
    for (const node of blank) node.remove();
  }

  /** One template's structure, cloned, waiting to be filled in. */
  function clone(id) {
    return document.getElementById(id).content.cloneNode(true).firstElementChild;
  }
  const KIND_LABELS = ${JSON.stringify(KIND_LABELS)};
  const state = { filter: 'all', kind: 'any', sort: 'diff', query: '', scenario: null, mode: 'diff' };

  const src = (id, side) => sources[id + ':' + side] || '';
  const pct = (ratio) => (ratio * 100).toFixed(2) + '%';

  /**
   * The pool: what a comparison carries that only its own detail view draws.
   *
   * The overview needs a status, a ratio and a kind per comparison, and that
   * is all the index holds. The markup diff of a run over nine hundred pages
   * is a hundred and forty megabytes of it, none of it on screen until someone
   * opens one page -- so it arrives per case, when that case is opened.
   *
   * It arrives as a script rather than as fetched JSON because the report is
   * opened from a file:// URL, where fetch is blocked and a script tag is not.
   */
  const cases = new Map();
  const asked = new Set();

  /** The case's own data, or null while it is still on its way. */
  function caseOf(comparison) {
    if (!cases.has(comparison.id) && !asked.has(comparison.id)) request(comparison);
    return cases.get(comparison.id) || null;
  }

  function request(comparison) {
    asked.add(comparison.id);
    const from = comparison.files && comparison.files.detail;

    // No chunk to ask for -- a report written before there were any. Settled
    // as empty rather than left pending, so the view says what it does have
    // and points at the patch, instead of waiting for something not coming.
    if (!from) {
      cases.set(comparison.id, {});
      return;
    }

    const script = document.createElement('script');
    script.src = from;
    // Same for a chunk that will not load: an empty case reads as "not in this
    // report", which is true, where a spinner that never stops is not.
    script.addEventListener('error', () => { take([comparison.id, {}]); });
    document.head.append(script);
  }

  /** What a chunk calls when it arrives, and what the shell calls inline. */
  function take(entry) {
    cases.set(entry[0], entry[1] || {});
    if (result && state.scenario) render();
  }

  /** Said in place of the thing, while the thing is still being fetched. */
  function awaiting(what) {
    const note = document.createElement('p');
    note.className = 'empty';
    note.textContent = 'Loading the ' + what + '…';
    return note;
  }

  /** Comparisons left after the filter row; the overview groups these. */
  function visible() {
    const query = state.query.trim().toLowerCase();
    return result.comparisons
      .map((comparison, index) => ({ comparison, index }))
      .filter(({ comparison }) => {
        if (state.filter === 'fail' && comparison.status !== 'fail') return false;
        if (state.filter === 'error' && comparison.status !== 'error') return false;
        if (state.filter === 'markup' && (!comparison.markup || comparison.markup.identical)) return false;
        if (state.filter === 'console' && !(comparison.logs && comparison.logs.differs)) return false;
        if (state.kind !== 'any' && !(comparison.kinds || []).includes(state.kind)) return false;
        if (!query) return true;
        return (
          (comparison.group ?? '') + ' ' + comparison.scenario + ' ' +
          comparison.viewport.name + ' ' + comparison.urlA + ' ' + comparison.urlB
        ).toLowerCase().includes(query);
      })
      .sort((left, right) => {
        if (state.sort === 'order') return left.index - right.index;
        if (state.sort === 'name') return left.comparison.scenario.localeCompare(right.comparison.scenario);
        const a = left.comparison.diff ? left.comparison.diff.ratio : -1;
        const b = right.comparison.diff ? right.comparison.diff.ratio : -1;
        return b - a;
      })
      .map((entry) => entry.comparison);
  }

  function render() {
    if (!state.scenario) {
      list.replaceChildren();
      return;
    }

    const items = result.comparisons.filter((entry) => qualify(entry) === state.scenario);
    list.replaceChildren();
    if (items.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'No comparisons match the current filter.';
      list.append(empty);
      return;
    }
    for (const comparison of items) list.append(card(comparison));
  }

  function card(comparison) {
    const node = template.content.cloneNode(true);
    const article = node.querySelector('.card');
    article.id = 'c-' + comparison.id;
    // Scale is 1 CSS pixel per captured pixel, which is how the page looked.
    article.style.setProperty('--shot-width', comparison.viewport.width + 'px');
    article.querySelector('.card__title').textContent = comparison.scenario;
    article.querySelector('.card__sub').textContent =
      comparison.viewport.name + ' · ' + comparison.viewport.width + '×' + comparison.viewport.height +
      (comparison.viewport.deviceScaleFactor !== 1 ? ' @' + comparison.viewport.deviceScaleFactor + 'x' : '');

    article.querySelector('.card__right').prepend(captured(comparison));

    const badge = article.querySelector('.badge');
    badge.classList.add('badge--' + comparison.status);
    badge.textContent = comparison.diff
      ? comparison.status + ' · ' + pct(comparison.diff.ratio)
      : comparison.status;

    if (comparison.markup && !comparison.markup.identical) {
      const pill = document.createElement('span');
      pill.className = 'pill pill--changed';
      pill.textContent = 'markup +' + comparison.markup.added + ' / -' + comparison.markup.removed;
      badge.after(pill);
    }

    const body = article.querySelector('.card__body');

    if (comparison.status === 'error' || comparison.status === 'timeout' || !comparison.diff) {
      const box = document.createElement('pre');
      box.className = comparison.error ? 'errorbox' : 'empty';
      box.textContent = comparison.error || 'Skipped by config.';
      body.append(box);
      return article;
    }

    body.append(view(comparison, state.mode));
    body.append(stats(comparison));
    if (comparison.command) body.append(rerun(comparison.command));
    return article;
  }

  /**
   * The line that runs this one comparison again, into this same report.
   *
   * Working through a list means fixing one thing and looking at one view
   * again; without this that is either a full run or working the flags out by
   * hand, once per finding.
   */
  /**
   * A line to paste, with the button that takes it.
   *
   * Choices turn it into several lines behind one button: the same run, asked
   * for differently. Copy reads what is on screen rather than what it was
   * built with, so switching between them needs only the text.
   */
  function rerun(command, label, choices) {
    const container = clone('rerun-template');

    const what = container.querySelector('.rerun__label');
    if (label) what.textContent = label;
    else what.remove();

    const line = container.querySelector('code');
    line.textContent = command;

    const pick = container.querySelector('.rerun__pick');
    if (!choices || choices.length < 2) {
      pick.remove();
    } else {
      for (const [at, choice] of choices.entries()) {
        const button = clone('rerun-choice-template');
        button.textContent = choice.label;
        button.title = choice.title || '';
        if (at === 0) button.classList.add('is-active');
        button.addEventListener('click', () => {
          pick.querySelectorAll('button').forEach((other) => other.classList.toggle('is-active', other === button));
          line.textContent = choice.command;
        });
        pick.append(button);
      }
    }

    const copy = container.querySelector('button:not(.rerun__pick button)');
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(line.textContent);
        copy.textContent = 'Copied';
      } catch {
        // A report opened from a file:// URL has no clipboard permission, so
        // selecting the text is the fallback that always works.
        const range = document.createRange();
        range.selectNodeContents(line);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        copy.textContent = 'Select and copy';
      }
      setTimeout(() => { copy.textContent = 'Copy'; }, 2000);
    });

    return container;
  }

  function view(comparison, mode) {
    if (mode === 'markup') return markupView(comparison);
    if (mode === 'console') return consoleView(comparison);
    const profile = comparison.diff ? comparison.diff.profile : null;

    if (mode === 'diff') {
      // Nothing differed, so no difference picture was written. Side A greyed
      // is what one would have shown.
      const difference = src(comparison.id, 'diff');
      return difference
        ? figure('Diff — red marks what changed', difference, null, profile)
        : figure('Diff — nothing differs', src(comparison.id, 'a'), null, profile, { flat: true });
    }
    if (mode === 'slider') return slider(comparison);
    if (mode === 'onion') return onion(comparison);

    const pair = document.createElement('div');
    pair.className = 'pair';
    pair.append(
      figure('A', src(comparison.id, 'a'), comparison.urlA, profile, { map: false }),
      figure('B', src(comparison.id, 'b'), comparison.urlB, profile)
    );

    linkScrolling([...pair.querySelectorAll('.frame')]);
    return pair;
  }

  /**
   * A miniature of the page marking where it differs, with the visible part
   * outlined. A full-page screenshot is thousands of pixels tall; without this
   * there is no way to tell whether the interesting part is just below the
   * fold or three screens down.
   */
  function minimap(frame, profile) {
    const map = document.createElement('div');
    map.className = 'map';

    const bands = profile && profile.length ? profile : [];
    const peak = Math.max(0, ...bands);

    if (peak === 0) {
      map.classList.add('map--flat');
      map.title = 'Nothing differs on this page';
      return map;
    }

    bands.forEach((value, index) => {
      if (value <= 0) return;
      const band = document.createElement('span');
      band.className = 'map__band';
      band.style.top = (index / bands.length) * 100 + '%';
      band.style.height = 100 / bands.length + '%';
      // Relative to the strongest band, so a page whose worst row is 4%
      // still shows where that 4% is.
      band.style.opacity = String(0.25 + 0.75 * (value / peak));
      map.append(band);
    });

    const window_ = document.createElement('span');
    window_.className = 'map__window';
    map.append(window_);

    const sync = () => {
      const range = frame.scrollHeight - frame.clientHeight;
      const top = range > 0 ? frame.scrollTop / frame.scrollHeight : 0;
      const height = frame.scrollHeight > 0 ? frame.clientHeight / frame.scrollHeight : 1;
      window_.style.top = top * 100 + '%';
      window_.style.height = Math.min(100, height * 100) + '%';
    };

    frame.addEventListener('scroll', sync);
    new ResizeObserver(sync).observe(frame);
    queueMicrotask(sync);

    map.addEventListener('click', (event) => {
      const box = map.getBoundingClientRect();
      const fraction = (event.clientY - box.top) / box.height;
      frame.scrollTop = fraction * frame.scrollHeight - frame.clientHeight / 2;
    });

    map.title = 'Where the two pages differ — select a spot to jump there';
    return map;
  }

  /** Index of the band with the most change, or null when nothing differs. */
  function peakBand(profile) {
    if (!profile || !profile.length) return null;
    let best = 0;
    for (let index = 1; index < profile.length; index += 1) {
      if (profile[index] > profile[best]) best = index;
    }
    return profile[best] > 0 ? best / profile.length : null;
  }

  function linkScrolling(frames) {
    let leading = null;

    for (const frame of frames) {
      frame.addEventListener('scroll', () => {
        if (leading && leading !== frame) return;
        leading = frame;

        const range = frame.scrollHeight - frame.clientHeight;
        const fraction = range > 0 ? frame.scrollTop / range : 0;

        for (const other of frames) {
          if (other === frame) continue;
          const otherRange = other.scrollHeight - other.clientHeight;
          other.scrollTop = otherRange * fraction;
        }

        // Released on the next frame, so the scroll events this just caused
        // do not each try to lead in turn.
        requestAnimationFrame(() => {
          leading = null;
        });
      });
    }
  }

  function figure(label, source, url, profile, options) {
    const wrapper = document.createElement('figure');
    const caption = document.createElement('figcaption');
    caption.textContent = label;
    wrapper.title = 'The two frames scroll together';
    if (url) {
      const link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = url;
      caption.append(' — ', link);
    }
    const image = document.createElement('img');
    image.className = 'shot';
    if (options && options.flat) image.classList.add('is-flat');
    image.src = source;
    image.alt = label;

    const frame = document.createElement('div');
    frame.className = 'frame';
    frame.append(image);

    const viewer = document.createElement('div');
    viewer.className = 'viewer';
    viewer.append(frame);
    if (!options || options.map !== false) viewer.append(minimap(frame, profile));
    else viewer.classList.add('viewer--nomap');

    // Land on the first thing that differs: the top of a long page is usually
    // an unchanged header, and opening there says nothing.
    const at = peakBand(profile);
    if (at !== null) {
      const jump = () => {
        frame.scrollTop = Math.max(0, at * frame.scrollHeight - frame.clientHeight / 3);
      };
      if (image.complete) queueMicrotask(jump);
      else image.addEventListener('load', jump, { once: true });
    }

    wrapper.append(caption, viewer);
    return wrapper;
  }

  /**
   * A and B in one frame, with a draggable split between them.
   *
   * The frame scrolls, like every other view of a page eight thousand pixels
   * tall, and it opens where the two differ most rather than at a header they
   * share. Both halves sit in one stage so they scroll as one thing: aligning
   * them once at the top and letting them drift apart is the whole failure
   * this view exists to avoid.
   */
  function slider(comparison) {
    const wrapper = document.createElement('div');
    wrapper.className = 'slider';

    // Everything visual lives in the stage, which is as tall as the pages
    // are. The frame around it is the window onto it.
    const stage = document.createElement('div');
    stage.className = 'slider__stage';

    const base = document.createElement('img');
    base.className = 'shot';
    // Dragging an image starts a native drag, which cancels the pointer stream
    // one move in and leaves the split stuck where it was first pressed.
    base.draggable = false;
    base.src = src(comparison.id, 'b');
    base.alt = result.config.labelB || 'B';

    const top = document.createElement('div');
    top.className = 'slider__top';
    const overlay = document.createElement('img');
    overlay.draggable = false;
    overlay.src = src(comparison.id, 'a');
    overlay.alt = result.config.labelA || 'A';
    top.append(overlay);

    const handle = document.createElement('div');
    handle.className = 'slider__handle';
    // Sticky, so the grip stays in view on a page far taller than the frame.
    const grip = document.createElement('span');
    grip.className = 'slider__grip';
    handle.append(grip);

    stage.append(base, top, handle);

    const control = document.createElement('label');
    control.className = 'slider__control';
    const range = document.createElement('input');
    range.type = 'range';
    range.min = '0';
    range.max = '100';
    range.value = '50';
    range.setAttribute('aria-label', 'Reveal ' + (result.config.labelA || 'A') + ' over ' + (result.config.labelB || 'B'));
    control.append(result.config.labelA || 'A', range, result.config.labelB || 'B');

    const apply = () => {
      const value = Number(range.value);
      top.style.width = value + '%';
      handle.style.left = value + '%';
      // The clipped half would otherwise scale its image down with it, so the
      // overlay is pinned to the width of the stage it is being clipped out of.
      overlay.style.width = stage.clientWidth + 'px';
    };

    range.addEventListener('input', apply);
    base.addEventListener('load', apply);
    new ResizeObserver(apply).observe(stage);

    // Dragging on the picture itself, which is what a split like this invites.
    // A pointer listener rather than an invisible input stretched over the
    // frame: that one swallowed the wheel and left the view unscrollable.
    const dragTo = (event) => {
      const box = stage.getBoundingClientRect();
      const share = ((event.clientX - box.left) / box.width) * 100;
      range.value = String(Math.max(0, Math.min(100, share)));
      apply();
    };

    stage.addEventListener('pointerdown', (event) => {
      // Left button only, so a scroll gesture or a context menu is left alone.
      if (event.button !== 0) return;
      event.preventDefault();
      stage.setPointerCapture(event.pointerId);
      dragTo(event);
    });
    stage.addEventListener('pointermove', (event) => {
      if (stage.hasPointerCapture(event.pointerId)) dragTo(event);
    });
    stage.addEventListener('pointerup', (event) => {
      if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
    });

    // Land where it differs; the top of a long page is a header they share.
    const at = peakBand(comparison.diff ? comparison.diff.profile : null);
    if (at !== null) {
      const jump = () => {
        wrapper.scrollTop = Math.max(0, at * wrapper.scrollHeight - wrapper.clientHeight / 3);
      };
      if (base.complete) queueMicrotask(jump);
      else base.addEventListener('load', jump, { once: true });
    }

    wrapper.append(stage);
    queueMicrotask(apply);

    const container = document.createElement('div');
    container.className = 'slider__box';
    container.append(wrapper, control);
    return container;
  }

  function onion(comparison) {
    const container = document.createElement('div');
    container.className = 'onion-view';
    const stack = document.createElement('div');
    stack.className = 'onion';
    const under = document.createElement('img');
    under.src = src(comparison.id, 'a');
    under.alt = 'A';
    const over = document.createElement('img');
    over.src = src(comparison.id, 'b');
    over.alt = 'B';
    over.style.opacity = '0.5';
    stack.append(under, over);

    const control = document.createElement('label');
    control.className = 'onion__control';
    const range = document.createElement('input');
    range.type = 'range';
    range.min = '0';
    range.max = '100';
    range.value = '50';
    range.addEventListener('input', () => { over.style.opacity = String(Number(range.value) / 100); });
    control.append('A', range, 'B');

    container.append(stack, control);
    return container;
  }

  /**
   * What each side said, with the one-sided lines marked.
   *
   * A line both sides log is how the site is; a line only one side logs is
   * often the reason the two pictures differ, so those are what the eye is
   * pointed at rather than the wall of output.
   */
  function consoleView(comparison) {
    const container = document.createElement('div');
    const logs = comparison.logs;

    if (!logs) {
      const note = document.createElement('p');
      note.className = 'empty';
      note.textContent = 'Console recording was disabled for this run.';
      container.append(note);
      return container;
    }

    const meta = document.createElement('div');
    meta.className = 'markup-meta';

    const pill = document.createElement('span');
    pill.className = logs.differs ? 'pill pill--changed' : 'pill';
    pill.textContent = logs.differs
      ? (logs.onlyA + logs.onlyB) + ' only on one side'
      : 'Both sides say the same';
    meta.append(pill);

    const tally = document.createElement('span');
    tally.textContent = logs.a.length + ' vs ' + logs.b.length + ' lines';
    meta.append(tally);
    container.append(meta);

    if (logs.a.length === 0 && logs.b.length === 0) {
      const note = document.createElement('p');
      note.className = 'empty';
      note.textContent = 'Neither side said anything.';
      container.append(note);
      return container;
    }

    const textsA = new Set(logs.a.map((entry) => entry.text));
    const textsB = new Set(logs.b.map((entry) => entry.text));

    const pair = document.createElement('div');
    pair.className = 'logs';

    for (const [label, entries, others] of [
      [result.config.labelA || 'A', logs.a, textsB],
      [result.config.labelB || 'B', logs.b, textsA],
    ]) {
      const column = clone('logs-side-template');
      column.querySelector('h3').textContent = label;

      if (entries.length === 0) {
        const quiet = document.createElement('p');
        quiet.className = 'empty';
        quiet.textContent = 'Nothing.';
        column.append(quiet);
      }

      for (const entry of entries) {
        const row = clone('logline-template');
        if (!others.has(entry.text)) row.classList.add('logline--only');

        const kind = row.querySelector('.logline__kind');
        kind.classList.add('logline__kind--' + entry.kind);
        kind.textContent = entry.kind;

        row.querySelector('.logline__text').textContent = entry.text;

        const times = row.querySelector('.logline__count');
        if (entry.count > 1) times.textContent = '×' + entry.count;
        else times.remove();

        column.append(row);
      }

      pair.append(column);
    }

    container.append(pair);
    return container;
  }

  function markupView(comparison) {
    const container = document.createElement('div');
    const markup = comparison.markup;

    if (!markup) {
      const note = document.createElement('p');
      note.className = 'empty';
      note.textContent = 'Markup diffing was disabled for this run.';
      container.append(note);
      return container;
    }

    const meta = document.createElement('div');
    meta.className = 'markup-meta';

    if (markup.identical) {
      const pill = document.createElement('span');
      pill.className = 'pill';
      pill.textContent = 'Markup identical';
      const count = document.createElement('span');
      count.textContent = markup.linesA.toLocaleString() + ' lines compared';
      meta.append(pill, count);
      container.append(meta);
      return container;
    }

    const pill = document.createElement('span');
    pill.className = 'pill pill--changed';
    pill.textContent = markup.hunks + (markup.hunks === 1 ? ' change' : ' changes');
    const added = document.createElement('span');
    added.className = 'added';
    added.textContent = '+' + markup.added;
    const removed = document.createElement('span');
    removed.className = 'removed';
    removed.textContent = '-' + markup.removed;
    const size = document.createElement('span');
    size.textContent = markup.linesA.toLocaleString() + ' vs ' + markup.linesB.toLocaleString() + ' lines';
    meta.append(pill, added, removed, size);

    if (comparison.files.patch) {
      const link = document.createElement('a');
      link.href = comparison.files.patch;
      link.textContent = 'full patch';
      link.target = '_blank';
      link.rel = 'noreferrer';
      meta.append(link);
    }
    container.append(meta);

    const held = caseOf(comparison);
    if (!held) {
      container.append(awaiting('markup diff'));
      return container;
    }

    const hunks = held.markupHunks || [];
    container.append(patchTable(hunks));

    if (markup.hunks > hunks.length) {
      const note = document.createElement('p');
      note.className = 'warn';
      note.textContent = 'Showing the first ' + hunks.length + ' of ' + markup.hunks +
        ' changes. The complete diff is in the .patch file next to this report.';
      container.append(note);
    }

    return container;
  }

  function patchTable(hunks) {
    const wrapper = clone('patch-template');
    const table = wrapper.querySelector('table');

    for (const hunk of hunks) {
      const header = clone('patch-hunk-template');
      header.querySelector('td').textContent =
        '@@ line ' + (hunk.startA + 1) + ' (A) / ' + (hunk.startB + 1) + ' (B)';
      table.append(header);

      let lineA = hunk.startA + 1;
      let lineB = hunk.startB + 1;

      for (const line of hunk.lines) {
        const row = clone('patch-line-template');
        row.className = line.type;

        const cells = row.querySelectorAll('td');
        if (line.type !== 'add') cells[0].textContent = String(lineA++);
        if (line.type !== 'remove') cells[1].textContent = String(lineB++);

        const marker = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
        cells[2].textContent = marker + line.text;

        table.append(row);
      }
    }

    return wrapper;
  }

  /**
   * When these two pictures were taken.
   *
   * One moment when both were taken for this run, two when a side came from an
   * earlier one — and then it matters, because a difference measured across
   * two moments is a different claim from one measured across none. A report
   * worked through over an afternoon has entries from several of them.
   */
  function captured(comparison) {
    const stamp = (iso, seconds) =>
      new Date(iso).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        ...(seconds ? { second: '2-digit' } : {}),
      });

    const sides = ['a', 'b'].map((side) => {
      const from = comparison.capture ? comparison.capture[side].reusedFrom : null;
      return {
        at: from ? from.capturedAt : comparison.ranAt,
        label: (side === 'a' ? result.config.labelA : result.config.labelB) || side.toUpperCase(),
      };
    });

    const fresh = comparison.ranAt > result.finishedAt;
    const span = document.createElement('span');
    // Newer than the report it sits in: this one was run again since.
    span.className = 'stamp' + (fresh ? ' stamp--fresh' : '');
    span.append(fresh ? 'Refreshed ' : 'Captured ');
    // The rounded time is what gets read; the exact one is a hover away.
    span.title = sides.map((side) => side.label + ': ' + new Date(side.at).toLocaleString()).join(NEWLINE);

    if (sides[0].at === sides[1].at) {
      const value = document.createElement('b');
      value.textContent = stamp(sides[0].at, false);
      span.append(value);
      return span;
    }

    // Two moments minutes apart round to the same minute, and two stamps that
    // read alike look like a mistake rather than like a difference. Where that
    // happens the seconds come along.
    const seconds = stamp(sides[0].at, false) === stamp(sides[1].at, false);

    for (const [index, side] of sides.entries()) {
      if (index > 0) span.append(' · ');
      const value = document.createElement('b');
      value.textContent = side.label + ' ' + stamp(side.at, seconds);
      span.append(value);
    }

    return span;
  }

  function stats(comparison) {
    const row = document.createElement('div');
    row.className = 'stats';
    const diff = comparison.diff;
    row.innerHTML =
      '<span>Difference <b>' + pct(diff.ratio) + '</b></span>' +
      '<span>Threshold <b>' + pct(comparison.threshold) + '</b></span>' +
      '<span>Pixels <b>' + diff.diffPixels.toLocaleString() + '</b> / ' + diff.totalPixels.toLocaleString() + '</span>' +
      '<span>Size <b>' + diff.width + '×' + diff.height + '</b></span>' +
      (diff.aligned && diff.aligned.shift !== 0
        ? '<span>Moved <b>' + (diff.aligned.shift > 0 ? '+' : '') + diff.aligned.shift + 'px</b>' +
          (diff.unaligned ? ' <span class="aside">(' + pct(diff.unaligned.ratio) + ' compared by position)</span>' : '') +
          '</span>'
        : '') +
      (diff.regions && diff.regions.length > 0
        ? '<span>Differs at <b>' +
          diff.regions
            .slice(0, 3)
            .map((region) => 'y ' + region.from + '–' + region.to)
            .join(', ') +
          (diff.regions.length > 3 ? ' and ' + (diff.regions.length - 3) + ' more' : '') +
          '</b></span>'
        : '') +
      '<span>Duration <b>' + (comparison.durationMs / 1000).toFixed(1) + 's</b></span>' +
      (comparison.markup
        ? '<span>Markup <b>' + (comparison.markup.identical
            ? 'identical'
            : '+' + comparison.markup.added + ' / -' + comparison.markup.removed) + '</b></span>'
        : '');

    // With rows matched up, a height difference is explained by the shift and
    // no longer inflates the number, so the warning would only mislead.
    if (!diff.sizeMismatch || diff.aligned) return row;

    const wrapper = document.createElement('div');
    const warn = document.createElement('p');
    warn.className = 'warn';
    warn.textContent =
      'Different dimensions: A is ' + diff.sizeA.width + '×' + diff.sizeA.height +
      ', B is ' + diff.sizeB.width + '×' + diff.sizeB.height +
      '. Both were padded to the union size, so the extra area counts as a difference.';
    wrapper.append(row, warn);
    return wrapper;
  }

  /**
   * The matrix answers "which page, at which size, and how badly" in one look.
   * A long run is dozens of cards; scrolling through them to find the worst one
   * is the thing this replaces.
   */
  /**
   * One tile per scenario, laid out as a grid.
   *
   * A run of eighteen sites is thirty-six full-size cards; finding the worst
   * one meant scrolling past all of them. A tile is small enough that the
   * whole run fits on a screen, and carries the diff image, so "what changed"
   * is answered before anything is opened.
   */
  function buildOverview() {
    const container = document.getElementById('tiles');
    const viewports = [];
    const cells = new Map();

    const shown = visible();

    for (const comparison of result.comparisons) {
      if (!viewports.includes(comparison.viewport.name)) viewports.push(comparison.viewport.name);
      cells.set(key(qualify(comparison), comparison.viewport.name), comparison);
    }

    // Bars are scaled to the worst comparison in the run: on a suite where
    // everything sits under 2%, an absolute scale would draw identical
    // slivers and say nothing.
    const scale = Math.max(0.01, ...result.comparisons.map((entry) => (entry.diff ? entry.diff.ratio : 0)));

    const worst = new Map();
    for (const comparison of result.comparisons) {
      const ratio = comparison.diff ? comparison.diff.ratio : -1;
      const name = qualify(comparison);
      worst.set(name, Math.max(worst.get(name) ?? -1, ratio));
    }

    const order = [...new Set(shown.map(qualify))];
    if (state.sort === 'diff') order.sort((left, right) => worst.get(right) - worst.get(left));
    if (state.sort === 'name') order.sort((left, right) => left.localeCompare(right));

    if (order.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'No comparisons match the current filter.';
      container.replaceChildren(empty);
      return;
    }

    // Scenarios keep the chosen order inside their group, and the groups
    // themselves are ordered by their worst page.
    const groups = new Map();
    for (const scenario of order) {
      const entry = shown.find((item) => qualify(item) === scenario);
      const name = entry && entry.group ? entry.group : null;
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(scenario);
    }

    if (groups.size === 1 && groups.has(null)) {
      container.className = 'tiles';
      container.replaceChildren(...order.map((scenario) => tile(scenario, viewports, cells, scale)));
      return;
    }

    container.className = '';
    container.replaceChildren(
      ...[...groups].map(([name, scenarios]) =>
        section(name, scenarios, viewports, cells, scale)
      )
    );
  }

  /** One collapsible block per group, with its own tally. */
  function section(name, scenarios, viewports, cells, scale) {
    const block = document.createElement('details');
    block.className = 'group';
    block.open = true;

    const comparisons = scenarios.flatMap((scenario) =>
      viewports.map((viewport) => cells.get(key(scenario, viewport))).filter(Boolean)
    );
    const differing = comparisons.filter((entry) => entry.status === 'fail').length;
    const broken = comparisons.filter(
      (entry) => entry.status === 'error' || entry.status === 'timeout'
    ).length;

    const summary = document.createElement('summary');

    const title = document.createElement('span');
    title.className = 'group__name';
    title.textContent = name ?? 'Ungrouped';

    const tally = document.createElement('span');
    tally.className = 'group__tally';
    const pages = scenarios.length + (scenarios.length === 1 ? ' page' : ' pages');
    if (differing === 0 && broken === 0) {
      tally.innerHTML = pages + ' · <span class="clean">all unchanged</span>';
    } else {
      const parts = [];
      if (differing > 0) parts.push('<b>' + differing + '</b> differing');
      if (broken > 0) parts.push(broken + ' errored');
      tally.innerHTML = pages + ' · ' + parts.join(' · ');
    }

    summary.append(title, tally);

    const lead = comparisons.find((entry) => entry.urlA);
    if (lead) {
      const where = document.createElement('span');
      where.className = 'group__where';
      where.textContent = short(lead.urlA) + ' → ' + short(lead.urlB);
      where.title = lead.urlA + '  →  ' + lead.urlB;
      summary.append(where);
    }

    const tiles = document.createElement('div');
    tiles.className = 'tiles';
    tiles.append(...scenarios.map((scenario) => tile(scenario, viewports, cells, scale)));

    block.append(summary, tiles);
    return block;
  }

  function tile(scenario, viewports, cells, scale) {
    const entries = viewports.map((viewport) => cells.get(key(scenario, viewport))).filter(Boolean);
    const lead = entries.find((entry) => entry.files && entry.files.diff) ?? entries[0];

    const element = clone('tile-template');
    element.querySelector('.tile__name').textContent = lead ? lead.scenario : scenario;

    const where = element.querySelector('.tile__where');
    if (lead && lead.urlA) {
      where.textContent = short(lead.urlA) + ' → ' + short(lead.urlB);
      element.title = lead.urlA + '  →  ' + lead.urlB;
    } else {
      where.remove();
    }

    const shot = element.querySelector('.tile__shot');
    const source = lead && lead.files ? src(lead.id, 'diff') || src(lead.id, 'a') : '';
    const flat = Boolean(lead && lead.files && !src(lead.id, 'diff'));

    if (source) {
      const image = document.createElement('img');
      image.loading = 'lazy';
      image.src = source;
      image.alt = '';

      const at = peakBand(lead && lead.diff ? lead.diff.profile : null);
      if (at !== null) {
        // Percentages on a transform resolve against the element, so this
        // shifts the image by that share of its own height, then centres.
        //
        // Held between the two edges: a difference near the top of the page
        // would otherwise be centred by pushing the picture down, and the
        // ground the tile sits on would show above it.
        const centred = 'calc(' + (-at * 100) + '% + var(--tile-shot) / 2)';
        image.style.transform =
          'translateY(min(0px, max(calc(var(--tile-shot) - 100%), ' + centred + ')))';
        shot.dataset.note = 'at ' + Math.round(at * 100) + '% of the page';
      }

      if (flat) image.classList.add('is-flat');
      shot.append(image);
    } else {
      shot.classList.add('tile__shot--none');
      shot.textContent = lead && lead.error ? 'not captured' : 'no image';
    }

    const rows = element.querySelector('.tile__rows');
    for (const viewport of viewports) {
      rows.append(tileRow(viewport, cells.get(key(scenario, viewport)), scale));
    }

    // What the tile's viewports found between them, so the kind is readable
    // without opening the scenario.
    const kinds = [];
    for (const entry of entries) {
      for (const kind of entry.kinds || []) if (!kinds.includes(kind)) kinds.push(kind);
    }
    if (kinds.length > 0) element.append(tags(kinds));

    element.addEventListener('click', () => openScenario(scenario));
    return element;
  }

  function tags(kinds) {
    const list = document.createElement('div');
    list.className = 'tags';

    for (const kind of kinds) {
      const tag = document.createElement('span');
      tag.className = 'tag tag--' + kind;
      tag.textContent = KIND_LABELS[kind] || kind;
      list.append(tag);
    }

    return list;
  }

  function tileRow(viewport, comparison, scale) {
    const row = clone('tile-row-template');
    row.querySelector('.tile__vp').textContent = viewport;

    const state = row.querySelector('.tile__row--state');
    const percent = row.querySelector('.tile__pct');
    const bar = row.querySelector('.tile__bar');

    // A row says either what went wrong or how much differs, never both, so
    // the half it is not is taken out rather than left empty: an empty span
    // still takes the gap its neighbours are spaced by.
    if (!comparison || comparison.status === 'error' || comparison.status === 'timeout' || comparison.status === 'skipped') {
      percent.remove();
      bar.remove();
      state.textContent = !comparison
        ? 'not run'
        : comparison.status === 'timeout'
          ? 'timed out'
          : comparison.status;
      if (comparison && comparison.status === 'skipped') row.classList.add('tile__row--skipped');
      return row;
    }

    state.remove();

    const ratio = comparison.diff ? comparison.diff.ratio : 0;
    if (comparison.status === 'pass') row.classList.add('tile__row--pass');
    else if (ratio >= scale * 0.5) row.classList.add('tile__row--heavy');

    percent.textContent = pct(ratio);
    // A hairline for a non-zero difference, so "tiny" never reads as "none".
    bar.querySelector('.tile__fill').style.width =
      ratio === 0 ? '0' : Math.max(3, (ratio / scale) * 100) + '%';

    return row;
  }

  /** What a scenario is called once its group is taken into account. */
  function qualify(comparison) {
    return comparison.group ? comparison.group + '/' + comparison.scenario : comparison.scenario;
  }

  function key(scenario, viewport) {
    return JSON.stringify([scenario, viewport]);
  }

  function firstLine(text) {
    return String(text).split(NEWLINE)[0];
  }

  /** Six steps, so a 0.2% change and a 40% one do not look the same. */
  function level(ratio) {
    const percent = ratio * 100;
    if (percent === 0) return 0;
    if (percent < 0.1) return 1;
    if (percent < 1) return 2;
    if (percent < 5) return 3;
    if (percent < 20) return 4;
    return 5;
  }

  function short(url) {
    if (!url) return '';
    try {
      const parsed = new URL(url);
      return parsed.host + (parsed.pathname === '/' ? '' : parsed.pathname);
    } catch {
      return url;
    }
  }

  /** Scenario names in the order the overview currently shows them. */
  function overviewOrder() {
    const worst = new Map();
    for (const comparison of result.comparisons) {
      const ratio = comparison.diff ? comparison.diff.ratio : -1;
      const name = qualify(comparison);
      worst.set(name, Math.max(worst.get(name) ?? -1, ratio));
    }

    const order = [...new Set(result.comparisons.map(qualify))];
    if (state.sort === 'diff') order.sort((left, right) => worst.get(right) - worst.get(left));
    if (state.sort === 'name') order.sort((left, right) => left.localeCompare(right));
    return order;
  }

  /**
   * Opens one scenario on its own.
   *
   * Thirty-six comparisons on one page is thirty-six full-page screenshots
   * loading at once, and scrolling past all of them to reach the one that
   * matters. The overview is the index; this is the page it points at.
   */
  function openScenario(scenario, options) {
    state.scenario = scenario;

    const entries = result.comparisons.filter((entry) => qualify(entry) === scenario);
    const lead = entries[0];

    const heading = document.getElementById('detail-name');
    heading.textContent = '';
    if (lead && lead.group) {
      const group = document.createElement('span');
      group.className = 'detail__group';
      group.textContent = lead.group + ' / ';
      heading.append(group);
    }
    heading.append(document.createTextNode(lead ? lead.scenario : scenario));
    const where = document.getElementById('detail-where');
    where.textContent = lead && lead.urlA ? lead.urlA + '  →  ' + lead.urlB : '';

    const order = overviewOrder();
    const at = order.indexOf(scenario);
    document.getElementById('prev').disabled = at <= 0;
    document.getElementById('next').disabled = at === -1 || at >= order.length - 1;

    document.getElementById('overview').hidden = true;
    document.getElementById('detail').hidden = false;
    document.documentElement.dataset.view = 'detail';

    render();

    if (!options || options.scroll !== false) window.scrollTo({ top: 0 });
    if (!options || options.hash !== false) {
      location.hash = encodeURIComponent(scenario);
    }
  }

  function showOverview(options) {
    state.scenario = null;
    document.getElementById('detail').hidden = true;
    document.getElementById('overview').hidden = false;
    document.documentElement.dataset.view = 'overview';
    render();

    if (!options || options.hash !== false) {
      history.pushState(null, '', location.pathname + location.search);
    }
  }

  function step(direction) {
    const order = overviewOrder();
    const at = order.indexOf(state.scenario);
    const next = order[at + direction];
    if (next) openScenario(next);
  }

  const kindPicker = document.getElementById('kind');
  if (kindPicker) {
    kindPicker.addEventListener('change', (event) => {
      state.kind = event.target.value;
      // The kinds are a question about the list, so answering it means going
      // back to the list rather than re-rendering the one view being read.
      if (state.scenario) showOverview();
      buildOverview();
    });
  }

  document.getElementById('modes').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-mode]');
    if (!button) return;
    state.mode = button.dataset.mode;
    document.querySelectorAll('#modes button').forEach((other) =>
      other.classList.toggle('is-active', other === button)
    );
    render();
  });

  document.getElementById('back').addEventListener('click', showOverview);
  document.getElementById('prev').addEventListener('click', () => step(-1));
  document.getElementById('next').addEventListener('click', () => step(1));

  /** The hash is the address of a view, so the browser's buttons work too. */
  function applyHash() {
    const requested = decodeURIComponent(location.hash.replace(/^#/, ''));
    const known = requested && result.comparisons.some((entry) => qualify(entry) === requested);

    if (known && requested !== state.scenario) openScenario(requested, { hash: false });
    else if (!requested && state.scenario) showOverview({ hash: false });
  }

  window.addEventListener('hashchange', applyHash);

  document.addEventListener('keydown', (event) => {
    if (!state.scenario || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.target.matches('input, select, textarea')) return;
    if (event.key === 'Escape') showOverview();
    if (event.key === 'ArrowLeft') step(-1);
    if (event.key === 'ArrowRight') step(1);
  });

  document.querySelector('.filters').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-filter]');
    if (!button) return;
    state.filter = button.dataset.filter;
    event.currentTarget.querySelectorAll('button').forEach((other) =>
      other.classList.toggle('is-active', other === button)
    );
    if (state.scenario) showOverview();
    buildOverview();
  });
  document.getElementById('sort').addEventListener('change', (event) => {
    state.sort = event.target.value;
    buildOverview();
  });
  document.getElementById('search').addEventListener('input', (event) => {
    state.query = event.target.value;
    if (state.scenario) showOverview();
    buildOverview();
  });

  /**
   * The settings the run was given, grouped the way the config file groups
   * them, so a finding can be traced back to what produced it. What the run
   * recorded is already free of credentials; this only lays it out.
   */
  function buildSettings() {
    const body = document.getElementById('settings-body');
    const settings = result.settings;
    if (!settings) {
      document.getElementById('settings').hidden = true;
      return;
    }

    const yes = (value) => (value ? 'yes' : 'no');
    const ms = (value) => (value === 0 ? 'none' : value + ' ms');
    const listOf = (values) => (values.length > 0 ? values.join(', ') : '—');
    const sideOf = (side) =>
      [
        side.baseUrl || 'per scenario',
        side.basicAuth ? 'basic auth' : null,
        side.headers.length > 0 ? 'headers ' + side.headers.join(', ') : null,
        side.cookies.length > 0 ? 'cookies ' + side.cookies.join(', ') : null,
        side.storageState ? 'storage state' : null,
      ]
        .filter(Boolean)
        .join(' · ');

    const groups = [
      ['Compare', [
        [settings.a.label, sideOf(settings.a)],
        [settings.b.label, sideOf(settings.b)],
        ['Scenarios', String(settings.scenarios)],
        ['Viewports', settings.viewports.map((view) => view.name + ' ' + view.width + '×' + view.height).join(', ')],
      ]],
      ['Difference', [
        ['Threshold', pct(settings.threshold)],
        ['Pixel tolerance', String(settings.pixelThreshold)],
        ['Ignore antialiasing', yes(settings.ignoreAntialiasing)],
        ['Align rows', yes(settings.alignRows)],
        ['Mask', listOf(settings.mask)],
        ['Hide', listOf(settings.hide)],
        ['Remove', listOf(settings.remove)],
      ]],
      ['Browser', [
        ['Engine', settings.browser + (settings.headless ? '' : ', headed')],
        ['Colour scheme', settings.colorScheme],
        ['Reduced motion', yes(settings.reducedMotion)],
        ['Locale', settings.locale || '—'],
        ['Time zone', settings.timezone || '—'],
        ['User agent', settings.userAgent || '—'],
        ['Ignore HTTPS errors', yes(settings.ignoreHTTPSErrors)],
      ]],
      ['Stability', [
        ['Workers', String(settings.workers)],
        ['Retries', String(settings.retries)],
        ['Capture sides', settings.sequential ? 'one after another' : 'at the same time'],
        ['Freeze animation', yes(settings.freeze)],
        ['Trigger lazy loading', yes(settings.triggerLazyLoad)],
      ]],
      ['Timeouts', [
        ['Per action', ms(settings.timeout)],
        ['Per comparison', ms(settings.comparisonTimeout)],
        ['Whole run', ms(settings.runTimeout)],
      ]],
      ['Markup', [
        ['Enabled', yes(settings.markup.enabled)],
        ['Fails a comparison', yes(settings.markup.failOnDifference)],
        ['Ignored attributes', listOf(settings.markup.ignoreAttributes)],
        ['Ignored selectors', listOf(settings.markup.ignoreSelectors)],
        ['Sort attributes', yes(settings.markup.sortAttributes)],
      ]],
      ['Console', [
        ['Enabled', yes(settings.logs.enabled)],
        ['Fails a comparison', yes(settings.logs.failOnDifference)],
        ['Levels', listOf(settings.logs.levels)],
        ['Ignored', listOf(settings.logs.ignore)],
        ['Kept per side', String(settings.logs.max)],
      ]],
    ];

    if (settings.beforeEach.length > 0) {
      groups.push(['Before each page', settings.beforeEach.map((entry) => [
        entry.name,
        [
          entry.steps + ' step' + (entry.steps === 1 ? '' : 's'),
          entry.when ? 'when ' + entry.when : 'always',
          entry.once ? 'once' : null,
          entry.required ? 'required' : null,
          entry.side ? 'side ' + entry.side.toUpperCase() : null,
        ].filter(Boolean).join(' · '),
      ])]);
    }

    if (settings.reuse.sides.length > 0) {
      groups.push(['Reuse', [
        ['Sides', settings.reuse.sides.map((side) => side.toUpperCase()).join(', ')],
        ['From', settings.reuse.from],
        ['Warn beyond', settings.reuse.maxAge === 0 ? 'never' : Math.round(settings.reuse.maxAge / 3600000) + ' h'],
      ]]);
    }

    for (const [title, rows] of groups) {
      const group = document.createElement('div');
      group.className = 'settings__group';

      const heading = document.createElement('h3');
      heading.textContent = title;
      group.append(heading);

      const table = document.createElement('dl');
      for (const [label, value] of rows) {
        const term = document.createElement('dt');
        term.textContent = label;
        const detail = document.createElement('dd');
        detail.textContent = value;
        table.append(term, detail);
      }

      group.append(table);
      body.append(group);
    }
  }

  document.getElementById('open-settings').addEventListener('click', () => {
    const panel = document.getElementById('settings');
    if (state.scenario) showOverview();
    panel.open = true;
    panel.scrollIntoView({ block: 'start' });
  });

  /**
   * Everything above is the shell's behaviour and needs no data to be wired
   * up. This is where the run itself arrives -- from data/run.js beside the
   * report, or inlined above when the report was built to travel alone.
   */
  function boot(payload) {
    result = payload.result;
    sources = payload.sources || {};

    const yaml = payload.settingsYaml;
    if (yaml) {
      document.getElementById('settings-yaml').hidden = false;
      document.getElementById('settings-yaml-text').textContent = yaml;
      const copy = document.getElementById('copy-settings');
      copy.addEventListener('click', () => {
        navigator.clipboard.writeText(yaml).then(() => {
          copy.textContent = 'Copied';
          setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
        });
      });
    }

    /*
     * The whole run again, said where the run is described rather than inside
     * a finding: from the overview the question is "look at all of this
     * again", and a per-case line is the wrong answer to it.
     */
    if (result.commands) {
      const a = result.config.labelA || 'A';
      const b = result.config.labelB || 'B';
      document.getElementById('run-command').append(
        rerun(result.commands.all, 'Capture again', [
          { label: 'both sides', command: result.commands.all },
          { label: a, command: result.commands.a, title: 'Capture ' + a + ' again, and take ' + b + ' from this run' },
          { label: b, command: result.commands.b, title: 'Capture ' + b + ' again, and take ' + a + ' from this run' },
        ])
      );
    }

    buildSettings();
    buildOverview();

    applyHash();
  }

  window.diffyard = { run: boot, case: take };
})();
`;
