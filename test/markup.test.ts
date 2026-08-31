import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { diffMarkup, normalise } from '../dist/markup.js';
import type { MarkupOptions } from '../dist/types.js';

const OPTIONS: MarkupOptions = {
  enabled: true,
  ignoreAttributes: [],
  ignoreSelectors: [],
  ignoreComments: false,
  normalizeWhitespace: true,
  sortAttributes: false,
  ignoreBaseUrl: true,
  failOnDifference: false,
  maxHunksInReport: 200,
};

function options(overrides: Partial<MarkupOptions> = {}): MarkupOptions {
  return { ...OPTIONS, ...overrides };
}

describe('normalise', () => {
  it('puts every tag and text run on its own line', () => {
    const html = '<div class="a"><p>Hello <b>world</b></p></div>';

    assert.equal(
      normalise(html, options()),
      ['<div class="a">', '  <p>', '    Hello', '    <b>', '      world', '    </b>', '  </p>', '</div>'].join('\n')
    );
  });

  it('collapses whitespace inside text and attributes', () => {
    const html = '<p title="a   b">much    space</p>';
    assert.equal(normalise(html, options()), '<p title="a b">\n  much space\n</p>');
  });

  it('keeps whitespace when asked to', () => {
    const html = '<p>much    space</p>';
    assert.match(normalise(html, options({ normalizeWhitespace: false })), /much {4}space/);
  });

  it('treats void elements as self-closing', () => {
    assert.equal(normalise('<div><br><img src="a.png"></div>', options()), '<div>\n  <br />\n  <img src="a.png" />\n</div>');
  });

  it('does not parse the contents of script and style as markup', () => {
    const html = '<script>if (a < b) { c(); }</script>';
    assert.equal(normalise(html, options()), '<script>\n  if (a < b) { c(); }\n</script>');
  });

  it('drops the whole subtree of an ignored selector', () => {
    const html = '<div><script>var a = 1;</script><p>keep</p></div>';
    assert.equal(normalise(html, options({ ignoreSelectors: ['script'] })), '<div>\n  <p>\n    keep\n  </p>\n</div>');
  });

  it('drops ignored attributes, including by prefix', () => {
    const html = '<div id="a" nonce="xyz" data-react-1="x" data-react-2="y" class="c"></div>';
    const result = normalise(html, options({ ignoreAttributes: ['nonce', 'data-react-*'] }));
    assert.equal(result, '<div id="a" class="c">\n</div>');
  });

  it('can sort attributes for systems that emit them in different orders', () => {
    const html = '<div zulu="1" alpha="2"></div>';
    assert.match(normalise(html, options({ sortAttributes: true })), /alpha="2" zulu="1"/);
  });

  it('keeps comments unless they are ignored', () => {
    assert.match(normalise('<!-- hi --><p>x</p>', options()), /<!-- hi -->/);
    assert.doesNotMatch(normalise('<!-- hi --><p>x</p>', options({ ignoreComments: true })), /hi/);
  });

  it('survives an unclosed tag', () => {
    assert.doesNotThrow(() => normalise('<div><p>text', options()));
  });

  it('does not mistake a > inside an attribute for the end of the tag', () => {
    const result = normalise('<div title="a > b"><p>x</p></div>', options());
    assert.match(result, /<div title="a > b">/);
    assert.match(result, /<p>/);
  });
});

describe('diffMarkup', () => {
  it('reports identical markup as identical', () => {
    const html = '<div><p>same</p></div>';
    const diff = diffMarkup(html, html, options());

    assert.equal(diff.result.identical, true);
    assert.equal(diff.result.added, 0);
    assert.equal(diff.result.removed, 0);
    assert.equal(diff.patch, '');
    assert.deepEqual(diff.hunks, []);
  });

  it('counts a changed line as one added and one removed', () => {
    const diff = diffMarkup('<p>before</p>', '<p>after</p>', options());

    assert.equal(diff.result.identical, false);
    assert.equal(diff.result.added, 1);
    assert.equal(diff.result.removed, 1);
    assert.equal(diff.result.hunks, 1);
  });

  it('counts an inserted element as added only', () => {
    const diff = diffMarkup('<div><p>a</p></div>', '<div><p>a</p><p>b</p></div>', options());

    assert.equal(diff.result.removed, 0);
    assert.ok(diff.result.added > 0);
  });

  it('produces a unified patch with markers', () => {
    const diff = diffMarkup('<p>before</p>', '<p>after</p>', options());

    assert.match(diff.patch, /^--- a \(side A\)$/m);
    assert.match(diff.patch, /^\+\+\+ b \(side B\)$/m);
    assert.match(diff.patch, /^@@ /m);
    assert.match(diff.patch, /^-\s+before$/m);
    assert.match(diff.patch, /^\+\s+after$/m);
  });

  it('reports lines that only differ in an ignored attribute as identical', () => {
    const a = '<link href="/style.css?v=1">';
    const b = '<link href="/style.css?v=2">';

    assert.equal(diffMarkup(a, b, options()).result.identical, false);
    assert.equal(diffMarkup(a, b, options({ ignoreAttributes: ['href'] })).result.identical, true);
  });

  it('keeps context lines around a change', () => {
    const before = ['<div>', '<p>1</p>', '<p>2</p>', '<p>3</p>', '<p>changed</p>', '<p>5</p>', '<p>6</p>', '</div>'].join('');
    const after = before.replace('changed', 'different');

    const [hunk] = diffMarkup(before, after, options()).hunks;
    assert.ok(hunk);
    assert.ok(hunk.lines.some((line) => line.type === 'context'));
    assert.ok(hunk.lines.some((line) => line.type === 'add'));
    assert.ok(hunk.lines.some((line) => line.type === 'remove'));
  });

  it('groups distant changes into separate hunks', () => {
    const lines = Array.from({ length: 40 }, (_, index) => `<p>${index}</p>`).join('');
    const changed = lines.replace('<p>1</p>', '<p>one</p>').replace('<p>38</p>', '<p>thirtyeight</p>');

    assert.equal(diffMarkup(lines, changed, options()).result.hunks, 2);
  });

  it('counts the lines of both sides', () => {
    const diff = diffMarkup('<p>a</p>', '<div><p>a</p><p>b</p></div>', options());

    assert.ok(diff.result.linesA < diff.result.linesB);
  });

  it('handles one side being empty', () => {
    const diff = diffMarkup('', '<p>new</p>', options());

    assert.equal(diff.result.removed, 0);
    assert.ok(diff.result.added > 0);
  });
});

