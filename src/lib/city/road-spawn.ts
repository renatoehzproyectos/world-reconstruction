/**
 * Ground-level spawn placement for the reconstruction workspace.
 *
 * The reconstructed world is entered at road level (consistent with the
 * Street View reference pane on the other side of the screen), never as a
 * drone/free camera above the terrain. This module answers one question:
 * "given a target point in the reconstructed tile, where on the nearest
 * drivable road does the player belong, at what ground height, facing which
 * way?"
 *
 * All coordinates here are the same feature-local meters the rest of
 * city/ uses: +x = east, +z = south (see geo.ts project/unproject), and
 * the height grid is sampled at (x, -z) exactly like vehicle.ts groundY.
 *
 * Deliberately a one-shot calculation — the caller runs it once when
 * spawning, not per frame. Continuous ground following stays in
 * vehicle.ts.
 */

import type { CityData, RoadFeature } from "./types";
import type { HeightGrid } from "./elevation";
import { sampleHeight } from "./elevation";
import { unproject } from "./geo";

/**
 * Road classes a car can actually drive on. Footpaths, cycleways, steps,
 * tracks and rails are excluded so the player never spawns on a staircase.
 */
const DRIVABLE = new Set([
  "motorway",
  "motorway_link",
  "trunk",
  "trunk_link",
  "primary",
  "primary_link",
  "secondary",
  "secondary_link",
  "tertiary",
  "tertiary_link",
  "residential",
  "unclassified",
  "living_street",
  "service",
  "road",
  "street",
  "driveway",
]);

/** Preference order when several roads are within a similar distance. */
function roadPriority(highway: string): number {
  if (highway === "residential" || highway === "living_street" || highway === "unclassified") return 0;
  if (highway.startsWith("tertiary") || highway.startsWith("secondary")) return 1;
  if (highway.startsWith("primary") || highway.startsWith("trunk")) return 2;
  if (highway.startsWith("motorway")) return 4; // last resort: no pleasant place to start
  return 3;
}

export type RoadSpawn = {
  /** Local meters, on the road centerline (nudged toward the driving lane). */
  x: number;
  z: number;
  /** Terrain height at (x, z) plus the car's ride height — ready for spawnAt(). */
  y: number;
  /** Ground height itself, without the ride-height offset. */
  groundY: number;
  /** Three.js yaw so the car faces along the road (forward = (sin yaw, cos yaw)). */
  yaw: number;
  /** Compass heading of that same direction, 0 = north — what Street View wants. */
  headingDeg: number;
  /** Geographic position of the spawn point, for the Street View reference pane. */
  lat: number;
  lon: number;
  /** How far the spawn point ended up from the requested target, in meters. */
  distanceM: number;
  roadId?: string;
  highway: string;
};

export type FindRoadSpawnOptions = {
  /** Point to search around, local meters. Defaults to the tile center (0, 0). */
  targetX?: number;
  targetZ?: number;
  heightGrid?: HeightGrid | null;
  /** Give up beyond this distance from the target. Defaults to the whole tile. */
  maxRadiusM?: number;
  /** Ride height added to the sampled terrain height. Matches vehicle.ts updateCar. */
  rideHeightM?: number;
};

type Candidate = {
  x: number;
  z: number;
  dirX: number;
  dirZ: number;
  distanceM: number;
  priority: number;
  road: RoadFeature;
};

/** Closest point on segment a→b to p, plus that segment's unit direction. */
function closestOnSegment(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  px: number,
  pz: number,
): { x: number; z: number; dirX: number; dirZ: number; dist: number } | null {
  const vx = bx - ax;
  const vz = bz - az;
  const len2 = vx * vx + vz * vz;
  if (len2 < 1e-9) return null; // degenerate segment
  let t = ((px - ax) * vx + (pz - az) * vz) / len2;
  t = Math.max(0, Math.min(1, t));
  const x = ax + vx * t;
  const z = az + vz * t;
  const len = Math.sqrt(len2);
  return { x, z, dirX: vx / len, dirZ: vz / len, dist: Math.hypot(px - x, pz - z) };
}

