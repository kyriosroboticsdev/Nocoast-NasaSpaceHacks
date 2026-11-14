import * as T from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const radius = 1737400;
const capRadius = 2 * radius * Math.tan(T.MathUtils.degToRad(1.5));
const base = import.meta.env.BASE_URL;
const element = <E extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as E;
const status = element('status');
const layer = element<HTMLSelectElement>('layer');
const focus = element<HTMLButtonElement>('focus');
const reset = element<HTMLButtonElement>('reset');
const size = 257;
const moonCenter = new T.Vector3(0,-radius,0);

export type MarkerCategory = 'catalog' | 'search' | 'chosen' | 'compare';

export type TerrainMarkerSpec = {
  id: string;
  category: MarkerCategory;
  latitudeDeg: number;
  longitudeEastDeg: number;
  label?: string;
};

export type TerrainPickCallback = (latitudeDeg: number, longitudeEastDeg: number) => void;
export type TerrainMarkerClickCallback = (marker: TerrainMarkerSpec) => void;

export type TerrainApi = {
  focusLatLon: (latitudeDeg: number, longitudeEastDeg: number) => void;
  showGlobe: (animate?: boolean) => void;
  showPolarCap: () => void;
  /** When enabled, next terrain click reports lat/lon instead of only flying. */
  setPickMode: (enabled: boolean, onPick?: TerrainPickCallback) => void;
  isPickMode: () => boolean;
  /** Replace dynamic location markers (catalog / search / chosen / compare). */
  setMarkers: (markers: TerrainMarkerSpec[]) => void;
  setCatalogMarkersVisible: (visible: boolean) => void;
  setSearchMarkersVisible: (visible: boolean) => void;
  onMarkerClick: (cb: TerrainMarkerClickCallback | undefined) => void;
};
type Grid = {x: number; y: number; width: number; spacing: number; values: Float32Array};

// World axes at the pole: +X points along 90°E, -Z along 0°E, +Y radially up.
function world(x: number, y: number, h: number) {
  const k = (x*x + y*y) / (4 * radius * radius);
  const horizontal = (1 + h / radius) / (1 + k);
  return new T.Vector3(x * horizontal, (h - k * (2*radius + h)) / (1 + k), -y * horizontal);
}

function projection(point: T.Vector3) {
  const radial = point.clone().sub(moonCenter).normalize();
  const scale = 2*radius / (1+radial.y);
  return [radial.x*scale, -radial.z*scale] as const;
}

function heightAt(grid: Grid, x: number, y: number) {
  const u = (x-grid.x)/grid.spacing, v = (grid.y-y)/grid.spacing;
  const i = Math.floor(u), j = Math.floor(v);
  if (i < 0 || j < 0 || i >= grid.width-1 || j >= grid.width-1) return NaN;
  const a = grid.values[j*grid.width+i], b = grid.values[j*grid.width+i+1];
  const c = grid.values[(j+1)*grid.width+i], d = grid.values[(j+1)*grid.width+i+1];
  const du = u-i, dv = v-j;
  return du+dv <= 1 ? a+(b-a)*du+(c-a)*dv : d+(c-d)*(1-du)+(b-d)*(1-dv);
}

/** Hard clip: polar 320 m LOLA owns ≤87°S; global LDEM starts north of that. */
const GLOBAL_HOLE_LAT_DEG = -87;
/** Fade global heights to the reference sphere approaching the polar join. */
const GLOBAL_FADE_LAT_DEG = -86;

type GlobalLdem = {
  width: number;
  height: number;
  ppd: number;
  lonWestDeg: number;
  latNorthDeg: number;
  metersPerUnit: number;
  values: Int16Array;
};

function parseGlobalLdem(buffer: ArrayBuffer): GlobalLdem {
  const header = new DataView(buffer);
  const magic = String.fromCharCode(
    header.getUint8(0), header.getUint8(1), header.getUint8(2), header.getUint8(3),
  );
  if (magic !== 'LDEM') throw new Error('Unexpected global LDEM magic');
  const version = header.getUint32(4, true);
  if (version !== 1) throw new Error(`Unsupported global LDEM version ${version}`);
  const width = header.getUint32(8, true);
  const height = header.getUint32(12, true);
  const ppd = header.getUint32(16, true);
  const lonWestDeg = header.getFloat32(20, true);
  const latNorthDeg = header.getFloat32(24, true);
  const metersPerUnit = header.getFloat32(28, true);
  const values = new Int16Array(buffer, 32, width * height);
  return { width, height, ppd, lonWestDeg, latNorthDeg, metersPerUnit, values };
}

/** Equatorial cell size of the 4 ppd global LDEM (~7.58 km). */
const GLOBAL_NATIVE_M = (2 * Math.PI * radius) / 1440;
/** Aim for this many screen pixels between wireframe edges (readable, never solid fill). */
const MESH_PIXELS_PER_EDGE = 14;
/** Faint elevation colormap under mesh wireframe (polar solid underlay). */
const MESH_UNDERLAY_OPACITY = 0.28;
/** Quantize camera direction so lazy remesh is stable under tiny orbit jitter. */
const VIEW_DIR_QUANT = 12;

/** Power-of-two stride so LOD rebuilds are stable under small zoom jitter. */
function snapStride(ideal: number, maxStride: number): number {
  const clamped = Math.min(maxStride, Math.max(1, ideal));
  const snapped = 2 ** Math.round(Math.log2(clamped));
  return Math.min(maxStride, Math.max(1, snapped));
}

/** Camera-facing + view-frustum cull for lazy wireframe tessellation. */
type VisibilityCull = {
  toCam: T.Vector3;
  /** Keep samples with radial·toCam ≥ minDot (near-side / limb band). */
  minDot: number;
  frustum: T.Frustum;
};

const _cullPoint = new T.Vector3();
const _cullRadial = new T.Vector3();
const _projScreen = new T.Matrix4();
const _viewFrustum = new T.Frustum();

function visibilityCullFromCamera(camera: T.PerspectiveCamera): VisibilityCull {
  const toCam = camera.position.clone().sub(moonCenter).normalize();
  const dist = Math.max(camera.position.distanceTo(moonCenter), radius + 1);
  // Geometric lunar limb from moon center; pad so a thin limb band still builds.
  const limbDot = radius / dist;
  const minDot = Math.max(0.02, limbDot - 0.08);
  _projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  _viewFrustum.setFromProjectionMatrix(_projScreen);
  return { toCam, minDot, frustum: _viewFrustum };
}

