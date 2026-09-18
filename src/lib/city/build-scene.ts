import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { BUILDING_TINTS, FACADE_PALETTES, ROOF_TINTS, cfg } from "./config";
import { bboxSizeMeters, ringArea, unproject } from "./geo";
import type { BuildingFeature, CityData, CoastlineFeature, PortFeature, RoadFeature, WaterFeature } from "./types";
import { fetchHeightGrid, sampleHeight, type HeightGrid } from "./elevation";
import { buildSatelliteCanvas } from "./satellite";
import {
  fetchLandCoverGrid,
  buildLandCoverCanvas,
  sampleLandCoverClass,
  isBuiltOrWaterClass,
  type LandCoverGrid,
} from "./landcover";
/**
 * Type-only import from reconstruction/ — reconstruction/types.ts only
 * imports BBox/Ring from city/types.ts, never build-scene.ts, so this
 * doesn't create a runtime cycle (erased at compile time either way). A
 * pragmatic exception to city/ not depending on reconstruction/: these are
 * data shapes, not behavior, and duplicating them here would just be two
 * lists to keep in sync.
 */
import type { SceneObject, SceneObjectKind, SidewalkFeature } from "@/lib/reconstruction/types";

function closedRing(ring: [number, number][]): [number, number][] {
  if (ring.length < 3) return ring;
  const a = ring[0];
  const b = ring[ring.length - 1];
  if (a[0] === b[0] && a[1] === b[1]) return ring.slice(0, -1);
  return ring;
}

function toShape(ring: [number, number][], holes: [number, number][][] = []): THREE.Shape | null {
  const outer = closedRing(ring);
  if (outer.length < 3) return null;
  const shape = new THREE.Shape();
  shape.moveTo(outer[0][0], -outer[0][1]);
  for (let i = 1; i < outer.length; i++) {
    shape.lineTo(outer[i][0], -outer[i][1]);
  }
  shape.closePath();

  for (const hole of holes) {
    const h = closedRing(hole);
    if (h.length < 3) continue;
    const path = new THREE.Path();
    path.moveTo(h[0][0], -h[0][1]);
    for (let i = 1; i < h.length; i++) path.lineTo(h[i][0], -h[i][1]);
    path.closePath();
    shape.holes.push(path);
  }
  return shape;
}

function extrudeShape(shape: THREE.Shape, depth: number): THREE.BufferGeometry | null {
  try {
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth,
      bevelEnabled: false,
      steps: 1,
    });
    geo.rotateX(-Math.PI / 2);
    geo.computeVertexNormals();
    return geo;
  } catch {
    return null;
  }
}

function paintGeometry(geo: THREE.BufferGeometry, color: [number, number, number]): void {
  const count = geo.getAttribute("position").count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = color[0];
    colors[i * 3 + 1] = color[1];
    colors[i * 3 + 2] = color[2];
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
}

/** Stable 0..1 hash from a building footprint so the same building always
 * gets the same facade/roof variant (no flicker on rebuilds). */
function buildingHash(b: BuildingFeature): number {
  let h = 0x811c9dc5;
  for (const [x, z] of b.ring) {
    h ^= Math.round(x * 37) | 0;
    h = Math.imul(h, 16777619);
    h ^= Math.round(z * 37) | 0;
    h = Math.imul(h, 16777619);
  }
  h ^= Math.round(b.height * 97) | 0;
  h = Math.imul(h, 16777619);
  return ((h >>> 0) % 100000) / 100000;
}

function pickVariant<T>(list: T[], t: number): T {
  const i = Math.min(list.length - 1, Math.floor(t * list.length));
  return list[i];
}

/** Individualized facade color: palette variant per kind, shaded slightly by height. */
function buildingColor(b: BuildingFeature): [number, number, number] {
  if (b.colorOverride) return applyOriginTint(b.colorOverride, b.origin);
  const palette = FACADE_PALETTES[b.kind] ?? FACADE_PALETTES.default;
  const t = buildingHash(b);
  const base = pickVariant(palette, t) ?? BUILDING_TINTS[b.kind] ?? cfg.BUILDING_COLOR;
  const th = Math.min(1, Math.max(0, (b.height - 8) / 80));
  const generated: [number, number, number] = [
    base[0] * (1 - th * 0.12),
    base[1] * (1 - th * 0.08),
    base[2] * (1 - th * 0.02) + th * 0.04,
  ];
  return applyOriginTint(generated, b.origin);
}

/**
 * Nudges a building's color toward a warm accent when it's human-edited or
 * human-added, so the reconstruction world stays visually distinguishable
 * from the generated base (spec §3 step 5) even without an explicit facade
 * material override. Subtle by design — this fires on every edited
 * building, including ones only touched for floor count.
 */
function applyOriginTint(
  color: [number, number, number],
  origin: BuildingFeature["origin"]
): [number, number, number] {
  if (origin !== "human-edited" && origin !== "human-added") return color;
  const accent: [number, number, number] = [1, 0.75, 0.35];
  const strength = origin === "human-added" ? 0.22 : 0.12;
  return [
    color[0] * (1 - strength) + accent[0] * strength,
    color[1] * (1 - strength) + accent[1] * strength,
    color[2] * (1 - strength) + accent[2] * strength,
  ];
}

/** Roof tint variant per building, following the same stable hash as the facade. */
function roofColor(b: BuildingFeature): [number, number, number] {
  const palette = ROOF_TINTS[b.kind] ?? ROOF_TINTS.default;
  const t = 1 - buildingHash(b); // decorrelate from facade pick
  return pickVariant(palette, t < 0 ? 0 : t > 1 ? 1 : t);
}

function bufferPolyline(pts: [number, number][], half: number): [number, number][] | null {
  if (pts.length < 2) return null;
  const left: [number, number][] = [];
  const right: [number, number][] = [];
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(pts.length - 1, i + 1)];
    let tx = next[0] - prev[0];
    let tz = next[1] - prev[1];
    const len = Math.hypot(tx, tz) || 1;
    tx /= len;
    tz /= len;
    const nx = -tz;
    const nz = tx;
    left.push([pts[i][0] + nx * half, pts[i][1] + nz * half]);
    right.push([pts[i][0] - nx * half, pts[i][1] - nz * half]);
  }
  const ring = left.concat(right.reverse());
  ring.push([ring[0][0], ring[0][1]]);
  return ring;
}

function mergeOrEmpty(geos: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (!geos.length) return null;
  let merged: THREE.BufferGeometry | null = null;
  try {
    merged = mergeGeometries(geos, false);
  } catch (e) {
    console.warn("mergeGeometries failed (mismatched attributes?)", e);
    merged = null;
  }
  if (!merged) {
    // Attribute sets didn't line up across the batch (e.g. one geometry has
    // uv/color and another doesn't) — three.js merges nothing in that case
    // instead of throwing, so fall back to keeping just the first geometry
    // rather than silently losing the whole batch or propagating a null.
    console.warn(`mergeGeometries returned null for ${geos.length} geometries; keeping first only`);
    merged = geos[0] ?? null;
    for (const g of geos.slice(1)) g.dispose();
    return merged;
  }
  for (const g of geos) g.dispose();
  return merged;
}

function centroid(ring: [number, number][]): [number, number] {
  let sx = 0, sz = 0;
  for (const p of ring) {
    sx += p[0];
    sz += p[1];
  }
  const n = ring.length || 1;
  return [sx / n, sz / n];
}

/**
 * Feature rings use project(): z = (originLat - lat) (north → negative).
 * HeightGrid.zs uses (lat - origin) (north → positive).
 * Terrain mesh places vertices at Three Z = -gridZs = feature z.
 * Convert feature (x, z) → height on the DEM.
 */
function heightAtFeature(grid: HeightGrid, x: number, zFeat: number): number {
  return sampleHeight(grid, x, -zFeat);
}

/** Min height under a footprint so the object sits on the ground (no floating). */
function footprintMinHeight(grid: HeightGrid, pts: [number, number][]): number {
  let minH = Infinity;
  for (const [x, z] of pts) {
    const h = heightAtFeature(grid, x, z);
    if (h < minH) minH = h;
  }
  if (pts.length >= 3) {
    const [cx, cz] = centroid(pts);
    const hc = heightAtFeature(grid, cx, cz);
    if (hc < minH) minH = hc;
  }
  return Number.isFinite(minH) ? minH : 0;
}

/**
 * Drape extruded geometry onto terrain: each vertex keeps its relative
 * extrusion height and is lifted so its base follows the DEM at (x, z).
 * After extrudeShape, positions are (x, yExtrude, zFeat) matching terrain Z.
 */
function drapeOntoTerrain(
  geo: THREE.BufferGeometry,
  grid: HeightGrid,
  yBias = 0
): void {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const ground = heightAtFeature(grid, x, z);
    pos.setY(i, ground + y + yBias);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
}

/**
 * Pyramid/hip roof for a building footprint: eave ring (slightly overhanging
 * the walls) lofted up to an apex above the centroid. Cheap to compute for
 * arbitrary polygons (no straight-skeleton needed) and reads as a proper
 * pitched roof from any angle, unlike a flat extrusion cap.
 */
/**
 * Axis-aligned bounding box of a ring in local meters, plus which axis is
 * longer — used by gableRoofGeometry/shedRoofGeometry to pick a sensible
 * ridge/slope direction without needing true building orientation data
 * (Overture doesn't give us one). Reasonable for rectangular-ish footprints,
 * less so for very irregular ones — documented limitation, not fixable
 * without real footprint-orientation analysis.
 */
