import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') return [];
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? files(file) : entry.name.endsWith('.mjs') ? [file] : [];
  });
}
const sources = files(root);
for (const source of sources) {
  const result = spawnSync(process.execPath, ['--check', source], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`Syntax checked ${sources.length} modules.`);
