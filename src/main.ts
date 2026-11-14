import * as T from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import './style.css';

const radius = 1737400;
const capRadius = 2 * radius * Math.tan(T.MathUtils.degToRad(1.5));
const base = import.meta.env.BASE_URL;
const element = <E extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as E;
const status = element('status');
const selector = element<HTMLSelectElement>('site');
const layer = element<HTMLSelectElement>('layer');
const terrainSource = element<HTMLSelectElement>('terrain-source');
const lockResolution = element<HTMLInputElement>('lock-resolution');
const focus = element<HTMLButtonElement>('focus');
const reset = element<HTMLButtonElement>('reset');
const size = 129;
const maxTiles = 36;
const moonCenter = new T.Vector3(0,-radius,0);

type Site = {name: string; latitudeDeg: number; longitudeEastDeg: number; surfaceElevationM: number};
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
  if (u < 0 || v < 0 || u > grid.width-1 || v > grid.width-1) return NaN;
  const i = Math.min(grid.width-2,Math.floor(u)), j = Math.min(grid.width-2,Math.floor(v));
  const a = grid.values[j*grid.width+i], b = grid.values[j*grid.width+i+1];
  const c = grid.values[(j+1)*grid.width+i], d = grid.values[(j+1)*grid.width+i+1];
  const du = u-i, dv = v-j;
  return du+dv <= 1 ? a+(b-a)*du+(c-a)*dv : d+(c-d)*(1-du)+(b-d)*(1-dv);
}

function meshFor(grid: Grid, material: T.Material) {
  const {values, width, spacing} = grid;
  const positions = new Float32Array(values.length*3);
  const colors = new Float32Array(positions.length);
  const projected = new Float32Array(values.length*2);
  const uv = new Float32Array(values.length*2);
  const valid = new Uint8Array(values.length);
  const low = new T.Color('#234d70'), mid = new T.Color('#6aa4a2'), high = new T.Color('#e7d29c');
  const color = new T.Color();
  for (let j=0; j<width; j++) for (let i=0; i<width; i++) {
    const idx = j*width+i;
    const x = grid.x+i*spacing, y = grid.y-j*spacing;
    projected[idx*2] = x;
    projected[idx*2+1] = y;
    uv[idx*2] = x/radius;
    uv[idx*2+1] = y/radius;
    const h = values[idx];
    const distanceToEdge = capRadius-Math.hypot(x,y);
    if (distanceToEdge < 0 || !Number.isFinite(h)) continue;
    // Bring the outer two kilometers back to the reference sphere at the globe join.
    const renderHeight = h*T.MathUtils.smoothstep(distanceToEdge,650,2650);
    valid[idx] = 1;
    world(x,y,renderHeight).toArray(positions, idx*3);
    const fraction = T.MathUtils.clamp((h+8000)/15000, 0, 1);
    color.copy(fraction < .5 ? low : mid).lerp(fraction < .5 ? mid : high, fraction < .5 ? fraction*2 : fraction*2-1);
    color.toArray(colors, idx*3);
  }
  const triangles: number[] = [];
  for (let j=0; j<width-1; j++) for (let i=0; i<width-1; i++) {
    const a = j*width+i, b=a+1, c=a+width, d=c+1;
    if (valid[a] && valid[c] && valid[b]) triangles.push(a,c,b);
    if (valid[b] && valid[c] && valid[d]) triangles.push(b,c,d);
  }
  const geometry = new T.BufferGeometry();
  geometry.setAttribute('position', new T.BufferAttribute(positions,3));
  geometry.setAttribute('color', new T.BufferAttribute(colors,3));
  geometry.setAttribute('projectedXY', new T.BufferAttribute(projected,2));
  geometry.setAttribute('uv', new T.BufferAttribute(uv,2));
  geometry.setIndex(triangles);
  geometry.computeVertexNormals();
  const normals = geometry.getAttribute('normal');
  const normal = new T.Vector3();
  const radial = new T.Vector3();
  for (let i=0; i<values.length; i++) {
    if (!valid[i]) continue;
    const edge = capRadius-Math.hypot(projected[i*2],projected[i*2+1]);
    if (edge >= 2650) continue;
    radial.fromArray(positions,i*3).sub(moonCenter).normalize();
    normal.fromBufferAttribute(normals,i).lerp(radial,1-T.MathUtils.smoothstep(edge,650,2650)).normalize();
    normals.setXYZ(i,normal.x,normal.y,normal.z);
  }
  return new T.Mesh(geometry, material);
}

