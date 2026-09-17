import type { BBox, Ring } from "@/lib/city/types";

/**
 * ============================================================================
 * RECONSTRUCTION DELTA LAYER
 * ============================================================================
 *
 * Core rule (spec §4): the generated base world (Overture buildings/roads/
 * water, Copernicus elevation, WorldCover) is NEVER mutated in place. Every
 * human change is stored as a semantic, undoable delta keyed to a stable
 * source id. The final rendered world = base data + deltas, recomputed at
 * render time (see reconstruction/apply.ts). This is what makes undo, save/
 * load, forking, and future base-data migrations possible.
 *
 * Edits are semantic ("2 floors", "gable roof, 3.2m rise"), never raw mesh
 * vertex edits (spec §23) — that's what keeps undo/versioning/regeneration
 * tractable.
 */

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------

/**
 * A single terrain sculpt operation, stored as a delta against the base
 * Copernicus/Terrarium height grid rather than baked into it (spec §5.3).
 * `localX`/`localZ` are in the project's local meter coordinate system
 * (see src/lib/city/geo.ts) so edits stay aligned regardless of which
 * elevation source produced the base grid.
 */
export type TerrainEdit = {
  id: string;
  kind: "raise" | "lower" | "smooth" | "flatten" | "slope" | "stamp";
  /** Center of the brush stroke, local meters. */
  localX: number;
  localZ: number;
  /** Brush radius, meters. */
  radius: number;
  /** Signed delta in meters for raise/lower; target height for flatten. */
  amount: number;
  /** 0–1 falloff softness at the brush edge. */
  falloff: number;
  createdAt: string;
};

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

export type RoofEdit = {
  type: "flat" | "gable" | "hip" | "shed" | "custom";
  pitch?: number;
  rise?: number;
  direction?: number; // degrees
  overhang?: number; // meters
  material?: string;
  color?: string;
};

export type FacadeSide = "north" | "south" | "east" | "west" | "front" | "back" | "left" | "right";

export type FacadeEdit = {
  material?: string;
  color?: string;
  textureUrl?: string;
  repeat?: number;
  roughness?: number;
  metallic?: number;
};

export type WindowPattern = {
  id: string;
  side: FacadeSide;
  /** 0–1 position along the facade, left to right. */
  offset: number;
  rows: number;
  cols: number;
  spacing: number;
  width: number;
  height: number;
  sill: number;
  frame?: string;
  shutters?: boolean;
};

export type DoorEdit = {
  id: string;
  side: FacadeSide;
  offset: number;
  kind: "front" | "garage" | "side";
  width: number;
  height: number;
  material?: string;
  color?: string;
};

/**
 * A human edit to one base building, joined by `sourceId` to
 * BuildingFeature.id (src/lib/city/types.ts). Only the fields the user
 * actually touched are present — everything else keeps falling back to the
 * generated base value, so re-running generation with a newer Overture
 * release only needs to re-resolve `sourceId`, not replay every field.
 */
export type BuildingEdit = {
  id: string;
  sourceId: string;
  floors?: number;
  height?: number;
  roof?: RoofEdit;
  facades?: Partial<Record<FacadeSide, FacadeEdit>>;
  windows?: WindowPattern[];
  doors?: DoorEdit[];
  fence?: { height: number; material: string } | null;
  /** True if this building was placed entirely by the user (no Overture source). */
  isCustom?: boolean;
  /** For custom buildings only: footprint in local meters. */
  customRing?: Ring;
  notes?: string;
  createdAt: string;
  updatedAt: string;
};

// ---------------------------------------------------------------------------
// Roads
// ---------------------------------------------------------------------------

export type RoadEdit = {
  id: string;
  sourceId: string;
  width?: number;
  surface?: string;
  path?: Ring; // moved/added vertices, local meters
  deleted?: boolean;
  createdAt: string;
  updatedAt: string;
};

// ---------------------------------------------------------------------------
// Sidewalks (first-class, spec §5.5)
// ---------------------------------------------------------------------------

export type SidewalkFeature = {
  id: string;
  path: Ring; // local meters
  width: number;
  curbHeight: number;
  material: string;
  drivewayCuts: { atDistance: number; width: number }[];
  ramps: { atDistance: number }[];
  createdAt: string;
  updatedAt: string;
};

// ---------------------------------------------------------------------------
// Free-standing objects (spec §5.11 / §5.12)
// ---------------------------------------------------------------------------

