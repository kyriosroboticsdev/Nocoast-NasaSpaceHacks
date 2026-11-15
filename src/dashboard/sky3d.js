// 3D sky view for the Overview tab: real terrain around the lander, the computed horizon, a lit and correctly
// oriented Earth, the Sun, and the full Sun/Earth paths over the mission (parts hidden behind hills are drawn
// dashed *through* the terrain, so no part of a path is ever cut off).
//
// World frame: x = east, y = up, z = south (three.js right-handed, so ENU (e, n, u) -> (e, u, -n)).
// Sizes are true angles as seen from the lander: the horizon wall, Sun and Earth sit at different distances,
// but each is placed so its angle above the horizon is exactly what the science API computed.
import * as THREE from "three";
import { apiUrl } from "../apiBase.ts";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";

const EYE = 2;              // contract observer height (m)
const RING_R = 9000;        // horizon wall distance (m)
const PATH_R = 11800;       // Sun/Earth path radius (m), beyond the wall so the hills hide it
const SKY_R = 12000;        // Sun/Earth distance (m)
const NEAR = { half: 620, n: 249 };    // 5 m detail around the lander
const FAR = { half: 8400, n: 241 };    // 70 m out to the horizon wall
const BIRD_SCALE = 5;       // Sun/Earth enlargement in bird's-eye view
const SUN_C = 0xffc83d, EARTH_C = 0x4fb8ff;

