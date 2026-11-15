/**
 * Whole-Moon wireframe terrain: one quadtree cube-sphere, one height function.
 *
 * - Tessellation: six cube faces, each a quadtree of 32×32-cell patches mapped
 *   to the sphere with an equal-angle warp. The south pole sits at the centre
 *   of a face, so cells stay near-square where a lat/lon grid degenerates.
 * - LOD: a patch splits when its cells grow past a screen-pixel size and
 *   merges back at a smaller size (hysteresis). Patches are built once, cached
 *   and reused; zooming only ever builds the handful of patches that are new.
 * - Continuity: neighbouring leaves never differ by more than one level, and
 *   the finer patch drops every other vertex along that edge, so both sides
 *   share exactly the same edge vertices. No cracks, no skirts.
 * - A new selection is shown only once every patch in it is built, so the
 *   displayed surface is always a complete, stitched sphere.
 * - Occlusion: each patch is an opaque depth-writing fill with the wire lines
 *   drawn on top. The depth buffer hides the far side and anything behind a
 *   ridge; there is no camera-dependent culling of the tessellation.
 */
import * as T from 'three';
import type { HeightField } from './heightField';

/** Cells along each patch edge. Even, because stitching works on 2×2 blocks. */
const GRID = 32;
const VERTS = GRID + 1;
/** Deepest quadtree level: (quarter circumference) / (32 · 2^12) ≈ 21 m cells. */
export const MOON_MESH_MAX_LEVEL = 12;

/**
 * A patch splits when its cells would be wider than viewportHeight / 30 on
 * screen (kept between 24 and 44 px), so a view shows a similar number of
 * cells on any display. It merges back at 73 % of that size, which means a
 * level never flips on a small zoom or orbit change.
 */
const SPLIT_VIEW_FRACTION = 1 / 30;
const SPLIT_MIN_PX = 24;
const SPLIT_MAX_PX = 44;
const MERGE_RATIO = 0.73;

/** Time allowed per frame for building patches that are not cached yet. */
const BUILD_BUDGET_MS = 6;
const CACHE_LIMIT = 520;
const CACHE_KEEP = 400;

/** Draw the diagonal of every triangle as well as the grid lines. */
const WIRE_DIAGONALS = false;
const WIRE_COLOR = 0x89b6ba;
/** Fill = dark base tinted by the elevation ramp (−8 km … +7 km). */
const FILL_BASE = new T.Color('#0a121c');
const FILL_TINT = 0.34;
const RAMP_LOW = new T.Color('#234d70');
const RAMP_MID = new T.Color('#6aa4a2');
const RAMP_HIGH = new T.Color('#e7d29c');

/**
 * Depth offset that keeps the fill behind its own wire lines. The renderer
 * uses a logarithmic depth buffer, which writes gl_FragDepth and therefore
 * ignores GL polygon offset, so the same slope-scaled offset is applied to
 * the fill's fragment depth instead.
 */
const FILL_DEPTH_SLOPE = 2;
const FILL_DEPTH_RELATIVE = 4e-5;

// Cube faces: outward normal n and tangents a, b with a × b = n.
const FACE_N = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [-1, 0, 0], [0, -1, 0], [0, 0, -1]];
const FACE_A = [[0, 1, 0], [0, 0, 1], [1, 0, 0], [0, 0, 1], [1, 0, 0], [0, 1, 0]];
const FACE_B = [[0, 0, 1], [1, 0, 0], [0, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 0]];

const QUARTER_PI = Math.PI / 4;

/** Equal-angle warp from face parameter (−1…1) to the cube face coordinate. */
function warp(t: number): number {
  // tan(π/4) is not exactly 1 in floating point; face edges must be, so the
  // same edge computed from either face gives identical vertices.
  return t === 1 ? 1 : t === -1 ? -1 : Math.tan(t * QUARTER_PI);
}

