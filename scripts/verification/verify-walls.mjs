// Standalone verification of buildWallsWithFacades' winding math, extracted
// from build-scene.ts, run against three's actual triangle/normal math.
import * as THREE from "three";

function closedRing(ring) {
  if (ring.length < 3) return ring;
  const a = ring[0], b = ring[ring.length - 1];
  if (a[0] === b[0] && a[1] === b[1]) return ring.slice(0, -1);
  return ring;
}

function buildWalls(ring, height) {
  const closed = closedRing(ring);
  const n = closed.length;
  let signed = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    signed += closed[j][0] * closed[i][1] - closed[i][0] * closed[j][1];
  }
  const ccw = signed > 0;
  const positions = [];
  const indices = [];
  let vi = 0;
  const edgeNormals = [];
  for (let i = 0; i < n; i++) {
    const [x1, z1] = closed[i];
    const [x2, z2] = closed[(i + 1) % n];
    const dx = x2 - x1, dz = z2 - z1;
    const len = Math.hypot(dx, dz) || 1;
    const nx = ccw ? dz / len : -dz / len;
    const nz = ccw ? -dx / len : dx / len;
    edgeNormals.push([nx, nz]);
    const base = vi;
    positions.push(x1, 0, z1, x2, 0, z2, x2, height, z2, x1, height, z1);
    if (ccw) indices.push(base, base+2, base+1, base, base+3, base+2);
    else indices.push(base, base+1, base+2, base, base+2, base+3);
    vi += 4;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return { geo, edgeNormals, ccw, signed };
}

function checkCase(name, ring) {
  const { geo, edgeNormals, ccw, signed } = buildWalls(ring, 3);
  const posAttr = geo.getAttribute("position");
  const idx = geo.index;
  let allMatch = true;
  for (let t = 0; t < idx.count / 3; t++) {
    const a = idx.getX(t*3), b = idx.getX(t*3+1), c = idx.getX(t*3+2);
    const va = new THREE.Vector3().fromBufferAttribute(posAttr, a);
    const vb = new THREE.Vector3().fromBufferAttribute(posAttr, b);
    const vc = new THREE.Vector3().fromBufferAttribute(posAttr, c);
    const faceNormal = new THREE.Vector3().subVectors(vb, va).cross(new THREE.Vector3().subVectors(vc, va)).normalize();
    const edgeIdx = Math.floor(t / 2);
    const expected = new THREE.Vector3(edgeNormals[edgeIdx][0], 0, edgeNormals[edgeIdx][1]);
    const dot = faceNormal.dot(expected);
    if (dot < 0.9) {
      allMatch = false;
      console.log(`  MISMATCH edge ${edgeIdx} tri ${t}: face normal ${faceNormal.toArray()} vs expected ${expected.toArray()} dot=${dot.toFixed(3)}`);
    }
  }
  console.log(`${name}: signed=${signed.toFixed(2)} ccw=${ccw} -> ${allMatch ? "ALL FACE NORMALS MATCH OUTWARD (PASS)" : "FAIL"}`);
}

// CCW square
checkCase("CCW square", [[0,0],[1,0],[1,1],[0,1]]);
// CW square (reversed)
checkCase("CW square", [[0,0],[0,1],[1,1],[1,0]]);
// CCW irregular pentagon
checkCase("CCW pentagon", [[0,0],[2,0],[3,1],[1,2],[-0.5,1]]);
// CW irregular pentagon (reverse of above)
checkCase("CW pentagon", [[-0.5,1],[1,2],[3,1],[2,0],[0,0]]);
