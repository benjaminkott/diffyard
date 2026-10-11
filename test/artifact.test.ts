import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { crc32, inflateRawSync } from 'node:zlib';
import { writeZip, zipDirectory } from '../dist/artifact.js';

/**
 * The archive `--zip` leaves behind.
 *
 * What it has to do: open in whatever the person at the other end has, which
 * for most archives means a reader that never learnt ZIP64 -- and still open
 * once a run has outgrown the four gigabytes a plain ZIP can count. Writing
 * four gigabytes in a test is not on, so the ZIP64 layout is reached by
 * lowering the point where it takes over.
 */

const workDir = mkdtempSync(join(tmpdir(), 'diffyard-artifact-'));
const runDir = join(workDir, 'run-one');

const FILES: Record<string, Buffer> = {
  'index.html': Buffer.from(`<!doctype html>${'<p>report</p>'.repeat(200)}`),
  'data/run.js': Buffer.from('diffyard.run({});\n'),
  'shots/home.a.png': Buffer.alloc(300, 7),
  'über.txt': Buffer.from('a name that is not ASCII'),
};

before(() => {
  for (const [name, body] of Object.entries(FILES)) {
    mkdirSync(join(runDir, name, '..'), { recursive: true });
    writeFileSync(join(runDir, name), body);
  }
});

after(() => rmSync(workDir, { recursive: true, force: true }));

interface Read {
  name: string;
  body: Buffer;
  /** Whether its central record needed a ZIP64 field. */
  zip64: boolean;
}

/**
 * Reads an archive the way the format says to: from the end record, through
 * the ZIP64 locator when there is one, to the central directory, and from
 * there to each local header.
 */
function readZip(archive: Buffer): { entries: Read[]; zip64: boolean } {
  const end = archive.length - 22;
  assert.equal(archive.readUInt32LE(end), 0x06054b50, 'an end record, with no comment after it');

  let count = archive.readUInt16LE(end + 10);
  let size = archive.readUInt32LE(end + 12);
  let start = archive.readUInt32LE(end + 16);

  const zip64 = end >= 20 && archive.readUInt32LE(end - 20) === 0x07064b50;
  if (zip64) {
    const record = Number(archive.readBigUInt64LE(end - 20 + 8));
    assert.equal(archive.readUInt32LE(record), 0x06064b50, 'the locator points at the ZIP64 end record');
    assert.equal(record + 56, end - 20, 'and the record sits right before it');
    count = Number(archive.readBigUInt64LE(record + 32));
    size = Number(archive.readBigUInt64LE(record + 40));
    start = Number(archive.readBigUInt64LE(record + 48));
  } else {
    assert.notEqual(count, 0xffff, 'a sentinel in the end record needs a ZIP64 one behind it');
    assert.notEqual(size, 0xffffffff);
    assert.notEqual(start, 0xffffffff);
  }

  const entries: Read[] = [];
  let at = start;

  for (let index = 0; index < count; index++) {
    assert.equal(archive.readUInt32LE(at), 0x02014b50, 'a central record');
    const method = archive.readUInt16LE(at + 10);
    const crc = archive.readUInt32LE(at + 16);
    let compressedSize = archive.readUInt32LE(at + 20);
    let fullSize = archive.readUInt32LE(at + 24);
    const nameLength = archive.readUInt16LE(at + 28);
    const extraLength = archive.readUInt16LE(at + 30);
    const commentLength = archive.readUInt16LE(at + 32);
    let offset = archive.readUInt32LE(at + 42);
    const name = archive.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const extra = archive.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength);

    // Only the fields that hold the sentinel are in the ZIP64 field, in order.
    let field = 4;
    const wide = (value: number): number => {
      if (value !== 0xffffffff) return value;
      assert.equal(extra.readUInt16LE(0), 0x0001, `${name}: a ZIP64 field for a sentinel`);
      const read = Number(extra.readBigUInt64LE(field));
      field += 8;
      return read;
    };
    fullSize = wide(fullSize);
    compressedSize = wide(compressedSize);
    offset = wide(offset);
    if (extraLength > 0) assert.equal(field, 4 + extra.readUInt16LE(2), `${name}: nothing left over`);

    assert.equal(archive.readUInt32LE(offset), 0x04034b50, `${name}: a local header where it says`);
    const localNameLength = archive.readUInt16LE(offset + 26);
    const localExtraLength = archive.readUInt16LE(offset + 28);
    if (archive.readUInt32LE(offset + 18) === 0xffffffff) {
      // Here the ZIP64 field carries both sizes, whichever one overflowed.
      const localExtra = archive.subarray(offset + 30 + localNameLength);
      assert.equal(Number(localExtra.readBigUInt64LE(4)), fullSize, `${name}: local size`);
      assert.equal(Number(localExtra.readBigUInt64LE(12)), compressedSize, `${name}: local compressed size`);
    } else {
      assert.equal(archive.readUInt32LE(offset + 18), compressedSize, `${name}: local compressed size`);
    }

    const data = offset + 30 + localNameLength + localExtraLength;
    const stored = archive.subarray(data, data + compressedSize);
    const body = method === 8 ? inflateRawSync(stored) : stored;
    assert.equal(body.length, fullSize, `${name}: size`);
    assert.equal(crc32(body) >>> 0, crc, `${name}: checksum`);

    entries.push({ name, body, zip64: extraLength > 0 });
    at += 46 + nameLength + extraLength + commentLength;
  }

  assert.equal(at, start + size, 'the central directory is as long as it says');
  return { entries, zip64 };
}

