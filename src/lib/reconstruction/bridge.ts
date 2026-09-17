import { OVERTURE_RELEASE } from "@/lib/city/parse-overture";
import type { CityData } from "@/lib/city/types";
import type { HeightGrid } from "@/lib/city/elevation";

/**
 * Base-data identity string (spec §24): pins the exact Overture release +
 * bbox a project was generated against, so a later Overture release never
 * silently regenerates and misaligns an existing reconstruction. Elevation
 * source is intentionally excluded here — a CORS fallback to Terrarium
 * (see city/elevation.ts) is a network accident, not a deliberate base-data
 * choice, and re-fetching later may well land back on Copernicus.
 */
export function baseRevisionFor(city: CityData): string {
  const { minLon, minLat, maxLon, maxLat } = city.bbox;
  const r = (n: number) => n.toFixed(6);
  return `${OVERTURE_RELEASE}@${r(minLon)},${r(minLat)},${r(maxLon)},${r(maxLat)}`;
}

/**
 * Deterministic-ish project id from the base revision, so regenerating the
 * same area in the same session reattaches to the same saved project
 * instead of spawning a duplicate. Not cryptographically stable across
 * browsers/locales — fine for MVP local storage; a real id scheme is a
 * project.ts concern once this moves server-side.
 */
export function projectIdFor(city: CityData): string {
  const rev = baseRevisionFor(city);
  const safe = rev.replace(/[^a-zA-Z0-9]/g, "").slice(0, 40);
  return `proj_${safe}`;
}

export function elevationSourceFrom(grid: HeightGrid | null | undefined): "copernicus-glo-30" | "terrarium" {
  return grid?.source ?? "copernicus-glo-30";
}
