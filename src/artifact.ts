import { open, readdir, readFile, rm, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

/**
 * The largest value a plain ZIP field holds, and the sentinel that says "look
 * in the ZIP64 record instead". A value equal to it has to move as well, or a
 * reader takes it for the sentinel.
 */
const ZIP32 = 0xffffffff;

/** The same for the 16-bit entry counts in the end record. */
const ENTRIES16 = 0xffff;

interface ZipEntry {
  /** Path inside the archive, always with forward slashes. */
  name: Buffer;
  method: 0 | 8;
  crc: number;
  size: number;
  compressedSize: number;
  /** Where its local header starts in the archive. */
  offset: number;
}

/**
 * Packs a directory into a ZIP file without external dependencies, so a run
 * leaves behind exactly one file the caller can hand to a CI artifact store.
 *
 * Already-compressed payloads (PNG) are stored verbatim; text is deflated.
 */
export function zipDirectory(sourceDir: string, targetFile: string, root: string): Promise<number> {
  return writeZip(sourceDir, targetFile, root, ZIP32);
}

/**
 * The writer, with the point where ZIP64 takes over as a parameter.
 *
 * A run of a few thousand full-page screenshots passes four gigabytes, and
 * every field that counts bytes in a plain ZIP is 32 bits wide. Each value
 * that would not fit moves into a ZIP64 record, and only those: an archive
 * that fits is laid out exactly as it always was, for every reader that never
 * learnt ZIP64. The limit is a parameter so the tests can reach that layout
 * with kilobytes rather than gigabytes.
 *
 * Entries are written as they are packed, one file in memory at a time: the
 * whole run held at once, compressed and uncompressed, is twice the size of
 * the archive.
 */
export async function writeZip(
  sourceDir: string,
  targetFile: string,
  root: string,
  limit: number
): Promise<number> {
  const files = await collectFiles(sourceDir);
  const { date, time } = dosTimestamp(new Date());
  const central: Buffer[] = [];
  const archive = await open(targetFile, 'w');
  let offset = 0;

  const put = async (part: Buffer): Promise<void> => {
    await writeAll(archive, part);
    offset += part.length;
  };

  try {
    for (const file of files) {
      const data = await readFile(file);
      const name = `${root}/${relative(sourceDir, file).split(sep).join('/')}`;
      const store = /\.(png|jpe?g|gif|webp|avif|woff2?|zip)$/i.test(name);
      const compressed = store ? data : deflateRawSync(data, { level: 9 });
      // Deflate can grow tiny or incompressible payloads — fall back to storing.
      const useStore = store || compressed.length >= data.length;
      const payload = useStore ? data : compressed;
      const entry: ZipEntry = {
        name: Buffer.from(name, 'utf8'),
        method: useStore ? 0 : 8,
        crc: crc32(data) >>> 0,
        size: data.length,
        compressedSize: payload.length,
        offset,
      };

      await put(localHeader(entry, time, date, limit));
      await put(payload);
      central.push(centralHeader(entry, time, date, limit));
    }

    const start = offset;
    for (const record of central) await put(record);
    await put(endRecords(files.length, start, offset - start, limit));
  } catch (error) {
    // Half an archive looks like a whole one until somebody opens it.
    await archive.close();
    await rm(targetFile, { force: true });
    throw error;
  }

  await archive.close();
  return offset;
}

async function writeAll(file: FileHandle, part: Buffer): Promise<void> {
  let written = 0;
  while (written < part.length) {
    const { bytesWritten } = await file.write(part, written, part.length - written);
    written += bytesWritten;
  }
}

function localHeader(entry: ZipEntry, time: number, date: number, limit: number): Buffer {
  // The local record has no offset, and its ZIP64 field carries both sizes or
  // neither, whichever of the two is the one that overflowed.
  const wide = entry.size >= limit || entry.compressedSize >= limit;
  const extra = wide ? zip64Extra([entry.size, entry.compressedSize]) : Buffer.alloc(0);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(versionFor(entry, limit), 4); // version needed
  local.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
  local.writeUInt16LE(entry.method, 8);
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(entry.crc, 14);
  local.writeUInt32LE(wide ? ZIP32 : entry.compressedSize, 18);
  local.writeUInt32LE(wide ? ZIP32 : entry.size, 22);
  local.writeUInt16LE(entry.name.length, 26);
  local.writeUInt16LE(extra.length, 28);

  return Buffer.concat([local, entry.name, extra]);
}

function centralHeader(entry: ZipEntry, time: number, date: number, limit: number): Buffer {
  // Here only the fields that overflowed move, in the order the format fixes.
  const moved = [entry.size, entry.compressedSize, entry.offset].filter((value) => value >= limit);
  const extra = moved.length > 0 ? zip64Extra(moved) : Buffer.alloc(0);
  const version = versionFor(entry, limit);
  const narrow = (value: number): number => (value >= limit ? ZIP32 : value);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(version, 4); // version made by
  central.writeUInt16LE(version, 6); // version needed
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(entry.method, 10);
  central.writeUInt16LE(time, 12);
  central.writeUInt16LE(date, 14);
  central.writeUInt32LE(entry.crc, 16);
  central.writeUInt32LE(narrow(entry.compressedSize), 20);
  central.writeUInt32LE(narrow(entry.size), 24);
  central.writeUInt16LE(entry.name.length, 28);
  central.writeUInt16LE(extra.length, 30);
  central.writeUInt16LE(0, 32); // comment
  central.writeUInt16LE(0, 34); // disk number
  central.writeUInt16LE(0, 36); // internal attributes
  central.writeUInt32LE(((0o100644 << 16) >>> 0), 38); // external attributes: regular file, 0644
  central.writeUInt32LE(narrow(entry.offset), 42);

  return Buffer.concat([central, entry.name, extra]);
}

/** 4.5 is the version of the format that introduced ZIP64; 2.0 is deflate. */
function versionFor(entry: ZipEntry, limit: number): number {
  return Math.max(entry.size, entry.compressedSize, entry.offset) >= limit ? 45 : 20;
}

/** The ZIP64 extended information field: tag 1, then each value as 64 bits. */
function zip64Extra(values: number[]): Buffer {
  const extra = Buffer.alloc(4 + 8 * values.length);
  extra.writeUInt16LE(0x0001, 0);
  extra.writeUInt16LE(8 * values.length, 2);
  values.forEach((value, index) => extra.writeBigUInt64LE(BigInt(value), 4 + 8 * index));
  return extra;
}

/**
 * The end of central directory record, preceded by its ZIP64 counterpart and
 * the locator that points at it when a count, size or offset has outgrown it.
 */
function endRecords(count: number, start: number, size: number, limit: number): Buffer {
  const manyEntries = count >= Math.min(limit, ENTRIES16);
  const zip64 = manyEntries || start >= limit || size >= limit;
  const parts: Buffer[] = [];

  if (zip64) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(44n, 4); // size of what follows this field
    record.writeUInt16LE(45, 12); // version made by
    record.writeUInt16LE(45, 14); // version needed
    record.writeUInt32LE(0, 16); // disk number
    record.writeUInt32LE(0, 20); // disk with central directory
    record.writeBigUInt64LE(BigInt(count), 24);
    record.writeBigUInt64LE(BigInt(count), 32);
    record.writeBigUInt64LE(BigInt(size), 40);
    record.writeBigUInt64LE(BigInt(start), 48);

    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeUInt32LE(0, 4); // disk with the ZIP64 end record
    locator.writeBigUInt64LE(BigInt(start + size), 8);
    locator.writeUInt32LE(1, 16); // total disks

    parts.push(record, locator);
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); // disk number
  end.writeUInt16LE(0, 6); // disk with central directory
  end.writeUInt16LE(manyEntries ? ENTRIES16 : count, 8);
  end.writeUInt16LE(manyEntries ? ENTRIES16 : count, 10);
  end.writeUInt32LE(size >= limit ? ZIP32 : size, 12);
  end.writeUInt32LE(start >= limit ? ZIP32 : start, 16);
  end.writeUInt16LE(0, 20); // comment length
  parts.push(end);

  return Buffer.concat(parts);
}

async function collectFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await collectFiles(path)));
    } else if (entry.isFile()) {
      found.push(path);
    }
  }

  return found;
}

/** MS-DOS date/time as used by the ZIP header. */
function dosTimestamp(now: Date): { date: number; time: number } {
  const year = Math.max(1980, now.getFullYear());
  return {
    date: ((year - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate(),
    time: (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2),
  };
}

export async function fileSize(path: string): Promise<number> {
  return (await stat(path)).size;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}