describe('what gets written to disk', () => {
  it('keeps attributes the comparison ignores', () => {
    // Ignoring src because build hashes churn is right; throwing it away means
    // going back to the site to find out which image was used.
    const html = '<img src="/a-1a2b3c.png" alt="x">';
    const diff = diffMarkup(html, html, options({ ignoreAttributes: ['src'] }));

    assert.match(diff.normalisedA, /src="\/a-1a2b3c\.png"/);
    assert.equal(diff.result.identical, true, 'and still ignores it when comparing');
  });

  it('keeps subtrees the comparison skips', () => {
    const html = '<div><script>var a = 1;</script><p>keep</p></div>';
    const diff = diffMarkup(html, html, options({ ignoreSelectors: ['script'] }));

    assert.match(diff.normalisedA, /var a = 1;/);
  });

  it('still reports two pages as identical when only ignored parts differ', () => {
    const a = '<link href="/style.css?v=1">';
    const b = '<link href="/style.css?v=2">';
    const diff = diffMarkup(a, b, options({ ignoreAttributes: ['href'] }));

    assert.equal(diff.result.identical, true);
    assert.match(diff.normalisedA, /v=1/);
    assert.match(diff.normalisedB, /v=2/);
  });
});

/**
 * The two systems sit on two hosts, by definition.
 *
 * Every absolute address the page writes then differs, which on a large site
 * is hundreds of changed lines per comparison saying the same thing, and they
 * bury whatever else the page did.
 */
describe('the two systems own addresses', () => {
  const sides = { a: 'https://live.example.com/de/veranstaltung', b: 'https://staging.test:8443/de/veranstaltung' };

  const pageOn = (host: string): string =>
    `<html><head><link rel="canonical" href="${host}/de/veranstaltung">` +
    `</head><body><a href="${host}/de/tickets">Tickets</a>` +
    `<img src="${host}/fileadmin/hero.jpg" srcset="${host}/fileadmin/hero.jpg 1x"></body></html>`;

  it('is not a difference on every link of the page', () => {
    const diff = diffMarkup(pageOn('https://live.example.com'), pageOn('https://staging.test:8443'), options(), sides);

    assert.equal(diff.result.identical, true, 'the same page on two hosts is the same page');
  });

  it('still reports one side pointing at the other', () => {
    // The single case worth catching in all of that: a staging page that links
    // back to production.
    const leaking =
      '<html><head><link rel="canonical" href="https://staging.test:8443/de/veranstaltung">' +
      '</head><body><a href="https://live.example.com/de/tickets">Tickets</a>' +
      '<img src="https://staging.test:8443/fileadmin/hero.jpg" srcset="https://staging.test:8443/fileadmin/hero.jpg 1x"></body></html>';

    const diff = diffMarkup(pageOn('https://live.example.com'), leaking, options(), sides);

    assert.equal(diff.result.identical, false);
    assert.match(diff.patch, /live\.example\.com\/de\/tickets/, 'and says which address it is');
  });

  it('keeps the addresses as served in what it writes to disk', () => {
    const diff = diffMarkup(pageOn('https://live.example.com'), pageOn('https://staging.test:8443'), options(), sides);

    assert.match(diff.normalisedA, /https:\/\/live\.example\.com\/de\/tickets/);
    assert.match(diff.normalisedB, /https:\/\/staging\.test:8443\/de\/tickets/);
  });

  it('leaves them alone when the run says to', () => {
    const diff = diffMarkup(
      pageOn('https://live.example.com'),
      pageOn('https://staging.test:8443'),
      options({ ignoreBaseUrl: false }),
      sides
    );

    assert.equal(diff.result.identical, false, 'every absolute address differs, and is reported');
  });

  it('leaves a host that merely starts the same alone', () => {
    const diff = diffMarkup(
      '<a href="https://live.example.com.evil.test/x">x</a>',
      '<a href="https://staging.test:8443.evil.test/x">x</a>',
      options(),
      sides
    );

    assert.equal(diff.result.identical, false, 'a different host is a different host');
  });
});
