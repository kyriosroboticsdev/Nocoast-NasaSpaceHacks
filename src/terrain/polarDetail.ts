import * as T from 'three';
import { apiUrl } from '../apiBase';
import type { HeightField } from './heightField';

const SIZE = 257;
const STRIDES = [1, 2, 4, 8] as const;
const ORIGIN = 99_997.5; // Offset to the first 5 m pixel centre.
const MOSAIC_SIZE = 40_000;
const VIEW_TILE_LIMIT = 40;
const CACHE_LIMIT = 128;
type Tile = { column: number; row: number; stride: number };
type Bounds = { left: number; right: number; bottom: number; top: number };
const key = ({ column, row, stride }: Tile) => `${stride}/${column}/${row}`;

export function createPolarDetail(radius: number, changed: (bounds: Bounds) => void) {
  const cache = new Map<string, { tile: Tile; values: Float32Array }>();
  const pending = new Set<string>();
  const retryAfter = new Map<string, number>();
  let queue: Tile[] = [];
  let wanted = new Set<string>();
  let nextView = 0;

  function notify({ column, row, stride }: Tile) {
    const left = column * 5 - ORIGIN, top = ORIGIN - row * 5, span = (SIZE - 1) * stride * 5;
    const margin = stride * 20 + 40; // Border blending and normal samples.
    changed({ left: left - margin, right: left + span + margin, bottom: top - span - margin, top: top + margin });
  }

  function pump() {
    while (pending.size < 2 && queue.length) {
      const tile = queue.shift()!;
      const id = key(tile);
      if (cache.has(id) || pending.has(id) || (retryAfter.get(id) ?? 0) > performance.now()) continue;
      pending.add(id);
      const params = new URLSearchParams({ column: String(tile.column), row: String(tile.row), stride: String(tile.stride) });
      void fetch(apiUrl(`api/terrain/window?${params}`)).then(async response => {
        if (!response.ok) throw new Error(`LOLA tile HTTP ${response.status}`);
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength !== SIZE * SIZE * 4) throw new Error('Unexpected LOLA tile size');
        cache.set(id, { tile, values: new Float32Array(bytes) });
        retryAfter.delete(id);
        notify(tile);
        for (const [oldId, old] of cache) {
          if (cache.size <= CACHE_LIMIT) break;
          if (wanted.has(oldId)) continue;
          cache.delete(oldId);
          notify(old.tile);
        }
      }).catch(() => {
        if (retryAfter.size >= CACHE_LIMIT) retryAfter.delete(retryAfter.keys().next().value!);
        retryAfter.set(id, performance.now() + 3000);
      }).finally(() => {
        pending.delete(id);
        pump();
      });
    }
  }

  function update(camera: T.PerspectiveCamera, surfaceRadius: number, coverage: number) {
    const now = performance.now();
    if (now < nextView) return;
    nextView = now + 180;
    const altitude = camera.position.length() - surfaceRadius;
    queue = [];
    wanted = new Set();
    if (altitude > 35_000 || camera.position.y < radius * 0.99) return;
    const sphere = new T.Sphere(new T.Vector3(), surfaceRadius);
    const caster = new T.Raycaster(), hit = new T.Vector3();
    const points: T.Vector2[] = [];
    for (const v of [-1, -0.5, 0, 0.5, 1]) for (const u of [-1, -0.5, 0, 0.5, 1]) {
      caster.setFromCamera(new T.Vector2(u, v), camera);
      if (!caster.ray.intersectSphere(sphere, hit) || hit.y < 0) continue;
      const scale = 2 * radius / (surfaceRadius + hit.y);
      points.push(new T.Vector2(hit.x * scale, -hit.z * scale));
    }
    if (!points.length) return;
    const bounds = new T.Box2().setFromPoints(points).expandByScalar(150);
    const center = bounds.getCenter(new T.Vector2());
    const limit = new T.Box2(new T.Vector2(-coverage, -coverage), new T.Vector2(coverage, coverage));
    bounds.intersect(limit);
    if (bounds.isEmpty()) return;
    const first = altitude < 4200 ? 0 : altitude < 8500 ? 1 : altitude < 15000 ? 2 : 3;
    for (const stride of STRIDES.slice(first)) {
      const span = (SIZE - 1) * stride;
      const candidates: Tile[] = [];
      for (let row = Math.max(0, Math.floor((ORIGIN - bounds.max.y) / (5 * span)) * span);
        row <= (ORIGIN - bounds.min.y) / 5 && row + span < MOSAIC_SIZE; row += span) {
        for (let column = Math.max(0, Math.floor((bounds.min.x + ORIGIN) / (5 * span)) * span);
          column <= (bounds.max.x + ORIGIN) / 5 && column + span < MOSAIC_SIZE; column += span) {
          const x = column * 5 - ORIGIN, y = ORIGIN - row * 5;
          if (Math.hypot(T.MathUtils.clamp(0, x, x + span * 5), T.MathUtils.clamp(0, y - span * 5, y)) < coverage) {
            candidates.push({ column, row, stride });
          }
        }
      }
      if (candidates.length > VIEW_TILE_LIMIT && stride !== 8) continue;
      const distance = (tile: Tile) => Math.hypot(tile.column * 5 - ORIGIN + span * 2.5 - center.x,
        ORIGIN - tile.row * 5 - span * 2.5 - center.y);
      queue = candidates.sort((a, b) => distance(a) - distance(b)).slice(0, VIEW_TILE_LIMIT);
      wanted = new Set(queue.map(key));
      break;
    }
    pump();
  }

  function enhance(field: HeightField): HeightField {
    return {
      ...field,
      height(dx, dy, dz) {
        let height = field.height(dx, dy, dz);
        if (dy < 0.998) return height;
        const scale = 2 * radius / (1 + dy), x = dx * scale, y = -dz * scale;
        const edge = T.MathUtils.smoothstep(field.blendOuterM - Math.hypot(x, y), 0, field.blendOuterM - field.blendInnerM);
        if (!edge || !cache.size) return height;
        const px = (x + ORIGIN) / 5, py = (ORIGIN - y) / 5;
        for (let level = STRIDES.length - 1; level >= 0; level--) {
          const stride = STRIDES[level], span = (SIZE - 1) * stride;
          const column = Math.floor(px / span) * span, row = Math.floor(py / span) * span;
          const data = cache.get(`${stride}/${column}/${row}`);
          if (!data) continue;
          const u = (px - column) / stride, v = (py - row) / stride;
          const i = Math.floor(u), j = Math.floor(v), k = j * SIZE + i;
          const { values } = data;
          const a = values[k], b = values[k + 1], c = values[k + SIZE], d = values[k + SIZE + 1];
          if (!Number.isFinite(a + b + c + d)) continue;
          let border = 4;
          if (u < 4 && !cache.has(`${stride}/${column - span}/${row}`)) border = Math.min(border, u);
          if (v < 4 && !cache.has(`${stride}/${column}/${row - span}`)) border = Math.min(border, v);
          if (u > SIZE - 5 && !cache.has(`${stride}/${column + span}/${row}`)) border = Math.min(border, SIZE - 1 - u);
          if (v > SIZE - 5 && !cache.has(`${stride}/${column}/${row + span}`)) border = Math.min(border, SIZE - 1 - v);
          const sample = T.MathUtils.lerp(T.MathUtils.lerp(a, b, u - i), T.MathUtils.lerp(c, d, u - i), v - j);
          height = T.MathUtils.lerp(height, sample * edge, T.MathUtils.smoothstep(border, 0, 4));
        }
        return height;
      },
    };
  }
  return { enhance, update };
}