/** A second opinion from a reader that is not this file, where there is one. */
function unzipTest(file: string): string | null {
  const unzip = spawnSync('unzip', ['-t', file], { encoding: 'utf8' });
  if (unzip.error) return null;
  assert.equal(unzip.status, 0, unzip.stdout + unzip.stderr);
  return unzip.stdout;
}

const expected = Object.entries(FILES)
  .map(([name, body]) => ({ name: `run-one/${name}`, body }))
  .sort((left, right) => left.name.localeCompare(right.name));

describe('packing a run', () => {
  it('writes an archive that fits in a plain ZIP without anything ZIP64 in it', async () => {
    const file = join(workDir, 'plain.zip');
    const size = await zipDirectory(runDir, file, 'run-one');
    const archive = readFileSync(file);

    assert.equal(size, archive.length, 'it says how much it wrote');

    const read = readZip(archive);
    assert.equal(read.zip64, false);
    assert.deepEqual(
      read.entries.map(({ name, body }) => ({ name, body })).sort((l, r) => l.name.localeCompare(r.name)),
      expected
    );
    assert.equal(read.entries.some((entry) => entry.zip64), false);
    // Version needed 2.0 everywhere: nothing a reader without ZIP64 refuses.
    assert.equal(archive.indexOf(Buffer.from([0x2d, 0x00, 0x00, 0x08])), -1);

    unzipTest(file);
  });

  for (const limit of [1, 64, 600]) {
    it(`moves every field past the limit into ZIP64 and keeps it readable (limit ${limit})`, async () => {
      const file = join(workDir, `wide-${limit}.zip`);
      await writeZip(runDir, file, 'run-one', limit);

      const read = readZip(readFileSync(file));

      assert.equal(read.zip64, true, 'the end records moved');
      assert.equal(read.entries.some((entry) => entry.zip64), true, 'and some entries with them');
      assert.deepEqual(
        read.entries.map(({ name, body }) => ({ name, body })).sort((l, r) => l.name.localeCompare(r.name)),
        expected
      );

      const said = unzipTest(file);
      if (said !== null) assert.match(said, /No errors detected/);
    });
  }

  it('leaves no half archive behind when it cannot finish', {
    // Root reads a file whatever its mode says, so nothing would fail.
    skip: process.getuid?.() === 0 || process.platform === 'win32',
  }, async () => {
    const source = join(workDir, 'unreadable');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'a.txt'), 'packed first');
    writeFileSync(join(source, 'b.txt'), 'and this one cannot be read');
    chmodSync(join(source, 'b.txt'), 0o000);
    const file = join(workDir, 'never.zip');

    await assert.rejects(() => zipDirectory(source, file, 'run-one'), { code: 'EACCES' });
    assert.throws(() => readFileSync(file), { code: 'ENOENT' });
  });
});