function collectCandidates(roads: RoadFeature[], targetX: number, targetZ: number, drivableOnly: boolean) {
  let best: Candidate | null = null;
  for (const road of roads) {
    if (!road.path || road.path.length < 2) continue;
    const highway = road.highway || "road";
    if (drivableOnly && !DRIVABLE.has(highway)) continue;
    const priority = roadPriority(highway);
    for (let i = 1; i < road.path.length; i++) {
      const [ax, az] = road.path[i - 1];
      const [bx, bz] = road.path[i];
      const hit = closestOnSegment(ax, az, bx, bz, targetX, targetZ);
      if (!hit) continue;
      const better =
        !best ||
        hit.dist < best.distanceM - 0.5 ||
        (Math.abs(hit.dist - best.distanceM) <= 0.5 && priority < best.priority);
      if (better) {
        best = {
          x: hit.x,
          z: hit.z,
          dirX: hit.dirX,
          dirZ: hit.dirZ,
          distanceM: hit.dist,
          priority,
          road,
        };
      }
    }
  }
  return best;
}

/**
 * Finds the nearest usable road to the target point and returns a complete,
 * ground-level spawn pose. Returns null when the tile contains no road
 * geometry at all (or none within maxRadiusM) — callers must handle that
 * rather than falling back to an invented position.
 */
export function findNearestRoadSpawn(city: CityData, opts: FindRoadSpawnOptions = {}): RoadSpawn | null {
  const { targetX = 0, targetZ = 0, heightGrid = null, rideHeightM = 0.4 } = opts;
  if (!city?.roads?.length) return null;

  const spanX = Math.abs(city.extent.maxX - city.extent.minX);
  const spanZ = Math.abs(city.extent.maxZ - city.extent.minZ);
  const maxRadiusM = opts.maxRadiusM ?? Math.max(spanX, spanZ, 500);

  // Prefer drivable streets; only widen to any road geometry (paths, tracks)
  // if the tile genuinely has no drivable street anywhere.
  const best = collectCandidates(city.roads, targetX, targetZ, true) ?? collectCandidates(city.roads, targetX, targetZ, false);
  if (!best || best.distanceM > maxRadiusM) return null;

  // Sit just beside the centerline (right-hand side of travel) so the car
  // is on the road surface rather than straddling the middle of it, then
  // keep it inside the tile with the same padding vehicle.ts uses.
  const halfLane = Math.min(Math.max((best.road.width || 6) * 0.25, 1), 4);
  let x = best.x + best.dirZ * halfLane;
  let z = best.z - best.dirX * halfLane;
  const pad = 8;
  x = Math.min(city.extent.maxX - pad, Math.max(city.extent.minX + pad, x));
  z = Math.min(city.extent.maxZ - pad, Math.max(city.extent.minZ + pad, z));

  // One-shot ground sample. Grid north is -z (same convention as vehicle.ts).
  const groundY = heightGrid ? sampleHeight(heightGrid, x, -z) : 0;

  // Three yaw such that forward = (sin yaw, cos yaw) points along the road.
  const yaw = Math.atan2(best.dirX, best.dirZ);
  const [lon, lat] = unproject(x, z, city.origin.lon, city.origin.lat);

  return {
    x,
    z,
    y: groundY + rideHeightM,
    groundY,
    yaw,
    headingDeg: yawToHeadingDeg(yaw),
    lat,
    lon,
    distanceM: best.distanceM,
    roadId: best.road.id,
    highway: best.road.highway || "road",
  };
}

/**
 * Three yaw → compass heading (0 = north, 90 = east). Local +z is south
 * (geo.ts project), so a yaw of 0 (forward = +z) is heading 180.
 */
export function yawToHeadingDeg(yaw: number): number {
  const deg = (Math.atan2(Math.sin(yaw), -Math.cos(yaw)) * 180) / Math.PI;
  return (deg + 360) % 360;
}