async function fetchAsset(path: string) {
  const response = await fetch(base + path);
  if (!response.ok) throw new Error(`Terrain request failed (${response.status})`);
  return response;
}

async function start() {
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

  const [overviewBody, siteBody] = await Promise.all([
    fetchAsset('terrain/polar-overview.bin').then(r=>r.arrayBuffer()),
    fetchAsset('terrain/sites.json').then(r=>r.json() as Promise<{sites:Site[]}>),
  ]);
  const header = new DataView(overviewBody);
  const overview: Grid = {
    x:header.getInt32(0,true), y:header.getInt32(4,true),
    width:header.getUint32(8,true), spacing:320, values:new Float32Array(overviewBody,12),
  };
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
    mesh: new T.MeshBasicMaterial({color:0x89b6ba,wireframe:true}),
  };
  const cutouts = Array.from({length:2*maxTiles},()=>new T.Vector4());
  const cutout = {value:cutouts};
  const replacementCount = {value:0};
  const cap = {value:capRadius};
  function clippedMaterials(fallback: boolean) {
    return Object.fromEntries(Object.entries(materials).map(([key, material]) => {
    const copy = material.clone();
    copy.customProgramCacheKey = () => `polar-clipped-${key}-${fallback}`;
    copy.onBeforeCompile = shader => {
      if (key === 'relief') applyPolarImagery(shader);
      shader.uniforms.detailBounds = cutout;
      shader.uniforms.replacementCount = replacementCount;
      shader.uniforms.capRadius = cap;
      shader.vertexShader = 'attribute vec2 projectedXY; varying vec2 polarXY;\n' + shader.vertexShader.replace('#include <begin_vertex>', `
        #include <begin_vertex>
        polarXY = projectedXY;
      `);
      shader.fragmentShader = `uniform vec4 detailBounds[${cutouts.length}]; uniform int replacementCount; uniform float capRadius; varying vec2 polarXY;\n` +
        shader.fragmentShader.replace('#include <clipping_planes_fragment>', `
          #include <clipping_planes_fragment>
          if (length(polarXY) > capRadius) discard;
          for (int i = 0; i < ${fallback ? 'replacementCount' : cutouts.length}; i++) {
            vec4 bounds = detailBounds[i];
            if (polarXY.x >= bounds.x && polarXY.x <= bounds.z &&
                polarXY.y >= bounds.y && polarXY.y <= bounds.w) discard;
          }
        `);
    };
    return [key,copy];
    })) as typeof materials;
  }
  const overviewMaterials = clippedMaterials(false);
  const fallbackMaterials = clippedMaterials(true);
  const backdrop = meshFor(overview, overviewMaterials.relief);
  scene.add(backdrop);
  type Tile = {grid: Grid; mesh: T.Mesh; bounds: T.Vector4};
  const tiles = new Map<string,Tile>();
  const pending = new Map<string,AbortController>();
  const retryAt = new Map<string,number>();
  let visibleKeys = new Set<string>();
  let fallbackKeys = new Set<string>();
  let requestedKeys = new Set<string>();
  let nextUpdate = 0;
  const footprintRay = new T.Raycaster();
  const footprintPoint = new T.Vector3();
  const footprintSphere = new T.Sphere(moonCenter,radius);
  const terrainEnvelope = new T.Sphere(moonCenter,radius+10000);
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
  function setLayer() {
    const key = layer.value as keyof typeof materials;
    backdrop.material = overviewMaterials[key];
    syncTiles();
    element('legend').hidden = key !== 'elevation';
  }
  layer.onchange = setLayer;
  setLayer();

  function syncTiles() {
    backdrop.visible = !lockResolution.checked;
    let index = 0;
    const layerKey = layer.value as keyof typeof materials;
    for (const key of visibleKeys) cutouts[index++].copy(tiles.get(key)!.bounds);
    replacementCount.value = index;
    for (const [key,tile] of tiles) {
      const replacement = visibleKeys.has(key);
      tile.mesh.visible = replacement || fallbackKeys.has(key);
      tile.mesh.material = replacement ? materials[layerKey] : fallbackMaterials[layerKey];
      if (tile.mesh.visible && !replacement) cutouts[index++].copy(tile.bounds);
    }
    while (index < cutouts.length) cutouts[index++].set(1,1,0,0);
  }

  function updateDetail() {
    const distance = camera.position.distanceTo(controls.target);
    const overviewText = '87°S–90°S · 320 M OVERVIEW';
    const nativeOnly = lockResolution.checked;
    const [targetX,targetY] = projection(controls.target);
    if ((!nativeOnly && distance > 26000) ||
        (nativeOnly && (controls.target.distanceTo(moonCenter) < radius/2 || Math.hypot(targetX,targetY) > capRadius))) {
      visibleKeys.clear();
      fallbackKeys.clear();
      requestedKeys.clear();
      for (const controller of pending.values()) controller.abort();
      syncTiles();
      element('mode-label').textContent = nativeOnly ? '5 M ONLY · SELECT THE POLAR CAP' : overviewText;
      status.textContent = '';
      return;
    }

    camera.updateMatrixWorld();
    const points: (readonly [number,number])[] = [[targetX,targetY]];
    // At close range the reference sphere can sit kilometers below the
    // visible ground. Estimate the footprint at the tracked terrain height.
    const elevation = groundHeight(targetX,targetY);
    footprintSphere.radius = radius + (Number.isFinite(elevation)
      ? elevation
      : controls.target.distanceTo(moonCenter)-radius);
    let grazing = false;
    for (const v of [-1,-.5,0,.5,1]) for (const u of [-1,-.5,0,.5,1]) {
      footprintRay.setFromCamera(new T.Vector2(u,v),camera);
      if (footprintRay.ray.intersectSphere(footprintSphere,footprintPoint)) {
        points.push(projection(footprintPoint));
        if (footprintPoint.distanceTo(camera.position) > distance*4+4000) grazing = true;
      } else if (footprintRay.ray.intersectsSphere(terrainEnvelope)) {
        grazing = true;
      }
    }
    // Preserve native detail around the target during a close grazing view.
    // Rays near the horizon can otherwise make a nearby footprint span the cap.
    if ((nativeOnly || (grazing && distance < 1000)) && Math.hypot(targetX,targetY) <= capRadius) {
      const localRange = nativeOnly ? 6*(size-1)*5 : Math.max(distance,320);
      const xs = points.map(([x])=>x);
      const ys = points.map(([,y])=>y);
      points.length = 1;
      points.push(
        [Math.max(targetX-localRange,Math.min(...xs)-320),Math.max(targetY-localRange,Math.min(...ys)-320)],
        [Math.min(targetX+localRange,Math.max(...xs)+320),Math.min(targetY+localRange,Math.max(...ys)+320)],
      );
      grazing = false;
    }
    const xs = points.map(([x])=>x), ys = points.map(([,y])=>y);
    const [centerX,centerY] = points[0];
    const padding = 350;
    const minX = Math.max(-capRadius,Math.min(...xs)-padding);
    const maxX = Math.min(capRadius,Math.max(...xs)+padding);
    const minY = Math.max(-capRadius,Math.min(...ys)-padding);
    const maxY = Math.min(capRadius,Math.max(...ys)+padding);
    let stride = nativeOnly || distance < 4200 ? 1 : distance < 8500 ? 2 : distance < 15000 ? 4 : 8;
    let candidates: {column:number; row:number; key:string; distance:number}[] = [];
    const source = terrainSource.value;
    while (!grazing) {
      const span = (size-1)*stride;
      candidates = [];
      for (let row=Math.floor((100000-maxY)/5/span)*span; row<=(100000-minY)/5; row+=span) {
        for (let column=Math.floor((minX+100000)/5/span)*span; column<=(maxX+100000)/5; column+=span) {
          const x=-100000+(column+.5)*5, y=100000-(row+.5)*5, edge=5*span;
          if (Math.hypot(T.MathUtils.clamp(0,x,x+edge),T.MathUtils.clamp(0,y-edge,y)) > capRadius) continue;
          candidates.push({column,row,key:`${source}/${column}/${row}/${stride}`,
            distance:Math.hypot(x+edge/2-centerX,y-edge/2-centerY)});
        }
      }
      if (nativeOnly || candidates.length <= maxTiles || stride === 8) break;
      stride *= 2;
    }
    candidates.sort((a,b)=>a.distance-b.distance);
    // At wide grazing angles, use the overview for the entire view if even
    // the coarsest detail level would exceed the tile budget.
    const limited = nativeOnly && candidates.length > maxTiles;
    if (limited) candidates = candidates.slice(0,maxTiles);
    else if (candidates.length > maxTiles) candidates = [];
    requestedKeys = new Set(candidates.map(tile=>tile.key));
    const ready = new Set(candidates.filter(tile=>tiles.has(tile.key)).map(tile=>tile.key));
    const wasShowingDetail = visibleKeys.size > 0;
    if (!candidates.length || ready.size === candidates.length) {
      fallbackKeys.clear();
    } else if ([...visibleKeys].some(key=>!requestedKeys.has(key))) {
      fallbackKeys = visibleKeys;
    }
    for (const key of ready) fallbackKeys.delete(key);
    visibleKeys = ready;
    syncTiles();
    if (ready.size && !wasShowingDetail && focusedPoint && controls.target.distanceTo(focusedPoint.target)<1) {
      const {x,y} = focusedPoint;
      const target = world(x,y,groundHeight(x,y));
      if (Number.isFinite(target.y)) {
        camera.position.add(target.clone().sub(controls.target));
        controls.target.copy(target);
        focusedPoint.target.copy(target);
        controls.update();
      }
    }
    for (const [key,controller] of pending) {
      if (!requestedKeys.has(key)) controller.abort();
    }
    const shown = tiles.get(visibleKeys.values().next().value ?? fallbackKeys.values().next().value ?? '');
    element('mode-label').textContent = shown
      ? ready.size < candidates.length
        ? `UPDATING TERRAIN · ${ready.size}/${candidates.length} TILES READY`
        : `${shown.grid.spacing} M TERRAIN · ${limited ? 'VIEW CENTER' : `${visibleKeys.size} TILES`}`
      : nativeOnly ? '5 M ONLY · LOADING TILES' : overviewText;
    if (!candidates.length || ready.size === candidates.length) status.textContent = '';
    const requests = candidates.filter(({key})=>!tiles.has(key) && !pending.has(key) &&
      (retryAt.get(key) ?? 0) <= performance.now());
    for (const {column,row,key} of requests.slice(0,Math.max(0,2-pending.size))) {
      const spacing = 5*stride;
      const controller = new AbortController();
      pending.set(key,controller);
      status.textContent = `Loading ${spacing} m terrain from ${source === 'local' ? 'disk' : 'NASA'}…`;
      const params = new URLSearchParams({column:String(column),row:String(row),stride:String(stride),size:String(size),source});
      void fetch(base+`terrain/window?${params}`,{signal:controller.signal})
        .then(async response => {
          if (!response.ok) throw new Error(await response.text());
          const data = await response.arrayBuffer();
          if (data.byteLength !== size*size*4) throw new Error('Unexpected terrain tile');
          if (controller.signal.aborted) return;
          const grid = {x:-100000+(column+.5)*5,y:100000-(row+.5)*5,width:size,
            spacing,values:new Float32Array(data)};
          const mesh = meshFor(grid,materials[layer.value as keyof typeof materials]);
          const span = (size-1)*spacing;
          const bounds = grid.values.every(Number.isFinite)
            ? new T.Vector4(grid.x,grid.y-span,grid.x+span,grid.y)
            : new T.Vector4(1,1,0,0);
          tiles.set(key,{grid,mesh,bounds});
          mesh.visible = false;
          scene.add(mesh);
          retryAt.delete(key);
          for (const [oldKey,old] of tiles) {
            if (tiles.size <= 54) break;
            if (requestedKeys.has(oldKey) || visibleKeys.has(oldKey) || fallbackKeys.has(oldKey)) continue;
            scene.remove(old.mesh);
            old.mesh.geometry.dispose();
            tiles.delete(oldKey);
          }
        }).catch((error:unknown) => {
          if (controller.signal.aborted) return;
          retryAt.set(key,performance.now()+5000);
          status.textContent = error instanceof Error ? error.message : 'Detailed terrain unavailable';
        }).finally(() => {
          pending.delete(key);
          nextUpdate = 0;
        });
    }
  }
  terrainSource.onchange = () => {
    for (const request of pending.values()) request.abort();
    requestedKeys.clear();
    retryAt.clear();
    nextUpdate = 0;
  };
  lockResolution.onchange = () => {
    if (lockResolution.checked) {
      visibleKeys = new Set([...visibleKeys].filter(key=>tiles.get(key)?.grid.spacing === 5));
      fallbackKeys = new Set([...fallbackKeys].filter(key=>tiles.get(key)?.grid.spacing === 5));
      for (const [key,controller] of pending) {
        if (!key.endsWith('/1')) controller.abort();
      }
      if (controls.target.distanceTo(moonCenter) < radius/2) reset.click();
    }
    syncTiles();
    nextUpdate = 0;
  };
  const sites = siteBody.sites.map(site => {
    const rho = 2*radius*Math.tan(T.MathUtils.degToRad((site.latitudeDeg+90)/2));
    const lon = T.MathUtils.degToRad(site.longitudeEastDeg);
    return {...site,x:rho*Math.sin(lon),y:rho*Math.cos(lon)};
  });
  const markers = sites.map(() => {
    const sprite = new T.Sprite(new T.SpriteMaterial({color:0x7de4d4}));
    sprite.renderOrder = 4;
    scene.add(sprite);
    return sprite;
  });
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
    for (const key of [...visibleKeys,...fallbackKeys]) {
      const {grid} = tiles.get(key)!;
      const height = heightAt(grid,x,y);
      if (Number.isFinite(height)) return height*T.MathUtils.smoothstep(capRadius-Math.hypot(x,y),650,2650);
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
  reset.onclick = () => {
    focusedPoint = undefined;
    element('details').replaceChildren();
    const ratio = Math.max(1, 1/camera.aspect);
    flyTo(new T.Vector3(),new T.Vector3(25000,200000,140000).multiplyScalar(ratio),new T.Vector3(0,1,0));
  };
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
  function goToSite() {
    const site = sites[selector.selectedIndex];
    focusTerrain(site.x,site.y);
  }
  const ray = new T.Raycaster();
  let pressed: {id:number; x:number; y:number} | undefined;
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
    const candidates = [...tiles.values()].filter(tile=>tile.mesh.visible).map(tile=>tile.mesh);
    if (backdrop.visible) candidates.push(backdrop);
    candidates.push(globe);
    for (const hit of ray.intersectObjects(candidates,false)) {
      if (hit.object === globe) {
        focusedPoint = undefined;
        element('details').replaceChildren();
        const radial = hit.point.clone().sub(moonCenter).normalize();
        flyTo(hit.point,radial.multiplyScalar(410000),new T.Vector3(0,-1,0));
        break;
      }
      const [x,y] = projection(hit.point);
      const isFallback = [...fallbackKeys].some(key=>tiles.get(key)?.mesh === hit.object);
      const activeCuts = hit.object === backdrop ? cutouts : isFallback ? cutouts.slice(0,replacementCount.value) : [];
      if (activeCuts.some(bounds=>x>=bounds.x && x<=bounds.z && y>=bounds.y && y<=bounds.w)) continue;
      focusTerrain(x,y);
      break;
    }
  });
  for (const site of sites) selector.add(new Option(site.name));
  selector.onchange = goToSite;
  focus.onclick = goToSite;
  terrainSource.value = 'local';
  selector.disabled = focus.disabled = reset.disabled = layer.disabled = globeButton.disabled = terrainSource.disabled = lockResolution.disabled = false;
  showGlobe(false);
  const fps = element('fps');
  let fpsStart = performance.now();
  let frames = 0;
  renderer.setAnimationLoop(now => {
    frames++;
    const elapsed = now-fpsStart;
    if (elapsed >= 1000) {
      fps.textContent = `${Math.round(frames*1000/elapsed)} FPS`;
      fpsStart = now;
      frames = 0;
    }
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
    if (!flight && now >= nextUpdate) {
      nextUpdate = now+200;
      updateDetail();
    }
    for (let i=0; i<sites.length; i++) {
      const site = sites[i];
      const h = groundHeight(site.x,site.y);
      markers[i].position.copy(world(site.x,site.y,h+8));
      markers[i].scale.setScalar(T.MathUtils.clamp(camera.position.distanceTo(markers[i].position)*.013,3,12000));
    }
    renderer.render(scene,camera);
  });
}

void start().catch(error => {
  status.textContent = 'Could not open the polar terrain viewer.';
  console.error(error);
});
