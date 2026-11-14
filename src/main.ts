import * as T from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createHeightField, parseGlobalLdem } from './terrain/heightField';
import { createMoonMesh, MOON_MESH_MAX_LEVEL } from './terrain/moonMesh';

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

/**
 * Polar stereographic DEM mesh for the lunar-surface and elevation layers
 * (320 m overview and the streamed 5–20 m detail windows). The mesh layer
 * does not use this; it draws the whole Moon through `createMoonMesh`.
 */
function meshFor(grid: Grid, material: T.Material, parent?: Grid) {
  const width = grid.width;
  const positions = new Float32Array(width * width * 3);
  const colors = new Float32Array(positions.length);
  const projected = new Float32Array(width * width * 2);
  const uv = new Float32Array(width * width * 2);
  const valid = new Uint8Array(width * width);
  const low = new T.Color('#234d70'), mid = new T.Color('#6aa4a2'), high = new T.Color('#e7d29c');
  const color = new T.Color();
  const margin = 24;
  for (let j = 0; j < width; j++) for (let i = 0; i < width; i++) {
    const idx = j * width + i;
    const x = grid.x + i * grid.spacing, y = grid.y - j * grid.spacing;
    projected[idx * 2] = x;
    projected[idx * 2 + 1] = y;
    uv[idx * 2] = x / radius;
    uv[idx * 2 + 1] = y / radius;
    const h = grid.values[idx];
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
  // Materials of the lunar-surface and elevation layers (polar DEM meshes).
  const materials = {
    relief: polarSurface,
    elevation: new T.MeshBasicMaterial({vertexColors:true}),
  };
  const solidLayer = (): keyof typeof materials => layer.value === 'elevation' ? 'elevation' : 'relief';
  // Mesh layer: one height function and one quadtree cube-sphere for the whole
  // Moon, drawn as an opaque fill with wire lines on top (see terrain/moonMesh.ts).
  const heightField = createHeightField(radius, overview, globalLdem);
  const moonMesh = createMoonMesh({radius, center: moonCenter, field: heightField});
  moonMesh.group.visible = false;
  scene.add(moonMesh.group);
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
  const backdrop = meshFor(overview, overviewMaterials.relief);
  scene.add(backdrop);
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
    // Short defer before the next detail-window / badge refresh.
    orbit.addEventListener('change',()=> {nextUpdate = performance.now()+70;});
    return orbit;
  }
  let controls = createControls();

  function formatMeters(meters: number): string {
    if (meters >= 10000) return `${Math.round(meters / 1000)} KM`;
    if (meters >= 1000) return `${(meters / 1000).toFixed(1)} KM`;
    return `${Math.round(meters)} M`;
  }

  /** Relief/elevation: fine 5–20 m polar detail windows near the view centre. */
  function detailPolicy(distance: number): { maxDistance: number; stride: number } {
    if (distance < 1000) return { maxDistance: 6300, stride: 1 };
    if (distance < 2300) return { maxDistance: 6300, stride: 2 };
    return { maxDistance: 6300, stride: 4 };
  }

  const viewRay = new T.Ray();
  const referenceSphere = new T.Sphere(moonCenter, radius);
  const viewCentre = new T.Vector3();
  /** Direction from the Moon's centre to the surface in the middle of the view. */
  function viewCentreDirection(): T.Vector3 {
    viewRay.origin.copy(camera.position);
    camera.getWorldDirection(viewRay.direction);
    if (!viewRay.intersectSphere(referenceSphere, viewCentre)) viewCentre.copy(camera.position);
    return viewCentre.sub(moonCenter).normalize();
  }

  /** Mesh badge: the grid and the data actually drawn at the view centre. */
  function meshModeLabel(): string {
    const d = viewCentreDirection();
    const level = Math.max(0, moonMesh.levelAt(d.x, d.y, d.z));
    const cell = moonMesh.cellMeters(level);
    const source = heightField.source(d.x, d.y, d.z);
    const native = source === 'ldem' ? heightField.ldemSpacingM : heightField.lolaSpacingM;
    const data = source === 'lola' ? `LOLA ${formatMeters(native)}`
      : source === 'ldem' ? `GLOBAL LDEM ${formatMeters(native)}`
      : 'LOLA + LDEM BLEND';
    // Cells finer than the data only resample it; say so.
    const resampled = cell < native * 0.75 ? ' INTERPOLATED' : '';
    return `MESH LOD ${level}/${MOON_MESH_MAX_LEVEL} · ~${formatMeters(cell)} CELLS · ${data}${resampled}`;
  }

  function setOverviewModeLabel() {
    const text = layer.value === 'mesh' ? meshModeLabel() : '87°S–90°S · 320 M OVERVIEW';
    const label = element('mode-label');
    if (label.textContent !== text) label.textContent = text;
  }

  function setLayer() {
    const meshOn = layer.value === 'mesh';
    // The elevation ramp also applies to the mesh layer's faint fill tint.
    element('legend').hidden = layer.value === 'relief';
    // Detail windows belong to the surface layers; the mesh layer never uses them.
    request?.abort();
    removeDetail();
    // The mesh layer is its own complete surface, so the textured globe and
    // polar DEM are hidden under it (and the other way round). Its LOD is
    // refreshed every frame by the render loop.
    moonMesh.group.visible = meshOn;
    globe.visible = backdrop.visible = !meshOn;
    if (!meshOn) backdrop.material = overviewMaterials[solidLayer()];
    setOverviewModeLabel();
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
    const matKey = solidLayer();
    detail = meshFor(grid, materials[matKey], overview);
    currentGrid = grid;
    currentKey = key;
    const span = (size-1)*grid.spacing;
    // Cut overview under a fully valid window so detail + base don't z-fight.
    if (grid.values.every(Number.isFinite) &&
        [grid.x,grid.x+span].every(x=>Math.hypot(x,grid.y) < capRadius && Math.hypot(x,grid.y-span) < capRadius)) {
      cutout.value.set(grid.x+3,grid.y-span+3,grid.x+span-3,grid.y-3);
    }
    scene.add(detail);
    backdrop.material = overviewMaterials[matKey];
    element('legend').hidden = matKey !== 'elevation';
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
    // Mesh layer: the whole-Moon mesh is the surface; no detail windows.
    if (layer.value === 'mesh') {
      if (currentKey || detail) {
        request?.abort();
        removeDetail();
        setOverviewModeLabel();
      }
      status.textContent = '';
      return;
    }
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
    nextUpdate = performance.now()+70;
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
  /**
   * Height of the surface the active layer draws at polar (x, y), for the
   * close-focus camera. NaN where close focus is not offered (outside the cap).
   */
  function groundHeight(x: number,y: number) {
    if (layer.value === 'mesh') {
      return Math.hypot(x,y) <= capRadius*1.05 ? heightField.heightAtPolar(x,y) : NaN;
    }
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
      // Aim at the surface that is drawn: the displaced mesh, or the smooth globe.
      const surface = layer.value === 'mesh' ? heightField.height(local.x, local.y, local.z) : 0;
      const target = moonCenter.clone().add(local.clone().multiplyScalar(radius + surface));
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
    // A click outside the polar cap: report it, or fly to a regional view.
    const globeHit = (point: T.Vector3) => {
      if (pickMode && pickCallback) {
        const ll = latLonFromGlobeHit(point);
        pickCallback(ll.latitudeDeg, ll.longitudeEastDeg);
        return;
      }
      focusedPoint = undefined;
      element('details').replaceChildren();
      const radial = point.clone().sub(moonCenter).normalize();
      flyTo(point,radial.multiplyScalar(410000),new T.Vector3(0,-1,0));
    };
    // A click inside the polar cap: report it and fly to the close focus view.
    const polarHit = (x: number, y: number) => {
      if (pickMode && pickCallback) {
        const ll = latLonFromPolarXY(x, y);
        pickCallback(ll.latitudeDeg, ll.longitudeEastDeg);
      }
      focusTerrain(x, y);
    };
    if (layer.value === 'mesh') {
      // The mesh layer is one surface: hit the patches that are on screen.
      const point = moonMesh.intersect(ray);
      if (!point) return;
      const [x,y] = projection(point);
      if (Math.hypot(x,y) <= capRadius) polarHit(x,y);
      else globeHit(point);
      return;
    }
    const bounds = cutout.value;
    const candidates = detail ? [detail,backdrop,globe] : [backdrop,globe];
    for (const hit of ray.intersectObjects(candidates,false)) {
      if (hit.object === globe) {
        globeHit(hit.point);
        break;
      }
      const [x,y] = projection(hit.point);
      if (hit.object === backdrop && x>bounds.x && x<bounds.z && y>bounds.y && y<bounds.w) continue;
      polarHit(x,y);
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
    const meshOn = layer.value === 'mesh';
    // Mesh LOD follows the camera every frame, including during flights. It
    // only does work when the camera moved, and only builds uncached patches.
    if (meshOn) moonMesh.update(camera, viewport.clientHeight);
    if (now >= nextUpdate) {
      nextUpdate = now + 90;
      if (meshOn) setOverviewModeLabel();
      if (!flight) updateDetail();
    }
    for (const m of liveMarkers) {
      // Markers sit on the surface the active layer draws.
      const local = currentGrid ? heightAt(currentGrid, m.x, m.y) : NaN;
      const h = meshOn ? heightField.heightAtPolar(m.x, m.y)
        : Number.isFinite(local) ? local : heightAt(overview, m.x, m.y);
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

  if (import.meta.env.DEV) {
    // Dev-server only inspection hook (stripped from production builds).
    Object.assign(window, {__terrainDebug: {
      renderer, scene, camera, moonMesh, heightField, world, projection,
      controls: () => controls,
      markers: () => liveMarkers,
      ray,
    }});
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