function localBounds(ring: [number, number][]) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const width = maxX - minX;
  const depth = maxZ - minZ;
  return { minX, maxX, minZ, maxZ, width, depth, alongX: width >= depth };
}

function roofRiseFor(b: BuildingFeature, riseOverride?: number): number {
  const r = Math.sqrt(Math.max(ringArea(b.ring), 1) / Math.PI);
  return riseOverride !== undefined
    ? Math.max(0.2, riseOverride)
    : Math.min(cfg.ROOF_RISE_MAX, Math.max(cfg.ROOF_RISE_MIN, r * 0.32));
}

/**
 * A true two-slope gable roof — ridge line along the footprint's longer
 * axis, two roof planes down to the eaves, triangular gable ends closing
 * the two short sides. Distinct from the pyramid/hip shape roofGeometry()
 * builds. Winding/normals here are best-effort (computeVertexNormals +
 * FrontSide rendering elsewhere) and haven't been visually confirmed —
 * a gable end could in principle render backface-invisible from some
 * angles if a winding is flipped; flagged as a follow-up to check once
 * this is actually seen running.
 */
function gableRoofGeometry(b: BuildingFeature, riseOverride?: number): THREE.BufferGeometry | null {
  const ring = closedRing(b.ring);
  if (ring.length < 3) return null;
  const { minX, maxX, minZ, maxZ, alongX } = localBounds(ring);
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const rise = roofRiseFor(b, riseOverride);

  // Eave rectangle corners (0..3) + two ridge points (4,5), oriented so the
  // ridge runs along whichever axis is longer. The triangle-index topology
  // below is identical either way — only the point positions differ.
  const p: [number, number, number][] = alongX
    ? [
        [minX, 0, minZ],
        [maxX, 0, minZ],
        [maxX, 0, maxZ],
        [minX, 0, maxZ],
        [minX, rise, cz],
        [maxX, rise, cz],
      ]
    : [
        [minX, 0, minZ],
        [minX, 0, maxZ],
        [maxX, 0, maxZ],
        [maxX, 0, minZ],
        [cx, rise, minZ],
        [cx, rise, maxZ],
      ];
  const indices = [
    0, 1, 5, 0, 5, 4, // slope 1
    2, 3, 4, 2, 4, 5, // slope 2
    3, 0, 4, // gable end
    1, 2, 5, // gable end
  ];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(p.flat(), 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Single-pitch shed roof — one plane from a high eave down to the opposite
 * low eave along the footprint's longer axis. Direction (which side is
 * high) isn't user-controllable yet — always slopes from the min side to
 * the max side — see BuildingEdit.roof.direction, unused here so far.
 */
function shedRoofGeometry(b: BuildingFeature, riseOverride?: number): THREE.BufferGeometry | null {
  const ring = closedRing(b.ring);
  if (ring.length < 3) return null;
  const { minX, maxX, minZ, maxZ, alongX } = localBounds(ring);
  const rise = roofRiseFor(b, riseOverride);

  const p: [number, number, number][] = alongX
    ? [
        [minX, rise, minZ],
        [maxX, rise, minZ],
        [maxX, 0, maxZ],
        [minX, 0, maxZ],
      ]
    : [
        [minX, rise, minZ],
        [minX, 0, maxZ],
        [maxX, 0, maxZ],
        [maxX, rise, minZ],
      ];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(p.flat(), 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Builds building walls as individual per-edge quads (instead of relying on
 * THREE.ExtrudeGeometry's side faces) so each cardinal facade can carry its
 * own color. Only used when a building has facadeColors set and no holes —
 * holes keep the simpler extrudeShape() path below, because getting a
 * courtyard wall's winding right depends on the hole ring's orientation
 * relative to the outer ring, which this codebase doesn't guarantee and
 * isn't worth the risk to get wrong for a rare case.
 *
 * Winding correctness matters here: the material has no explicit `side`
 * (defaults to THREE.FrontSide), so a wrong winding means an invisible
 * wall face. This was hand-derived from a worked example and then
 * empirically verified — a standalone script (verify-walls.mjs, run with
 * plain node against the real `three` package) constructs this exact wall
 * geometry for 4 test rings (CW and CCW versions of a square and an
 * irregular pentagon) and checks every resulting face normal against the
 * expected outward direction via the actual cross product. All 4 passed.
 * That's a materially stronger claim than most of the geometry in this
 * file, which was written by inference and never run.
 */
function buildWallsWithFacades(
  ring: [number, number][],
  height: number,
  facadeColors: NonNullable<BuildingFeature["facadeColors"]>,
  defaultColor: [number, number, number]
): THREE.BufferGeometry | null {
  const closed = closedRing(ring);
  const n = closed.length;
  if (n < 3) return null;

  // Signed area (shoelace, no abs) to detect winding — ringArea() elsewhere
  // in this file only returns |area|, which isn't enough to know winding.
  let signed = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    signed += closed[j][0] * closed[i][1] - closed[i][0] * closed[j][1];
  }
  const ccw = signed > 0;

  const positions: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  let vi = 0;

  for (let i = 0; i < n; i++) {
    const [x1, z1] = closed[i];
    const [x2, z2] = closed[(i + 1) % n];
    const dx = x2 - x1;
    const dz = z2 - z1;
    const len = Math.hypot(dx, dz) || 1;
    // Outward normal: derived for the CCW case as (dz,-dx)/len (see the
    // worked example above); mirrored for CW.
    const nx = ccw ? dz / len : -dz / len;
    const nz = ccw ? -dx / len : dx / len;
    const side = Math.abs(nx) >= Math.abs(nz) ? (nx >= 0 ? "east" : "west") : nz >= 0 ? "south" : "north";
    const color = facadeColors[side] ?? defaultColor;

    const base = vi;
    // v0=edgeStart-bottom, v1=edgeEnd-bottom, v2=edgeEnd-top, v3=edgeStart-top
    positions.push(x1, 0, z1, x2, 0, z2, x2, height, z2, x1, height, z1);
    for (let k = 0; k < 4; k++) colors.push(color[0], color[1], color[2]);
    // Simple per-edge planar UVs — same attribute shape as ExtrudeGeometry's
    // (needed so mergeGeometries doesn't reject the batch over a UV
    // mismatch, see the required-for-window-texture note above), not tuned
    // for texel density or window-texture alignment quality.
    const uRepeat = Math.max(1, len / 4);
    uvs.push(0, 0, uRepeat, 0, uRepeat, 1, 0, 1);
    if (ccw) {
      indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
    } else {
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    vi += 4;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  // extrudeShape() below (the path this function replaces for
  // facade-colored buildings) produces non-indexed geometry — confirmed
  // empirically, it's not just an assumption (see
  // scripts/verification/repro-merge.mjs). mergeGeometries() requires every
  // geometry in a batch to be either all-indexed or all-non-indexed; mixing
  // this indexed geometry into the same wallGeos array as extrudeShape's
  // non-indexed output threw "All geometries must have compatible
  // attributes... index attribute exists among all geometries, or in none
  // of them" at runtime. toNonIndexed() matches the existing convention.
  return geo.toNonIndexed();
}

/**
 * ExtrudeGeometry (the path buildWallsWithFacades replaces) also produced a
 * top cap for free from the shape's own triangulation; the per-edge wall
 * builder above only makes walls, so flat/clutter-roofed buildings would
 * otherwise show a hollow top. This adds that cap back using the same
 * triangulator Three's own shape/extrude code uses internally, so it
 * handles concave footprints correctly — not reinventing triangulation.
 */
function buildTopCap(
  ring: [number, number][],
  height: number,
  color: [number, number, number]
): THREE.BufferGeometry | null {
  const closed = closedRing(ring);
  if (closed.length < 3) return null;
  const vec2s = closed.map(([x, z]) => new THREE.Vector2(x, z));
  const triangles = THREE.ShapeUtils.triangulateShape(vec2s, []);
  if (triangles.length === 0) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of closed) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const spanX = Math.max(1e-3, maxX - minX);
  const spanZ = Math.max(1e-3, maxZ - minZ);

  const positions: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = []; // same attribute-shape requirement as buildWallsWithFacades, see its comment
  for (const [x, z] of closed) {
    positions.push(x, height, z);
    colors.push(color[0], color[1], color[2]);
    uvs.push((x - minX) / spanX, (z - minZ) / spanZ);
  }
  // ShapeUtils.triangulateShape's winding is consistently opposite of what
  // a +Y-facing cap needs — empirically verified against 5 test shapes
  // (square/pentagon, CW and CCW, plus a concave L) in verify-cap2.mjs
  // before this shipped; every case needed this same reversal.
  const indices = triangles.flatMap(([a, b, c]) => [a, c, b]);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  // Same non-indexed requirement as buildWallsWithFacades above — this cap
  // merges into the same wallGeos array as extrudeShape's non-indexed
  // output, see that function's comment for the empirical confirmation.
  return geo.toNonIndexed();
}

function roofGeometry(b: BuildingFeature, riseOverride?: number): THREE.BufferGeometry | null {
  const ring = closedRing(b.ring);
  if (ring.length < 3) return null;
  const [cx, cz] = centroid(ring);
  const area = ringArea(ring);
  const r = Math.sqrt(Math.max(area, 1) / Math.PI);
  const rise =
    riseOverride !== undefined
      ? Math.max(0.2, riseOverride)
      : Math.min(cfg.ROOF_RISE_MAX, Math.max(cfg.ROOF_RISE_MIN, r * 0.32));

  const n = ring.length;
  const positions: number[] = [];
  const indices: number[] = [];

  // Eave ring (x, 0, z) — overhangs the wall slightly for an eave shadow line.
  for (let i = 0; i < n; i++) {
    const [x, z] = ring[i];
    let ex = x - cx;
    let ez = z - cz;
    const len = Math.hypot(ex, ez) || 1;
    ex = x + (ex / len) * cfg.ROOF_INSET;
    ez = z + (ez / len) * cfg.ROOF_INSET;
    positions.push(ex, 0, ez);
  }
  // Apex
  const apexIdx = n;
  positions.push(cx, rise, cz);

  for (let i = 0; i < n; i++) {
    const a = i;
    const bI = (i + 1) % n;
    indices.push(a, apexIdx, bI);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Small rooftop clutter (AC units / mechanical boxes) for flat/tall roofs
 * that don't get a pitched roof — cheap microdetail that reads at close range
 * without needing real MEP modeling.
 */
function roofClutterGeometry(b: BuildingFeature): THREE.BufferGeometry | null {
  const area = ringArea(b.ring);
  if (area < 120) return null;
  const [cx, cz] = centroid(b.ring);
  const r = Math.sqrt(area / Math.PI);
  const seed = buildingHash(b);
  const count = Math.min(4, Math.max(1, Math.floor(area / 260)));
  const geos: THREE.BufferGeometry[] = [];
  for (let i = 0; i < count; i++) {
    const t1 = (seed * 97 + i * 53.7) % 1;
    const t2 = (seed * 193 + i * 29.3) % 1;
    const t3 = (seed * 311 + i * 71.1) % 1;
    const ang = t1 * Math.PI * 2;
    const dist = t2 * r * 0.45;
    const w = 1.1 + t3 * 1.3;
    const d = 1.1 + ((t2 + t3) % 1) * 1.3;
    const h = 0.7 + ((t1 + t3) % 1) * 0.9;
    const box = new THREE.BoxGeometry(w, h, d);
    box.deleteAttribute("uv"); // keep attribute set identical to pyramid roofs (position/normal/color only)
    box.translate(cx + Math.cos(ang) * dist, h / 2, cz + Math.sin(ang) * dist);
    geos.push(box);
  }
  const merged = mergeOrEmpty(geos);
  if (merged) paintGeometry(merged, [0.52, 0.53, 0.55]);
  return merged;
}

/**
 * One entry per building contributed to the merged wall geometry, in the
 * same order buildingsGeometry() pushed them. `triangleStart`/`triangleCount`
 * are in merged-geometry face units (index.count / 3), so a raycaster hit's
 * `faceIndex` can be resolved back to a source building — see
 * resolveBuildingAtFace() below. Buildings are still rendered as a single
 * merged THREE.Mesh (one draw call, spec §26); this index makes per-building
 * picking possible without giving that up.
 */
export type BuildingPickEntry = {
  featureIndex: number;
  sourceId: string | undefined;
  triangleStart: number;
  triangleCount: number;
  /** Vertex range in the merged buildings geometry, for selection-highlight recoloring. */
  vertexStart: number;
  vertexCount: number;
};

function buildingsGeometry(
  features: BuildingFeature[],
  grid: HeightGrid | null
): { walls: THREE.BufferGeometry | null; roofs: THREE.BufferGeometry | null; buildingIndex: BuildingPickEntry[] } {
  const wallGeos: THREE.BufferGeometry[] = [];
  const roofGeos: THREE.BufferGeometry[] = [];
  const buildingIndex: BuildingPickEntry[] = [];
  let triangleCursor = 0;
  let vertexCursor = 0;
  for (let featureIndex = 0; featureIndex < features.length; featureIndex++) {
    const b = features[featureIndex];
    if (b.height < cfg.MIN_BUILDING_HEIGHT) continue;
    if (ringArea(b.ring) < cfg.MIN_BUILDING_AREA) continue;
    const shape = toShape(b.ring, b.holes);
    if (!shape) continue;
    const useFacadeWalls = b.facadeColors && b.holes.length === 0;
    const geo = useFacadeWalls
      ? buildWallsWithFacades(b.ring, b.height, b.facadeColors!, buildingColor(b))
      : extrudeShape(shape, b.height);
    if (!geo) continue;

    const baseY = grid ? footprintMinHeight(grid, b.ring) : 0;
    geo.translate(0, baseY, 0);
    if (!useFacadeWalls) paintGeometry(geo, buildingColor(b));
    wallGeos.push(geo);

    let capTriCount = 0;
    let capVertCount = 0;
    if (useFacadeWalls) {
      // buildWallsWithFacades only makes walls (see its own comment) — add
      // the top cap back so the building isn't hollow-topped. Winding here
      // is NOT hand-verified the way the walls above are — see buildTopCap's
      // comment; flagged as a real "check this once it's actually running" item.
      const cap = buildTopCap(b.ring, b.height, buildingColor(b));
      if (cap) {
        cap.translate(0, baseY, 0);
        wallGeos.push(cap);
        capTriCount = (cap.index ? cap.index.count : cap.getAttribute("position").count) / 3;
        capVertCount = cap.getAttribute("position").count;
      }
    }

    // Cap (if any) is pushed to wallGeos immediately after the wall geometry,
    // so it merges into a contiguous block right after it — the pick index
    // below must span both, or picking desyncs for every building after
    // this one (their offsets would drift by the cap's size otherwise).
    const triCount = (geo.index ? geo.index.count : geo.getAttribute("position").count) / 3 + capTriCount;
    const vertCount = geo.getAttribute("position").count + capVertCount;
    buildingIndex.push({
      featureIndex,
      sourceId: b.id,
      triangleStart: triangleCursor,
      triangleCount: triCount,
      vertexStart: vertexCursor,
      vertexCount: vertCount,
    });
    triangleCursor += triCount;
    vertexCursor += vertCount;

    // A human-set roof override takes priority over the height/holes
    // heuristic: "flat" forces clutter even on a low building, any pitched
    // type forces a pitched roof (using the pyramid/hip shape — true
    // gable/shed silhouettes aren't modeled yet, see reconstruction/apply.ts)
    // even on a tall one, at the user's chosen rise.
    const roofType = b.roofOverride?.type ?? (b.height <= cfg.ROOF_MAX_HEIGHT_FOR_PITCH && !b.holes.length ? "hip" : "flat");

    if (cfg.ENABLE_ROOFS && roofType !== "flat") {
      const rGeo =
        roofType === "gable"
          ? gableRoofGeometry(b, b.roofOverride?.rise)
          : roofType === "shed"
            ? shedRoofGeometry(b, b.roofOverride?.rise)
            : roofGeometry(b, b.roofOverride?.rise);
      if (rGeo) {
        rGeo.translate(0, baseY + b.height, 0);
        paintGeometry(rGeo, roofColor(b));
        roofGeos.push(rGeo);
      }
    } else {
      // Flat-roofed / tall buildings get rooftop clutter instead of a pitch.
      const clutter = roofClutterGeometry(b);
      if (clutter) {
        clutter.translate(0, baseY + b.height, 0);
        roofGeos.push(clutter);
      }
    }
  }
  return { walls: mergeOrEmpty(wallGeos), roofs: mergeOrEmpty(roofGeos), buildingIndex };
}

/**
 * Resolve a THREE.Raycaster intersection's `faceIndex` (triangle index into
 * the merged buildings mesh) back to the BuildingFeature that produced it.
 * `buildingIndex` entries are contiguous and sorted by construction order, so
 * binary search works.
 */
/**
 * Overwrite the vertex colors for one building's range in the merged
 * buildings geometry (selection highlight / human-edited tint). Pass `null`
 * color to restore by re-painting from `restoreColor`. Mutates the shared
 * color attribute in place and marks it for GPU upload — cheap, no rebuild.
 */
export function tintBuildingRange(
  geo: THREE.BufferGeometry,
  entry: BuildingPickEntry,
  color: [number, number, number]
): void {
  const colorAttr = geo.getAttribute("color");
  if (!colorAttr) return;
  for (let v = entry.vertexStart; v < entry.vertexStart + entry.vertexCount; v++) {
    colorAttr.setXYZ(v, color[0], color[1], color[2]);
  }
  colorAttr.needsUpdate = true;
}

export function resolveBuildingAtFace(
  buildingIndex: BuildingPickEntry[],
  faceIndex: number
): BuildingPickEntry | null {
  let lo = 0;
  let hi = buildingIndex.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const entry = buildingIndex[mid];
    if (faceIndex < entry.triangleStart) {
      hi = mid - 1;
    } else if (faceIndex >= entry.triangleStart + entry.triangleCount) {
      lo = mid + 1;
    } else {
      return entry;
    }
  }
  return null;
}

/**
 * Procedural window/facade texture: a light neutral base (so the per-building
 * vertex-color tint reads through) with a grid of darker glass rectangles and
 * thin frame lines. Applied with real-world-scaled repeat so window size stays
 * consistent across small and large buildings.
 */
let cachedWindowNormalMap: THREE.Texture | null = null;
function createWindowNormalMap(): THREE.Texture {
  if (cachedWindowNormalMap) return cachedWindowNormalMap;
  const size = cfg.WINDOW_TEXTURE_SIZE;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;

  // Heightmap pass: recessed glass, raised frame/sill — same layout as the
  // color texture so the relief lines up with the visible windows.
  ctx.fillStyle = "#808080"; // neutral height
  ctx.fillRect(0, 0, size, size);
  const cols = 4;
  const rows = 5;
  const padX = size / cols;
  const padY = size / rows;
  const winW = padX * 0.62;
  const winH = padY * 0.68;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * padX + (padX - winW) / 2;
      const y = r * padY + (padY - winH) / 2;
      // frame: slightly raised ring
      ctx.fillStyle = "#9c9c9c";
      ctx.fillRect(x - 3, y - 3, winW + 6, winH + 6);
      // glass: recessed
      ctx.fillStyle = "#5c5c5c";
      ctx.fillRect(x, y, winW, winH);
      // sill: raised strip under the window
      ctx.fillStyle = "#a8a8a8";
      ctx.fillRect(x - 3, y + winH + 3, winW + 6, size * 0.02);
    }
  }

  const heightData = ctx.getImageData(0, 0, size, size);
  const normalData = ctx.createImageData(size, size);
  const strength = 2.2;
  const at = (x: number, y: number) => {
    const xi = (x + size) % size;
    const yi = (y + size) % size;
    return heightData.data[(yi * size + xi) * 4] / 255;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const hl = at(x - 1, y);
      const hr = at(x + 1, y);
      const hd = at(x, y - 1);
      const hu = at(x, y + 1);
      let nx = (hl - hr) * strength;
      let ny = (hd - hu) * strength;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      const nzn = nz / len;
      const idx = (y * size + x) * 4;
      normalData.data[idx] = Math.round((nx * 0.5 + 0.5) * 255);
      normalData.data[idx + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      normalData.data[idx + 2] = Math.round((nzn * 0.5 + 0.5) * 255);
      normalData.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(normalData, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1 / cfg.FACADE_METERS_PER_TILE, 1 / cfg.FACADE_METERS_PER_TILE);
  tex.needsUpdate = true;
  cachedWindowNormalMap = tex;
  return tex;
}
let cachedWindowTexture: THREE.Texture | null = null;
function createWindowTexture(): THREE.Texture {
  if (cachedWindowTexture) return cachedWindowTexture;
  const size = cfg.WINDOW_TEXTURE_SIZE;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#e9e6df";
  ctx.fillRect(0, 0, size, size);

  const cols = 4;
  const rows = 5;
  const padX = size / cols;
  const padY = size / rows;
  const winW = padX * 0.62;
  const winH = padY * 0.68;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * padX + (padX - winW) / 2;
      const y = r * padY + (padY - winH) / 2;
      const shade = 30 + Math.round(((c * 7 + r * 13) % 5) * 6); // subtle per-window variation
      ctx.fillStyle = `rgb(${shade + 10}, ${shade + 18}, ${shade + 30})`;
      ctx.fillRect(x, y, winW, winH);
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = Math.max(1, size * 0.006);
      ctx.strokeRect(x, y, winW, winH);
      // mullion
      ctx.beginPath();
      ctx.moveTo(x + winW / 2, y);
      ctx.lineTo(x + winW / 2, y + winH);
      ctx.moveTo(x, y + winH / 2);
      ctx.lineTo(x + winW, y + winH / 2);
      ctx.strokeStyle = "rgba(255,255,255,0.25)";
      ctx.lineWidth = Math.max(1, size * 0.004);
      ctx.stroke();
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.repeat.set(1 / cfg.FACADE_METERS_PER_TILE, 1 / cfg.FACADE_METERS_PER_TILE);
  tex.needsUpdate = true;
  cachedWindowTexture = tex;
  return tex;
}

/**
 * Terrain-following road ribbon: left/right edges along the centerline.
 * Each edge samples the DEM independently so cross-slopes don't bury one side,
 * and we lift clearly above the terrain mesh to avoid z-fighting with coarse DEM.
 */
function roadRibbonGeometry(
  path: [number, number][],
  halfWidth: number,
  grid: HeightGrid | null,
  thickness = cfg.ROAD_HEIGHT,
  originTint = false,
  colorOverride?: { fill: [number, number, number]; edge: [number, number, number] }
): THREE.BufferGeometry | null {
  if (path.length < 2 || halfWidth <= 0) return null;

  // Deduplicate consecutive points
  const raw: [number, number][] = [path[0]];
  for (let i = 1; i < path.length; i++) {
    const a = raw[raw.length - 1];
    const b = path[i];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 0.4) raw.push(b);
  }
  if (raw.length < 2) return null;

  // Densify so the ribbon follows DEM gradients instead of long chords that
  // cut through hills (looks like roads "mixed into" terrain).
  const STEP = 6; // meters between stations
  const pts: [number, number][] = [raw[0]];
  for (let i = 1; i < raw.length; i++) {
    const a = raw[i - 1];
    const b = raw[i];
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(1, Math.ceil(seg / STEP));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }

  const n = pts.length;
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  // Clearance above DEM: coarse elevation grids (15–40 m) can undershoot the
  // rendered terrain triangle by several decimeters; keep roads clearly on top.
  const LIFT = 0.35;
  // 4 verts per station: edge(curb/sidewalk, light) — inner(asphalt, dark) x2 — edge(light).
  // Skip the curb band on very narrow paths (footways etc.) where it'd be visually noisy.
  const hasCurb = halfWidth > 2.2;
  const innerFrac = hasCurb ? 0.86 : 1;
  const roadC: [number, number, number] = colorOverride ? [...colorOverride.fill] : [...cfg.ROAD_COLOR];
  const edgeC: [number, number, number] = colorOverride ? [...colorOverride.edge] : [...cfg.ROAD_EDGE_COLOR];
  if (originTint) {
    // Human-edited roads get the same subtle warm nudge as edited buildings (spec §3 step 5).
    const accent: [number, number, number] = [1, 0.75, 0.35];
    const t = 0.14;
    for (const c of [roadC, edgeC]) {
      c[0] = c[0] * (1 - t) + accent[0] * t;
      c[1] = c[1] * (1 - t) + accent[1] * t;
      c[2] = c[2] * (1 - t) + accent[2] * t;
    }
  }

  for (let i = 0; i < n; i++) {
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(n - 1, i + 1)];
    let tx = next[0] - prev[0];
    let tz = next[1] - prev[1];
    const len = Math.hypot(tx, tz) || 1;
    tx /= len;
    tz /= len;
    const nx = -tz;
    const nz = tx;

    const x = pts[i][0];
    const z = pts[i][1];
    const innerHalf = halfWidth * innerFrac;

    const offsets: [number, [number, number, number]][] = [
      [halfWidth, edgeC],
      [innerHalf, roadC],
      [-innerHalf, roadC],
      [-halfWidth, edgeC],
    ];

    for (const [off, col] of offsets) {
      const vx = x + nx * off;
      const vz = z + nz * off;
      let y = LIFT;
      if (grid) {
        const hV = heightAtFeature(grid, vx, vz);
        const hC = heightAtFeature(grid, x, z);
        y = Math.max(hV, hC) + LIFT;
      }
      positions.push(vx, y + thickness, vz);
      colors.push(col[0], col[1], col[2]);
    }
  }

  for (let i = 0; i < n - 1; i++) {
    const base = i * 4;
    const nextBase = base + 4;
    for (let k = 0; k < 3; k++) {
      const a = base + k;
      const b = base + k + 1;
      const c = nextBase + k;
      const d = nextBase + k + 1;
      indices.push(a, c, b);
      indices.push(b, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

export type SidewalkPickEntry = {
  featureIndex: number;
  sourceId: string;
  triangleStart: number;
  triangleCount: number;
  vertexStart: number;
  vertexCount: number;
};

const SIDEWALK_FILL: [number, number, number] = [0.78, 0.76, 0.72];
const SIDEWALK_EDGE: [number, number, number] = [0.68, 0.66, 0.62];

/**
 * Renders user-drawn SidewalkFeatures (spec §5.5) as a raised ribbon —
 * reuses roadRibbonGeometry's terrain-following extrusion with a concrete
 * color and the sidewalk's own curbHeight as thickness, so it sits visibly
 * above the road surface next to it rather than flush with it.
 */
function sidewalksGeometry(
  sidewalks: SidewalkFeature[],
  grid: HeightGrid | null
): { geometry: THREE.BufferGeometry | null; sidewalkIndex: SidewalkPickEntry[] } {
  const geos: THREE.BufferGeometry[] = [];
  const sidewalkIndex: SidewalkPickEntry[] = [];
  let triangleCursor = 0;
  let vertexCursor = 0;
  for (let featureIndex = 0; featureIndex < sidewalks.length; featureIndex++) {
    const s = sidewalks[featureIndex];
    if (s.path.length < 2) continue;
    const geo = roadRibbonGeometry(s.path, Math.max(0.5, s.width) / 2, grid, s.curbHeight, false, {
      fill: SIDEWALK_FILL,
      edge: SIDEWALK_EDGE,
    });
    if (!geo) continue;
    geos.push(geo);
    const triCount = (geo.index ? geo.index.count : geo.getAttribute("position").count) / 3;
    const vertCount = geo.getAttribute("position").count;
    sidewalkIndex.push({
      featureIndex,
      sourceId: s.id,
      triangleStart: triangleCursor,
      triangleCount: triCount,
      vertexStart: vertexCursor,
      vertexCount: vertCount,
    });
    triangleCursor += triCount;
    vertexCursor += vertCount;
  }
  return { geometry: mergeOrEmpty(geos), sidewalkIndex };
}

export function resolveSidewalkAtFace(index: SidewalkPickEntry[], faceIndex: number): SidewalkPickEntry | null {
  let lo = 0;
  let hi = index.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const entry = index[mid];
    if (faceIndex < entry.triangleStart) hi = mid - 1;
    else if (faceIndex >= entry.triangleStart + entry.triangleCount) lo = mid + 1;
    else return entry;
  }
  return null;
}

export type RoadPickEntry = {
  featureIndex: number;
  sourceId: string | undefined;
  triangleStart: number;
  triangleCount: number;
  vertexStart: number;
  vertexCount: number;
};

function roadsGeometry(
  features: RoadFeature[],
  grid: HeightGrid | null
): { geometry: THREE.BufferGeometry | null; roadIndex: RoadPickEntry[] } {
  const geos: THREE.BufferGeometry[] = [];
  const roadIndex: RoadPickEntry[] = [];
  let triangleCursor = 0;
  let vertexCursor = 0;
  for (let featureIndex = 0; featureIndex < features.length; featureIndex++) {
    const r = features[featureIndex];
    if (r.path.length < 2) continue;
    if (r.width < 1.2) continue; // skip tiny footpaths for cleaner mesh
    const geo = roadRibbonGeometry(r.path, r.width / 2, grid, cfg.ROAD_HEIGHT, r.origin === "human-edited");
    if (!geo) continue;
    geos.push(geo);

    const triCount = (geo.index ? geo.index.count : geo.getAttribute("position").count) / 3;
    const vertCount = geo.getAttribute("position").count;
    roadIndex.push({
      featureIndex,
      sourceId: r.id,
      triangleStart: triangleCursor,
      triangleCount: triCount,
      vertexStart: vertexCursor,
      vertexCount: vertCount,
    });
    triangleCursor += triCount;
    vertexCursor += vertCount;
  }
  // Junctions are appended after all ribbons, so they never shift the ribbon
  // index above — picking simply won't resolve a junction disc to a road,
  // which is fine (there's nothing useful to edit about a junction fill).
  const junctions = roadJunctionsGeometry(features, grid);
  if (junctions) geos.push(junctions);
  return { geometry: mergeOrEmpty(geos), roadIndex };
}

/** Resolve a raycast faceIndex on the roads mesh back to a source road. Mirrors resolveBuildingAtFace. */
export function resolveRoadAtFace(roadIndex: RoadPickEntry[], faceIndex: number): RoadPickEntry | null {
  let lo = 0;
  let hi = roadIndex.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const entry = roadIndex[mid];
    if (faceIndex < entry.triangleStart) {
      hi = mid - 1;
    } else if (faceIndex >= entry.triangleStart + entry.triangleCount) {
      lo = mid + 1;
    } else {
      return entry;
    }
  }
  return null;
}

/**
 * Fills the gaps at street intersections with a flat paved disc sized to the
 * widest road meeting there, so junctions read as continuous pavement instead
 * of two ribbons crossing with visible notches (real streets have a merged
 * intersection surface, not raw crossing strips).
 */
function roadJunctionsGeometry(features: RoadFeature[], grid: HeightGrid | null): THREE.BufferGeometry | null {
  type Node = { x: number; z: number; maxHalf: number; roads: number };
  const cellSize = 3; // meters — endpoints within this snap together
  const buckets = new Map<string, Node>();

  const key = (x: number, z: number) => `${Math.round(x / cellSize)}:${Math.round(z / cellSize)}`;

  for (const r of features) {
    if (r.path.length < 2 || r.width < 1.2) continue;
    const half = r.width / 2;
    for (const [x, z] of [r.path[0], r.path[r.path.length - 1]]) {
      const k = key(x, z);
      const existing = buckets.get(k);
      if (existing) {
        existing.x = (existing.x * existing.roads + x) / (existing.roads + 1);
        existing.z = (existing.z * existing.roads + z) / (existing.roads + 1);
        existing.maxHalf = Math.max(existing.maxHalf, half);
        existing.roads += 1;
      } else {
        buckets.set(k, { x, z, maxHalf: half, roads: 1 });
      }
    }
  }

  const geos: THREE.BufferGeometry[] = [];
  const roadC: [number, number, number] = [...cfg.ROAD_COLOR];
  for (const node of buckets.values()) {
    if (node.roads < 2) continue; // only real junctions, not dead ends
    const r = node.maxHalf * 1.08;
    const segs = 12;
    const positions: number[] = [];
    const indices: number[] = [];
    const LIFT = 0.35 + cfg.ROAD_HEIGHT + 0.03; // sit just above ribbon tops to cleanly cover seams
    const yc = grid ? heightAtFeature(grid, node.x, node.z) : 0;
    positions.push(node.x, yc + LIFT, node.z);
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const px = node.x + Math.cos(a) * r;
      const pz = node.z + Math.sin(a) * r;
      const y = grid ? Math.max(yc, heightAtFeature(grid, px, pz)) : 0;
      positions.push(px, y + LIFT, pz);
    }
    for (let i = 1; i <= segs; i++) indices.push(0, i, i + 1);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    paintGeometry(geo, roadC);
    geos.push(geo);
  }
  return mergeOrEmpty(geos);
}

function waterGeometry(features: WaterFeature[], grid: HeightGrid | null): THREE.BufferGeometry | null {
  const geos: THREE.BufferGeometry[] = [];
  for (const w of features) {
    if (!w.rings.length) continue;
    const shape = toShape(w.rings[0], w.rings.slice(1));
    if (!shape) continue;
    const geo = extrudeShape(shape, 0.35);
    if (!geo) continue;
    if (grid) {
      drapeOntoTerrain(geo, grid, 0.04);
    } else {
      geo.translate(0, 0.02, 0);
    }
    geos.push(geo);
  }
  return mergeOrEmpty(geos);
}

function portGeometry(features: PortFeature[], grid: HeightGrid | null): THREE.BufferGeometry | null {
  const geos: THREE.BufferGeometry[] = [];
  for (const p of features) {
    let geo: THREE.BufferGeometry | null = null;
    if (p.shape === "line" && p.path) {
      geo = roadRibbonGeometry(p.path, (p.width ?? 4) / 2, grid, 0.3);
    } else if (p.shape === "area" && p.ring) {
      const shape = toShape(p.ring);
      if (shape) geo = extrudeShape(shape, 0.3);
      if (geo) {
        geo.deleteAttribute("uv"); // match ribbon-derived geometries (position/normal/color only) before merge
        if (grid) drapeOntoTerrain(geo, grid, 0.05);
        else geo.translate(0, 0.05, 0);
      }
    }
    if (!geo) continue;
    const color = cfg.PORT_COLOR_MAP[p.kind] ?? [0.5, 0.49, 0.47];
    paintGeometry(geo, color);
    geos.push(geo);
  }
  const merged = mergeOrEmpty(geos);
  return merged;
}

function coastlineGeometry(features: CoastlineFeature[], grid: HeightGrid | null): THREE.BufferGeometry | null {
  const geos: THREE.BufferGeometry[] = [];
  for (const c of features) {
    const geo = roadRibbonGeometry(c.path, 0.6, grid, 0.12);
    if (!geo) continue;
    paintGeometry(geo, [...cfg.COASTLINE_COLOR]);
    geos.push(geo);
  }
  return mergeOrEmpty(geos);
}

function terrainGeometryFromGrid(
  grid: HeightGrid,
  extent?: { minX: number; maxX: number; minZ: number; maxZ: number }
): THREE.BufferGeometry {
  const { width: cols, height: rows, data, xs, zs } = grid;
  const geo = new THREE.PlaneGeometry(1, 1, cols - 1, rows - 1);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const uvs = geo.attributes.uv as THREE.BufferAttribute;

  const minX = extent?.minX ?? xs[0];
  const maxX = extent?.maxX ?? xs[cols - 1];
  const minZ = extent?.minZ ?? -zs[rows - 1]; // feature Z (north negative)
  const maxZ = extent?.maxZ ?? -zs[0];
  const spanX = maxX - minX || 1;
  const spanZ = maxZ - minZ || 1;

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const idx = j * cols + i;
      const x = xs[i];
      const zNorth = zs[j]; // local Z north
      const h = data[idx];
      // Three Z = -north = feature z
      const zFeat = -zNorth;
      pos.setXYZ(idx, x, h, zFeat);
      // UV: u east, v north→south so satellite orientation matches
      const u = (x - minX) / spanX;
      const v = 1 - (zFeat - minZ) / spanZ;
      uvs.setXY(idx, u, v);
    }
  }
  pos.needsUpdate = true;
  uvs.needsUpdate = true;
  geo.computeVertexNormals();
  // Ensure normals point skyward (+Y). PlaneGeometry remapped onto XZ can end up
  // with either winding; sample the average Y and flip only if needed.
  const nrm = geo.attributes.normal as THREE.BufferAttribute;
  let avgY = 0;
  for (let i = 0; i < nrm.count; i++) avgY += nrm.getY(i);
  avgY /= Math.max(1, nrm.count);
  if (avgY < 0) {
    for (let i = 0; i < nrm.count; i++) {
      nrm.setXYZ(i, -nrm.getX(i), -nrm.getY(i), -nrm.getZ(i));
    }
  }
  nrm.needsUpdate = true;
  return geo;
}

function flatTerrainGeometry(data: CityData): THREE.BufferGeometry {
  const { width, depth } = bboxSizeMeters(data.bbox);
  const pad = 1.08;
  const geo = new THREE.BoxGeometry(Math.max(width, 40) * pad, 1.2, Math.max(depth, 40) * pad);
  geo.translate(0, -0.6, 0);
  return geo;
}

// Procedural trees: a small family of shapes (conifer / rounded broadleaf /
// layered) so a scattered forest doesn't read as one repeated cookie-cutter
// mesh. Trunk + volumetric canopy, colored via vertex colors for instancing.
type TreeKind = "conifer" | "round" | "layered";

function paintTree(merged: THREE.BufferGeometry, trunkTopY: number, canopyTint: [number, number, number]): void {
  const count = merged.getAttribute("position").count;
  const colors = new Float32Array(count * 3);
  const pos = merged.getAttribute("position");
  for (let i = 0; i < count; i++) {
    const y = pos.getY(i);
    if (y < trunkTopY) {
      colors[i * 3] = 0.32 + (i % 5) * 0.01;
      colors[i * 3 + 1] = 0.2;
      colors[i * 3 + 2] = 0.11;
    } else {
      colors[i * 3] = canopyTint[0];
      colors[i * 3 + 1] = canopyTint[1];
      colors[i * 3 + 2] = canopyTint[2];
    }
  }
  merged.setAttribute("color", new THREE.BufferAttribute(colors, 3));
}

function createTreeGeometry(kind: TreeKind, tint: [number, number, number]): THREE.BufferGeometry {
  let merged: THREE.BufferGeometry | null;
  let trunkTop: number;
  // Every contributing primitive is normalized to non-indexed before
  // merging. This mattered in practice, not just in theory: CylinderGeometry
  // and ConeGeometry are indexed by default in this Three version, but
  // IcosahedronGeometry (used for the "round" and "layered" canopy shapes)
  // is non-indexed — confirmed empirically, not assumed (same kind of check
  // as build-scene.ts's buildWallsWithFacades). Mixing them made
  // mergeGeometries() return null for 2 of the 3 tree variants, and the `!`
  // non-null assertions that used to follow silently turned that into
  // "Cannot read properties of null (reading 'getAttribute')" inside
  // paintTree() below whenever a scattered tree happened to roll "round" or
  // "layered" — a real, reproduced, now-fixed bug (see
  // scripts/verification/repro-tree-merge.mjs), not a hypothetical one.
  if (kind === "conifer") {
    const trunk = new THREE.CylinderGeometry(0.22, 0.38, 3.4, 6).toNonIndexed();
    trunk.translate(0, 1.7, 0);
    const c1 = new THREE.ConeGeometry(2.1, 3.6, 8).toNonIndexed();
    c1.translate(0, 4.6, 0);
    const c2 = new THREE.ConeGeometry(1.55, 3.2, 8).toNonIndexed();
    c2.translate(0, 6.6, 0);
    const c3 = new THREE.ConeGeometry(0.95, 2.4, 8).toNonIndexed();
    c3.translate(0, 8.4, 0);
    merged = mergeGeometries([trunk, c1, c2, c3], false);
    [trunk, c1, c2, c3].forEach((g) => g.dispose());
    trunkTop = 3.0;
  } else if (kind === "round") {
    const trunk = new THREE.CylinderGeometry(0.26, 0.42, 3.6, 6).toNonIndexed();
    trunk.translate(0, 1.8, 0);
    const canopy = new THREE.IcosahedronGeometry(2.6, 1).toNonIndexed();
    canopy.scale(1, 0.85, 1);
    canopy.translate(0, 5.4, 0);
    merged = mergeGeometries([trunk, canopy], false);
    [trunk, canopy].forEach((g) => g.dispose());
    trunkTop = 3.4;
  } else {
    const trunk = new THREE.CylinderGeometry(0.24, 0.4, 3.8, 6).toNonIndexed();
    trunk.translate(0, 1.9, 0);
    const lobe1 = new THREE.IcosahedronGeometry(1.9, 0).toNonIndexed();
    lobe1.translate(-1.1, 5.0, 0.3);
    const lobe2 = new THREE.IcosahedronGeometry(2.1, 0).toNonIndexed();
    lobe2.translate(1.0, 5.6, -0.4);
    const lobe3 = new THREE.IcosahedronGeometry(1.7, 0).toNonIndexed();
    lobe3.translate(0.1, 6.6, 0.7);
    merged = mergeGeometries([trunk, lobe1, lobe2, lobe3], false);
    [trunk, lobe1, lobe2, lobe3].forEach((g) => g.dispose());
    trunkTop = 3.6;
  }
  // Defensive fallback (should be unreachable now that inputs are
  // consistently non-indexed, but a null merge silently producing an
  // invisible tree is preferable to a hard crash if some future Three
  // version changes a primitive's indexing again).
  if (!merged) {
    console.warn(`createTreeGeometry: mergeGeometries returned null for kind="${kind}" — rendering an empty tree.`);
    merged = new THREE.BufferGeometry();
  }
  paintTree(merged, trunkTop, tint);
  return merged;
}

// A handful of shape/tint combos so the tree canopy of a scattered forest
// looks naturally varied rather than a single repeated instance.
const TREE_VARIANTS: { kind: TreeKind; tint: [number, number, number] }[] = [
  { kind: "conifer", tint: [0.15, 0.34, 0.17] },
  { kind: "conifer", tint: [0.19, 0.4, 0.21] },
  { kind: "round", tint: [0.26, 0.46, 0.22] },
  { kind: "round", tint: [0.32, 0.5, 0.24] },
  { kind: "layered", tint: [0.24, 0.42, 0.2] },
  { kind: "layered", tint: [0.29, 0.47, 0.26] },
];

/**
 * Renders placed SceneObjects (spec §5.11/§5.12) as simple primitive meshes
 * — boxes/cylinders/cones, not real models. Good enough to see where things
 * are and confirm placement works; a real asset library is future work.
 * Small counts expected (tens, not thousands) so individual THREE.Mesh
 * instances are fine — no need for the instancing scatterTrees() uses.
 */
function sceneObjectsGeometry(objects: SceneObject[], grid: HeightGrid | null): THREE.Group | null {
  if (objects.length === 0) return null;
  const group = new THREE.Group();
  group.name = "placed-objects";

  for (const obj of objects) {
    const mesh = primitiveForKind(obj.kind);
    if (!mesh) continue;
    const groundY = grid ? heightAtFeature(grid, obj.localX, obj.localZ) : 0;
    mesh.position.set(obj.localX, groundY, obj.localZ);
    mesh.rotation.y = (obj.rotationDeg * Math.PI) / 180;
    mesh.scale.setScalar(obj.scale || 1);
    group.add(mesh);
  }
  return group.children.length > 0 ? group : null;
}

const OBJECT_MATERIAL_CACHE = new Map<string, THREE.MeshStandardMaterial>();
function objectMaterial(hex: number): THREE.MeshStandardMaterial {
  const key = hex.toString(16);
  let mat = OBJECT_MATERIAL_CACHE.get(key);
  if (!mat) {
    mat = new THREE.MeshStandardMaterial({ color: hex, roughness: 0.85, metalness: 0.05 });
    OBJECT_MATERIAL_CACHE.set(key, mat);
  }
  return mat;
}

/** One simple mesh per SceneObjectKind. Heights are meters, matching everything else in this file. */
function primitiveForKind(kind: SceneObjectKind): THREE.Object3D | null {
  switch (kind) {
    case "tree": {
      const g = new THREE.Group();
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.2, 1.6, 6), objectMaterial(0x6b4a2f));
      trunk.position.y = 0.8;
      const canopy = new THREE.Mesh(new THREE.ConeGeometry(1.6, 3.2, 8), objectMaterial(0x3f7a3f));
      canopy.position.y = 3.2;
      g.add(trunk, canopy);
      return g;
    }
    case "bush":
      return new THREE.Mesh(new THREE.SphereGeometry(0.7, 8, 6), objectMaterial(0x4a7a3f));
    case "grass-patch":
      return new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 0.05, 8), objectMaterial(0x6fae4f));
    case "pole":
    case "street-light":
    case "traffic-sign":
    case "road-sign": {
      const g = new THREE.Group();
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 3.5, 6), objectMaterial(0x555555));
      pole.position.y = 1.75;
      g.add(pole);
      if (kind === "street-light") {
        const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 6), objectMaterial(0xfff2c0));
        lamp.position.y = 3.5;
        g.add(lamp);
      } else if (kind === "traffic-sign" || kind === "road-sign") {
        const sign = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.04), objectMaterial(0xd94c3d));
        sign.position.y = 3.2;
        g.add(sign);
      }
      return g;
    }
    case "bench":
      return new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.45, 0.5), objectMaterial(0x8a5a3a));
    case "trash-can":
      return new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.24, 0.75, 8), objectMaterial(0x3a5a4a));
    case "mailbox":
      return new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.35, 0.5), objectMaterial(0x4a5a8a));
    case "bollard":
      return new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.9, 8), objectMaterial(0x444444));
    case "hydrant":
      return new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.18, 0.7, 8), objectMaterial(0xc0392b));
    case "planter":
      return new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.45, 0.5, 10), objectMaterial(0x8a6a4a));
    case "utility-box":
      return new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.2, 0.5), objectMaterial(0x6a6a5a));
    case "bus-stop":
      return new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.2, 1), objectMaterial(0x9aa5b0));
    case "fence":
    case "gate":
    case "wall":
      return new THREE.Mesh(new THREE.BoxGeometry(2, 1.2, 0.1), objectMaterial(0x8a8a7a));
    case "parking-object":
      return new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.15, 1.6), objectMaterial(0xdddddd));
    default:
      return new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), objectMaterial(0x999999));
  }
}
function scatterTrees(
  grid: HeightGrid,
  data: CityData,
  count: number,
  landCoverGrid: LandCoverGrid | null = null
): THREE.Group | null {
  if (count <= 0) return null;

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.92,
    metalness: 0,
    flatShading: true,
  });

  const matrix = new THREE.Matrix4();
  const dummy = new THREE.Object3D();

  // Simple rejection sampling over the grid
  const widthM = data.extent.maxX - data.extent.minX;
  const depthM = data.extent.maxZ - data.extent.minZ;
  let placed = 0;
  let attempts = 0;
  const maxAttempts = count * 8;
  const seed = (data.origin.lon * 1000 + data.origin.lat * 100) | 0;

  function rand(i: number) {
    const x = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453;
    return x - Math.floor(x);
  }

  // Exclusion zones: buildings (centroid + radius) and dense samples along every road
  const exclude: { x: number; z: number; r: number }[] = [];
  for (const b of data.buildings.slice(0, 1200)) {
    const [cx, cz] = centroid(b.ring);
    const area = ringArea(b.ring);
    const r = Math.sqrt(area / Math.PI) * 1.35 + 4;
    exclude.push({ x: cx, z: cz, r });
  }
  for (const road of data.roads) {
    if (road.path.length < 2) continue;
    const clearR = Math.max(road.width * 0.6 + 3.5, 5);
    // Sample every ~8 m along the path so trees never sit on carriageways
    let acc = 0;
    exclude.push({ x: road.path[0][0], z: road.path[0][1], r: clearR });
    for (let i = 1; i < road.path.length; i++) {
      const a = road.path[i - 1];
      const b = road.path[i];
      const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
      acc += seg;
      if (acc >= 8 || i === road.path.length - 1) {
        exclude.push({ x: b[0], z: b[1], r: clearR });
        acc = 0;
      }
    }
  }
  for (const w of data.water.slice(0, 200)) {
    for (const ring of w.rings.slice(0, 1)) {
      const [cx, cz] = centroid(ring);
      const area = ringArea(ring);
      exclude.push({ x: cx, z: cz, r: Math.sqrt(area / Math.PI) * 1.1 + 6 });
    }
  }

  const buckets: THREE.Matrix4[][] = TREE_VARIANTS.map(() => []);

  while (placed < count && attempts < maxAttempts) {
    attempts++;
    const u = rand(attempts * 2);
    const v = rand(attempts * 2 + 1);
    const x = data.extent.minX + u * widthM;
    const z = data.extent.minZ + v * depthM; // feature-local Z (north → negative)

    const h = heightAtFeature(grid, x, z);

    // Slope estimate in feature space
    const eps = 8;
    const hx = heightAtFeature(grid, x + eps, z) - heightAtFeature(grid, x - eps, z);
    const hz = heightAtFeature(grid, x, z + eps) - heightAtFeature(grid, x, z - eps);
    const slope = Math.hypot(hx, hz) / (2 * eps);
    if (slope > cfg.TREE_MAX_SLOPE) continue;

    // Exclusion: no trees on roads, buildings, or water
    let ok = true;
    for (const e of exclude) {
      if (Math.hypot(x - e.x, z - e.z) < e.r) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    // Where we have ESA WorldCover, only let trees grow on vegetated/land
    // pixels — never on built-up, water, or snow/ice classification.
    if (landCoverGrid) {
      const [lon, lat] = unproject(x, z, data.origin.lon, data.origin.lat);
      const cls = sampleLandCoverClass(landCoverGrid, lon, lat);
      if (cls !== 0 && isBuiltOrWaterClass(cls)) continue;
    }

    // Slight random scale / rotation / variant pick, and cluster same-variant
    // trees loosely (real forests aren't a uniform shuffle of species).
    const s = 0.65 + rand(attempts * 3) * 1.0;
    const rot = rand(attempts * 4) * Math.PI * 2;
    const clusterSeed = Math.floor(x / 40) * 13 + Math.floor(z / 40) * 7;
    const variantT = (rand(clusterSeed) * 0.7 + rand(attempts * 5) * 0.3) % 1;
    const variantIdx = Math.min(TREE_VARIANTS.length - 1, Math.floor(variantT * TREE_VARIANTS.length));

    dummy.position.set(x, h, z);
    dummy.rotation.set(0, rot, 0);
    dummy.scale.set(s, s, s);
    dummy.updateMatrix();
    buckets[variantIdx].push(dummy.matrix.clone());
    placed++;
  }

  const group = new THREE.Group();
  group.name = "trees";
  for (let vi = 0; vi < TREE_VARIANTS.length; vi++) {
    const list = buckets[vi];
    if (!list.length) continue;
    const geometry = createTreeGeometry(TREE_VARIANTS[vi].kind, TREE_VARIANTS[vi].tint);
    const im = new THREE.InstancedMesh(geometry, material, list.length);
    im.castShadow = true;
    im.receiveShadow = true;
    for (let i = 0; i < list.length; i++) im.setMatrixAt(i, list[i]);
    im.instanceMatrix.needsUpdate = true;
    im.count = list.length;
    group.add(im);
  }

  if (placed === 0) {
    material.dispose();
    return null;
  }
  return group;
}

