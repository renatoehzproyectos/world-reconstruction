/**
 * Storage for the user's own Google Maps API key, used to enable the real
 * Street View reference provider (see google-street-view.ts). This is a
 * key the user types in themselves and explicitly saves — never fetched,
 * generated, or shipped with the app. "Save forever" means localStorage,
 * same durability tier as everything else this app persists
 * (project/serialize.ts uses the same mechanism).
 *
 * The key stays entirely client-side: it's read here and handed directly
 * to Google's own JS SDK loader in the browser, never sent through this
 * app's own network calls or logged anywhere.
 */

const STORAGE_KEY = "world-reconstruction:google-maps-api-key";

export function getGoogleMapsApiKey(): string | null {
  return localStorage.getItem(STORAGE_KEY);
}

export function setGoogleMapsApiKey(key: string): void {
  const trimmed = key.trim();
  if (trimmed) localStorage.setItem(STORAGE_KEY, trimmed);
  else localStorage.removeItem(STORAGE_KEY);
}

export function clearGoogleMapsApiKey(): void {
  localStorage.removeItem(STORAGE_KEY);
}
