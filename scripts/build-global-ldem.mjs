/**
 * Offline pipeline: NASA SVS CGI Moon Kit LDEM @ 4 pixels/degree → compact browser asset.
 *
 * Source: https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/ldem_4.tif
 * (float32 kilometers relative to R = 1737.4 km; cylindrical, centered on 0°E)
 *
 * Output: public/terrain/global-ldem-4ppd.bin
 *   magic "LDEM" | version u32 | width u32 | height u32 | ppd u32
 *   | lonWestDeg f32 | latNorthDeg f32 | metersPerUnit f32
 *   | Int16[width*height] heights in meters (row-major, north→south, west→east)
 *
 * Usage: node scripts/build-global-ldem.mjs
 */
import { mkdir, writeFile, access, constants } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fromFile } from 'geotiff';

const SOURCE_URL = 'https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/ldem_4.tif';
const CACHE_PATH = '.cache/ldem_4.tif';
const OUT_PATH = 'public/terrain/global-ldem-4ppd.bin';
const EXPECTED_PPD = 4;
const EXPECTED_WIDTH = 360 * EXPECTED_PPD;
const EXPECTED_HEIGHT = 180 * EXPECTED_PPD;
const HEADER_BYTES = 32;

async function ensureTiff() {
  try {
    await access(CACHE_PATH, constants.R_OK);
    console.log(`Using cached ${CACHE_PATH}`);
    return;
  } catch {
    /* download */
  }
  await mkdir('.cache', { recursive: true });
  console.log(`Downloading ${SOURCE_URL}`);
  const response = await fetch(SOURCE_URL);
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status})`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(CACHE_PATH));
  console.log(`Saved ${CACHE_PATH}`);
}

await ensureTiff();
const tiff = await fromFile(CACHE_PATH);
const image = await tiff.getImage();
const width = image.getWidth();
const height = image.getHeight();
const bits = image.getBitsPerSample()?.[0] ?? image.getBitsPerSample();
const sampleFormat = image.getSampleFormat()?.[0] ?? image.getSampleFormat();
if (width !== EXPECTED_WIDTH || height !== EXPECTED_HEIGHT) {
  throw new Error(`Unexpected LDEM size ${width}×${height} (want ${EXPECTED_WIDTH}×${EXPECTED_HEIGHT})`);
}
if (bits !== 32 || sampleFormat !== 3) {
  throw new Error(`Unexpected sample type bits=${bits} format=${sampleFormat} (want float32)`);
}

const km = await image.readRasters({ samples: [0], interleave: true });
const heights = new Int16Array(width * height);
let minM = Infinity;
let maxM = -Infinity;
for (let i = 0; i < km.length; i++) {
  const meters = Math.round(km[i] * 1000);
  if (!Number.isFinite(meters)) throw new Error(`Non-finite height at index ${i}`);
  if (meters < -32768 || meters > 32767) throw new Error(`Height out of Int16 range: ${meters}`);
  heights[i] = meters;
  minM = Math.min(minM, meters);
  maxM = Math.max(maxM, meters);
}

const header = Buffer.alloc(HEADER_BYTES);
header.write('LDEM', 0, 4, 'ascii');
header.writeUInt32LE(1, 4);
header.writeUInt32LE(width, 8);
header.writeUInt32LE(height, 12);
header.writeUInt32LE(EXPECTED_PPD, 16);
header.writeFloatLE(-180, 20); // western edge of column 0
header.writeFloatLE(90, 24);   // northern edge of row 0
header.writeFloatLE(1, 28);    // meters per Int16 unit

await mkdir('public/terrain', { recursive: true });
const body = Buffer.from(heights.buffer, heights.byteOffset, heights.byteLength);
await writeFile(OUT_PATH, Buffer.concat([header, body]));

console.log(JSON.stringify({
  out: OUT_PATH,
  bytes: HEADER_BYTES + body.length,
  width,
  height,
  ppd: EXPECTED_PPD,
  minM,
  maxM,
  coverage: 'global cylindrical −180°…+180°E, +90°…−90°N (polar hole applied at runtime ~south of 87°S)',
  source: SOURCE_URL,
}, null, 2));