export type CityMeshes = {
  group: THREE.Group;
  buildings?: THREE.Mesh;
  roofs?: THREE.Mesh;
  roads?: THREE.Mesh;
  sidewalks?: THREE.Mesh;
  water?: THREE.Mesh;
  ports?: THREE.Mesh;
  coastline?: THREE.Mesh;
  terrain: THREE.Mesh;
  trees?: THREE.Group;
  stats: { buildings: number; roads: number; water: number; ports: number; vertices: number; trees?: number };
  heightGrid?: HeightGrid | null;
  /** Vertex-range index for resolving a buildings-mesh raycast hit to a source building (see resolveBuildingAtFace). */
  buildingIndex: BuildingPickEntry[];
  /** Same idea for roads — see resolveRoadAtFace. */
  roadIndex: RoadPickEntry[];
  /** Same idea for user-drawn sidewalks — see resolveSidewalkAtFace. */
  sidewalkIndex: SidewalkPickEntry[];
};

export type BuildSceneOptions = {
  /** Trees per m². Defaults to cfg.TREE_DENSITY. */
  treeDensity?: number;
  /** Drape Esri World Imagery (no API key) onto the terrain. */
  satellite?: boolean;
  /**
   * Drape ESA WorldCover land-cover classification (no API key) onto the
   * terrain as its "biological/physical material" — tree cover, grassland,
   * cropland, built-up, bare ground, water, etc. Takes priority over
   * `satellite` when both are enabled, and also gates where trees can grow.
   */
  landCover?: boolean;
  /** Called with overall meshing fraction 0–1 and a stage label. */
  onProgress?: (fraction: number, label: string) => void;
  /**
   * Use this height grid instead of fetching one. For the reconstruction
   * terrain-sculpt tool: fetch the base grid once, then pass
   * applyTerrainEdits(baseGrid, edits) back in on every rebuild so a brush
   * stroke doesn't re-fetch/re-sample Copernicus/Terrarium on every frame —
   * see reconstruction/apply.ts. `undefined` (the default) preserves the
   * original always-fetch behavior; `null` forces flat terrain.
   */
  externalHeightGrid?: HeightGrid | null;
  /** Placed reconstruction objects (spec §5.11/§5.12) to render alongside the generated scene. */
  objects?: SceneObject[];
  /** User-drawn sidewalks (spec §5.5) to render alongside the generated scene. */
  sidewalks?: SidewalkFeature[];
};

