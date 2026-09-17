import * as THREE from "three";

function closedRing(ring) {
  if (ring.length < 3) return ring;
  const a = ring[0], b = ring[ring.length - 1];
  if (a[0] === b[0] && a[1] === b[1]) return ring.slice(0, -1);
  return ring;
}

function buildTopCap(ring, height) {
  const closed = closedRing(ring);
  const vec2s = closed.map(([x, z]) => new THREE.Vector2(x, z));
  const triangles = THREE.ShapeUtils.triangulateShape(vec2s, []);
  const positions = [];
  for (const [x, z] of closed) positions.push(x, height, z);
  // FIX: triangulateShape's winding is consistently opposite of what we
  // need for a +Y-facing cap — reverse each triangle.
  const indices = triangles.flatMap(([a, b, c]) => [a, c, b]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function checkCap(name, ring) {
  const geo = buildTopCap(ring, 3);
  const posAttr = geo.getAttribute("position");
  const idx = geo.index;
  let allUp = true;
  for (let t = 0; t < idx.count / 3; t++) {
    const a = idx.getX(t*3), b = idx.getX(t*3+1), c = idx.getX(t*3+2);
    const va = new THREE.Vector3().fromBufferAttribute(posAttr, a);
    const vb = new THREE.Vector3().fromBufferAttribute(posAttr, b);
    const vc = new THREE.Vector3().fromBufferAttribute(posAttr, c);
    const n = new THREE.Vector3().subVectors(vb, va).cross(new THREE.Vector3().subVectors(vc, va)).normalize();
    if (n.y < 0.9) allUp = false;
  }
  console.log(`${name}: ${allUp ? "ALL FACES POINT +Y (PASS)" : "FAIL"}`);
  return allUp;
}

checkCap("CCW square", [[0,0],[1,0],[1,1],[0,1]]);
checkCap("CW square", [[0,0],[0,1],[1,1],[1,0]]);
checkCap("CCW pentagon", [[0,0],[2,0],[3,1],[1,2],[-0.5,1]]);
checkCap("CW pentagon", [[-0.5,1],[1,2],[3,1],[2,0],[0,0]]);
checkCap("concave L-shape", [[0,0],[2,0],[2,1],[1,1],[1,2],[0,2]]);
