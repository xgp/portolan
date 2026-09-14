#!/usr/bin/env node
// The Deno sandbox runtime is plain JavaScript executed by Deno, never by tsc or Node,
// so it is copied verbatim into dist/ rather than compiled.
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const assets = [['src/sandbox/runtime.js', 'dist/sandbox/runtime.js']];

for (const [from, to] of assets) {
  await mkdir(dirname(join(root, to)), { recursive: true });
  await copyFile(join(root, from), join(root, to));
  console.log(`copied ${from} -> ${to}`);
}
