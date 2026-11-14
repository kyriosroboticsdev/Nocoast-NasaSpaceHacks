import { sphereHorizon, type HorizonProfile } from './types';
import { findSite } from '../scenario/catalog';

const cache = new Map<string, HorizonProfile>();

export async function loadHorizonProfile(
  siteId: string,
  baseUrl: string,
  latDeg?: number,
  lonEastDeg?: number,
): Promise<HorizonProfile> {
  const key = `${siteId}:${latDeg ?? ''}:${lonEastDeg ?? ''}`;
  const hit = cache.get(key);
  if (hit) return hit;

  if (siteId === 'custom' || !findSite(siteId) || findSite(siteId)?.horizonModel === 'sphere_optimistic') {
    const site = findSite(siteId);
    const profile = sphereHorizon(
      siteId,
      latDeg ?? site?.latitudeDeg ?? -89.5,
      lonEastDeg ?? site?.longitudeEastDeg ?? 0,
      site?.surfaceElevationM ?? 0,
      site?.observerHeightAboveGroundM ?? 2,
    );
    cache.set(key, profile);
    return profile;
  }

  const site = findSite(siteId)!;
  if (site.horizonUrl) {
    try {
      const res = await fetch(baseUrl + site.horizonUrl);
      if (res.ok) {
        const profile = (await res.json()) as HorizonProfile;
        cache.set(key, profile);
        return profile;
      }
    } catch {
      // fall through to sphere
    }
  }

  const profile = sphereHorizon(
    siteId,
    site.latitudeDeg,
    site.longitudeEastDeg,
    site.surfaceElevationM,
    site.observerHeightAboveGroundM,
  );
  cache.set(key, profile);
  return profile;
}