function isVisibleWorldPoint(x: number, y: number, z: number, cull: VisibilityCull): boolean {
  _cullPoint.set(x, y, z);
  _cullRadial.copy(_cullPoint).sub(moonCenter).normalize();
  if (_cullRadial.dot(cull.toCam) < cull.minDot) return false;
  // Slightly inflate: frustum test on a short radial segment covers elevated DEM.
  if (cull.frustum.containsPoint(_cullPoint)) return true;
  _cullPoint.copy(_cullRadial).multiplyScalar(radius * 1.002).add(moonCenter);
  return cull.frustum.containsPoint(_cullPoint);
}

function viewCullKey(cull: VisibilityCull, polarStride: number, globalStep: number): string {
  const q = VIEW_DIR_QUANT;
  return [
    Math.round(cull.toCam.x * q),
    Math.round(cull.toCam.y * q),
    Math.round(cull.toCam.z * q),
    Math.round(cull.minDot * 40),
    polarStride,
    globalStep,
  ].join(':');
}

/**
 * Displaced cylindrical LDEM wireframe with a south-polar hole so it never
 * intersects the 87°S–90°S LOLA overview (or its fade-to-sphere rim).
 * `step` subsamples the DEM grid (1 = native 4 ppd) for zoom-adaptive density.
 * When `cull` is set, only the camera-facing / in-frustum patch is tessellated.
 */
function meshFromGlobalLdem(
  dem: GlobalLdem,
  material: T.Material,
  step = 1,
  cull?: VisibilityCull,
) {
  const { width, height, ppd, lonWestDeg, latNorthDeg, metersPerUnit, values } = dem;
  const stride = Math.max(1, step | 0);
  const jSamples: number[] = [];
  for (let j = 0; j < height; j += stride) jSamples.push(j);
  const iSamples: number[] = [];
  for (let i = 0; i < width; i += stride) iSamples.push(i);
  const jCount = jSamples.length;
  const iCount = iSamples.length;
  const positions = new Float32Array(jCount * iCount * 3);
  const lookup = new Int32Array(jCount * iCount).fill(-1);
  let vertexCount = 0;
  const radial = new T.Vector3();
  for (let jj = 0; jj < jCount; jj++) {
    const j = jSamples[jj];
    const latDeg = latNorthDeg - (j + 0.5) / ppd;
    if (latDeg < GLOBAL_HOLE_LAT_DEG) continue;
    const lat = T.MathUtils.degToRad(latDeg);
    const cosLat = Math.cos(lat);
    const sinLat = Math.sin(lat);
    const fade = latDeg <= GLOBAL_FADE_LAT_DEG
      ? T.MathUtils.smoothstep(latDeg, GLOBAL_HOLE_LAT_DEG, GLOBAL_FADE_LAT_DEG)
      : 1;
    for (let ii = 0; ii < iCount; ii++) {
      const i = iSamples[ii];
      const lonDeg = lonWestDeg + (i + 0.5) / ppd;
      const lon = T.MathUtils.degToRad(lonDeg);
      const h = values[j * width + i] * metersPerUnit * fade;
      // World frame matches globe picks: +Y through south pole, +X = 90°E, −Z = 0°E.
      radial.set(
        cosLat * Math.sin(lon),
        -sinLat,
        -cosLat * Math.cos(lon),
      ).normalize();
      const wx = moonCenter.x + radial.x * (radius + h);
      const wy = moonCenter.y + radial.y * (radius + h);
      const wz = moonCenter.z + radial.z * (radius + h);
      if (cull && !isVisibleWorldPoint(wx, wy, wz, cull)) continue;
      const idx = vertexCount++;
      lookup[jj * iCount + ii] = idx;
      positions[idx * 3] = wx;
      positions[idx * 3 + 1] = wy;
      positions[idx * 3 + 2] = wz;
    }
  }
  const triangles: number[] = [];
  for (let jj = 0; jj < jCount - 1; jj++) {
    for (let ii = 0; ii < iCount; ii++) {
      const ii1 = (ii + 1) % iCount;
      const a = lookup[jj * iCount + ii];
      const b = lookup[jj * iCount + ii1];
      const c = lookup[(jj + 1) * iCount + ii];
      const d = lookup[(jj + 1) * iCount + ii1];
      if (a < 0 || b < 0 || c < 0 || d < 0) continue;
      triangles.push(a, c, b, b, c, d);
    }
  }
  const geometry = new T.BufferGeometry();
  geometry.setAttribute('position', new T.BufferAttribute(positions.subarray(0, vertexCount * 3), 3));
  geometry.setIndex(triangles);
  const mesh = new T.Mesh(geometry, material);
  mesh.frustumCulled = false;
  return mesh;
}

/**
 * Polar DEM mesh. `sampleStride` > 1 keeps full geographic extent (includes last
 * row/col) while thinning triangles for wireframe LOD — elevations stay real.
 * Optional `cull` drops occluded / out-of-view samples (lazy mesh mode).
 */
