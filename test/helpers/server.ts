import { createServer } from 'node:http';
import { crc32, deflateSync } from 'node:zlib';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Site {
  /** Path without the leading slash mapped to the HTML served for it. */
  pages: Record<string, string>;
  /** Anything that is not a page: images a lazy loader has to go and fetch. */
  assets?: Record<string, { type: string; body: Buffer }>;
}

export interface RunningSite {
  url: string;
  close: () => Promise<void>;
}

/**
 * Serves a handful of HTML pages on a random port.
 *
 * Comparing two of these gives the diff, the markup diff and the whole capture
 * path something real to work on without reaching for the network — and the
 * two sides can be made to differ in exactly one known way, which is what makes
 * the assertions meaningful.
 */
export async function serve(site: Site): Promise<RunningSite> {
  const server: Server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname.replace(/^\/+/, '');

    const asset = site.assets?.[path];
    if (asset) {
      response.writeHead(200, { 'content-type': asset.type });
      response.end(asset.body);
      return;
    }

    const body = site.pages[path] ?? site.pages[`${path}/`] ?? site.pages['index'];

    if (body === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
      return;
    }

    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(body);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/**
 * A solid-colour PNG, written by hand.
 *
 * Something a lazy loader actually has to go and fetch, so a test can tell a
 * loaded image from an empty box by looking at the pixels.
 */
export function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      row[1 + x * 3] = rgb[0];
      row[2 + x * 3] = rgb[1];
      row[3 + x * 3] = rgb[2];
    }
    rows.push(row);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A minimal page with a stable layout, so only intended changes show up. */
export function page(options: {
  title: string;
  body: string;
  head?: string;
  background?: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${options.title}</title>
${options.head ?? ''}
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font: 16px/1.5 monospace;
    background: ${options.background ?? '#ffffff'};
    color: #000000;
    width: 800px;
  }
  .block { height: 120px; background: #cccccc; margin-bottom: 20px; }
  .tall { height: 400px; background: #dddddd; }
  h1 { font-size: 24px; padding: 20px; }
</style>
</head>
<body>
${options.body}
</body>
</html>`;
}
