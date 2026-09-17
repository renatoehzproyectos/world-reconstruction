import type { BuildingFeature, CityData, RoadFeature } from "@/lib/city/types";
import type { HeightGrid } from "@/lib/city/elevation";
import type { BuildingEdit, MaterialDefinition, ReconstructionDeltas, RoadEdit } from "./types";

/**
 * A building/road in the final world, tagged with provenance so the renderer
 * and UI can visually distinguish generated-only content from
 * human-reconstructed content (spec §3 step 5: "the original generated world
 * must remain distinguishable from human modifications").
 */
export type ReconstructedBuilding = BuildingFeature & {
  edit: BuildingEdit | null;
  origin: "generated" | "human-edited" | "human-added";
};

export type ReconstructedRoad = RoadFeature & {
  edit: RoadEdit | null;
  origin: "generated" | "human-edited";
};

export type ReconstructedWorld = {
  buildings: ReconstructedBuilding[];
  roads: ReconstructedRoad[];
  /** Base CityData fields untouched by the delta layer, passed through as-is. */
  water: CityData["water"];
  ports: CityData["ports"];
  coastline: CityData["coastline"];
  objects: ReconstructionDeltas["objects"];
  sidewalks: ReconstructionDeltas["sidewalks"];
};

/**
 * Merge base-world data with the reconstruction delta layer. Pure and
 * non-destructive: `base` is never mutated. Call this on every render/edit
 * rather than baking deltas into the base data, so undo/redo and future
 * base-data migrations stay possible (spec §4, §15).
 */
export function applyReconstruction(base: CityData, deltas: ReconstructionDeltas): ReconstructedWorld {
  const buildingEditBySource = new Map<string, BuildingEdit>();
  for (const edit of deltas.buildingEdits) {
    buildingEditBySource.set(edit.sourceId, edit);
  }

  const buildings: ReconstructedBuilding[] = base.buildings.map((b) => {
    const edit = (b.id && buildingEditBySource.get(b.id)) || null;
    if (edit) buildingEditBySource.delete(b.id!);
    return mergeBuilding(b, edit, deltas.materials);
  });

  // Remaining edits with no matching source id are user-placed custom
  // buildings (isCustom) — surface them even though no Overture footprint
  // backs them.
  for (const edit of buildingEditBySource.values()) {
    if (edit.isCustom && edit.customRing) {
      buildings.push({
        ring: edit.customRing,
        holes: [],
        height: edit.height ?? (edit.floors ? edit.floors * 3 : 3),
        kind: "custom",
        id: edit.sourceId,
        colorOverride: colorOverrideFor(edit, deltas.materials),
        facadeColors: facadeColorsFor(edit, deltas.materials),
        roofOverride: roofOverrideFor(edit),
        edit,
        origin: "human-added",
      });
    }
  }

  const roadEditBySource = new Map<string, RoadEdit>();
  for (const edit of deltas.roadEdits) {
    roadEditBySource.set(edit.sourceId, edit);
  }

  const roads: ReconstructedRoad[] = [];
  for (const r of base.roads) {
    const edit = (r.id && roadEditBySource.get(r.id)) || null;
    if (edit?.deleted) continue;
    roads.push(mergeRoad(r, edit));
  }

  return {
    buildings,
    roads,
    water: base.water,
    ports: base.ports,
    coastline: base.coastline,
    objects: deltas.objects,
    sidewalks: deltas.sidewalks,
  };
}

/**
 * Turn a ReconstructedWorld back into a renderable CityData so the existing
 * build-scene.ts / CityViewer pipeline can consume it unmodified —
 * ReconstructedBuilding/ReconstructedRoad are structural supersets of
 * BuildingFeature/RoadFeature (extra `edit`/`origin` fields are simply
 * ignored by the renderer). This is the seam where "base + deltas" becomes
 * an actual scene: call it once per render, never cache the result across
 * edits, so undo/redo and new edits always show up.
 *
 * Roof/facade edits now reflect here as generic rendering hints
 * (colorOverride/roofOverride on BuildingFeature — see city/types.ts),
 * computed by mergeBuilding() below. This is a flat-tint approximation, not
 * real materials/textures or distinct gable/hip/shed roof shapes — see the
 * FACADE_MATERIAL_COLORS comment and build-scene.ts's roof handling for the
 * documented simplification. Height/floors and road width/path map onto
 * fields BuildingFeature/RoadFeature already have.
 */
export function materializeCityData(base: CityData, deltas: ReconstructionDeltas): CityData {
  const world = applyReconstruction(base, deltas);
  return {
    ...base,
    buildings: world.buildings,
    roads: world.roads,
  };
}

/**
 * Facade material name → base RGB (0–1). Deliberately simple — the renderer
 * only supports flat vertex-color tinting per building (see
 * build-scene.ts), not textures, so "brick" etc. means "brick-ish tint",
 * not an actual brick texture. Real materials/textures are future work.
 */
const FACADE_MATERIAL_COLORS: Record<string, [number, number, number]> = {
  brick: [0.55, 0.28, 0.22],
  plaster: [0.86, 0.82, 0.74],
  wood: [0.42, 0.3, 0.18],
  stone: [0.6, 0.58, 0.54],
  concrete: [0.62, 0.62, 0.62],
};

/**
 * A building only has one merged-mesh color today (no per-side material
 * support in the renderer — see build-scene.ts), so when multiple facades
 * have different materials set, the first one (by FACADE_SIDES order) wins
 * as a stand-in for the whole building. Documented simplification, not a bug.
 */
const FACADE_SIDE_ORDER = ["north", "south", "east", "west", "front", "back", "left", "right"] as const;