export async function buildCityMeshes(
  data: CityData,
  options: BuildSceneOptions = {}
): Promise<CityMeshes> {
  const group = new THREE.Group();
  group.name = "CityGLB";

  const treeDensity =
    options.treeDensity !== undefined && Number.isFinite(options.treeDensity)
      ? Math.max(0, options.treeDensity)
      : cfg.TREE_DENSITY;
  const wantSatellite = Boolean(options.satellite);
  const wantLandCover = Boolean(options.landCover);
  const onProgress = options.onProgress;

  // Parallelize elevation + land-cover fetches (they are independent network work).
  // Weighted progress: elevation 0–35%, landcover 0–20% of total meshing budget.
  let elevFrac = 0;
  let coverFrac = 0;
  const reportFetch = () => {
    // Combined fetch stage occupies first 55% of meshing.
    const combined = (elevFrac * 0.35 + coverFrac * 0.2) / 0.55;
    onProgress?.(Math.min(0.55, combined * 0.55), "Loading terrain data…");
  };

  const elevPromise =
    options.externalHeightGrid !== undefined
      ? Promise.resolve(options.externalHeightGrid)
      : !cfg.FLAT_TERRAIN
        ? fetchHeightGrid(data.bbox, data.origin, {
            targetMeters: Math.max(8, Math.min(24, (data.extent.maxX - data.extent.minX) / 96)),
            maxSamples: 140,
            onProgress: (f) => {
              elevFrac = f;
              reportFetch();
            },
          }).catch((e) => {
            console.warn("Elevation fetch failed, falling back to flat", e);
            return null as HeightGrid | null;
          })
        : Promise.resolve(null as HeightGrid | null);

  const coverPromise = wantLandCover
    ? fetchLandCoverGrid(data.bbox, {
        targetMeters: 10,
        maxSamples: 512,
        onProgress: (f) => {
          coverFrac = f;
          reportFetch();
        },
      }).catch((e) => {
        console.warn("Land cover fetch failed", e);
        return null as LandCoverGrid | null;
      })
    : Promise.resolve(null as LandCoverGrid | null);

  // Kick off satellite texture early so it overlaps with DEM/landcover + meshing.
  const satPromise =
    wantSatellite && !wantLandCover
      ? buildSatelliteCanvas(data.bbox, { maxTiles: 48, targetPx: 1536 }).catch((e) => {
          console.warn("Satellite texture failed", e);
          return null;
        })
      : Promise.resolve(null);

  const [grid, landCoverGrid] = await Promise.all([elevPromise, coverPromise]);
  onProgress?.(0.55, "Building terrain…");

  const buildingMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.86,
    metalness: 0.04,
    flatShading: true,
    color: 0xffffff,
  });
  if (cfg.ENABLE_WINDOWS) {
    try {
      buildingMat.map = createWindowTexture();
      buildingMat.normalMap = createWindowNormalMap();
      buildingMat.normalScale = new THREE.Vector2(0.6, 0.6);
      buildingMat.needsUpdate = true;
    } catch (e) {
      console.warn("Window texture failed", e);
    }
  }
  const roadMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    color: 0xffffff,
    roughness: 0.92,
    metalness: 0.0,
    flatShading: true,
    // Pull roads toward the camera in the depth buffer so they win against
    // coplanar / near-coplanar terrain triangles (z-fighting).
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    depthWrite: true,
  });
  const roofMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.75,
    metalness: 0.02,
    flatShading: true,
    color: 0xffffff,
  });
  const waterMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color().fromArray([...cfg.WATER_COLOR]),
    roughness: 0.18,
    metalness: 0.22,
    transparent: true,
    opacity: 0.88,
    depthWrite: false,
  });
  const portMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.9,
    metalness: 0.05,
    flatShading: true,
    color: 0xffffff,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  const coastlineMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.95,
    metalness: 0,
    flatShading: true,
    color: 0xffffff,
  });
  const terrainMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color().fromArray([...cfg.TERRAIN_COLOR]),
    roughness: 1,
    metalness: 0,
    flatShading: !wantSatellite && !wantLandCover,
    // FrontSide once normals are guaranteed +Y; avoids the dark "backface"
    // look when viewing the terrain from above with inverted lighting.
    side: THREE.DoubleSide,
  });

  const terrainGeo = grid
    ? terrainGeometryFromGrid(grid, data.extent)
    : flatTerrainGeometry(data);
  const terrainMesh = new THREE.Mesh(terrainGeo, terrainMat);
  terrainMesh.name = "terrain";
  terrainMesh.receiveShadow = true;
  group.add(terrainMesh);

  // Land cover (ESA WorldCover) takes priority as the ground material since
  // it's a classification, not just an image — it also drives tree gating
  // below. Falls back to satellite imagery if land cover wasn't requested
  // or failed to load.
  if (wantLandCover && landCoverGrid) {
    try {
      const canvas = buildLandCoverCanvas(landCoverGrid);
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      tex.needsUpdate = true;
      terrainMat.map = tex;
      terrainMat.color.set(0xffffff);
      // Photo/class textures look crushed under full PBR roughness + ACES.
      // Slightly lower roughness and a gentle emissive lift keep albedo readable
      // from above without washing out relief shading.
      terrainMat.roughness = 0.78;
      terrainMat.metalness = 0;
      terrainMat.emissiveMap = tex;
      terrainMat.emissive.setHex(0xffffff);
      terrainMat.emissiveIntensity = 0.22;
      terrainMat.flatShading = false;
      terrainMat.needsUpdate = true;
    } catch (e) {
      console.warn("Land cover texture failed", e);
    }
  } else if (wantSatellite) {
    try {
      const canvas = await satPromise;
      if (canvas) {
        const tex = new THREE.CanvasTexture(canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        tex.needsUpdate = true;
        terrainMat.map = tex;
        terrainMat.color.set(0xffffff);
        terrainMat.roughness = 0.78;
        terrainMat.metalness = 0;
        terrainMat.emissiveMap = tex;
        terrainMat.emissive.setHex(0xffffff);
        terrainMat.emissiveIntensity = 0.28;
        terrainMat.flatShading = false;
        terrainMat.needsUpdate = true;
      }
    } catch (e) {
      console.warn("Satellite texture failed", e);
    }
  }

  onProgress?.(0.62, "Extruding buildings…");

  let vertices = terrainMesh.geometry.getAttribute("position").count;

  let buildingsMesh: THREE.Mesh | undefined;
  let roofsMesh: THREE.Mesh | undefined;
  let roadsMesh: THREE.Mesh | undefined;
  let sidewalksMesh: THREE.Mesh | undefined;
  let waterMesh: THREE.Mesh | undefined;
  let portsMesh: THREE.Mesh | undefined;
  let coastlineMesh: THREE.Mesh | undefined;
  let treesMesh: THREE.Group | undefined;
  let treeStatsCount = 0;

  const { walls: bGeo, roofs: roofGeo, buildingIndex } = buildingsGeometry(data.buildings, grid);
  if (bGeo) {
    buildingsMesh = new THREE.Mesh(bGeo, buildingMat);
    buildingsMesh.name = "buildings";
    buildingsMesh.castShadow = true;
    buildingsMesh.receiveShadow = true;
    group.add(buildingsMesh);
    vertices += bGeo.getAttribute("position").count;
  }
  if (roofGeo) {
    roofsMesh = new THREE.Mesh(roofGeo, roofMat);
    roofsMesh.name = "roofs";
    roofsMesh.castShadow = true;
    roofsMesh.receiveShadow = true;
    group.add(roofsMesh);
    vertices += roofGeo.getAttribute("position").count;
  }

  onProgress?.(0.75, "Meshing water…");

  const wGeo = waterGeometry(data.water, grid);
  if (wGeo) {
    waterMesh = new THREE.Mesh(wGeo, waterMat);
    waterMesh.name = "water";
    waterMesh.renderOrder = 1;
    group.add(waterMesh);
    vertices += wGeo.getAttribute("position").count;
  }

  onProgress?.(0.8, "Meshing ports & coastline…");

  const pGeo = portGeometry(data.ports, grid);
  if (pGeo) {
    portsMesh = new THREE.Mesh(pGeo, portMat);
    portsMesh.name = "ports";
    portsMesh.renderOrder = 2;
    group.add(portsMesh);
    vertices += pGeo.getAttribute("position").count;
  }

  const cGeo = coastlineGeometry(data.coastline, grid);
  if (cGeo) {
    coastlineMesh = new THREE.Mesh(cGeo, coastlineMat);
    coastlineMesh.name = "coastline";
    coastlineMesh.renderOrder = 2;
    group.add(coastlineMesh);
    vertices += cGeo.getAttribute("position").count;
  }

  onProgress?.(0.85, "Meshing roads…");

  const { geometry: rGeo, roadIndex } = roadsGeometry(data.roads, grid);
  if (rGeo) {
    roadsMesh = new THREE.Mesh(rGeo, roadMat);
    roadsMesh.name = "roads";
    roadsMesh.renderOrder = 2; // after terrain & water
    group.add(roadsMesh);
    vertices += rGeo.getAttribute("position").count;
  }

  let sidewalkIndex: SidewalkPickEntry[] = [];
  if (options.sidewalks && options.sidewalks.length > 0) {
    const sw = sidewalksGeometry(options.sidewalks, grid);
    sidewalkIndex = sw.sidewalkIndex;
    if (sw.geometry) {
      sidewalksMesh = new THREE.Mesh(sw.geometry, roadMat);
      sidewalksMesh.name = "sidewalks";
      sidewalksMesh.renderOrder = 2;
      group.add(sidewalksMesh);
      vertices += sw.geometry.getAttribute("position").count;
    }
  }

  onProgress?.(0.93, "Placing trees…");

  // Trees
  if (cfg.ENABLE_TREES && grid && treeDensity > 0) {
    const area = (data.extent.maxX - data.extent.minX) * (data.extent.maxZ - data.extent.minZ);
    const desired = Math.min(cfg.MAX_TREES, Math.floor(area * treeDensity));
    treesMesh = scatterTrees(grid, data, desired, landCoverGrid) ?? undefined;
    if (treesMesh) {
      group.add(treesMesh);
      let treeVerts = 0;
      let treeCount = 0;
      treesMesh.traverse((obj) => {
        const im = obj as THREE.InstancedMesh;
        if ((im as unknown as { isInstancedMesh?: boolean }).isInstancedMesh) {
          treeVerts += im.geometry.getAttribute("position").count * (im.count || 0);
          treeCount += im.count || 0;
        }
      });
      vertices += treeVerts;
      treeStatsCount = treeCount;
    }
  }

  // Placed reconstruction objects (spec §5.11/§5.12)
  if (options.objects && options.objects.length > 0) {
    const objectsGroup = sceneObjectsGeometry(options.objects, grid);
    if (objectsGroup) {
      group.add(objectsGroup);
      objectsGroup.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) vertices += mesh.geometry.getAttribute("position")?.count ?? 0;
      });
    }
  }

  onProgress?.(0.99, "Finalizing…");

  return {
    group,
    buildings: buildingsMesh,
    roofs: roofsMesh,
    roads: roadsMesh,
    sidewalks: sidewalksMesh,
    water: waterMesh,
    ports: portsMesh,
    coastline: coastlineMesh,
    terrain: terrainMesh,
    trees: treesMesh,
    buildingIndex,
    roadIndex,
    sidewalkIndex,
    stats: {
      buildings: data.buildings.length,
      roads: data.roads.length,
      water: data.water.length,
      ports: data.ports.length,
      vertices,
      trees: treeStatsCount,
    },
    heightGrid: grid,
  };
}

export function disposeCityMeshes(meshes: CityMeshes): void {
  meshes.group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = mesh.material;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else if (mat) mat.dispose();
  });
}
