import { mkdir, writeFile } from 'node:fs/promises';
import { fromUrl } from 'geotiff';

const options = {blockSize: 65536, cacheSize: 256, maxRanges: 0};
const regional = await fromUrl('https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/LDEM_80S_80MPP_ADJ.TIF', options);
const overview = await regional.getImage(2);
const [originX, originY] = (await regional.getImage()).getOrigin();
const spacing = 320;
const column = Math.floor((-91200-originX)/spacing);
const row = Math.floor((originY-91200)/spacing);
const width = 572;
const elevations = await overview.readRasters({
  window: [column, row, column+width, row+width], samples: [0], interleave: true,
});
const header = Buffer.alloc(12);
header.writeInt32LE(originX+(column+.5)*spacing);
header.writeInt32LE(originY-(row+.5)*spacing,4);
header.writeUInt32LE(width,8);
await mkdir('public/terrain/focus', {recursive:true});
await writeFile('public/terrain/polar-overview.bin', Buffer.concat([header, Buffer.from(Float32Array.from(elevations).buffer)]));
await regional.close();

const mosaic = await fromUrl('https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/87S/ldem_87s_5mpp.tif', options);
const image = await mosaic.getImage();
for (const [column, row] of [[17664,22272], [19328,21120]]) {
  const heights = await image.readRasters({
    window: [column, row, column+257, row+257], samples: [0], interleave: true,
  });
  if (!heights.every(Number.isFinite)) throw new Error('Missing elevation in a study point window');
  await writeFile(`public/terrain/focus/${column}-${row}.bin`, Buffer.from(Float32Array.from(heights).buffer));
}
await mosaic.close();
