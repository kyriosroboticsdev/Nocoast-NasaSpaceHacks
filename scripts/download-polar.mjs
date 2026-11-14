import { createReadStream } from 'node:fs';
import { mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const url = 'https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/87S/ldem_87s_5mpp.tif';
const length = 3465285714;
const directory = '.cache/polar-4m-ranges';
const target = '.cache/polar-full.tif';
const partSize = 4 * 1024 * 1024;
const parts = Math.ceil(length / partSize);
const sizeOf = path => stat(path).then(info => info.size, error => {
  if (error.code === 'ENOENT') return 0;
  throw error;
});
const partPath = index => `${directory}/${index}.part`;
const curl = process.platform === 'win32' ? 'curl.exe' : 'curl';

function transfer(args) {
  return new Promise((resolve, reject) => {
    const process = spawn(curl, args, {stdio: ['ignore', 'pipe', 'inherit']});
    let output = '';
    process.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
    process.on('error', reject);
    process.on('close', code => code === 0 ? resolve(output) : reject(new Error(`curl exited with ${code}`)));
  });
}

async function download(index) {
  const start = index * partSize;
  const end = Math.min(length, start + partSize) - 1;
  const expected = end - start + 1;
  const file = partPath(index);
  if (await sizeOf(file) === expected) return;
  const temporary = `${file}.download`;
  const headers = await transfer([
    '--fail', '--silent', '--show-error', '--location', '--retry', '4',
    '--speed-limit', '1024', '--speed-time', '30', '--range', `${start}-${end}`, '--max-filesize', String(expected),
    '--dump-header', '-', '--output', temporary, url,
  ]);
  const range = new RegExp(`^content-range: bytes ${start}-${end}/${length}\\s*$`, 'im');
  if (!range.test(headers) || await sizeOf(temporary) !== expected) {
    throw new Error(`Unexpected response for bytes ${start}–${end}`);
  }
  await rename(temporary, file);
}

if (await sizeOf(target) === length) {
  console.log(`Mosaic already present at ${target}`);
} else {
  await mkdir(directory, {recursive: true});
  let next = 0;
  let finished = 0;
  const errors = [];
  await Promise.all(Array.from({length: 24}, async () => {
    while (next < parts) {
      const index = next++;
      try {
        await download(index);
        finished++;
        if (finished % 10 === 0 || finished === parts) console.log(`${finished}/${parts} ranges ready`);
      } catch (error) {
        errors.push(error);
        console.error(`Range ${index} failed:`, error.message);
      }
    }
  }));
  if (errors.length) throw new AggregateError(errors, 'Download incomplete. Run again to retry missing ranges.');
  const temporary = `${target}.assembling`;
  const output = await open(temporary, 'w');
  try {
    for (let index = 0; index < parts; index++) {
      for await (const block of createReadStream(partPath(index), {highWaterMark: 1024 * 1024})) {
        await output.writeFile(block);
      }
    }
  } finally {
    await output.close();
  }
  if (await sizeOf(temporary) !== length) throw new Error('Assembled mosaic has unexpected size');
  await rename(temporary, target);
  console.log(`Saved ${length} bytes to ${target}`);
  for (let index = 0; index < parts; index++) await unlink(partPath(index));
}