function meshFor(
  grid: Grid,
  material: T.Material,
  parent?: Grid,
  sampleStride = 1,
  cull?: VisibilityCull,
) {
  const step = Math.max(1, sampleStride | 0);
  const last = grid.width - 1;
  const sample: number[] = [];
  for (let i = 0; ; i++) {
    const t = Math.min(i * step, last);
    sample.push(t);
    if (t >= last) break;
  }
  const width = sample.length;
  const positions = new Float32Array(width * width * 3);
  const colors = new Float32Array(positions.length);
  const projected = new Float32Array(width * width * 2);
  const uv = new Float32Array(width * width * 2);
  const valid = new Uint8Array(width * width);
  const low = new T.Color('#234d70'), mid = new T.Color('#6aa4a2'), high = new T.Color('#e7d29c');
  const color = new T.Color();
  const margin = Math.min(24, Math.max(2, Math.floor(width / 8)));
  for (let j = 0; j < width; j++) for (let i = 0; i < width; i++) {
    const gi = sample[i], gj = sample[j];
    const idx = j * width + i;
    const x = grid.x + gi * grid.spacing, y = grid.y - gj * grid.spacing;
    projected[idx * 2] = x;
    projected[idx * 2 + 1] = y;
    uv[idx * 2] = x / radius;
    uv[idx * 2 + 1] = y / radius;
    const h = grid.values[gj * grid.width + gi];
    let renderHeight = h;
    // Fade the outer margin into the overview to keep the join continuous.
    if (parent) {
      const coarse = heightAt(parent, x, y);
      const weight = T.MathUtils.smoothstep(Math.min(i, j, width - 1 - i, width - 1 - j), 0, margin);
      if (Number.isFinite(coarse)) renderHeight = T.MathUtils.lerp(coarse, h, weight);
    }
    const distanceToEdge = capRadius - Math.hypot(x, y);
    if (distanceToEdge < 0 || !Number.isFinite(renderHeight)) continue;
    // Bring the outer two kilometers back to the reference sphere at the globe join.
    renderHeight *= T.MathUtils.smoothstep(distanceToEdge, 650, 2650);
    const point = world(x, y, renderHeight);
    if (cull && !isVisibleWorldPoint(point.x, point.y, point.z, cull)) continue;
    valid[idx] = 1;
    point.toArray(positions, idx * 3);
    const fraction = T.MathUtils.clamp((h + 8000) / 15000, 0, 1);
    color.copy(fraction < .5 ? low : mid).lerp(fraction < .5 ? mid : high, fraction < .5 ? fraction * 2 : fraction * 2 - 1);
    color.toArray(colors, idx * 3);
  }
  const triangles: number[] = [];
  for (let j = 0; j < width - 1; j++) for (let i = 0; i < width - 1; i++) {
    const a = j * width + i, b = a + 1, c = a + width, d = c + 1;
    if (valid[a] && valid[c] && valid[b]) triangles.push(a, c, b);
    if (valid[b] && valid[c] && valid[d]) triangles.push(b, c, d);
  }
  const geometry = new T.BufferGeometry();
  geometry.setAttribute('position', new T.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new T.BufferAttribute(colors, 3));
  geometry.setAttribute('projectedXY', new T.BufferAttribute(projected, 2));
  geometry.setAttribute('uv', new T.BufferAttribute(uv, 2));
  geometry.setIndex(triangles);
  geometry.computeVertexNormals();
  const normals = geometry.getAttribute('normal');
  const normal = new T.Vector3();
  const radial = new T.Vector3();
  for (let i = 0; i < width * width; i++) {
    if (!valid[i]) continue;
    const edge = capRadius - Math.hypot(projected[i * 2], projected[i * 2 + 1]);
    if (edge >= 2650) continue;
    radial.fromArray(positions, i * 3).sub(moonCenter).normalize();
    normal.fromBufferAttribute(normals, i).lerp(radial, 1 - T.MathUtils.smoothstep(edge, 650, 2650)).normalize();
    normals.setXYZ(i, normal.x, normal.y, normal.z);
  }
  return new T.Mesh(geometry, material);
}

async function fetchAsset(path: string) {
  const response = await fetch(base + path);
  if (!response.ok) throw new Error(`Terrain request failed (${response.status})`);
  return response;
}