function nodeKey(face: number, level: number, ix: number, iy: number): number {
  return ((level * 6 + face) * 8192 + ix) * 8192 + iy;
}

// Edge directions and the matching stitch-mask bits: −u, +u, −v, +v.
const EDGE_DX = [-1, 1, 0, 0];
const EDGE_DY = [0, 0, -1, 1];
const WEST = 1;
const EAST = 2;
const SOUTH = 4;
const NORTH = 8;

type IndexVariant = {
  triangles: T.BufferAttribute;
  lines: T.BufferAttribute;
  triangleCount: number;
  segmentCount: number;
};

/**
 * Indices for one patch. Each 2×2 block of cells is a fan around its centre
 * vertex. On an edge that borders a coarser patch (`mask` bit set) the fan
 * skips the mid-edge vertex, leaving only the vertices the coarser patch has.
 */
function buildIndexVariant(mask: number): IndexVariant {
  const triangles: number[] = [];
  const edges = new Set<number>();
  const lines: number[] = [];
  const vertex = (i: number, j: number) => j * VERTS + i;
  const addEdge = (p: number, q: number) => {
    const lo = Math.min(p, q);
    const hi = Math.max(p, q);
    const id = lo * VERTS * VERTS + hi;
    if (edges.has(id)) return;
    edges.add(id);
    const diagonal = lo % VERTS !== hi % VERTS && Math.floor(lo / VERTS) !== Math.floor(hi / VERTS);
    if (diagonal && !WIRE_DIAGONALS) return;
    lines.push(lo, hi);
  };
  const blocks = GRID / 2;
  const ring: number[] = [];
  for (let bj = 0; bj < blocks; bj++) {
    for (let bi = 0; bi < blocks; bi++) {
      const cx = 2 * bi + 1;
      const cy = 2 * bj + 1;
      const centre = vertex(cx, cy);
      ring.length = 0;
      ring.push(vertex(cx - 1, cy - 1));
      if (!(mask & SOUTH && bj === 0)) ring.push(vertex(cx, cy - 1));
      ring.push(vertex(cx + 1, cy - 1));
      if (!(mask & EAST && bi === blocks - 1)) ring.push(vertex(cx + 1, cy));
      ring.push(vertex(cx + 1, cy + 1));
      if (!(mask & NORTH && bj === blocks - 1)) ring.push(vertex(cx, cy + 1));
      ring.push(vertex(cx - 1, cy + 1));
      if (!(mask & WEST && bi === 0)) ring.push(vertex(cx - 1, cy));
      for (let k = 0; k < ring.length; k++) {
        const p = ring[k];
        const q = ring[(k + 1) % ring.length];
        triangles.push(centre, p, q);
        addEdge(centre, p);
        addEdge(p, q);
      }
    }
  }
  return {
    triangles: new T.BufferAttribute(new Uint16Array(triangles), 1),
    lines: new T.BufferAttribute(new Uint16Array(lines), 1),
    triangleCount: triangles.length / 3,
    segmentCount: lines.length / 2,
  };
}

type Patch = {
  key: number;
  level: number;
  fill: T.Mesh<T.BufferGeometry, T.MeshBasicMaterial | T.MeshStandardMaterial>;
  wire: T.LineSegments<T.BufferGeometry, T.LineBasicMaterial>;
  /** Stitch mask the index buffers are currently set to (−1 = none yet). */
  mask: number;
  lastUsed: number;
};

export type MoonMeshLayer = 'imagery' | 'elevation' | 'wireframe';

type Leaf = { face: number; level: number; ix: number; iy: number; key: number; mask: number };

export type MoonMeshStats = {
  patches: number;
  triangles: number;
  lineSegments: number;
  /** Displayed patches per quadtree level, index = level. */
  perLevel: number[];
  finestLevel: number;
  cached: number;
  /** True while a newer selection is still being built. */
  pending: boolean;
};

