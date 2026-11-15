import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fromFile } from 'geotiff';

const radius = 1737400;
const rad = Math.PI / 180;
const definitions = [
  ['connecting-ridge-cr1', 'Connecting Ridge CR1', 'CR1', '01', -89.4555, 222.6192, 2, 1949.608077],
  ['shackleton-rim-sr1', 'Shackleton Rim SR1', 'SR1', '04', -89.7742, 203.4952, 4, 1735.217926],
];
const sites = [];

function glb(positions, indices, min, max) {
  const vertices = Buffer.from(positions.buffer);
  const faces = Buffer.from(indices.buffer);
  const layout = {
    asset: {version: '2.0', generator: 'Lunar Shadow Lab'},
    scene: 0, scenes: [{nodes: [0]}], nodes: [{mesh: 0}],
    meshes: [{primitives: [{attributes: {POSITION: 0}, indices: 1}]}],
    buffers: [{byteLength: vertices.length + faces.length}],
    bufferViews: [
      {buffer: 0, byteLength: vertices.length, target: 34962},
      {buffer: 0, byteOffset: vertices.length, byteLength: faces.length, target: 34963},
    ],
    accessors: [
      {bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3', min, max},
      {bufferView: 1, componentType: 5125, count: indices.length, type: 'SCALAR'},
    ],
  };
  const encoded = Buffer.from(JSON.stringify(layout));
  const json = Buffer.alloc(Math.ceil(encoded.length / 4) * 4, 32);
  encoded.copy(json);
  const header = Buffer.alloc(20);
  header.write('glTF'); header.writeUInt32LE(2, 4);
  header.writeUInt32LE(28 + json.length + vertices.length + faces.length, 8);
  header.writeUInt32LE(json.length, 12); header.write('JSON', 16);
  const bin = Buffer.alloc(8);
  bin.writeUInt32LE(vertices.length + faces.length);
  bin.write('BIN\0', 4);
  return Buffer.concat([header, json, bin, vertices, faces]);
}

for (const [siteId, name, publishedLabel, tile, latitudeDeg, longitudeEastDeg, stride, expectedElevation] of definitions) {
  const file = `.cache/site${tile}.tif`;
  const tiff = await fromFile(file);
  const image = await tiff.getImage();
  const keys = image.getGeoKeys();
  const [x0, y0] = image.getOrigin();
  const [dx, dy] = image.getResolution();
  if (dx !== 5 || dy !== -5 || keys.GTRasterTypeGeoKey !== 1 ||
      keys.ProjStraightVertPoleLongGeoKey !== 0 || keys.ProjNatOriginLatGeoKey !== -90 ||
      keys.GeogSemiMajorAxisGeoKey !== radius || keys.GeogSemiMinorAxisGeoKey !== radius ||
      keys.ProjScaleAtNatOriginGeoKey !== 1 || keys.ProjCoordTransGeoKey !== 15 ||
      keys.ProjFalseEastingGeoKey !== 0 || keys.ProjFalseNorthingGeoKey !== 0) {
    throw new Error(`Unexpected lunar polar stereographic metadata in ${file}: ${JSON.stringify(keys)}`);
  }
  const lat = latitudeDeg * rad, lon = longitudeEastDeg * rad;
  const rho = 2 * radius * Math.tan((lat + Math.PI / 2) / 2);
  const col = (rho * Math.sin(lon) - x0) / dx - 0.5;
  const row = (rho * Math.cos(lon) - y0) / dy - 0.5;
  const cx = Math.floor(col), cy = Math.floor(row);
  const half = 250; // 2.5 km crop; mesh stride is independent of source sampling.
  const window = [cx - half, cy - half, cx + half + 1, cy + half + 1];
  if (window[0] < 0 || window[1] < 0 || window[2] > image.getWidth() || window[3] > image.getHeight()) {
    throw new Error(`Crop outside source tile: ${siteId}`);
  }
  const raster = await image.readRasters({window, samples: [0], interleave: true});
  const nodata = image.getGDALNoData(), width = 2 * half + 1;
  const sample = (x, y) => raster[y * width + x];
  const valid = v => Number.isFinite(v) && v !== nodata;
  const samples = [sample(half, half), sample(half + 1, half), sample(half, half + 1), sample(half + 1, half + 1)];
  if (!samples.every(valid)) throw new Error(`Missing observer samples: ${siteId}`);
  const u = col - cx, v = row - cy;
  const elevation = (1 - v) * ((1 - u) * samples[0] + u * samples[1]) +
    v * ((1 - u) * samples[2] + u * samples[3]);
  if (Math.abs(elevation - expectedElevation) > 0.01) throw new Error(`Site elevation mismatch: ${siteId} ${elevation}`);

  const up = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
  const east = [-Math.sin(lon), Math.cos(lon), 0];
  const north = [-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)];
  const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
  const n = Math.floor((width - 1) / stride) + 1;
  const positions = [], indices = [], lookup = new Int32Array(n*n).fill(-1);
  const integral = new Uint32Array((width + 1) ** 2);
  const pitch = width + 1;
  for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
    const i = (y+1)*pitch+x+1;
    integral[i] = integral[i-1]+integral[i-pitch]-integral[i-pitch-1]+Number(!valid(sample(x,y)));
  }
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const h = sample(x*stride, y*stride);
    if (!valid(h)) continue;
    const px = x0 + (window[0] + x*stride + 0.5) * dx;
    const py = y0 + (window[1] + y*stride + 0.5) * dy;
    const phi = 2 * Math.atan(Math.hypot(px,py)/(2*radius)) - Math.PI/2;
    const lambda = Math.atan2(px,py);
    const p = [Math.cos(phi)*Math.cos(lambda), Math.cos(phi)*Math.sin(lambda), Math.sin(phi)]
      .map((axis, i) => axis * (radius+h) - up[i] * (radius+elevation));
    const vertex = [dot(p,east), dot(p,up), -dot(p,north)].map(Math.fround);
    lookup[y*n+x] = positions.length/3;
    positions.push(...vertex);
    vertex.forEach((value,i) => {min[i]=Math.min(min[i],value); max[i]=Math.max(max[i],value);});
  }
  let omittedQuads = 0;
  for (let y = 0; y < n-1; y++) for (let x = 0; x < n-1; x++) {
    const a = lookup[y*n+x], b = lookup[y*n+x+1], c = lookup[(y+1)*n+x], d = lookup[(y+1)*n+x+1];
    const left = x*stride, top = y*stride, right = left+stride+1, bottom = top+stride+1;
    const missing = integral[bottom*pitch+right]-integral[top*pitch+right]-integral[bottom*pitch+left]+integral[top*pitch+left];
    if (!missing) indices.push(a,c,b,b,c,d);
    else omittedQuads++;
  }
  if (!indices.length) throw new Error(`No renderable triangles: ${siteId}`);
  const sourceUrl = `https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/Site${tile}/Site${tile}_final_adj_5mpp_surf.tif`;
  const directory = `public/terrain/${siteId}`;
  await mkdir(directory, {recursive: true});
  await writeFile(`${directory}/terrain.glb`, glb(Float32Array.from(positions), Uint32Array.from(indices), min, max));
  sites.push({siteId, name, publishedLabel, latitudeDeg, longitudeEastDeg, surfaceElevationM: elevation,
    observerHeightAboveGroundM: 2, observerAltitudeAboveReferenceSphereM: elevation+2,
    terrainUrl: `terrain/${siteId}/terrain.glb`, sourceUrl, sourceSha256: createHash('sha256').update(await readFile(file)).digest('hex'),
    sourcePixelM: dx, meshSpacingM: dx*stride, cropWidthM: dx*(width-1), triangles: indices.length/3, omittedQuads,
    sourcePixelCenterIndex: [col,row], sourceElevationSamplesM: samples, horizonStatus: 'horizon_missing'});
  await tiff.close();
  console.log(siteId, elevation.toFixed(6), 'm;', indices.length/3, 'triangles');
}
await writeFile('public/terrain/sites.json', JSON.stringify({
  schemaVersion: '0.1', artifactId: 'lola-local-terrain-v1', generatedAtUtc: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  frameId: 'MOON_ME_DE421', referenceRadiusM: radius, meshAxes: ['east','up','south'],
  units: {distance:'m', angles:'degrees'}, provenance: 'NASA PGDA LOLA 5 m south pole landing site DEMs',
  samplingMethod: 'Bilinear at fixed site; pixel-center stride for mesh; body-fixed Cartesian to local ENU', sites,
}, null, 2) + '\n');
