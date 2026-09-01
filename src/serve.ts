import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve, sep } from 'node:path';

/**
 * The report, over HTTP.
 *
 * A report opens from a file:// URL and is built to: the run is written beside
 * it as scripts rather than JSON because fetch is blocked there. What file://
 * cannot do is be opened from the phone on the desk, or from the machine that
 * did not do the run -- and a folder of nine hundred screenshots is not
 * something to send around. One command in the folder answers both.
 *
 * Static files and nothing else. There is no state to keep, no upload to
 * accept and nothing to write: the run is already on disk, and the report
 * reads it the same way whether it arrives over a socket or off a disk.
 */

/** What a browser has to be told, for the few kinds of file a run holds. */
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.txt': 'text/plain; charset=utf-8',
  // The unified diff beside a comparison: a reader opens it, so it has to
  // arrive as text rather than as a download.
  '.patch': 'text/plain; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8',
  '.zip': 'application/zip',
};

export interface Serving {
  /** Where it is, with the port it actually got. */
  url: string;
  port: number;
  close: () => Promise<void>;
}

/** Where it goes when nobody says. Kept off the ports a dev server takes. */
export const PREFERRED_PORT = 4173;

/** How many after the wanted one to try before asking for any free port. */
const NEIGHBOURS = 10;

export interface ServeOptions {
  /** 0 asks the operating system for a free one. */
  port?: number;
  /**
   * Whether the port is a requirement or a preference.
   *
   * A number somebody typed is a requirement: they are pointing something else
   * at it, and quietly serving somewhere else would leave them looking at the
   * wrong thing, or at nothing. The default is a preference, and a second run
   * in another window is the ordinary reason it is taken.
   */
  strict?: boolean;
  /**
   * Localhost by default. A report is a page about systems that are not
   * public, taken with credentials that are not public, and putting it on
   * every interface of the machine should be something someone asked for.
   */
  host?: string;
}

export async function serveReport(dir: string, options: ServeOptions = {}): Promise<Serving> {
  const root = resolve(dir);
  const host = options.host ?? '127.0.0.1';

  const server = createServer((request, response) => {
    void answer(root, request.url ?? '/', response).catch(() => {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Something went wrong reading that.\n');
    });
  });

  await listenOn(server, host, options);

  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/`,
    port,
    close: () => closeServer(server),
  };
}

/**
 * The wanted port, then the ten after it, then whichever one is free.
 *
 * A port that is taken is almost always a report already being served in
 * another window, and walking on is what someone would do by hand. Zero is
 * asked for last rather than first so the address stays predictable: the same
 * command in the same folder lands on the same port from one day to the next.
 */
async function listenOn(server: Server, host: string, options: ServeOptions): Promise<void> {
  const wanted = options.port ?? PREFERRED_PORT;
  const ports = options.strict || wanted === 0
    ? [wanted]
    : [...Array.from({ length: NEIGHBOURS + 1 }, (_, step) => wanted + step), 0];

  let last: Error | null = null;

  for (const port of ports) {
    try {
      await new Promise<void>((ready, failed) => {
        const stumbled = (error: Error) => {
          server.off('listening', settled);
          failed(error);
        };
        const settled = () => {
          server.off('error', stumbled);
          ready();
        };

        server.once('error', stumbled);
        server.once('listening', settled);
        server.listen(port, host);
      });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      last = error as Error;
    }
  }

  throw last ?? new Error('Could not listen on any port');
}

async function answer(
  root: string,
  target: string,
  response: import('node:http').ServerResponse
): Promise<void> {
  const asked = decodeURIComponent(new URL(target, 'http://localhost').pathname);

  // Everything under the folder that was served, and nothing above it: a
  // report links to its own files by relative path, and an address that
  // climbs out of the folder is not one of them.
  const path = resolve(join(root, normalize(asked)));
  if (path !== root && !path.startsWith(root + sep)) {
    response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Outside the report.\n');
    return;
  }

  let entry;
  try {
    entry = await stat(path);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not in this report.\n');
    return;
  }

  if (entry.isDirectory()) {
    const index = join(path, 'index.html');
    try {
      const found = await stat(index);
      send(response, index, found.size);
      return;
    } catch {
      await listRuns(path, asked, response);
      return;
    }
  }

  send(response, path, entry.size);
}

/**
 * Never cached.
 *
 * The report is written again every few seconds while a run is going, and the
 * whole point of opening it then is that a refresh shows where it has got to.
 * A cached page shows where it had got to.
 */
function send(response: import('node:http').ServerResponse, path: string, size: number): void {
  response.writeHead(200, {
    'content-type': TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
    'content-length': size,
    'cache-control': 'no-store',
  });

  createReadStream(path).pipe(response);
}

/**
 * A folder of runs rather than a run: the output directory, with one folder
 * per run in it. Listed newest first, which is the one being looked for.
 */
async function listRuns(
  path: string,
  asked: string,
  response: import('node:http').ServerResponse
): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true });
  const runs: { name: string; at: number }[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const record = await stat(join(path, entry.name, 'results.json'));
      runs.push({ name: entry.name, at: record.mtimeMs });
    } catch {
      // A directory that is not a run; nothing to link to.
    }
  }

  runs.sort((left, right) => right.at - left.at);

  const base = asked.endsWith('/') ? asked : `${asked}/`;
  const links = runs
    .map(
      (run) =>
        `<li><a href="${escapeHtml(base + run.name)}/">${escapeHtml(run.name)}</a>` +
        ` <small>${new Date(run.at).toLocaleString()}</small></li>`
    )
    .join('\n');

  const body = runs.length > 0
    ? `<h1>Runs</h1>\n<ul>\n${links}\n</ul>`
    : '<h1>Nothing here</h1>\n<p>No report and no runs in this folder.</p>';

  response.writeHead(runs.length > 0 ? 200 : 404, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(
    `<!doctype html><meta charset="utf-8"><title>diffyard</title>` +
      `<style>body{font:14px system-ui;margin:3rem;max-width:40rem}` +
      `li{margin:.4rem 0}small{color:#777;margin-left:.5rem}</style>${body}\n`
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((done) => {
    server.closeAllConnections();
    server.close(() => done());
  });
}