export type SceneObjectKind =
  | "tree"
  | "bush"
  | "grass-patch"
  | "pole"
  | "street-light"
  | "traffic-sign"
  | "road-sign"
  | "bench"
  | "trash-can"
  | "fence"
  | "gate"
  | "wall"
  | "mailbox"
  | "bollard"
  | "hydrant"
  | "planter"
  | "utility-box"
  | "bus-stop"
  | "parking-object";

export type SceneObject = {
  id: string;
  kind: SceneObjectKind;
  localX: number;
  localZ: number;
  rotationDeg: number;
  scale: number;
  /** Per-instance overrides (color, variant, etc). Kept loose intentionally. */
  props?: Record<string, string | number | boolean>;
  createdAt: string;
};

// ---------------------------------------------------------------------------
// Materials (referenced by id from facades/roofs/sidewalks/objects)
// ---------------------------------------------------------------------------

export type MaterialDefinition = {
  id: string;
  name: string;
  baseColor: string;
  textureUrl?: string;
  repeatMeters?: number;
  roughness?: number;
  metallic?: number;
};

// ---------------------------------------------------------------------------
// Revisions / provenance (spec §9, §24)
// ---------------------------------------------------------------------------

export type Revision = {
  id: string;
  message: string;
  author?: string;
  createdAt: string;
  /** Snapshot of the delta-layer state at this revision (for diff/rollback). */
  snapshot: ReconstructionDeltas;
};

export type ReconstructionDeltas = {
  terrainEdits: TerrainEdit[];
  buildingEdits: BuildingEdit[];
  roadEdits: RoadEdit[];
  sidewalks: SidewalkFeature[];
  objects: SceneObject[];
  materials: MaterialDefinition[];
};

/**
 * Full persisted project (spec §8). `source` pins the exact base-data
 * identity this project was generated against so a future newer Overture
 * release never silently regenerates and misaligns an existing reconstruction
 * (spec §24) — migration is an explicit future action, not automatic.
 */
export type ReconstructionProject = {
  id: string;
  name: string;

  source: {
    provider: "city-glb";
    overtureRelease: string;
    elevationSource: "copernicus-glo-30" | "terrarium";
    bbox: BBox;
    origin: { lon: number; lat: number };
  };

  /** Opaque identity of the generated base world this project started from. */
  baseRevision: string;

  deltas: ReconstructionDeltas;

  metadata: {
    author?: string;
    description?: string;
    createdAt: string;
    updatedAt: string;
    forkedFrom?: { projectId: string; revisionId: string };
  };

  history: Revision[];
};

export function emptyDeltas(): ReconstructionDeltas {
  return {
    terrainEdits: [],
    buildingEdits: [],
    roadEdits: [],
    sidewalks: [],
    objects: [],
    materials: [],
  };
}

export function createProject(input: {
  id: string;
  name: string;
  bbox: BBox;
  origin: { lon: number; lat: number };
  overtureRelease: string;
  elevationSource: "copernicus-glo-30" | "terrarium";
  baseRevision: string;
  author?: string;
}): ReconstructionProject {
  const now = new Date().toISOString();
  return {
    id: input.id,
    name: input.name,
    source: {
      provider: "city-glb",
      overtureRelease: input.overtureRelease,
      elevationSource: input.elevationSource,
      bbox: input.bbox,
      origin: input.origin,
    },
    baseRevision: input.baseRevision,
    deltas: emptyDeltas(),
    metadata: {
      author: input.author,
      createdAt: now,
      updatedAt: now,
    },
    history: [],
  };
}

/**
 * Fork an existing project (spec Phase 3): a new project id/name, but a
 * deep copy of the source's deltas so the fork starts from exactly where
 * the original was, and `forkedFrom` recording the lineage. The source
 * project is never modified. History is intentionally NOT carried over —
 * a fork gets its own fresh revision list; the source's checkpoints stay
 * with the source. This is a client-side data operation only: there's no
 * sharing, discovery, or moderation layer yet (see Phase 3 in the spec) —
 * this just makes "start from a copy of this" possible locally.
 */
export function forkProject(source: ReconstructionProject, newId: string, newName: string): ReconstructionProject {
  const now = new Date().toISOString();
  return {
    ...source,
    id: newId,
    name: newName,
    deltas: JSON.parse(JSON.stringify(source.deltas)) as ReconstructionDeltas,
    metadata: {
      ...source.metadata,
      createdAt: now,
      updatedAt: now,
      forkedFrom: { projectId: source.id, revisionId: source.history[source.history.length - 1]?.id ?? "" },
    },
    history: [],
  };
}
