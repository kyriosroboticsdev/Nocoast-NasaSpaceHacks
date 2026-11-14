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
const focus = element<HTMLButtonElement>('focus');
const reset = element<HTMLButtonElement>('reset');
const size = 257;
const moonCenter = new T.Vector3(0,-radius,0);
// Embedded in the team dashboard: hide the page header so the viewer fills the frame.
if (new URLSearchParams(location.search).has('embed')) document.documentElement.classList.add('embed');

type Site = {siteId: string; name: string; latitudeDeg: number; longitudeEastDeg: number; surfaceElevationM: number};
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

function meshFor(grid: Grid, material: T.Material, parent?: Grid) {
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
    let renderHeight = h;
    // Fade the outer margin into the overview to keep the join continuous.
    if (parent) {
      const coarse = heightAt(parent, x, y);
      const weight = T.MathUtils.smoothstep(Math.min(i,j,width-1-i,width-1-j), 0, 24);
      if (Number.isFinite(coarse)) renderHeight = T.MathUtils.lerp(coarse, h, weight);
    }
    const distanceToEdge = capRadius-Math.hypot(x,y);
    if (distanceToEdge < 0 || !Number.isFinite(renderHeight)) continue;
    // Bring the outer two kilometers back to the reference sphere at the globe join.
    renderHeight *= T.MathUtils.smoothstep(distanceToEdge, 650, 2650);
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
    orbit.addEventListener('change',()=> {nextUpdate = performance.now()+180;});
    return orbit;
  }
  let controls = createControls();
  function setLayer() {
    const key = layer.value as keyof typeof materials;
    backdrop.material = overviewMaterials[key];
    if (detail) detail.material = materials[key];
    element('legend').hidden = key !== 'elevation';
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
    detail = meshFor(grid, materials.relief, overview);
    currentGrid = grid;
    currentKey = key;
    const span = (size-1)*grid.spacing;
    // Only open the overview underneath a fully valid window.
    if (grid.values.every(Number.isFinite) &&
        [grid.x,grid.x+span].every(x=>Math.hypot(x,grid.y) < capRadius && Math.hypot(x,grid.y-span) < capRadius)) {
      cutout.value.set(grid.x+3,grid.y-span+3,grid.x+span-3,grid.y-3);
    }
    scene.add(detail);
    setLayer();
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
    if (distance > 6300 || Math.hypot(x,y) > capRadius) {
      request?.abort();
      removeDetail();
      element('mode-label').textContent = '87°S–90°S · 320 M OVERVIEW';
      status.textContent = '';
      return;
    }
    const stride = distance < 1000 ? 1 : distance < 2300 ? 2 : 4;
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
  // ---- Sun/Earth directions from the comms workstream (Person 2), posted by the dashboard.
  // Unit vectors arrive in the site's local East-North-Up basis (team contract localVectorBasis).
  type Sky = {type:'lunar-sky'; siteId:string; timeUtc:string; sunEnu:number[]; earthEnu:number[];
    sunVisible:boolean|null; earthVisible:boolean|null};
  let sky: Sky | undefined;
  const skyArrows = {sun:new T.ArrowHelper(new T.Vector3(1,0,0),new T.Vector3(),1,0xffc83d),
    earth:new T.ArrowHelper(new T.Vector3(1,0,0),new T.Vector3(),1,0x4fb8ff)};
  for (const arrow of Object.values(skyArrows)) {
    arrow.visible = false;
    arrow.renderOrder = 5;
    for (const part of [arrow.line, arrow.cone]) {
      const material = part.material as T.Material;
      material.transparent = true;
      material.depthTest = false;
    }
    scene.add(arrow);
  }
  function enuToWorld(enu: number[], site: (typeof sites)[number]) {
    // Local basis at the site in viewer axes (+X = 90°E, -Z = 0°E, +Y up at the pole).
    const lon = T.MathUtils.degToRad(site.longitudeEastDeg);
    const up = world(site.x,site.y,0).sub(moonCenter).normalize();
    const north = new T.Vector3(Math.sin(lon),0,-Math.cos(lon)).projectOnPlane(up).normalize();
    const east = new T.Vector3(Math.cos(lon),0,Math.sin(lon)).projectOnPlane(up).normalize();
    return east.multiplyScalar(enu[0]).add(north.multiplyScalar(enu[1])).add(up.multiplyScalar(enu[2])).normalize();
  }
  addEventListener('message', event => {
    if (event.origin !== location.origin || event.data?.type !== 'lunar-sky') return;
    sky = event.data as Sky;
    const index = sites.findIndex(site => site.siteId === sky!.siteId);
    if (index < 0) return;
    if (selector.selectedIndex !== index || !focusedPoint) {
      selector.selectedIndex = index;
      goToSite();
    }
    // Illustrative lighting from the computed Sun direction (no cast shadows).
    light.position.copy(enuToWorld(sky.sunEnu,sites[index]));
    const visible = (value: boolean|null) => value === true ? 'visible' : value === false ? 'blocked by terrain' : 'unknown';
    const note = document.querySelector('.coverage p');
    if (note) note.textContent = `${sky.timeUtc}: Sun ${visible(sky.sunVisible)}, Earth ${visible(sky.earthVisible)} ` +
      '(computed numerical horizon). Arrows show directions; lighting is illustrative and casts no shadows.';
  });
  if (parent !== window) parent.postMessage({type:'lunar-sky-ready'}, location.origin);
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
    const bounds = cutout.value;
    const candidates = detail ? [detail,backdrop,globe] : [backdrop,globe];
    for (const hit of ray.intersectObjects(candidates,false)) {
      if (hit.object === globe) {
        focusedPoint = undefined;
        element('details').replaceChildren();
        const radial = hit.point.clone().sub(moonCenter).normalize();
        flyTo(hit.point,radial.multiplyScalar(410000),new T.Vector3(0,-1,0));
        break;
      }
      const [x,y] = projection(hit.point);
      if (hit.object === backdrop && x>bounds.x && x<bounds.z && y>bounds.y && y<bounds.w) continue;
      focusTerrain(x,y);
      break;
    }
  });
  for (const site of sites) selector.add(new Option(site.name));
  selector.onchange = goToSite;
  focus.onclick = goToSite;
  selector.disabled = focus.disabled = reset.disabled = layer.disabled = globeButton.disabled = false;
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
    if (!flight && now >= nextUpdate) {
      nextUpdate = now+200;
      updateDetail();
    }
    for (let i=0; i<sites.length; i++) {
      const site = sites[i];
      const local = currentGrid ? heightAt(currentGrid,site.x,site.y) : NaN;
      const h = Number.isFinite(local) ? local : heightAt(overview,site.x,site.y);
      markers[i].position.copy(world(site.x,site.y,h+8));
      markers[i].scale.setScalar(T.MathUtils.clamp(camera.position.distanceTo(markers[i].position)*.013,3,12000));
    }
    if (sky) {
      const index = sites.findIndex(site => site.siteId === sky!.siteId);
      if (index >= 0) {
        const origin = markers[index].position;
        const length = T.MathUtils.clamp(camera.position.distanceTo(origin)*.35,30,250000);
        for (const [key,arrow] of Object.entries(skyArrows)) {
          const body = key === 'sun' ? sky.sunEnu : sky.earthEnu;
          const shown = key === 'sun' ? sky.sunVisible : sky.earthVisible;
          arrow.position.copy(origin);
          arrow.setDirection(enuToWorld(body,sites[index]));
          arrow.setLength(length,length*.12,length*.05);
          for (const part of [arrow.line, arrow.cone]) (part.material as T.Material).opacity = shown ? 1 : .3;
          arrow.visible = true;
        }
      }
    }
    renderer.render(scene,camera);
  });
}

void start().catch(error => {
  status.textContent = 'Could not open the polar terrain viewer.';
  console.error(error);
});
