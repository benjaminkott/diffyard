#!/usr/bin/env node
import { chmod, mkdir, stat } from 'node:fs/promises';
import { build } from 'esbuild';

/**
 * Bundles the CLI and the MCP server into executable files.
 *
 * Playwright stays external: it ships native code and downloads its own browser
 * binaries, so inlining it would produce a file that still could not run on its
 * own. sharp is external for the same reason: it ships prebuilt binaries per
 * platform, which npm places on install. Everything else — the YAML parser,
 * the PNG codec, the diff — is bundled.
 */
const targets = [
  { entry: 'src/cli.ts', outfile: 'bin/diffyard.mjs' },
  { entry: 'src/mcp.ts', outfile: 'bin/diffyard-mcp.mjs' },
];

await mkdir('bin', { recursive: true });

for (const target of targets) {
  await build({
    entryPoints: [target.entry],
    outfile: target.outfile,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    sourcemap: false,
    legalComments: 'none',
    external: ['playwright', 'playwright-core', 'sharp'],
    banner: {
      // createRequire keeps bundled CommonJS dependencies working inside ESM.
      js: `#!/usr/bin/env node
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);`,
    },
  });

  await chmod(target.outfile, 0o755);

  const { size } = await stat(target.outfile);
  process.stdout.write(`Bundled ${target.outfile} (${Math.round(size / 1024)} KB)\n`);
}
