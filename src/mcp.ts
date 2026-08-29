import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { EXAMPLE_CONFIG } from './example.js';
import { STEP_REFERENCE } from './reference.js';
import { schemaJson } from './schema.js';
import { VERSION } from './manifest.js';

/**
 * The MCP server is a signpost, not a second implementation.
 *
 * Everything diffyard does is already a command line, and an agent that can run
 * a shell can run it: the run prints progress per scenario, and the results are
 * files it can open. Wrapping that in tool calls would mean a comparison that
 * shows nothing for minutes and screenshots squeezed through base64 for no
 * reason. So the server answers one question — where is the tool and how is it
 * used — and then gets out of the way.
 */
const INSTRUCTIONS = `diffyard compares two URLs against each other and reports what changed, as a
pixel diff and as a structural diff of the DOM. It is a command line tool.

Call diffyard_usage once to get its path and how to drive it, then run it in your
shell. There are no tools here that run comparisons or read results: the command
writes files, and you can read those directly.`;

export function createServer(): McpServer {
  const server = new McpServer({ name: 'diffyard', version: VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool(
    'diffyard_usage',
    {
      title: 'How to run diffyard',
      description:
        'Where diffyard is installed and how to use it: writing a config, running a comparison, ' +
        'and reading the results. Call this first; everything after it happens in your shell.',
      inputSchema: {},
    },
    async () => ({ content: [{ type: 'text' as const, text: usage() }] })
  );

  server.registerResource(
    'config-reference',
    'diffyard://reference/config',
    {
      title: 'Config reference',
      description: 'A diffyard config with every option documented inline.',
      mimeType: 'text/yaml',
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/yaml', text: EXAMPLE_CONFIG }] })
  );

  server.registerResource(
    'step-reference',
    'diffyard://reference/steps',
    {
      title: 'Interaction steps',
      description: 'Every step a scenario can perform before the screenshot is taken.',
      mimeType: 'text/markdown',
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: STEP_REFERENCE }] })
  );

  server.registerResource(
    'json-schema',
    'diffyard://reference/schema',
    {
      title: 'Config JSON schema',
      description: 'For validating or generating a config.',
      mimeType: 'application/json',
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: schemaJson() }] })
  );

  return server;
}

function usage(): string {
  const cli = cliPath();

  return `diffyard ${VERSION} — visual regression by comparing two URLs.

Path
  ${cli}

Run everything below in the project you are checking: the config lives there,
and so do the results.

Commands
  ${cli} explore https://example.com/
      Opens a page and reports what a config needs to know about it: the
      consent banner, the elements that open menus, the internal links worth
      comparing, the content that changes on its own — plus a config draft.
      Start here for a site you do not know.

  ${cli} init diffyard.yaml
      Writes an annotated config plus diffyard.schema.json next to it. The first
      line of the config points at the schema, so an editor validates it.

  ${cli} run diffyard.yaml
      Captures every scenario on both sides, one after another — roughly ten
      seconds per scenario and viewport. It prints one line per comparison as
      it goes. Exit code 0 when nothing differs, 1 on differences, 2 on errors.
      Flags: --filter <text>, --group <name>, --run-id <name>, --out <dir>,
      --threshold <0..1>, --workers <n>, --headed, --junit <file>.

  ${cli} run diffyard.yaml --reuse b
      Takes side B from the last run instead of photographing it again. While
      a regression is being fixed only the local side moves, and the reference
      is usually the slower of the two because it goes over the network. Shots
      whose settings no longer match are captured again by themselves, and the
      run says which side it reused and how old it is. --reuse-from <run> picks
      a particular run; --refresh <side> takes one side fresh again.

  ${cli} schema
      Writes just diffyard.schema.json.

Config in brief
  compare:                       # optional base URLs for the two sides
    a: https://example.ddev.site
    b: https://example.com
  browser:
    viewports:
      desktop: { width: 1440, height: 900 }
  scenarios:
    - /                          # a bare path, compared on both sides
    - name: contact
      a: /kontakt                # per-side address; a full URL also works,
      b: /contact                # so one scenario can span two hosts
    - name: menu-open
      path: /
      fullPage: false            # the open menu lives in the viewport
      steps:
        - click: "button.nav-toggle"
        - waitFor: ".nav--open"
  beforeEach:                    # runs on every page, before the steps
    - name: accept consent
      when: "#uc-btn-accept-banner"   # only when the banner is there
      once: true                       # the decision sticks for the run
      steps:
        - click: "#uc-btn-accept-banner"

Reading the results
  Each run writes .diffyard-report/<timestamp>-<hash>/ into the working
  directory, with a .gitignore already inside it:

    index.html                   the report: side by side, slider, onion
                                 overlay, pixel diff, markup diff
    results.json                 every comparison with its ratio, threshold,
                                 status, markup counts and file paths
    shots/<scenario>--<viewport>.a.png    .b.png    .diff.png
    shots/<scenario>--<viewport>.a.html   .b.html   .patch

  Read results.json for the numbers, the .patch for what changed in the DOM —
  that usually explains a pixel difference — and open the .diff.png to see
  where on the page it sits.

Two things decide whether a comparison is meaningful. A consent banner has to
be accepted rather than removed, because an overlay left in place swallows the
clicks of every later step. And content that legitimately differs between the
two systems — timestamps, rotating carousels — has to be masked, or every
scenario fails for the wrong reason. \`explore\` finds both.

The resources diffyard://reference/config, /steps and /schema hold the full
config format, the step vocabulary and the JSON schema.`;
}

/**
 * The CLI ships next to this server in bin/, so the path handed out points at
 * the same installation the agent is already talking to.
 */
function cliPath(): string {
  const sibling = fileURLToPath(new URL('./diffyard.mjs', import.meta.url));
  if (existsSync(sibling)) return sibling;

  // Running from dist/ during development, or installed without the bundle.
  const fromDist = fileURLToPath(new URL('../bin/diffyard.mjs', import.meta.url));
  return existsSync(fromDist) ? fromDist : 'diffyard';
}

export async function main(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
}

// Only start when executed directly, so the module stays importable.
if (basename(process.argv[1] ?? '').startsWith('diffyard-mcp')) {
  await main();
}
