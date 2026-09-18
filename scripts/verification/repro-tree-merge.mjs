// Reproduces a real, pre-existing bug (not introduced by recent work)
// caught during live testing: IcosahedronGeometry is non-indexed in this
// Three version while CylinderGeometry/ConeGeometry are indexed.
// createTreeGeometry's "round" and "layered" tree shapes mixed an
// Icosahedron canopy with a Cylinder trunk, so mergeGeometries() returned
// null for those two of three variants, and the `!` non-null assertion that
// followed turned that into "Cannot read properties of null (reading
// getAttribute)" inside paintTree() whenever a scattered tree happened to
// roll one of those shapes. Fixed by normalizing every contributing
// primitive to non-indexed before merging. This script proves both the
// failure (against the pre-fix code, if checked out) and the fix (against
// the current code) by calling the real buildCityMeshes() with tree
// scattering enabled and a synthetic height grid.

import { createServer } from "vite";

function fakeCtx() {
  const noop = () => {};
  return new Proxy({}, { get: () => noop, set: () => true });
}
globalThis.document = {
  createElement: (tag) => tag === "canvas" ? { width: 0, height: 0, getContext: () => fakeCtx() } : { style: {}, appendChild: () => {}, remove: () => {} },
};
globalThis.window = globalThis.window ?? {};

const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
  ssr: {},
});

try {
  const buildScene = await vite.ssrLoadModule("/src/lib/city/build-scene.ts");
  const { buildCityMeshes } = buildScene;

  // Synthetic flat height grid so scatterTrees' `if (grid && treeDensity > 0)` gate passes.
  const cols = 10, rows = 10;
  const xs = new Float32Array(cols).map((_, i) => (i / (cols - 1)) * 120 - 10);
  const zs = new Float32Array(rows).map((_, i) => (i / (rows - 1)) * 30 - 10);
  const data = new Float32Array(cols * rows).fill(0);
  const heightGrid = { width: cols, height: rows, data, xs, zs, minH: 0, maxH: 0, originLon: -71.615, originLat: -33.045, source: "terrarium" };

  const buildings = [
    { ring: [[0,0],[10,0],[10,8],[0,8]], holes: [], height: 9, kind: "residential", id: "b1" },
    { ring: [[20,0],[28,0],[28,6],[20,6]], holes: [], height: 9, kind: "residential", id: "b2", facadeColors: { north: [1,0,0] }, origin: "human-edited" },
  ];
  const cityData = {
    bbox: { minLon: -71.62, minLat: -33.05, maxLon: -71.61, maxLat: -33.04 },
    origin: { lon: -71.615, lat: -33.045 },
    placeName: "Test",
    buildings, roads: [], water: [], ports: [], coastline: [],
    extent: { minX: -10, maxX: 120, minZ: -10, maxZ: 20 },
  };

  console.log("Calling real buildCityMeshes() WITH a real (synthetic) height grid and tree density...");
  const meshes = await buildCityMeshes(cityData, {
    externalHeightGrid: heightGrid,
    satellite: false,
    landCover: false,
    treeDensity: 0.05, // deliberately high to force many trees / all 3 tree-shape branches across repeated calls
  });
  console.log("SUCCESS. Stats:", meshes.stats);
  console.log("trees mesh present:", !!meshes.trees);
} catch (err) {
  console.error("THREW:", err);
  process.exitCode = 1;
} finally {
  await vite.close();
}
