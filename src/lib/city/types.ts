export type BBox = {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
};

export type Ring = [number, number][];

export type BuildingFeature = {
  ring: Ring;
  holes: Ring[];
  height: number;
  kind: string;
  /**
   * Stable Overture GERS id when the source provided one (buildings sourced
   * from OSM or synthesized may omit it). This is the join key the
   * reconstruction delta layer uses to attach human edits to a specific
   * building — see src/lib/reconstruction/types.ts. Do not treat as unique
   * across releases; a bbox-clip can split one feature into multiple pieces
   * that currently share the same id (acceptable for MVP, tracked as a
   * known limitation).
   */
  id?: string;
  /**
   * Rendering hints the reconstruction layer computes from a BuildingEdit
   * (see reconstruction/apply.ts materializeCityData). Deliberately generic
   * (color triples, not material names) so build-scene.ts / city/types.ts
   * stay decoupled from the reconstruction/ module — no circular import.
   */
  colorOverride?: [number, number, number];
  /**
   * Per-facade-side colors (north/south/east/west), used instead of a
   * single colorOverride when present and the building has no holes (see
   * build-scene.ts buildWallsWithFacades — holes keep the simpler
   * single-color extrusion path, see that function's comment for why).
   */
  facadeColors?: Partial<Record<"north" | "south" | "east" | "west", [number, number, number]>>;
  roofOverride?: { type: "flat" | "gable" | "hip" | "shed"; rise?: number };
  /** Set by materializeCityData so the renderer can visually distinguish human work from generated data. */
  origin?: "generated" | "human-edited" | "human-added";
};

export type RoadFeature = {
  path: Ring;
  width: number;
  highway: string;
  /** Stable Overture GERS id, see BuildingFeature.id. */
  id?: string;
  /** Set by materializeCityData, see BuildingFeature.origin. */
  origin?: "generated" | "human-edited";
};

export type WaterFeature = {
  rings: Ring[];
};

/** Ports, quays, breakwaters, piers, jetties, marinas — linear or area
 * waterfront infrastructure. Line-shaped features (piers, breakwaters,
 * groynes) use `path` + `width` like a road; area features (quays,
 * marina basins, harbour grounds) use `ring`. Exactly one of the two
 * is populated depending on `shape`. */
export type PortFeature = {
  kind: "pier" | "breakwater" | "quay" | "marina" | "harbour" | "groyne" | "dock" | "slipway";
  shape: "line" | "area";
  path?: Ring;
  width?: number;
  ring?: Ring;
};

/** The land/sea boundary itself, reconstructed from OSM natural=coastline
 * ways, independent of any water polygon. Used to give the shoreline a
 * distinct, precise edge rather than relying only on water polygon rims. */
export type CoastlineFeature = {
  path: Ring;
};

export type CityData = {
  origin: { lon: number; lat: number };
  bbox: BBox;
  placeName: string;
  buildings: BuildingFeature[];
  roads: RoadFeature[];
  water: WaterFeature[];
  ports: PortFeature[];
  coastline: CoastlineFeature[];
  extent: { minX: number; maxX: number; minZ: number; maxZ: number };
};

export type CityStats = {
  buildings: number;
  roads: number;
  water: number;
  ports: number;
  vertices: number;
  trees?: number;
};

export type PlaceHit = {
  label: string;
  lat: number;
  lon: number;
  bbox: BBox;
};

export type StudioStatus = "idle" | "fetching" | "meshing" | "ready" | "error";