/**
 * All four cardinal facades resolved to colors at once, for the per-side
 * wall renderer (build-scene.ts buildWallsWithFacades). Falls back through
 * the same custom-library → built-in lookup as colorOverrideFor per side.
 */
function facadeColorsFor(
  edit: BuildingEdit,
  materials: MaterialDefinition[]
): BuildingFeature["facadeColors"] {
  if (!edit.facades) return undefined;
  const CARDINALS = ["north", "south", "east", "west"] as const;
  const out: NonNullable<BuildingFeature["facadeColors"]> = {};
  for (const side of CARDINALS) {
    const material = edit.facades[side]?.material;
    if (!material) continue;
    const custom = materials.find((m) => m.id === material || m.name === material);
    if (custom) out[side] = hexToRgb01(custom.baseColor);
    else if (FACADE_MATERIAL_COLORS[material]) out[side] = FACADE_MATERIAL_COLORS[material];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function colorOverrideFor(edit: BuildingEdit, materials: MaterialDefinition[]): [number, number, number] | undefined {
  if (!edit.facades) return undefined;
  for (const side of FACADE_SIDE_ORDER) {
    const material = edit.facades[side]?.material;
    if (!material) continue;
    const custom = materials.find((m) => m.id === material || m.name === material);
    if (custom) return hexToRgb01(custom.baseColor);
    if (FACADE_MATERIAL_COLORS[material]) return FACADE_MATERIAL_COLORS[material];
  }
  return undefined;
}

/** "#rrggbb" → [r,g,b] in 0–1, matching the format everything else in this file uses. */
function hexToRgb01(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const n = parseInt(clean.length === 3 ? clean.replace(/(.)/g, "$1$1") : clean, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/**
 * "gable" and "shed" now get their own distinct roof shapes in
 * build-scene.ts (gableRoofGeometry/shedRoofGeometry). "custom" still maps
 * to "hip" as the closest available shape until a real custom-roof editor
 * exists.
 */
function roofOverrideFor(edit: BuildingEdit): BuildingFeature["roofOverride"] {
  if (!edit.roof) return undefined;
  const type = edit.roof.type === "custom" ? "hip" : edit.roof.type;
  return { type, rise: edit.roof.rise };
}

function mergeBuilding(
  base: BuildingFeature,
  edit: BuildingEdit | null,
  materials: MaterialDefinition[]
): ReconstructedBuilding {
  if (!edit) return { ...base, edit: null, origin: "generated" };
  return {
    ...base,
    height: edit.height ?? (edit.floors ? edit.floors * 3 : base.height),
    colorOverride: colorOverrideFor(edit, materials),
    facadeColors: facadeColorsFor(edit, materials),
    roofOverride: roofOverrideFor(edit),
    edit,
    origin: "human-edited",
  };
}

function mergeRoad(base: RoadFeature, edit: RoadEdit | null): ReconstructedRoad {
  if (!edit) return { ...base, edit: null, origin: "generated" };
  return {
    ...base,
    width: edit.width ?? base.width,
    path: edit.path ?? base.path,
    edit,
    origin: "human-edited",
  };
}

/**
 * Terrain deltas are applied as an additive offset sampled at render time,
 * mirroring the elevation module's own philosophy (never silently overwrite
 * the base value — see src/lib/city/elevation.ts). Returns a new Float32Array;
 * `grid.data` (the generated base) is left untouched.
 */
export function applyTerrainEdits(grid: HeightGrid, edits: ReconstructionDeltas["terrainEdits"]): Float32Array {
  const out = Float32Array.from(grid.data);
  if (edits.length === 0) return out;

  for (let j = 0; j < grid.height; j++) {
    const z = grid.zs[j];
    for (let i = 0; i < grid.width; i++) {
      const x = grid.xs[i];
      const idx = j * grid.width + i;
      let h = out[idx];
      for (const edit of edits) {
        const dx = x - edit.localX;
        const dz = z - edit.localZ;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist > edit.radius) continue;
        const t = 1 - dist / edit.radius;
        const w = Math.pow(t, 1 + edit.falloff * 3); // softer falloff as `falloff` grows
        if (edit.kind === "flatten") {
          h = h + (edit.amount - h) * w;
        } else if (edit.kind === "smooth") {
          // simple box blur pass toward the 4-neighbor average, weighted by brush
          const n = sampleGrid(out, grid.width, grid.height, i - 1, j);
          const s = sampleGrid(out, grid.width, grid.height, i + 1, j);
          const e = sampleGrid(out, grid.width, grid.height, i, j - 1);
          const wst = sampleGrid(out, grid.width, grid.height, i, j + 1);
          const avg = (n + s + e + wst) / 4;
          h = h + (avg - h) * w;
        } else {
          // raise / lower / slope / stamp: additive
          h = h + edit.amount * w;
        }
      }
      out[idx] = h;
    }
  }
  return out;
}

/**
 * Convenience wrapper: applyTerrainEdits() returns just the edited height
 * array; this returns a full HeightGrid with that array swapped in, ready to
 * pass as buildCityMeshes' `externalHeightGrid` option. minH/maxH are left
 * as the base grid's values (used only for a couple of coloring heuristics
 * downstream) — fine for MVP brush strokes, worth recomputing if edits ever
 * get large enough to visibly skew terrain shading.
 */
export function applyTerrainEditsToGrid(grid: HeightGrid, edits: ReconstructionDeltas["terrainEdits"]): HeightGrid {
  if (edits.length === 0) return grid;
  return { ...grid, data: applyTerrainEdits(grid, edits) };
}

function sampleGrid(data: Float32Array, width: number, height: number, i: number, j: number): number {
  const ci = Math.max(0, Math.min(width - 1, i));
  const cj = Math.max(0, Math.min(height - 1, j));
  return data[cj * width + ci];
}
