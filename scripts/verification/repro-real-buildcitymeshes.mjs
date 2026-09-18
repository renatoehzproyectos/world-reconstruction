// Loads and calls the REAL buildCityMeshes() via Vite's own SSR module
// loader (same transform pipeline the actual app uses in dev), against
// realistic synthetic CityData mixing plain buildings, facade-colored
// buildings, a building with holes, and gable/shed roof overrides. This is
// the strongest verification in this project: it exercises the real
// production code path, not a hand-reimplementation of its logic.
// Requires network access only for `vite` itself (already installed);
// no external fetches happen since externalHeightGrid/satellite/landCover
// are all disabled.

import { createServer } from "vite";

// Minimal DOM stubs so createWindowTexture()/createWindowNormalMap() (which
// call document.createElement("canvas")) don't throw in plain Node. We
// don't care about the texture's visual correctness here, only that the
// merge doesn't crash — a permissive fake 2D context is enough.
function fakeCtx() {
  const noop = () => {};
  const proxy = new Proxy({}, {
    get(_t, prop) {
      if (prop === "canvas") return undefined;
      if (typeof prop === "string" && /^(fillStyle|strokeStyle|lineWidth|globalAlpha|font|textAlign|textBaseline)$/.test(prop)) return "";
      return noop;
    },
    set() { return true; },
  });
  return proxy;
}
globalThis.document = {
  createElement: (tag) => {
    if (tag === "canvas") {
      return { width: 0, height: 0, getContext: () => fakeCtx() };
    }
    return { style: {}, appendChild: () => {}, remove: () => {} };
  },
};
globalThis.window = globalThis.window ?? {};

const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  resolve: {
    alias: { "@": new URL("./src", import.meta.url).pathname },
  },
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
  ssr: {},
});

try {
  const buildScene = await vite.ssrLoadModule("/src/lib/city/build-scene.ts");
  const { buildCityMeshes } = buildScene;

  // Realistic synthetic CityData: a mix of plain buildings, facade-colored
  // buildings (some with holes), various roof overrides — matching the
  // real construction order buildingsGeometry() would see.
  const buildings = [
    { ring: [[0,0],[10,0],[10,8],[0,8]], holes: [], height: 9, kind: "residential", id: "b1" },
    { ring: [[20,0],[28,0],[28,6],[20,6]], holes: [], height: 9, kind: "residential", id: "b2",
      colorOverride: [0.8,0.2,0.2], facadeColors: { north: [1,0,0], south: [0,1,0] }, origin: "human-edited" },
    { ring: [[40,0],[46,0],[46,5],[40,5]], holes: [], height: 5, kind: "commercial", id: "b3",
      roofOverride: { type: "gable", rise: 2 }, origin: "human-edited" },
    { ring: [[60,0],[70,3],[68,9],[58,6]], holes: [], height: 12, kind: "residential", id: "b4",
      roofOverride: { type: "shed", rise: 1.5 }, colorOverride: [0.3,0.3,0.6], origin: "human-edited" },
    { ring: [[80,0],[88,0],[88,7],[80,7]], holes: [[[82,2],[86,2],[86,4],[82,4]]], height: 15, kind: "commercial", id: "b5" },
    { ring: [[100,0],[108,0],[108,8],[100,8]], holes: [], height: 6, kind: "residential", id: "b6",
      facadeColors: { east: [0.9,0.9,0.2] }, origin: "human-edited" },
  ];
  const roads = [
    { path: [[0,-5],[110,-5]], width: 6, highway: "residential", id: "r1" },
  ];

  const cityData = {
    bbox: { minLon: -71.62, minLat: -33.05, maxLon: -71.61, maxLat: -33.04 },
    origin: { lon: -71.615, lat: -33.045 },
    placeName: "Test",
    buildings,
    roads,
    water: [],
    ports: [],
    coastline: [],
    extent: { minX: -10, maxX: 120, minZ: -10, maxZ: 20 },
  };

  console.log("Calling the REAL buildCityMeshes()...");
  const meshes = await buildCityMeshes(cityData, {
    externalHeightGrid: null, // skip elevation fetch
    satellite: false,
    landCover: false,
    treeDensity: 0.01,
  });
  console.log("SUCCESS. Stats:", meshes.stats);
  console.log("buildings mesh present:", !!meshes.buildings);
  console.log("roofs mesh present:", !!meshes.roofs);
  console.log("roads mesh present:", !!meshes.roads);
  console.log("buildingIndex entries:", meshes.buildingIndex.length);
} catch (err) {
  console.error("REAL buildCityMeshes THREW:");
  console.error(err);
  process.exitCode = 1;
} finally {
  await vite.close();
}
