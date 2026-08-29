import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

interface ZipEntry {
  /** Path inside the archive, always with forward slashes. */
  name: string;
  data: Buffer;
  compressed: Buffer;
  method: 0 | 8;
  crc: number;
}

/**
 * Packs a directory into a ZIP file without external dependencies, so a run
 * leaves behind exactly one file the caller can hand to a CI artifact store.
 *
 * Already-compressed payloads (PNG) are stored verbatim; text is deflated.
 */
export async function zipDirectory(sourceDir: string, targetFile: string, root: string): Promise<number> {
  const files = await collectFiles(sourceDir);
  const entries: ZipEntry[] = [];

  for (const file of files) {
    const data = await readFile(file);
    const name = `${root}/${relative(sourceDir, file).split(sep).join('/')}`;
    const store = /\.(png|jpe?g|gif|webp|avif|woff2?|zip)$/i.test(name);
    const compressed = store ? data : deflateRawSync(data, { level: 9 });
    // Deflate can grow tiny or incompressible payloads — fall back to storing.
    const useStore = store || compressed.length >= data.length;
    entries.push({
      name,
      data,
      compressed: useStore ? data : compressed,
      method: useStore ? 0 : 8,
      crc: crc32(data) >>> 0,
    });
  }

  if (entries.length > 0xffff) {
    throw new Error(`Cannot archive ${entries.length} files: the ZIP format caps at 65535 entries.`);
  }

  const archive = buildArchive(entries);
  await writeFile(targetFile, archive);
  return archive.length;
}

function buildArchive(entries: ZipEntry[]): Buffer {
  const { date, time } = dosTimestamp(new Date());
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    local.writeUInt16LE(entry.method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(entry.crc, 14);
    local.writeUInt32LE(entry.compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra field length

    localParts.push(local, name, entry.compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(entry.method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(entry.crc, 16);
    central.writeUInt32LE(entry.compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(((0o100644 << 16) >>> 0), 38); // external attributes: regular file, 0644
    central.writeUInt32LE(offset, 42);

    centralParts.push(central, name);
    offset += local.length + name.length + entry.compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); // disk number
  end.writeUInt16LE(0, 6); // disk with central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, centralDirectory, end]);
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