export type MoonMesh = {
  group: T.Group;
  /** Re-evaluate LOD for this camera. Returns true when the displayed set changed. */
  update: (camera: T.PerspectiveCamera, viewportHeightPx: number) => boolean;
  /** Nearest hit of the ray with the displayed surface, in world space. */
  intersect: (raycaster: T.Raycaster) => T.Vector3 | undefined;
  /** Level of the displayed patch under a direction from the Moon's centre. */
  levelAt: (dx: number, dy: number, dz: number) => number;
  /** Nominal cell edge of a level in metres. */
  cellMeters: (level: number) => number;
  stats: () => MoonMeshStats;
  setLayer: (layer: MoonMeshLayer) => void;
  invalidateHeights: (intersects: (center: T.Vector3, radius: number) => boolean) => void;
  dispose: () => void;
};

export function createMoonMesh(options: {
  radius: number;
  center: T.Vector3;
  field: HeightField;
  shadedMaterial?: T.MeshStandardMaterial;
}): MoonMesh {
  const { radius, field } = options;
  const cx = options.center.x;
  const cy = options.center.y;
  const cz = options.center.z;
  const group = new T.Group();
  group.name = 'moon-mesh';

  const fillMaterial = new T.MeshBasicMaterial({
    vertexColors: true,
    // Effective only without a logarithmic depth buffer; see the shader patch.
    polygonOffset: true,
    polygonOffsetFactor: FILL_DEPTH_SLOPE,
    polygonOffsetUnits: 2,
  });
  fillMaterial.customProgramCacheKey = () => 'moon-mesh-fill';
  fillMaterial.onBeforeCompile = shader => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <logdepthbuf_fragment>', `
      #if defined( USE_LOGARITHMIC_DEPTH_BUFFER )
        float fillDepth = vFragDepth * ${(1 + FILL_DEPTH_RELATIVE).toFixed(6)}
          + ${FILL_DEPTH_SLOPE.toFixed(1)} * fwidth( vFragDepth );
        gl_FragDepth = vIsPerspective == 0.0 ? gl_FragCoord.z : log2( fillDepth ) * logDepthBufFC * 0.5;
      #endif
    `);
  };
  const wireMaterial = new T.LineBasicMaterial({ color: WIRE_COLOR });
  const shaded = options.shadedMaterial;
  const elevationMaterial = new T.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
  elevationMaterial.onBeforeCompile = shader => {
    // Recover the elevation ramp from the tinted vertex colors used for the wireframe fill.
    const base = [FILL_BASE.r, FILL_BASE.g, FILL_BASE.b].map(channel => channel.toFixed(9)).join(', ');
    shader.vertexShader = shader.vertexShader.replace('#include <color_vertex>', `
      #include <color_vertex>
      vColor.rgb = vec3(${base}) + (vColor.rgb - vec3(${base})) / ${FILL_TINT};
    `);
  };
  let layer: MoonMeshLayer = shaded ? 'imagery' : 'wireframe';

  function applyLayer(patch: Patch) {
    patch.fill.material = layer === 'elevation' ? elevationMaterial
      : layer === 'imagery' && shaded ? shaded : fillMaterial;
    if (layer === 'wireframe') group.add(patch.wire);
    else group.remove(patch.wire);
  }

  function setLayer(next: MoonMeshLayer) {
    if (next === layer) return;
    layer = next;
    for (const patch of shown.values()) applyLayer(patch);
  }

  const variants: (IndexVariant | undefined)[] = [];
  const variant = (mask: number) => (variants[mask] ??= buildIndexVariant(mask));

  const cache = new Map<number, Patch>();
  let shown = new Map<number, Patch>();
  /** Nodes split by the distance rule last time; this is the hysteresis state. */
  let splitByDistance = new Set<number>();
  let frame = 0;
  let pending = false;
  let lastView = '';

  const cellMeters = (level: number) => (Math.PI / 2) * radius / (GRID * 2 ** level);

  // ---- patch construction -------------------------------------------------

  const rampColor = new T.Color();
  const warpedU = new Float64Array(VERTS);

  function buildPatch(face: number, level: number, ix: number, iy: number, key: number): Patch {
    const n = FACE_N[face];
    const a = FACE_A[face];
    const b = FACE_B[face];
    const size = 2 / 2 ** level;
    const u0 = -1 + ix * size;
    const v0 = -1 + iy * size;
    const step = size / GRID;

    // Positions are stored relative to the patch centre so 32-bit floats keep
    // sub-metre precision everywhere on a 1737 km body.
    const wuMid = warp(u0 + size / 2);
    const wvMid = warp(v0 + size / 2);
    let px = n[0] + wuMid * a[0] + wvMid * b[0];
    let py = n[1] + wuMid * a[1] + wvMid * b[1];
    let pz = n[2] + wuMid * a[2] + wvMid * b[2];
    let inv = 1 / Math.sqrt(px * px + py * py + pz * pz);
    const midRadius = radius + field.height(px * inv, py * inv, pz * inv);
    const ox = cx + px * inv * midRadius;
    const oy = cy + py * inv * midRadius;
    const oz = cz + pz * inv * midRadius;

    const positions = new Float32Array(VERTS * VERTS * 3);
    const colors = new Float32Array(VERTS * VERTS * 3);
    const directions = shaded ? new Float32Array(positions.length) : undefined;
    const normals = shaded ? new Float32Array(positions.length) : undefined;
    const radial = new T.Vector3(), east = new T.Vector3(), north = new T.Vector3();
    const normal = new T.Vector3(), sample = new T.Vector3();
    const sampleStep = 15;
    function heightAlong(tangent: T.Vector3, distance: number) {
      sample.copy(radial).addScaledVector(tangent, distance / radius).normalize();
      return field.height(sample.x, sample.y, sample.z);
    }
    for (let i = 0; i < VERTS; i++) warpedU[i] = warp(u0 + i * step);
    let maxSq = 0;
    let o = 0;
    for (let j = 0; j < VERTS; j++) {
      const wv = warp(v0 + j * step);
      for (let i = 0; i < VERTS; i++, o += 3) {
        const wu = warpedU[i];
        px = n[0] + wu * a[0] + wv * b[0];
        py = n[1] + wu * a[1] + wv * b[1];
        pz = n[2] + wu * a[2] + wv * b[2];
        inv = 1 / Math.sqrt(px * px + py * py + pz * pz);
        const dx = px * inv;
        const dy = py * inv;
        const dz = pz * inv;
        if (directions) directions.set([dx,dy,dz],o);
        const h = field.height(dx, dy, dz);
        if (normals) {
          // Sample a common surface at shared vertices, independent of patch LOD.
          radial.set(dx, dy, dz);
          normal.copy(radial);
          if (dy > 0.998) {
            east.set(dy, -dx, 0).normalize();
            north.crossVectors(radial, east);
            const slopeEast = (heightAlong(east, sampleStep) - heightAlong(east, -sampleStep)) / (2 * sampleStep);
            const slopeNorth = (heightAlong(north, sampleStep) - heightAlong(north, -sampleStep)) / (2 * sampleStep);
            normal.addScaledVector(east, -slopeEast).addScaledVector(north, -slopeNorth).normalize();
          }
          normal.toArray(normals, o);
        }
        const r = radius + h;
        const x = cx + dx * r - ox;
        const y = cy + dy * r - oy;
        const z = cz + dz * r - oz;
        positions[o] = x;
        positions[o + 1] = y;
        positions[o + 2] = z;
        maxSq = Math.max(maxSq, x * x + y * y + z * z);
        const t = Math.min(1, Math.max(0, (h + 8000) / 15000));
        if (t < 0.5) rampColor.copy(RAMP_LOW).lerp(RAMP_MID, t * 2);
        else rampColor.copy(RAMP_MID).lerp(RAMP_HIGH, t * 2 - 1);
        colors[o] = FILL_BASE.r + (rampColor.r - FILL_BASE.r) * FILL_TINT;
        colors[o + 1] = FILL_BASE.g + (rampColor.g - FILL_BASE.g) * FILL_TINT;
        colors[o + 2] = FILL_BASE.b + (rampColor.b - FILL_BASE.b) * FILL_TINT;
      }
    }

    const position = new T.BufferAttribute(positions, 3);
    const bounds = new T.Sphere(new T.Vector3(), Math.sqrt(maxSq));
    const fillGeometry = new T.BufferGeometry();
    fillGeometry.setAttribute('position', position);
    fillGeometry.setAttribute('color', new T.BufferAttribute(colors, 3));
    if (directions) fillGeometry.setAttribute('moonDirection', new T.BufferAttribute(directions, 3));
    if (normals) fillGeometry.setAttribute('normal', new T.BufferAttribute(normals, 3));
    fillGeometry.boundingSphere = bounds;
    const wireGeometry = new T.BufferGeometry();
    wireGeometry.setAttribute('position', position);
    wireGeometry.boundingSphere = bounds.clone();

    const fill = new T.Mesh(fillGeometry, shaded ?? fillMaterial);
    const wire = new T.LineSegments(wireGeometry, wireMaterial);
    for (const object of [fill, wire]) {
      object.position.set(ox, oy, oz);
      object.matrixAutoUpdate = false;
      object.updateMatrix();
    }
    wire.renderOrder = 1;
    // Clicks are resolved against the fill; the lines are display only.
    wire.raycast = () => {};
    return { key, level, fill, wire, mask: -1, lastUsed: frame };
  }

  function disposePatch(patch: Patch) {
    // Index buffers are shared between patches; detach them so disposing this
    // geometry does not delete a buffer other patches still draw with.
    patch.fill.geometry.index = null;
    patch.wire.geometry.index = null;
    patch.fill.geometry.dispose();
    patch.wire.geometry.dispose();
  }

  // ---- selection ----------------------------------------------------------

  /** Face/cell containing a direction, at a given level. */
  const located = { face: 0, u: 0, v: 0 };
  function locate(px: number, py: number, pz: number) {
    const ax = Math.abs(px);
    const ay = Math.abs(py);
    const az = Math.abs(pz);
    const face = ax >= ay && ax >= az ? (px > 0 ? 0 : 3) : ay >= az ? (py > 0 ? 1 : 4) : (pz > 0 ? 2 : 5);
    const n = FACE_N[face];
    const a = FACE_A[face];
    const b = FACE_B[face];
    const pn = px * n[0] + py * n[1] + pz * n[2];
    located.face = face;
    located.u = Math.atan((px * a[0] + py * a[1] + pz * a[2]) / pn) / QUARTER_PI;
    located.v = Math.atan((px * b[0] + py * b[1] + pz * b[2]) / pn) / QUARTER_PI;
  }

  const cellIndex = (t: number, count: number) =>
    Math.min(count - 1, Math.max(0, Math.floor((t + 1) * 0.5 * count)));

  /** Same-level neighbour across an edge, following the cube onto other faces. */
  const neighbour = { face: 0, ix: 0, iy: 0 };
  const crossFace = new Map<number, number>();
  function findNeighbour(face: number, level: number, ix: number, iy: number, edge: number) {
    const count = 2 ** level;
    const jx = ix + EDGE_DX[edge];
    const jy = iy + EDGE_DY[edge];
    if (jx >= 0 && jx < count && jy >= 0 && jy < count) {
      neighbour.face = face;
      neighbour.ix = jx;
      neighbour.iy = jy;
      return;
    }
    const memoKey = nodeKey(face, level, ix, iy) * 4 + edge;
    let packed = crossFace.get(memoKey);
    if (packed === undefined) {
      // Step just past the face edge at this patch's centre line and see
      // which face and cell that direction falls in.
      const size = 2 / count;
      const beyond = 1 + 1e-6;
      const u = edge === 0 ? -beyond : edge === 1 ? beyond : -1 + (ix + 0.5) * size;
      const v = edge === 2 ? -beyond : edge === 3 ? beyond : -1 + (iy + 0.5) * size;
      const n = FACE_N[face];
      const a = FACE_A[face];
      const b = FACE_B[face];
      const wu = warp(u);
      const wv = warp(v);
      locate(n[0] + wu * a[0] + wv * b[0], n[1] + wu * a[1] + wv * b[1], n[2] + wu * a[2] + wv * b[2]);
      packed = (located.face * 8192 + cellIndex(located.u, count)) * 8192 + cellIndex(located.v, count);
      if (crossFace.size > 20000) crossFace.clear();
      crossFace.set(memoKey, packed);
    }
    neighbour.iy = packed % 8192;
    neighbour.ix = Math.floor(packed / 8192) % 8192;
    neighbour.face = Math.floor(packed / (8192 * 8192));
  }

  /** Leaves for a camera at `q` (relative to the Moon's centre), balanced and with stitch masks. */
  function select(qx: number, qy: number, qz: number, pixelAngle: number, splitPx: number): Leaf[] {
    const qLength = Math.max(1, Math.hypot(qx, qy, qz));
    // Camera nadir in each face's (u, v); outside ±1 when it is over another face.
    const camU: number[] = [];
    const camV: number[] = [];
    for (let face = 0; face < 6; face++) {
      const n = FACE_N[face];
      const a = FACE_A[face];
      const b = FACE_B[face];
      const pn = (qx * n[0] + qy * n[1] + qz * n[2]) / qLength;
      const pa = (qx * a[0] + qy * a[1] + qz * a[2]) / qLength;
      const pb = (qx * b[0] + qy * b[1] + qz * b[2]) / qLength;
      camU[face] = pn > 1e-9 ? Math.atan(pa / pn) / QUARTER_PI : Math.sign(pa) * 2;
      camV[face] = pn > 1e-9 ? Math.atan(pb / pn) / QUARTER_PI : Math.sign(pb) * 2;
    }

    /** Distance from the camera to the closest point of a patch's surface. */
    function nearestDistance(face: number, u0: number, v0: number, size: number): number {
      const n = FACE_N[face];
      const a = FACE_A[face];
      const b = FACE_B[face];
      const wu = warp(Math.min(u0 + size, Math.max(u0, camU[face])));
      const wv = warp(Math.min(v0 + size, Math.max(v0, camV[face])));
      const px = n[0] + wu * a[0] + wv * b[0];
      const py = n[1] + wu * a[1] + wv * b[1];
      const pz = n[2] + wu * a[2] + wv * b[2];
      const inv = 1 / Math.sqrt(px * px + py * py + pz * pz);
      const r = radius + field.height(px * inv, py * inv, pz * inv);
      return Math.max(1, Math.hypot(qx - px * inv * r, qy - py * inv * r, qz - pz * inv * r));
    }

    const nextByDistance = new Set<number>();
    /** Every node that is split this frame, by distance or to keep the tree balanced. */
    const split = new Set<number>();
    const queue: number[] = [];
    const enqueue = (face: number, level: number, ix: number, iy: number) => {
      queue.push(face, level, ix, iy);
    };

    function visit(face: number, level: number, ix: number, iy: number) {
      const key = nodeKey(face, level, ix, iy);
      if (level < MOON_MESH_MAX_LEVEL) {
        const size = 2 / 2 ** level;
        const u = -1 + ix * size, v = -1 + iy * size;
        const distance = nearestDistance(face, u, v, size);
        const cellPx = cellMeters(level) / (distance * pixelAngle);
        const polar = shaded && face === 1 && u < 0.075 && u + size > -0.075 && v < 0.075 && v + size > -0.075;
        const threshold = polar ? Math.min(splitPx, 7) : splitPx;
        if (cellPx > threshold * (splitByDistance.has(key) ? MERGE_RATIO : 1)) {
          nextByDistance.add(key);
          split.add(key);
          for (let c = 0; c < 4; c++) visit(face, level + 1, ix * 2 + (c & 1), iy * 2 + (c >> 1));
          return;
        }
      }
      enqueue(face, level, ix, iy);
    }
    for (let face = 0; face < 6; face++) visit(face, 0, 0, 0);
    splitByDistance = nextByDistance;

    // Balance: the patch across any edge of a leaf may be at most one level
    // coarser. Split coarser neighbours until that holds everywhere.
    while (queue.length) {
      const iy = queue.pop()!;
      const ix = queue.pop()!;
      const level = queue.pop()!;
      const face = queue.pop()!;
      if (level < 2 || split.has(nodeKey(face, level, ix, iy))) continue;
      for (let edge = 0; edge < 4; edge++) {
        findNeighbour(face, level, ix, iy, edge);
        const nf = neighbour.face;
        const nx = neighbour.ix;
        const ny = neighbour.iy;
        // The neighbour's parent (level − 1) must exist: split all its ancestors.
        for (let l = 0; l < level - 1; l++) {
          const shift = level - l;
          const ax = nx >> shift;
          const ay = ny >> shift;
          const ancestor = nodeKey(nf, l, ax, ay);
          if (split.has(ancestor)) continue;
          split.add(ancestor);
          for (let c = 0; c < 4; c++) enqueue(nf, l + 1, ax * 2 + (c & 1), ay * 2 + (c >> 1));
        }
      }
    }

    const leaves: Leaf[] = [];
    function collect(face: number, level: number, ix: number, iy: number) {
      const key = nodeKey(face, level, ix, iy);
      if (split.has(key)) {
        for (let c = 0; c < 4; c++) collect(face, level + 1, ix * 2 + (c & 1), iy * 2 + (c >> 1));
        return;
      }
      let mask = 0;
      if (level > 0) {
        for (let edge = 0; edge < 4; edge++) {
          findNeighbour(face, level, ix, iy, edge);
          // No same-level node across this edge means a coarser leaf is there.
          if (!split.has(nodeKey(neighbour.face, level - 1, neighbour.ix >> 1, neighbour.iy >> 1))) {
            mask |= 1 << edge;
          }
        }
      }
      leaves.push({ face, level, ix, iy, key, mask });
    }
    for (let face = 0; face < 6; face++) collect(face, 0, 0, 0);
    return leaves;
  }

  // ---- display ------------------------------------------------------------

  function update(camera: T.PerspectiveCamera, viewportHeightPx: number): boolean {
    const height = Math.max(1, viewportHeightPx);
    const qx = camera.position.x - cx;
    const qy = camera.position.y - cy;
    const qz = camera.position.z - cz;
    const view = `${qx},${qy},${qz},${camera.fov},${camera.zoom},${height}`;
    if (!pending && view === lastView) return false;
    lastView = view;
    frame++;

    // Angle one CSS pixel subtends at the view centre.
    const pixelAngle = 2 * Math.tan(T.MathUtils.degToRad(camera.fov) / 2) / camera.zoom / height;
    const splitPx = Math.min(SPLIT_MAX_PX, Math.max(SPLIT_MIN_PX, height * SPLIT_VIEW_FRACTION));
    const leaves = select(qx, qy, qz, pixelAngle, splitPx);

    // Build what is missing, coarse levels first, within the frame budget.
    // The very first selection is built in full so there is always a surface.
    leaves.sort((p, q) => p.level - q.level);
    const deadline = shown.size === 0 ? Infinity : performance.now() + BUILD_BUDGET_MS;
    let overBudget = false;
    pending = false;
    for (const leaf of leaves) {
      let patch = cache.get(leaf.key);
      if (!patch) {
        if (overBudget) {
          pending = true;
          continue;
        }
        patch = buildPatch(leaf.face, leaf.level, leaf.ix, leaf.iy, leaf.key);
        cache.set(leaf.key, patch);
        overBudget = performance.now() > deadline;
      }
      patch.lastUsed = frame;
    }
    // Keep showing the previous complete sphere until the new one is ready.
    if (pending) return false;

    let changed = false;
    const next = new Map<number, Patch>();
    for (const leaf of leaves) {
      const patch = cache.get(leaf.key)!;
      if (patch.mask !== leaf.mask) {
        const indices = variant(leaf.mask);
        patch.fill.geometry.setIndex(indices.triangles);
        patch.wire.geometry.setIndex(indices.lines);
        patch.mask = leaf.mask;
        changed = true;
      }
      if (shown.get(leaf.key) !== patch) {
        group.add(patch.fill);
        applyLayer(patch);
        changed = true;
      }
      next.set(leaf.key, patch);
    }
    for (const [key, patch] of shown) {
      if (next.get(key) === patch) continue;
      group.remove(patch.fill, patch.wire);
      if (cache.get(key) !== patch) disposePatch(patch);
      changed = true;
    }
    shown = next;

    if (cache.size > CACHE_LIMIT) {
      const idle = [...cache.values()]
        .filter(patch => !shown.has(patch.key))
        .sort((p, q) => p.lastUsed - q.lastUsed);
      for (const patch of idle) {
        if (cache.size <= CACHE_KEEP) break;
        disposePatch(patch);
        cache.delete(patch.key);
      }
    }
    return changed;
  }

  function intersect(raycaster: T.Raycaster): T.Vector3 | undefined {
    group.updateMatrixWorld();
    const fills: T.Object3D[] = [];
    for (const patch of shown.values()) fills.push(patch.fill);
    return raycaster.intersectObjects(fills, false)[0]?.point;
  }

  function levelAt(dx: number, dy: number, dz: number): number {
    locate(dx, dy, dz);
    const { face, u, v } = located;
    for (let level = MOON_MESH_MAX_LEVEL; level >= 0; level--) {
      const count = 2 ** level;
      if (shown.has(nodeKey(face, level, cellIndex(u, count), cellIndex(v, count)))) return level;
    }
    return -1;
  }

  function stats(): MoonMeshStats {
    const perLevel = new Array<number>(MOON_MESH_MAX_LEVEL + 1).fill(0);
    let triangles = 0;
    let lineSegments = 0;
    let finestLevel = 0;
    for (const patch of shown.values()) {
      perLevel[patch.level]++;
      finestLevel = Math.max(finestLevel, patch.level);
      const indices = variant(Math.max(0, patch.mask));
      triangles += indices.triangleCount;
      lineSegments += indices.segmentCount;
    }
    return { patches: shown.size, triangles, lineSegments, perLevel, finestLevel, cached: cache.size, pending };
  }

  function dispose() {
    group.clear();
    for (const patch of new Set([...cache.values(), ...shown.values()])) disposePatch(patch);
    cache.clear();
    shown.clear();
    fillMaterial.dispose();
    elevationMaterial.dispose();
    wireMaterial.dispose();
  }

  function invalidateHeights(intersects: (center: T.Vector3, radius: number) => boolean) {
    for (const [key, patch] of cache) {
      if (!intersects(patch.fill.position, patch.fill.geometry.boundingSphere!.radius)) continue;
      cache.delete(key);
      if (shown.get(key) !== patch) disposePatch(patch);
      lastView = '';
    }
  }

  return { group, update, intersect, levelAt, cellMeters, stats, setLayer, invalidateHeights, dispose };
}