const w = (v) => new THREE.Vector3(v[0], v[2], -v[1]);
const dirAzEl = (azDeg, elDeg) => {
  const a = THREE.MathUtils.degToRad(azDeg), e = THREE.MathUtils.degToRad(elDeg);
  return new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e));
};
function rng(seed) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ------------------------------------------------------------------ textures
function regolithCanvas(size, seed) {
  const rnd = rng(seed), c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d"), img = g.createImageData(size, size), px = new Float32Array(size * size);
  for (const [period, amp] of [[4, 0.35], [8, 0.25], [16, 0.18], [32, 0.12], [64, 0.07], [128, 0.05], [256, 0.04]]) {
    const lat = Array.from({ length: period * period }, rnd), cell = size / period;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const fx = x / cell, fy = y / cell, x0 = Math.floor(fx), y0 = Math.floor(fy);
      const sx = (fx - x0) ** 2 * (3 - 2 * (fx - x0)), sy = (fy - y0) ** 2 * (3 - 2 * (fy - y0));
      const L = (i, j) => lat[((j + period) % period) * period + ((i + period) % period)];
      px[y * size + x] += amp * ((L(x0, y0) * (1 - sx) + L(x0 + 1, y0) * sx) * (1 - sy)
        + (L(x0, y0 + 1) * (1 - sx) + L(x0 + 1, y0 + 1) * sx) * sy);
    }
  }
  for (let i = 0; i < px.length; i++) {
    const v = Math.max(0, Math.min(255, (0.32 + 0.75 * (px[i] - 0.5) + 0.35) * 255));
    img.data.set([v, v * 0.985, v * 0.955, 255], i * 4);
  }
  g.putImageData(img, 0, 0);
  // small craters (drawn wrapped so the texture tiles): dark bowl, bright rim
  for (let k = 0; k < 140; k++) {
    const r = 2 + 38 * rnd() ** 3, x = rnd() * size, y = rnd() * size;
    for (const ox of [-size, 0, size]) for (const oy of [-size, 0, size]) {
      const cx = x + ox, cy = y + oy;
      if (cx + r * 1.4 < 0 || cy + r * 1.4 < 0 || cx - r * 1.4 > size || cy - r * 1.4 > size) continue;
      const gr = g.createRadialGradient(cx, cy, 0, cx, cy, r * 1.35);
      gr.addColorStop(0, "rgba(20,20,20,0.35)"); gr.addColorStop(0.65, "rgba(40,40,40,0.15)");
      gr.addColorStop(0.78, "rgba(235,235,230,0.30)"); gr.addColorStop(1, "rgba(235,235,230,0)");
      g.fillStyle = gr; g.beginPath(); g.arc(cx, cy, r * 1.35, 0, Math.PI * 2); g.fill();
    }
  }
  return c;
}
function canvasTexture(canvas, repeat, srgb) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat, repeat); t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function glowTexture() {
  const c = document.createElement("canvas"); c.width = c.height = 256;
  const g = c.getContext("2d"), gr = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  gr.addColorStop(0, "rgba(255,255,245,1)"); gr.addColorStop(0.06, "rgba(255,248,220,0.95)");
  gr.addColorStop(0.18, "rgba(255,214,120,0.35)"); gr.addColorStop(0.45, "rgba(255,190,90,0.08)");
  gr.addColorStop(1, "rgba(255,180,80,0)");
  g.fillStyle = gr; g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

// ------------------------------------------------------------------ Earth (day/night, clouds, atmosphere)
function earthMaterial(sunDir) {
  const L = new THREE.TextureLoader(), tex = (f, srgb = true) => {
    const t = L.load(`/sky/${f}`); if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
  };
  return new THREE.ShaderMaterial({
    uniforms: { day: { value: tex("earth_atmos_2048.jpg") }, night: { value: tex("earth_lights_2048.png") },
      clouds: { value: tex("earth_clouds_1024.png", false) }, sunDir: { value: sunDir } },
    vertexShader: `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec2 vUv; varying vec3 vN; varying vec3 vView;
      void main() {
        vUv = uv; vN = normalize(mat3(modelMatrix) * normal);
        vec4 wp = modelMatrix * vec4(position, 1.0); vView = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform sampler2D day, night, clouds; uniform vec3 sunDir;
      varying vec2 vUv; varying vec3 vN; varying vec3 vView;
      void main() {
        #include <logdepthbuf_fragment>
        vec3 n = normalize(vN); float d = dot(n, sunDir);
        float cl = texture2D(clouds, vUv).r;
        vec3 dayc = mix(texture2D(day, vUv).rgb, vec3(1.0), cl * 0.85) * (0.04 + 1.25 * max(d, 0.0));
        vec3 nightc = texture2D(night, vUv).rgb * 1.6 * (1.0 - cl * 0.8);
        vec3 col = mix(nightc, dayc, smoothstep(-0.08, 0.12, d));
        float rim = pow(1.0 - max(dot(n, normalize(vView)), 0.0), 2.5);
        col += vec3(0.30, 0.55, 1.0) * rim * smoothstep(-0.25, 0.35, d) * 0.9;
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

// ------------------------------------------------------------------ lander model
function lander() {
  const g = new THREE.Group();
  const foil = new THREE.MeshStandardMaterial({ color: 0xd9a63e, metalness: 0.85, roughness: 0.35 });
  const white = new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.6 });
  const panel = new THREE.MeshStandardMaterial({ color: 0x1b2a5c, metalness: 0.4, roughness: 0.3 });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.3, 1.6, 8), foil); body.position.y = 1.9; g.add(body);
  const deck = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 0.15, 8), white); deck.position.y = 2.78; g.add(deck);
  for (let k = 0; k < 4; k++) {
    const a = (k + 0.5) * Math.PI / 2, leg = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.3), white);
    leg.position.set(Math.cos(a) * 1.55, 0.95, Math.sin(a) * 1.55); leg.rotation.set(Math.sin(a) * 0.45, 0, -Math.cos(a) * 0.45);
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.06, 12), white);
    pad.position.set(Math.cos(a) * 2.05, 0.03, Math.sin(a) * 2.05); g.add(leg, pad);
  }
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.4), white); mast.position.y = 3.5; g.add(mast);
  const dish = new THREE.Mesh(new THREE.SphereGeometry(0.45, 16, 8, 0, Math.PI * 2, 0, 1.1), white);
  dish.position.y = 4.2; dish.name = "dish"; g.add(dish);
  for (const s of [-1, 1]) {
    const p = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.04, 1.1), panel); p.position.set(s * 2.3, 2.6, 0); g.add(p);
  }
  g.traverse((o) => { o.castShadow = o.receiveShadow = !!o.isMesh; });
  return g;
}

// ------------------------------------------------------------------ the view
export function createSkyView(container) {
  container.innerHTML = "";
  const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  container.appendChild(renderer.domElement);
  const overlay = document.createElement("div"); overlay.className = "sky3d-labels"; container.appendChild(overlay);

  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x000000);
  const camera = new THREE.PerspectiveCamera(70, 1, 0.5, 30000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.minDistance = 300; controls.maxDistance = 70000; controls.enabled = false;
  controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN;

  // stars (decorative), always centred on the camera so they sit behind everything
  const stars = (() => {
    const rnd = rng(7), n = 2600, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const u = rnd() * 2 - 1, t = rnd() * Math.PI * 2, s = Math.sqrt(1 - u * u), b = 0.25 + 0.75 * rnd() ** 4;
      pos.set([s * Math.cos(t), u, s * Math.sin(t)], i * 3);
      col.set([b, b, b * (0.9 + 0.2 * rnd())], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3)); geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    const p = new THREE.Points(geo, new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, depthWrite: false }));
    p.renderOrder = -10; p.frustumCulled = false; return p;
  })();
  scene.add(stars);

  // light: the Sun (shadows from local hills and from the horizon wall), plus faint earthshine
  const sunDir = new THREE.Vector3(0, 1, 0);
  const sunLight = new THREE.DirectionalLight(0xfff4e2, 3.2);
  sunLight.castShadow = true;
  Object.assign(sunLight.shadow.camera, { left: -12000, right: 12000, top: 12000, bottom: -12000, near: 100, far: 45000 });
  sunLight.shadow.mapSize.set(4096, 4096); sunLight.shadow.bias = -0.0008; sunLight.shadow.normalBias = 18;
  scene.add(sunLight, sunLight.target);
  const earthshine = new THREE.AmbientLight(0x7f95c8, 0.16); scene.add(earthshine);

  // alt-az guide: true horizontal circle, elevation rings, compass meridians
  const guide = new THREE.Group();
  const gm = (o) => new THREE.LineBasicMaterial({ color: 0x9fb3d9, transparent: true, opacity: o, depthWrite: false });
  const circle = (el, m) => new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(
    Array.from({ length: 180 }, (_, k) => dirAzEl(k * 2, el).multiplyScalar(SKY_R * 1.01).add(new THREE.Vector3(0, EYE, 0)))), m);
  guide.add(circle(0, gm(0.35)), circle(30, gm(0.1)), circle(60, gm(0.1)));
  for (let az = 0; az < 360; az += 45) {
    guide.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(
      Array.from({ length: 31 }, (_, k) => dirAzEl(az, -30 + k * 4).multiplyScalar(SKY_R * 1.01).add(new THREE.Vector3(0, EYE, 0)))), gm(az % 90 ? 0.05 : 0.12)));
  }
  scene.add(guide);

  // Sun: bright disc + glow, true direction
  const sun = new THREE.Group();
  const sunCore = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12), new THREE.MeshBasicMaterial({ color: 0xfffbea, toneMapped: false }));
  const sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
  sun.add(sunCore, sunGlow); scene.add(sun);

  // Earth: textured sphere, oriented by the API's pole/prime-meridian vectors, lit by the true Sun direction
  const earth = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), earthMaterial(sunDir));
  scene.add(earth);

  const landerModel = lander(); landerModel.visible = false; scene.add(landerModel);

  // terrain material (procedural regolith detail on top of the real NASA heights)
  const regoNear = regolithCanvas(512, 11), regoFar = regolithCanvas(512, 23);
  const terrainMat = (cv, rep) => new THREE.MeshStandardMaterial({
    color: 0xa6a39d, map: canvasTexture(cv, rep, true), bumpMap: canvasTexture(cv, rep, false), bumpScale: 3,
    roughness: 1, metalness: 0 });
  const nearMat = terrainMat(regoNear, 1), farMat = terrainMat(regoFar, 1);
  farMat.bumpMap = null;            // bump detail aliases into speckle at kilometre distances
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x8f8c86, map: canvasTexture(regoFar, 1, true), roughness: 1,
    side: THREE.FrontSide, shadowSide: THREE.DoubleSide });
  let nearMesh = null, farMesh = null, wall = null;

  // paths
  const pathGroup = new THREE.Group(); scene.add(pathGroup);
  const lineMats = [];

  const st = { siteKey: null, r: undefined, i: 0, mode: "lander", yaw: 0, pitch: 4, fov: 70, texts: {}, visible: true,
    labels: new Map(), aimed: false, lift: 0 };

  // ---------------------------------------------------------------- terrain
  function gridGeometry(grid, tileM, skipInside, round) {
    const { n, halfExtentM: h, heightsM: z } = grid, step = (2 * h) / (n - 1);
    const pos = new Float32Array(n * n * 3), uv = new Float32Array(n * n * 2), idx = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const k = j * n + i, e = -h + i * step, nn = -h + j * step;
      pos.set([e, z[k] ?? -50, -nn], k * 3); uv.set([e / tileM, nn / tileM], k * 2);
    }
    for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      if ([a, b, c, d].some((k) => z[k] == null)) continue;
      if (round && Math.hypot(-h + (i + 0.5) * step, -h + (j + 0.5) * step) > h - step) continue;
      if (skipInside) {
        const e0 = -h + i * step, n0 = -h + j * step;
        if (e0 >= -skipInside && e0 + step <= skipInside && n0 >= -skipInside && n0 + step <= skipInside) continue;
      }
      idx.push(a, b, c, b, d, c);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3)); geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx); geo.computeVertexNormals();
    return geo;
  }
  // angle (deg, from the eye) of the far terrain's outer edge in each direction, so the wall starts where it ends
  function edgeAngle(far, azDeg) {
    const { n, halfExtentM: h, heightsM: z } = far, step = (2 * h) / (n - 1), d = dirAzEl(azDeg, 0);
    const R = h - 2.5 * step;
    const i = Math.round((d.x * R + h) / step), j = Math.round((-d.z * R + h) / step);
    const zz = z[j * n + i];
    return zz == null ? null : THREE.MathUtils.radToDeg(Math.atan2(zz - EYE, R));
  }
  function horizonWall(mask, azStep, far) {
    const n = mask.length, known = mask.filter((v) => v != null), fallback = Math.min(...known) - 4;
    const pos = [], nor = [], uv = [], idx = [];
    for (let k = 0; k <= n; k++) {
      const el = mask[k % n] ?? fallback + 3, d = dirAzEl(k * azStep, 0);
      const bottom = Math.min(el - 0.05, (far && edgeAngle(far, k * azStep)) ?? fallback) - 0.4;
      const inward = new THREE.Vector3(-d.x, 0, -d.z).multiplyScalar(0.55).add(new THREE.Vector3(0, 0.84, 0)).normalize();
      for (const e of [bottom, el]) {
        pos.push(d.x * RING_R, EYE + RING_R * Math.tan(THREE.MathUtils.degToRad(e)), d.z * RING_R);
        nor.push(inward.x, inward.y, inward.z); uv.push(k * 0.35, (e - bottom) * 2.5);
      }
      if (k < n) { const a = 2 * k; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2)); geo.setIndex(idx);
    return geo;
  }
  async function setSite(site) {
    const key = `${site.lat},${site.lon}`;
    if (key === st.siteKey) return;
    const wasAtSite = Boolean(nearMesh);
    st.siteKey = key; st.aimed = false; st.far = null;
    const get = async (p) => {
      const response = await fetch(apiUrl(`api/local_terrain?latitudeDeg=${site.lat}&longitudeEastDeg=${site.lon}&halfExtentM=${p.half}&n=${p.n}`));
      if (!response.ok) throw new Error(`Terrain API returned ${response.status}`);
      return response.json();
    };
    let near, far;
    try { [near, far] = await Promise.all([get(NEAR), get(FAR)]); }
    catch (error) {
      if (key === st.siteKey) throw error;
      return;
    }
    if (key !== st.siteKey) return;
    for (const m of [nearMesh, farMesh]) if (m) { scene.remove(m); m.geometry.dispose(); }
    nearMesh = new THREE.Mesh(gridGeometry(near, 40), nearMat);
    farMesh = new THREE.Mesh(gridGeometry(far, 700, NEAR.half - 20, true), farMat);
    for (const m of [nearMesh, farMesh]) { m.receiveShadow = m.castShadow = true; scene.add(m); }
    st.far = far; buildWall();
    if (wasAtSite && st.mode === "lander" && !flight) {
      camera.position.set(0, 360, 180);
      camera.lookAt(0, EYE, 0);
      moveCamera("lander");
    }
  }
  function buildWall() {
    if (wall) { scene.remove(wall); wall.geometry.dispose(); }
    wall = null;
    if (!st.r || !st.far) return;
    wall = new THREE.Mesh(horizonWall(st.r.horizon.elevationDeg, st.r.horizon.azimuthStepDeg, st.far), wallMat);
    wall.castShadow = true;
    wall.visible = st.mode === "lander";
    scene.add(wall);
  }

  // ---------------------------------------------------------------- data
  function setResult(r) {
    if (r === st.r) return;
    st.r = r; st.aimed = false;
    buildWall();

    for (const line of pathGroup.children) { line.geometry.dispose(); line.material.dispose(); }
    pathGroup.clear(); lineMats.length = 0;
    sun.visible = earth.visible = Boolean(r);
    if (!r) {
      for (const el of st.labels.values()) el.style.display = "none";
      return;
    }
    const s = r.series;
    for (const [body, color] of [["sun", SUN_C], ["earth", EARTH_C]]) {
      const enu = s[`${body}Enu`], vis = s[`${body}Visible`], seen = [], hidden = [];
      for (let k = 1; k < enu.length; k++) {
        const a = w(enu[k - 1]).multiplyScalar(PATH_R), b = w(enu[k]).multiplyScalar(PATH_R);
        a.y += EYE; b.y += EYE;
        (vis[k - 1] && vis[k] ? seen : hidden).push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
      const make = (arr, hiddenPart) => {
        if (!arr.length) return;
        const geo = new LineSegmentsGeometry().setPositions(arr);
        const mat = new LineMaterial({ color, linewidth: hiddenPart ? 1.6 : 2.6, transparent: true,
          opacity: hiddenPart ? 0.55 : 0.95, dashed: hiddenPart, dashSize: 70, gapSize: 70,
          depthTest: !hiddenPart, depthWrite: false });
        const line = new LineSegments2(geo, mat);
        if (hiddenPart) line.computeLineDistances();
        line.renderOrder = hiddenPart ? 5 : 1;
        lineMats.push(mat); pathGroup.add(line);
      };
      make(seen, false); make(hidden, true);
    }
    resize();
  }

  function setTime(i) {
    st.i = i;
    const r = st.r; if (!r) return;
    const s = r.series, scale = st.mode === "bird" ? BIRD_SCALE : 1;
    sunDir.copy(w(s.sunEnu[i])).normalize();
    const eDir = w(s.earthEnu[i]).normalize();
    sun.position.copy(sunDir).multiplyScalar(SKY_R).add(new THREE.Vector3(0, EYE, 0));
    const sunR = SKY_R * Math.tan(THREE.MathUtils.degToRad(s.sunAngularRadiusDeg[i])) * scale;
    sunCore.scale.setScalar(sunR); sunGlow.scale.setScalar(sunR * 34);
    earth.position.copy(eDir).multiplyScalar(SKY_R).add(new THREE.Vector3(0, EYE, 0));
    earth.scale.setScalar(SKY_R * Math.tan(THREE.MathUtils.degToRad(s.earthAngularRadiusDeg[i])) * scale);
    if (s.earthNorthPoleEnu) {
      const P = w(s.earthPrimeMeridianEnu[i]).normalize(), N = w(s.earthNorthPoleEnu[i]).normalize();
      const Z = new THREE.Vector3().crossVectors(N, P).negate();          // sphere-local -Z = 90°E
      earth.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(P, N, Z));
    }
    sunLight.position.copy(sunDir).multiplyScalar(20000); sunLight.target.position.set(0, 0, 0);
    earthshine.intensity = s.sunVisible[i] ? (st.mode === "bird" ? 0.3 : 0.14) : 0.8;     // night: brightened so the ground stays readable
    // the dish follows Earth
    const dish = landerModel.getObjectByName("dish");
    dish.lookAt(earth.position); dish.rotateX(Math.PI / 2);
    if (!st.aimed && st.mode === "lander" && !flight) { aim("earth", false); st.aimed = true; }
  }

  // ---------------------------------------------------------------- camera
  function applyLanderCamera() {
    const d = dirAzEl(st.yaw, st.pitch);
    camera.position.set(0, EYE + st.lift, 0); camera.fov = st.fov; camera.near = 0.5; camera.far = 30000;
    camera.lookAt(d.add(camera.position)); camera.updateProjectionMatrix();
  }
  let flight = null;
  function moveCamera(mode, animate = true) {
    const from = camera.position.clone(), fromQ = camera.quaternion.clone(), fromFov = camera.fov;
    st.mode = mode;
    controls.enabled = false;
    landerModel.visible = mode === "bird";
    // The synthetic skyline is meaningful from the lander's eye height only.
    if (wall) wall.visible = mode === "lander";
    if (mode === "bird") {
      camera.fov = 55; camera.near = .5; camera.far = 100000; camera.updateProjectionMatrix();
      camera.position.set(2200, 3600, 4600); controls.target.set(0, 0, 0); camera.lookAt(controls.target);
    } else applyLanderCamera();
    setTime(st.i);
    if (!animate || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      flight = null;
      controls.enabled = mode === "bird";
      return;
    }
    flight = {start:performance.now(), from, fromQ, fromFov, to:camera.position.clone(), toQ:camera.quaternion.clone(), toFov:camera.fov};
    camera.position.copy(from);
    camera.quaternion.copy(fromQ);
    camera.fov = fromFov;
    camera.updateProjectionMatrix();
  }
  function setMode(mode) {
    if (mode !== st.mode) moveCamera(mode);
  }
  function aim(body, zoom = true) {
    if (!st.r) return;
    const s = st.r.series, i = st.i;
    flight = null;
    if (st.mode !== "lander") moveCamera("lander", false);
    controls.enabled = false;
    st.yaw = s[`${body}AzimuthDeg`][i]; st.pitch = s[`${body}ElevationDeg`][i];
    if (zoom) st.fov = body === "earth" ? Math.max(2.5, s.earthAngularRadiusDeg[i] * 5) : 20;
    else st.fov = 70;
    applyLanderCamera();
  }
  // drag to look around (lander view); wheel = zoom like binoculars
  let drag = null;
  renderer.domElement.addEventListener("pointerdown", (e) => {
    if (st.mode !== "lander" || flight) return;
    drag = { x: e.clientX, y: e.clientY, yaw: st.yaw, pitch: st.pitch };
    renderer.domElement.setPointerCapture(e.pointerId);
  });
  renderer.domElement.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const k = st.fov / renderer.domElement.clientHeight;
    st.yaw = (drag.yaw - (e.clientX - drag.x) * k + 360) % 360;
    st.pitch = Math.max(-60, Math.min(89, drag.pitch + (e.clientY - drag.y) * k));
    applyLanderCamera();
  });
  renderer.domElement.addEventListener("pointerup", () => { drag = null; });
  renderer.domElement.addEventListener("wheel", (e) => {
    if (st.mode !== "lander" || flight) return;
    e.preventDefault();
    st.fov = Math.max(1.5, Math.min(100, st.fov * Math.exp(e.deltaY * 0.0012)));
    applyLanderCamera();
  }, { passive: false });

  // ---------------------------------------------------------------- labels
  function label(key, cls) {
    if (!st.labels.has(key)) {
      const el = document.createElement("div"); el.className = `sky3d-label ${cls}`; overlay.appendChild(el);
      st.labels.set(key, el);
    }
    return st.labels.get(key);
  }
  const tmp = new THREE.Vector3();
  function place(el, pos, text) {
    tmp.copy(pos).project(camera);
    const W = container.clientWidth, H = container.clientHeight;
    const show = tmp.z < 1 && Math.abs(tmp.x) < 1.05 && Math.abs(tmp.y) < 1.05;
    el.style.display = show ? "" : "none";
    if (!show) return;
    el.style.left = `${((tmp.x + 1) / 2) * W}px`; el.style.top = `${((1 - tmp.y) / 2) * H}px`;
    if (el.textContent !== text) el.textContent = text;
  }
  function updateLabels() {
    const r = st.r, t = st.texts; if (!r) return;
    const s = r.series, i = st.i, off = st.mode === "bird" ? BIRD_SCALE : 1;
    const lift = (p, rad) => p.clone().add(new THREE.Vector3(0, rad, 0));
    place(label("sun", "sun"), lift(sun.position, sunCore.scale.x * 3 + 40 * off), s.sunVisible[i] ? t.sun : t.sunHidden);
    place(label("earth", "earth"), lift(earth.position, earth.scale.x * 1.4 + 20 * off), s.earthVisible[i] ? t.earth : t.earthHidden);
    label("sun", "sun").classList.toggle("hidden", !s.sunVisible[i]);
    label("earth", "earth").classList.toggle("hidden", !s.earthVisible[i]);
    for (const [name, az] of (t.compass || [])) place(label(`c${az}`, "compass"), dirAzEl(az, -0.6).multiplyScalar(SKY_R).setY(EYE - 40), name);
    const lb = label("lander", "lander");
    if (st.mode === "bird") place(lb, new THREE.Vector3(0, 60, 0), t.lander); else lb.style.display = "none";
  }

  // ---------------------------------------------------------------- loop
  function resize() {
    const W = container.clientWidth, H = container.clientHeight;
    if (!W || !H) return;
    renderer.setSize(W, H, false); camera.aspect = W / H; camera.updateProjectionMatrix();
    for (const m of lineMats) m.resolution.set(W * renderer.getPixelRatio(), H * renderer.getPixelRatio());
  }
  new ResizeObserver(resize).observe(container);
  renderer.setAnimationLoop(now => {
    if (!container.offsetParent) return;          // tab hidden
    if (flight) {
      const t = THREE.MathUtils.clamp((now-flight.start)/900,0,1);
      const ease = THREE.MathUtils.smoothstep(t,0,1);
      camera.position.lerpVectors(flight.from,flight.to,ease);
      camera.quaternion.copy(flight.fromQ).slerp(flight.toQ,ease);
      camera.fov = THREE.MathUtils.lerp(flight.fromFov,flight.toFov,ease);
      camera.updateProjectionMatrix();
      if (t === 1) { flight = null; controls.enabled = st.mode === "bird"; }
    } else if (st.mode === "bird") controls.update();
    stars.position.copy(camera.position); stars.scale.setScalar(camera.far * 0.8);
    renderer.render(scene, camera);
    updateLabels();
  });
  applyLanderCamera();

  return {
    setSite, setResult, setTime, setMode, aim,
    setTexts(t) { st.texts = t; },
    get mode() { return st.mode; },
    resetView() { st.fov = 70; st.pitch = 4; moveCamera(st.mode); },
    // Scripted lander camera for the presentation: heading, pitch, field of view, and height above eye level.
    look({ yaw = st.yaw, pitch = st.pitch, fov = st.fov, lift = st.lift } = {}) {
      if (st.mode !== "lander") moveCamera("lander", false);
      flight = null; st.aimed = true;
      Object.assign(st, { yaw, pitch, fov, lift });
      applyLanderCamera();
    },
    get view() { return { yaw: st.yaw, pitch: st.pitch, fov: st.fov, lift: st.lift }; },
  };
}
