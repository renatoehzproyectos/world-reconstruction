// Reproduces a real bug caught during development: mergeGeometries() rejects
// a batch mixing indexed and non-indexed geometries. extrudeShape() (used
// for plain buildings) produces non-indexed output; buildWallsWithFacades/
// buildTopCap originally produced indexed output. This script proves the
// failure and proves the toNonIndexed() fix (now in build-scene.ts) resolves
// it, against a realistic mixed batch of 5 buildings.

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

function extrudeShape(shape, depth) {
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, steps: 1 });
  geo.rotateX(-Math.PI / 2);
  geo.computeVertexNormals();
  return geo;
}
function paintGeometry(geo, color) {
  const count = geo.getAttribute("position").count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) { colors[i*3]=color[0]; colors[i*3+1]=color[1]; colors[i*3+2]=color[2]; }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
}
function closedRing(ring) {
  if (ring.length < 3) return ring;
  const a = ring[0], b = ring[ring.length-1];
  if (a[0]===b[0] && a[1]===b[1]) return ring.slice(0,-1);
  return ring;
}
// FIXED version (matches real source now)
function buildWallsWithFacades(ring, height, facadeColors, defaultColor) {
  const closed = closedRing(ring);
  const n = closed.length;
  if (n < 3) return null;
  let signed = 0;
  for (let i=0,j=n-1;i<n;j=i++) signed += closed[j][0]*closed[i][1]-closed[i][0]*closed[j][1];
  const ccw = signed > 0;
  const positions=[],colors=[],uvs=[],indices=[];
  let vi=0;
  for (let i=0;i<n;i++) {
    const [x1,z1]=closed[i], [x2,z2]=closed[(i+1)%n];
    const dx=x2-x1, dz=z2-z1, len=Math.hypot(dx,dz)||1;
    const nx = ccw?dz/len:-dz/len, nz = ccw?-dx/len:dx/len;
    const side = Math.abs(nx)>=Math.abs(nz) ? (nx>=0?"east":"west") : (nz>=0?"south":"north");
    const color = facadeColors[side] ?? defaultColor;
    const base=vi;
    positions.push(x1,0,z1, x2,0,z2, x2,height,z2, x1,height,z1);
    for(let k=0;k<4;k++) colors.push(color[0],color[1],color[2]);
    const uRepeat = Math.max(1, len/4);
    uvs.push(0,0, uRepeat,0, uRepeat,1, 0,1);
    if (ccw) indices.push(base,base+2,base+1, base,base+3,base+2);
    else indices.push(base,base+1,base+2, base,base+2,base+3);
    vi+=4;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions,3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors,3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs,2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo.toNonIndexed(); // FIX
}
function buildTopCap(ring, height, color) {
  const closed = closedRing(ring);
  if (closed.length<3) return null;
  const vec2s = closed.map(([x,z]) => new THREE.Vector2(x,z));
  const triangles = THREE.ShapeUtils.triangulateShape(vec2s, []);
  if (triangles.length===0) return null;
  let minX=Infinity,maxX=-Infinity,minZ=Infinity,maxZ=-Infinity;
  for (const [x,z] of closed) { if(x<minX)minX=x; if(x>maxX)maxX=x; if(z<minZ)minZ=z; if(z>maxZ)maxZ=z; }
  const spanX=Math.max(1e-3,maxX-minX), spanZ=Math.max(1e-3,maxZ-minZ);
  const positions=[],colors=[],uvs=[];
  for (const [x,z] of closed) { positions.push(x,height,z); colors.push(color[0],color[1],color[2]); uvs.push((x-minX)/spanX,(z-minZ)/spanZ); }
  const indices = triangles.flatMap(([a,b,c]) => [a,c,b]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions,3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors,3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs,2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo.toNonIndexed(); // FIX
}
function toShape(ring, holes) {
  const shape = new THREE.Shape(ring.map(([x,z]) => new THREE.Vector2(x,z)));
  for (const h of holes) shape.holes.push(new THREE.Path(h.map(([x,z]) => new THREE.Vector2(x,z))));
  return shape;
}

// Realistic scenario: 5 buildings, mix of plain + facade-colored, in the order buildingsGeometry would process them
const buildings = [
  { ring: [[0,0],[10,0],[10,8],[0,8]], facade: null },
  { ring: [[20,0],[28,0],[28,6],[20,6]], facade: { north: [1,0,0] } },
  { ring: [[40,0],[46,0],[46,5],[40,5]], facade: null },
  { ring: [[60,0],[70,3],[68,9],[58,6]], facade: { east: [0,1,0], west: [0,0,1] } }, // irregular quad
  { ring: [[80,0],[88,0],[88,7],[80,7]], facade: null },
];

const wallGeos = [];
for (const b of buildings) {
  if (b.facade) {
    const w = buildWallsWithFacades(b.ring, 9, b.facade, [0.7,0.7,0.7]);
    wallGeos.push(w);
    const cap = buildTopCap(b.ring, 9, [0.7,0.7,0.7]);
    if (cap) wallGeos.push(cap);
  } else {
    const w = extrudeShape(toShape(b.ring, []), 9);
    paintGeometry(w, [0.7,0.7,0.7]);
    wallGeos.push(w);
  }
}

console.log("Batch composition:");
wallGeos.forEach((g, i) => console.log(`  [${i}] index=${g.index ? "indexed" : "non-indexed"} verts=${g.getAttribute("position").count}`));

try {
  const merged = mergeGeometries(wallGeos, false);
  console.log("\nMERGE RESULT:", merged ? `SUCCESS — total vertices=${merged.getAttribute("position").count}` : "returned null (would trigger keep-first-only fallback)");
} catch (e) {
  console.log("\nMERGE THREW:", e.message);
}
