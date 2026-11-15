import { spawnSync } from 'node:child_process';
import { readFile, writeFile, readdir, copyFile } from 'node:fs/promises';
import { join } from 'node:path';

// Use the pinned compiler: no new dependencies or Node experimental TS APIs.
const compiled = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.test.json'], { stdio: 'inherit' });
if (compiled.status !== 0) process.exit(compiled.status ?? 1);
// The declaration file supplies types; tsc does not copy its companion runtime.
await copyFile('src/power/model.mjs', '.cache/solar-tests/power/model.mjs');
async function resolveImports(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await resolveImports(path);
    else if (path.endsWith('.js')) {
      const source = await readFile(path, 'utf8');
      await writeFile(path, source.replace(/(from\s+['"])(\.\.?\/[^'"]+)(['"])/g,
        (_, prefix, specifier, quote) => prefix + (/\.[a-z]+$/i.test(specifier) ? specifier : specifier + '.js') + quote));
    }
  }
}
await resolveImports('.cache/solar-tests');
const files = (await readdir('test')).filter(name => name.endsWith('.test.mjs')).map(name => join('test', name));
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
