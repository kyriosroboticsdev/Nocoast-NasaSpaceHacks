// Where API requests go. Locally (and anywhere /api is same-origin) this is the page's BASE_URL, so the
// Vite dev proxy / dev middleware answer them. The Azure build sets VITE_API_ORIGIN to the Container App's
// URL, because Static Web Apps can't link an Express-mode Container App as its /api backend.
const env = import.meta.env as unknown as Record<string, string | undefined>;
const origin = (env.VITE_API_ORIGIN ?? '').replace(/\/+$/, '');

export function apiUrl(path: string, base: string = env.BASE_URL ?? '/'): string {
  return origin ? `${origin}/${path}` : `${base}${path}`;
}