export async function startTerrain(): Promise<TerrainApi> {
  const renderer = new T.WebGLRenderer({antialias:true, logarithmicDepthBuffer:true});
  const viewport = element('viewport');
  viewport.append(renderer.domElement);
  renderer.setPixelRatio(Math.min(devicePixelRatio,2));
  renderer.setClearColor(0x0b1420);
  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(48,1,0.2,20000000);
  renderer.domElement.tabIndex = 0;
  renderer.domElement.setAttribute('aria-label','Lunar terrain. Click or tap to focus. Arrow keys pan the map.');
  const light = new T.DirectionalLight(0xffffff,2.25);
  light.position.set(-1,.45,-.68);
  scene.add(light,new T.AmbientLight(0xffffff,1.35));
  const globeMap = new T.TextureLoader().load(base+'terrain/lroc-color-2k.jpg');
  globeMap.colorSpace = T.SRGBColorSpace;
  globeMap.wrapS = T.RepeatWrapping;
  const seam = 2*Math.atan((capRadius-650)/(2*radius));
  const globeShape = new T.SphereGeometry(radius,512,256,0,Math.PI*2,0,Math.PI-seam);
  const globeUV = globeShape.getAttribute('uv');
  for (let i=0; i<globeUV.count; i++) {
    // The texture is centered on 0°E and longitude increases eastward.
    globeUV.setY(i,1-(1-globeUV.getY(i))*(1-seam/Math.PI));
  }
  globeShape.rotateX(Math.PI);
  globeShape.rotateY(Math.PI/2);
  const lunarSurface = new T.MeshStandardMaterial({map:globeMap,roughness:1});
  const globe = new T.Mesh(globeShape,lunarSurface);
  globe.position.copy(moonCenter);
  scene.add(globe);

  const overviewBody = await fetchAsset('terrain/polar-overview.bin').then(r => r.arrayBuffer());
  const header = new DataView(overviewBody);
  const overview: Grid = {
    x:header.getInt32(0,true), y:header.getInt32(4,true),
    width:header.getUint32(8,true), spacing:320, values:new Float32Array(overviewBody,12),
  };
  const globalLdemBody = await fetchAsset('terrain/global-ldem-4ppd.bin').then(r => r.arrayBuffer());
  const globalLdem = parseGlobalLdem(globalLdemBody);
  const polarSurface = lunarSurface.clone();
  function applyPolarImagery(shader: Parameters<typeof polarSurface.onBeforeCompile>[0]) {
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
      vec2 p = vMapUv;
      float longitude = atan(p.x, p.y);
      vec2 uv = vec2(0.5 + longitude / 6.283185307, 2.0 * atan(length(p) * 0.5) / 3.141592654);
      vec2 alternate = vec2(fract(uv.x + 0.5), uv.y);
      vec2 dx = uv.x < 0.25 || uv.x > 0.75 ? dFdx(alternate) : dFdx(uv);
      vec2 dy = uv.x < 0.25 || uv.x > 0.75 ? dFdy(alternate) : dFdy(uv);
      diffuseColor *= textureGrad(map, uv, dx, dy);
    `);
  }
  polarSurface.onBeforeCompile = applyPolarImagery;
  polarSurface.customProgramCacheKey = () => 'polar-imagery';
  const materials = {
    relief: polarSurface,
    elevation: new T.MeshBasicMaterial({vertexColors:true}),
    // Wireframe lines only (no filled faces). Geometry is lazy-built for the
    // visible patch; depthWrite lets near lines occlude without opaque fill.
    mesh: new T.MeshBasicMaterial({
      color: 0x89b6ba,
      wireframe: true,
      side: T.FrontSide,
      depthTest: true,
      depthWrite: true,
      transparent: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    }),
  };
  const globalWireMaterial = new T.MeshBasicMaterial({
    color: 0x89b6ba,
    wireframe: true,
    side: T.FrontSide,
    depthTest: true,
    depthWrite: true,
    transparent: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  // Start coarse; zoom LOD rebuilds to native 4 ppd when close enough.
  let globalWireStep = 16;
  let meshViewKey = '';
  let globalWire = meshFromGlobalLdem(globalLdem, globalWireMaterial, globalWireStep);
  globalWire.visible = false;
  globalWire.renderOrder = 2;
  // Picks stay on the textured globe / polar DEM — wireframe is display-only.
  globalWire.raycast = () => {};
  scene.add(globalWire);
  const cutout = {value:new T.Vector4()};
  const cap = {value:capRadius};
  const overviewMaterials = Object.fromEntries(Object.entries(materials).map(([key, material]) => {
    const copy = material.clone();
    copy.customProgramCacheKey = () => `polar-overview-${key}`;
    copy.onBeforeCompile = shader => {
      if (key === 'relief') applyPolarImagery(shader);
      shader.uniforms.detailBounds = cutout;
      shader.uniforms.capRadius = cap;
      shader.vertexShader = 'attribute vec2 projectedXY; varying vec2 polarXY;\n' + shader.vertexShader.replace('#include <begin_vertex>', `
        #include <begin_vertex>
        polarXY = projectedXY;
      `);
      shader.fragmentShader = 'uniform vec4 detailBounds; uniform float capRadius; varying vec2 polarXY;\n' +
        shader.fragmentShader.replace('#include <clipping_planes_fragment>', `
          #include <clipping_planes_fragment>
          if (length(polarXY) > capRadius) discard;
          if (polarXY.x > detailBounds.x && polarXY.x < detailBounds.z &&
              polarXY.y > detailBounds.y && polarXY.y < detailBounds.w) discard;
        `);
    };
    return [key,copy];
  })) as typeof materials;
  // Faint elevation colormap under mesh wires (solid faces, low opacity).
  const meshUnderlayMaterial = overviewMaterials.elevation.clone();
  meshUnderlayMaterial.transparent = true;
  meshUnderlayMaterial.opacity = MESH_UNDERLAY_OPACITY;
  meshUnderlayMaterial.depthWrite = true;
  meshUnderlayMaterial.customProgramCacheKey = () => 'polar-overview-mesh-underlay';
  meshUnderlayMaterial.onBeforeCompile = shader => {
    shader.uniforms.detailBounds = cutout;
    shader.uniforms.capRadius = cap;
    shader.vertexShader = 'attribute vec2 projectedXY; varying vec2 polarXY;\n' + shader.vertexShader.replace('#include <begin_vertex>', `
      #include <begin_vertex>
      polarXY = projectedXY;
    `);
    shader.fragmentShader = 'uniform vec4 detailBounds; uniform float capRadius; varying vec2 polarXY;\n' +
      shader.fragmentShader.replace('#include <clipping_planes_fragment>', `
        #include <clipping_planes_fragment>
        if (length(polarXY) > capRadius) discard;
        if (polarXY.x > detailBounds.x && polarXY.x < detailBounds.z &&
            polarXY.y > detailBounds.y && polarXY.y < detailBounds.w) discard;
      `);
  };
  const polarWireMaterial = materials.mesh.clone();
  polarWireMaterial.customProgramCacheKey = () => 'polar-wire-lazy';
  let polarWireStride = 1;
  let backdrop = meshFor(overview, overviewMaterials.relief);
  scene.add(backdrop);
  let polarWire: T.Mesh | undefined;
  let detail: T.Mesh<T.BufferGeometry, T.Material> | undefined;
  let currentGrid: Grid | undefined;
  let currentKey = '';
  let pendingKey = '';
  let lastFailure = '';
  let retryAt = 0;
  let request: AbortController | undefined;
  let nextUpdate = 0;
  function createControls() {
    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.enableDamping = true;
    orbit.maxPolarAngle = Math.PI;
    orbit.minDistance = 25;
    orbit.maxDistance = 12000000;
    orbit.mouseButtons.MIDDLE = T.MOUSE.PAN;
    orbit.screenSpacePanning = true;
    orbit.listenToKeyEvents(renderer.domElement);
    orbit.addEventListener('change',()=> {nextUpdate = performance.now()+180;});
    return orbit;
  }
  let controls = createControls();

  /** Distance used for screen-space edge sizing (surface altitude, not center radius). */
  function surfaceViewDistance(): number {
    const toTarget = camera.position.distanceTo(controls.target);
    const toCenter = camera.position.distanceTo(moonCenter);
    return Math.max(25, Math.min(toTarget, Math.max(toCenter - radius, 25)));
  }

  /** World-space wire edge that subtends ~MESH_PIXELS_PER_EDGE on screen. */
  function targetWireEdgeMeters(): number {
    const dist = surfaceViewDistance();
    const metersPerPixel = 2 * dist * Math.tan(T.MathUtils.degToRad(camera.fov) * 0.5)
      / Math.max(1, viewport.clientHeight);
    return metersPerPixel * MESH_PIXELS_PER_EDGE;
  }

  function formatLodMeters(meters: number): string {
    if (meters >= 1000) return `${Math.round(meters / 1000)} KM`;
    return `${Math.round(meters)} M`;
  }

  function removePolarWire() {
    if (!polarWire) return;
    scene.remove(polarWire);
    polarWire.geometry.dispose();
    polarWire = undefined;
  }

  function rebuildGlobalWire(step: number, cull: VisibilityCull, force = false) {
    if (!force && step === globalWireStep && globalWire.parent) return;
    scene.remove(globalWire);
    globalWire.geometry.dispose();
    globalWire = meshFromGlobalLdem(globalLdem, globalWireMaterial, step, cull);
    globalWire.visible = layer.value === 'mesh';
    globalWire.renderOrder = 2;
    globalWire.raycast = () => {};
    scene.add(globalWire);
    globalWireStep = step;
  }

  function rebuildPolarWire(stride: number, cull: VisibilityCull) {
    const keepCutout = cutout.value.clone();
    removePolarWire();
    polarWire = meshFor(overview, polarWireMaterial, undefined, stride, cull);
    polarWire.visible = layer.value === 'mesh';
    polarWire.renderOrder = 2;
    polarWire.raycast = () => {};
    scene.add(polarWire);
    cutout.value.copy(keepCutout);
    polarWireStride = stride;
  }

  function rebuildPolarBackdrop(stride: number, materialKey: keyof typeof materials) {
    const keepCutout = cutout.value.clone();
    scene.remove(backdrop);
    backdrop.geometry.dispose();
    backdrop = meshFor(overview, overviewMaterials[materialKey], undefined, stride);
    scene.add(backdrop);
    cutout.value.copy(keepCutout);
  }

  /** Solid elevation underlay under mesh wires (full polar extent, no view cull). */
  function ensureMeshUnderlay() {
    const keepCutout = cutout.value.clone();
    scene.remove(backdrop);
    backdrop.geometry.dispose();
    backdrop = meshFor(overview, meshUnderlayMaterial, undefined, 1);
    backdrop.renderOrder = 0;
    scene.add(backdrop);
    cutout.value.copy(keepCutout);
  }

  /**
   * Zoom-adaptive + lazy visibility triangulation for mesh mode:
   * only the camera-facing / in-frustum patch is built (throttled via rAF budget).
   */
  function updateMeshLod(force = false) {
    if (layer.value !== 'mesh') return;
    camera.updateMatrixWorld(true);
    const cull = visibilityCullFromCamera(camera);
    const edge = targetWireEdgeMeters();
    // Polar 320 m LOLA: stride so spacing*stride ≈ target edge (max 128 ≈ 40 km).
    const polarStride = snapStride(edge / overview.spacing, 128);
    // Global 4 ppd (~7.6 km): same pixel budget (max 32 ≈ 240 km / ~20°).
    const globalStep = snapStride(edge / GLOBAL_NATIVE_M, 32);
    const key = viewCullKey(cull, polarStride, globalStep);
    if (!force && key === meshViewKey) return;
    meshViewKey = key;
    rebuildPolarWire(polarStride, cull);
    rebuildGlobalWire(globalStep, cull, true);
    // Keep detail-window badge while a local tile is loaded.
    if (!currentKey) setOverviewModeLabel();
  }

  /**
   * Mesh/wireframe: overview + global remesh by zoom; detail windows only when
   * close, stride from screen-edge budget (never finer than 20 m / stride 4).
   * Relief/elevation keep fine 5–20 m windows.
   */
  function detailPolicy(distance: number): { maxDistance: number; stride: number } {
    if (layer.value === 'mesh') {
      const edge = targetWireEdgeMeters();
      const stride = Math.max(4, snapStride(edge / 5, 32));
      return { maxDistance: 5500, stride };
    }
    if (distance < 1000) return { maxDistance: 6300, stride: 1 };
    if (distance < 2300) return { maxDistance: 6300, stride: 2 };
    return { maxDistance: 6300, stride: 4 };
  }

  function setOverviewModeLabel() {
    if (layer.value === 'mesh') {
      const polarM = overview.spacing * polarWireStride;
      const globalM = GLOBAL_NATIVE_M * globalWireStep;
      element('mode-label').textContent =
        `POLAR ~${formatLodMeters(polarM)} LOLA · GLOBAL ~${formatLodMeters(globalM)} LDEM`;
      return;
    }
    element('mode-label').textContent = '87°S–90°S · 320 M OVERVIEW';
  }

  function setLayer() {
    const key = layer.value as keyof typeof materials;
    // Elevation legend also hints the faint mesh underlay colormap.
    element('legend').hidden = key !== 'elevation' && key !== 'mesh';
    const meshOn = key === 'mesh';
    globalWire.visible = meshOn;
    if (polarWire) polarWire.visible = meshOn;
    // Dim the textured globe under outside-cap wires so relief context stays faint.
    // Keep depthWrite on so the near globe occludes anything still behind the limb.
    lunarSurface.transparent = meshOn;
    lunarSurface.opacity = meshOn ? 0.34 : 1;
    lunarSurface.depthWrite = true;
    lunarSurface.needsUpdate = true;
    // Mesh vs relief use different stride caps — drop the current window so LOD reloads uniformly.
    request?.abort();
    removeDetail();
    if (meshOn) {
      ensureMeshUnderlay();
      meshViewKey = '';
      polarWireStride = -1;
      globalWireStep = -1;
      updateMeshLod(true);
    } else {
      removePolarWire();
      meshViewKey = '';
      rebuildPolarBackdrop(1, key);
      if (detail) detail.material = materials[key];
      setOverviewModeLabel();
    }
    nextUpdate = performance.now();
  }
  layer.onchange = setLayer;
  setLayer();

  function removeDetail() {
    if (detail) {
      scene.remove(detail);
      detail.geometry.dispose();
      detail = undefined;
    }
    currentKey = '';
    currentGrid = undefined;
    cutout.value.set(0,0,0,0);
  }
  function showDetail(grid: Grid, key: string) {
    removeDetail();
    const meshOn = layer.value === 'mesh';
    detail = meshFor(grid, meshOn ? materials.mesh : materials.relief, overview);
    currentGrid = grid;
    currentKey = key;
    const span = (size-1)*grid.spacing;
    // Cut overview under a fully valid window so detail + base don't z-fight
    // (double shells / intersecting tops). Mesh keeps the faint underlay continuous.
    if (!meshOn &&
        grid.values.every(Number.isFinite) &&
        [grid.x,grid.x+span].every(x=>Math.hypot(x,grid.y) < capRadius && Math.hypot(x,grid.y-span) < capRadius)) {
      cutout.value.set(grid.x+3,grid.y-span+3,grid.x+span-3,grid.y-3);
    }
    scene.add(detail);
    // Apply materials without invalidating the window we just loaded.
    const matKey = layer.value as keyof typeof materials;
    if (meshOn) {
      backdrop.material = meshUnderlayMaterial;
      detail.material = materials.mesh;
      detail.renderOrder = 2;
      detail.raycast = () => {};
    } else {
      backdrop.material = overviewMaterials[matKey];
      detail.material = materials[matKey];
    }
    element('legend').hidden = matKey !== 'elevation' && matKey !== 'mesh';
    if (!flight && focusedPoint && controls.target.distanceTo(focusedPoint.target)<1) {
      const {x,y} = focusedPoint;
      const h = groundHeight(x,y);
      if (Number.isFinite(h)) {
        const target = world(x,y,h);
        camera.position.add(target.clone().sub(controls.target));
        controls.target.copy(target);
        focusedPoint.target.copy(target);
        controls.update();
      }
    }
  }

  function updateDetail() {
    const distance = camera.position.distanceTo(controls.target);
    const [x,y] = projection(controls.target);
    const { maxDistance, stride } = detailPolicy(distance);
    if (distance > maxDistance || Math.hypot(x,y) > capRadius) {
      request?.abort();
      removeDetail();
      setOverviewModeLabel();
      status.textContent = '';
      return;
    }
    const span = 256 * stride, step = 64 * stride;
    const column = Math.round(((x+100000)/5-span/2)/step)*step;
    const row = Math.round(((100000-y)/5-span/2)/step)*step;
    const key = `${column}/${row}/${stride}`;
    if (key === currentKey) {
      request?.abort();
      status.textContent = '';
      return;
    }
    if (key === pendingKey || (key === lastFailure && performance.now() < retryAt)) return;
    request?.abort();
    const controller = new AbortController();
    request = controller;
    pendingKey = key;
    status.textContent = `Loading ${5*stride} m terrain…`;
    const params = new URLSearchParams({column:String(column),row:String(row),stride:String(stride)});
    const cachedSite = stride === 1 && (key === '17664/22272/1' || key === '19328/21120/1');
    const path = cachedSite ? `terrain/focus/${column}-${row}.bin` : `terrain/window?${params}`;
    void fetch(base+path,{signal:controller.signal})
      .then(async response => {
        if (!response.ok) throw new Error(String(response.status));
        const data = await response.arrayBuffer();
        if (data.byteLength !== size*size*4) throw new Error('Unexpected terrain window');
        if (controller.signal.aborted) return;
        showDetail({x:-100000+(column+.5)*5,y:100000-(row+.5)*5,width:size,
          spacing:5*stride,values:new Float32Array(data)},key);
        element('mode-label').textContent = `${5*stride} M TERRAIN NEAR VIEW CENTER`;
        status.textContent = '';
      }).catch(() => {
        if (controller.signal.aborted) return;
        lastFailure = key;
        retryAt = performance.now()+5000;
        status.textContent = 'Detailed terrain is temporarily unavailable. Retrying…';
      }).finally(() => {if (request === controller) pendingKey = '';});
  }
  type LiveMarker = {
    spec: TerrainMarkerSpec;
    x: number;
    y: number;
    mesh: T.Mesh;
  };
  const markerRoot = new T.Group();
  scene.add(markerRoot);
  let liveMarkers: LiveMarker[] = [];
  let catalogVisible = true;
  let searchVisible = true;
  let markerClickCb: TerrainMarkerClickCallback | undefined;

  function markerColor(category: MarkerCategory): number {
    switch (category) {
      case 'catalog': return 0x5ec8c0; // teal circle — pre-chosen
      case 'search': return 0xe6b84d;  // amber diamond — search hit
      case 'chosen': return 0xff6b4a;  // coral square — adopted Site A
      case 'compare': return 0xb07dff; // violet ring — Site B
    }
  }

  function markerGeometry(category: MarkerCategory): T.BufferGeometry {
    switch (category) {
      case 'catalog': return new T.SphereGeometry(1, 10, 8);
      case 'search': return new T.OctahedronGeometry(1.15, 0);
      case 'chosen': return new T.BoxGeometry(1.6, 1.6, 1.6);
      case 'compare': return new T.TorusGeometry(0.95, 0.28, 8, 16);
    }
  }

  function markerRenderOrder(category: MarkerCategory): number {
    switch (category) {
      case 'catalog': return 3;
      case 'search': return 4;
      case 'compare': return 5;
      case 'chosen': return 6;
    }
  }

  function clearLiveMarkers() {
    for (const m of liveMarkers) {
      markerRoot.remove(m.mesh);
      m.mesh.geometry.dispose();
      (m.mesh.material as T.Material).dispose();
    }
    liveMarkers = [];
  }

  function setMarkers(markers: TerrainMarkerSpec[]) {
    clearLiveMarkers();
    for (const spec of markers) {
      const rho = 2 * radius * Math.tan(T.MathUtils.degToRad((spec.latitudeDeg + 90) / 2));
      const lon = T.MathUtils.degToRad(spec.longitudeEastDeg);
      const x = rho * Math.sin(lon);
      const y = rho * Math.cos(lon);
      const mesh = new T.Mesh(
        markerGeometry(spec.category),
        new T.MeshBasicMaterial({
          color: markerColor(spec.category),
          depthTest: false,
          transparent: true,
          opacity: 0.95,
        }),
      );
      mesh.renderOrder = markerRenderOrder(spec.category);
      mesh.userData.markerId = spec.id;
      mesh.visible =
        (spec.category !== 'catalog' || catalogVisible) &&
        (spec.category !== 'search' || searchVisible);
      markerRoot.add(mesh);
      liveMarkers.push({ spec, x, y, mesh });
    }
  }

  const resize = () => {
    const {clientWidth:w,clientHeight:h} = viewport;
    renderer.setSize(w,h,false);
    camera.aspect = w/Math.max(h,1);
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(viewport);
  resize();

  function pointAt(target: T.Vector3, offset: T.Vector3, up: T.Vector3) {
    // OrbitControls captures the camera's up vector when constructed.
    controls.dispose();
    camera.up.copy(up);
    camera.position.copy(target).add(offset);
    controls = createControls();
    controls.target.copy(target);
    controls.update();
    nextUpdate = performance.now()+180;
  }
  type Flight = {
    start: number; fromHeight: number; toHeight: number; direction: T.Vector3;
    rotation: T.Quaternion; fromLook: T.Quaternion; toLook: T.Quaternion;
    target: T.Vector3; offset: T.Vector3; up: T.Vector3;
  };
  let flight: Flight | undefined;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  function flyTo(target: T.Vector3, offset: T.Vector3, up: T.Vector3) {
    if (reducedMotion.matches) {
      flight = undefined;
      pointAt(target,offset,up);
      return;
    }
    const from = camera.position.clone().sub(moonCenter);
    const to = target.clone().add(offset).sub(moonCenter);
    const fromHeight = Math.max(1,from.length()-radius+15000);
    const toHeight = Math.max(1,to.length()-radius+15000);
    const direction = from.normalize();
    const rotation = new T.Quaternion().setFromUnitVectors(direction,to.normalize());
    const look = new T.Matrix4().lookAt(target.clone().add(offset),target,up);
    flight = {
      start:performance.now(), fromHeight,toHeight,direction,rotation,
      fromLook:camera.quaternion.clone(),toLook:new T.Quaternion().setFromRotationMatrix(look),target,offset,up,
    };
    controls.enabled = false;
  }
  function groundHeight(x: number,y: number) {
    if (currentGrid) {
      const h = heightAt(currentGrid,x,y);
      if (Number.isFinite(h)) {
        const u = (x-currentGrid.x)/currentGrid.spacing;
        const v = (currentGrid.y-y)/currentGrid.spacing;
        const edge = Math.min(u,v,currentGrid.width-1-u,currentGrid.width-1-v);
        const coarse = heightAt(overview,x,y);
        const height = Number.isFinite(coarse) ? T.MathUtils.lerp(coarse,h,T.MathUtils.smoothstep(edge,0,24)) : h;
        return height*T.MathUtils.smoothstep(capRadius-Math.hypot(x,y),650,2650);
      }
    }
    return heightAt(overview,x,y)*T.MathUtils.smoothstep(capRadius-Math.hypot(x,y),650,2650);
  }
  let focusedPoint: {x:number; y:number; target:T.Vector3} | undefined;
  function focusTerrain(x: number,y: number) {
    const h = groundHeight(x,y);
    if (!Number.isFinite(h)) return;
    const target = world(x,y,h);
    const radial = target.clone().sub(moonCenter).normalize();
    const screenUp = new T.Vector3(0,0,-1).projectOnPlane(radial).normalize();
    focusedPoint = {x,y,target};
    flyTo(target,radial.multiplyScalar(800),screenUp);
    const latitude = T.MathUtils.radToDeg(2*Math.atan(Math.hypot(x,y)/(2*radius)))-90;
    const longitude = T.MathUtils.euclideanModulo(T.MathUtils.radToDeg(Math.atan2(x,y)),360);
    const row = document.createElement('div'), term = document.createElement('dt'), value = document.createElement('dd');
    term.textContent = 'Focused coordinates';
    value.textContent = `${Math.abs(latitude).toFixed(4)}° S, ${longitude.toFixed(4)}° E`;
    row.append(term,value);
    element('details').replaceChildren(row);
  }
  function showPolarCap() {
    focusedPoint = undefined;
    element('details').replaceChildren();
    const ratio = Math.max(1, 1/camera.aspect);
    flyTo(new T.Vector3(),new T.Vector3(25000,200000,140000).multiplyScalar(ratio),new T.Vector3(0,1,0));
  }
  reset.onclick = () => showPolarCap();
  function showGlobe(animate: boolean) {
    focusedPoint = undefined;
    element('details').replaceChildren();
    const ratio = Math.max(1,1/camera.aspect);
    const offset = new T.Vector3(1700000,2200000,-4800000).multiplyScalar(ratio);
    const up = new T.Vector3(0,-1,0);
    if (animate) flyTo(moonCenter.clone(),offset,up);
    else pointAt(moonCenter.clone(),offset,up);
  }
  const globeButton = element<HTMLButtonElement>('globe');
  globeButton.onclick = () => showGlobe(true);
  function focusLatLon(latitudeDeg: number, longitudeEastDeg: number) {
    const rho = 2*radius*Math.tan(T.MathUtils.degToRad((latitudeDeg+90)/2));
    const lon = T.MathUtils.degToRad(longitudeEastDeg);
    const x = rho*Math.sin(lon);
    const y = rho*Math.cos(lon);
    if (Math.hypot(x, y) > capRadius * 1.05) {
      status.textContent = 'Site is outside the 87°S–90°S detailed cap — showing whole Moon.';
      // Aim camera at the site's selenographic position on the globe (not a fixed CR1 view).
      const lat = T.MathUtils.degToRad(latitudeDeg);
      const east = T.MathUtils.degToRad(longitudeEastDeg);
      // World frame: moonCenter at (0,-R,0); +Y through south pole; lon via X/−Z.
      const local = new T.Vector3(
        Math.cos(lat) * Math.sin(east),
        -Math.sin(lat),
        -Math.cos(lat) * Math.cos(east),
      ).normalize();
      const target = moonCenter.clone().add(local.clone().multiplyScalar(radius));
      const offset = local.clone().multiplyScalar(radius * 1.35).add(new T.Vector3(0, -radius * 0.15, 0));
      flyTo(target, offset, new T.Vector3(0, -1, 0));
      return;
    }
    focusTerrain(x, y);
  }
  // Zoom-to-site-A is owned by app.ts (must not overwrite its handler here).
  const ray = new T.Raycaster();
  let pressed: {id:number; x:number; y:number} | undefined;
  let pickMode = false;
  let pickCallback: TerrainPickCallback | undefined;

  function latLonFromPolarXY(x: number, y: number): { latitudeDeg: number; longitudeEastDeg: number } {
    const rho = Math.hypot(x, y);
    // Inverse of focusLatLon: rho = 2R tan((lat+90)/2°)
    const latitudeDeg = 2 * T.MathUtils.radToDeg(Math.atan(rho / (2 * radius))) - 90;
    // Prefer atan2 so lon is well-defined at the pole; world: +X=90°E, -Z=0°E → lon = atan2(x,y)
    let longitudeEastDeg = T.MathUtils.radToDeg(Math.atan2(x, y));
    if (longitudeEastDeg < 0) longitudeEastDeg += 360;
    return { latitudeDeg, longitudeEastDeg };
  }

  function latLonFromGlobeHit(point: T.Vector3): { latitudeDeg: number; longitudeEastDeg: number } {
    const radial = point.clone().sub(moonCenter).normalize();
    // moonCenter is at (0,-R,0); south pole has radial.y ≈ +1 → latitude −90°.
    const latitudeDeg = T.MathUtils.radToDeg(Math.asin(-radial.y));
    let longitudeEastDeg = T.MathUtils.radToDeg(Math.atan2(radial.x, -radial.z));
    if (longitudeEastDeg < 0) longitudeEastDeg += 360;
    return { latitudeDeg, longitudeEastDeg };
  }

  renderer.domElement.addEventListener('pointerdown', event => {
    pressed = event.isPrimary && event.button === 0 ? {id:event.pointerId,x:event.clientX,y:event.clientY} : undefined;
  });
  renderer.domElement.addEventListener('pointermove', event => {
    if (pressed && Math.hypot(event.clientX-pressed.x,event.clientY-pressed.y)>5) pressed = undefined;
  });
  renderer.domElement.addEventListener('pointercancel',()=> {pressed = undefined;});
  renderer.domElement.addEventListener('pointerup', event => {
    const click = pressed;
    pressed = undefined;
    if (!click || click.id !== event.pointerId || Math.hypot(event.clientX-click.x,event.clientY-click.y)>5) return;
    const rect = renderer.domElement.getBoundingClientRect();
    ray.setFromCamera(new T.Vector2(2*(event.clientX-rect.left)/rect.width-1,1-2*(event.clientY-rect.top)/rect.height),camera);
    const markerHits = ray.intersectObjects(liveMarkers.map(m => m.mesh).filter(m => m.visible), false);
    if (markerHits.length && markerClickCb) {
      const id = markerHits[0].object.userData.markerId as string;
      const live = liveMarkers.find(m => m.spec.id === id);
      if (live) {
        markerClickCb(live.spec);
        focusTerrain(live.x, live.y);
        return;
      }
    }
    const bounds = cutout.value;
    const candidates = detail ? [detail,backdrop,globe] : [backdrop,globe];
    for (const hit of ray.intersectObjects(candidates,false)) {
      if (hit.object === globe) {
        if (pickMode && pickCallback) {
          const ll = latLonFromGlobeHit(hit.point);
          pickCallback(ll.latitudeDeg, ll.longitudeEastDeg);
          break;
        }
        focusedPoint = undefined;
        element('details').replaceChildren();
        const radial = hit.point.clone().sub(moonCenter).normalize();
        flyTo(hit.point,radial.multiplyScalar(410000),new T.Vector3(0,-1,0));
        break;
      }
      const [x,y] = projection(hit.point);
      if (hit.object === backdrop && x>bounds.x && x<bounds.z && y>bounds.y && y<bounds.w) continue;
      if (pickMode && pickCallback) {
        const ll = latLonFromPolarXY(x, y);
        pickCallback(ll.latitudeDeg, ll.longitudeEastDeg);
        focusTerrain(x, y);
        break;
      }
      focusTerrain(x,y);
      break;
    }
  });
  focus.disabled = reset.disabled = layer.disabled = globeButton.disabled = false;
  showGlobe(false);
  renderer.setAnimationLoop(now => {
    if (flight) {
      const t = T.MathUtils.clamp((now-flight.start)/1400,0,1);
      const pan = T.MathUtils.smoothstep(t,0,.52);
      const zoom = T.MathUtils.smoothstep(t,.52,1);
      const rotation = new T.Quaternion().slerp(flight.rotation,pan);
      const altitude = Math.exp(T.MathUtils.lerp(Math.log(flight.fromHeight),Math.log(flight.toHeight),zoom))-15000;
      camera.position.copy(flight.direction).applyQuaternion(rotation).multiplyScalar(radius+altitude).add(moonCenter);
      camera.quaternion.copy(flight.fromLook).slerp(flight.toLook,pan);
      if (t === 1) {
        const {target,offset,up} = flight;
        flight = undefined;
        pointAt(target,offset,up);
      }
    } else {
      controls.update();
    }
    if (now >= nextUpdate) {
      nextUpdate = now + 200;
      // Remesh wire density while flying so Whole Moon never flashes solid blue.
      if (layer.value === 'mesh') updateMeshLod();
      if (!flight) updateDetail();
    }
    for (const m of liveMarkers) {
      const local = currentGrid ? heightAt(currentGrid, m.x, m.y) : NaN;
      const h = Number.isFinite(local) ? local : heightAt(overview, m.x, m.y);
      const lift = m.spec.category === 'chosen' ? 18 : m.spec.category === 'compare' ? 14 : 10;
      const base = Number.isFinite(h) ? h : 0;
      m.mesh.position.copy(world(m.x, m.y, base + lift));
      const dist = camera.position.distanceTo(m.mesh.position);
      const scale = T.MathUtils.clamp(dist * (m.spec.category === 'chosen' ? 0.018 : 0.012), 4, 14000);
      m.mesh.scale.setScalar(scale);
      m.mesh.lookAt(camera.position);
    }
    renderer.render(scene,camera);
  });

  // Prefer mesh/wireframe on load — geometry first; relief/elevation remain available.
  if (layer.querySelector('option[value="mesh"]')) {
    layer.value = 'mesh';
    setLayer();
  }

  return {
    focusLatLon,
    showGlobe: (animate = true) => showGlobe(animate),
    showPolarCap,
    setPickMode(enabled, onPick) {
      pickMode = enabled;
      pickCallback = enabled ? onPick : undefined;
      renderer.domElement.style.cursor = enabled ? 'crosshair' : '';
      const hint = element('hint');
      if (enabled) {
        hint.textContent = 'Pick mode · click terrain to set custom Site A (sphere horizon) · Esc or button to cancel';
      } else {
        hint.textContent = 'Click marker to select · Click terrain to fly · Drag to orbit · Scroll to zoom';
      }
    },
    isPickMode: () => pickMode,
    setMarkers,
    setCatalogMarkersVisible(visible) {
      catalogVisible = visible;
      for (const m of liveMarkers) {
        if (m.spec.category === 'catalog') m.mesh.visible = visible;
      }
    },
    setSearchMarkersVisible(visible) {
      searchVisible = visible;
      for (const m of liveMarkers) {
        if (m.spec.category === 'search') m.mesh.visible = visible;
      }
    },
    onMarkerClick(cb) {
      markerClickCb = cb;
    },
  };
}
