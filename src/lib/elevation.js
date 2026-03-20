import * as THREE from 'three';
import * as turf from '@turf/turf';
import { toLocal, latLngToTile, latLngToPixel } from '$lib/coords.js';

const TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
// Zoom 14 gives ~9 m/px resolution — fine enough for terrain within typical bbox sizes.
const ZOOM = 14;

// Fetch AWS Terrarium elevation tiles for a bounding box.
// Returns { sampleAtLatLng(lat, lng) → absolute elevation in metres, minElevation }.
export async function fetchElevationData(southWest, northEast) {
  const tileSize = 256;
  const swTile = latLngToTile(southWest.lat, southWest.lng, ZOOM);
  const neTile = latLngToTile(northEast.lat, northEast.lng, ZOOM);
  const minX = Math.min(swTile.x, neTile.x);
  const minY = Math.min(swTile.y, neTile.y);
  const maxX = Math.max(swTile.x, neTile.x);
  const maxY = Math.max(swTile.y, neTile.y);

  const canvas = document.createElement('canvas');
  canvas.width = (maxX - minX + 1) * tileSize;
  canvas.height = (maxY - minY + 1) * tileSize;
  const ctx = canvas.getContext('2d');

  const fetches = [];
  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      const url = TERRARIUM_URL.replace('{z}', String(ZOOM)).replace('{x}', String(x)).replace('{y}', String(y));
      const dx = (x - minX) * tileSize;
      const dy = (y - minY) * tileSize;
      fetches.push(
        fetch(url)
          .then((r) => r.blob())
          .then(createImageBitmap)
          .then((img) => ctx.drawImage(img, dx, dy, tileSize, tileSize))
          .catch(() => {})
      );
    }
  }
  await Promise.all(fetches);

  // Crop canvas to the exact bbox extent (NW corner at 0,0)
  const topLeft = latLngToPixel(northEast.lat, southWest.lng, ZOOM);
  const bottomRight = latLngToPixel(southWest.lat, northEast.lng, ZOOM);
  const bboxX = topLeft.x - minX * tileSize;
  const bboxY = topLeft.y - minY * tileSize;
  const bboxW = Math.max(1, Math.ceil(bottomRight.x - topLeft.x));
  const bboxH = Math.max(1, Math.ceil(bottomRight.y - topLeft.y));

  const cropped = document.createElement('canvas');
  cropped.width = bboxW;
  cropped.height = bboxH;
  cropped.getContext('2d').drawImage(canvas, bboxX, bboxY, bboxW, bboxH, 0, 0, bboxW, bboxH);

  const { data } = cropped.getContext('2d').getImageData(0, 0, bboxW, bboxH);

  // Terrarium decode: elevation = R*256 + G + B/256 - 32768
  function decode(r, g, b) {
    return r * 256 + g + b / 256 - 32768;
  }

  // Collect valid elevations (alpha > 0 means the tile loaded; alpha=0 means the
  // canvas pixel was never written — tile failed or was out of range).
  let minElevation = 0;
  let fallbackElevation = 0;
  {
    const valid = [];
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue; // tile didn't load
      valid.push(decode(data[i], data[i + 1], data[i + 2]));
    }
    if (valid.length > 0) {
      valid.sort((a, b) => a - b);
      minElevation = valid[0];
      fallbackElevation = valid[Math.floor(valid.length / 2)]; // median
    }
  }

  function sampleAtUV(u, v) {
    const px = Math.min(Math.max(Math.floor(u * bboxW), 0), bboxW - 1);
    const py = Math.min(Math.max(Math.floor(v * bboxH), 0), bboxH - 1);
    const i = (py * bboxW + px) * 4;
    // Return median elevation for pixels that never loaded (CORS failure, missing tile)
    if (data[i + 3] < 128) return fallbackElevation;
    return decode(data[i], data[i + 1], data[i + 2]);
  }

  // u=0=west, u=1=east; v=0=north (top of image), v=1=south
  function sampleAtLatLng(lat, lng) {
    const u = (lng - southWest.lng) / (northEast.lng - southWest.lng);
    const v = 1 - (lat - southWest.lat) / (northEast.lat - southWest.lat);
    return sampleAtUV(Math.min(1, Math.max(0, u)), Math.min(1, Math.max(0, v)));
  }

  return { sampleAtLatLng, minElevation };
}

// Like createTerrainMesh but clips the grid to the latlngs-defined polygon/circle,
// so the terrain respects the user's drawn selection rather than covering the full bbox.
export function createClippedTerrainMesh(latlngs, southWest, northEast, referencePoint, elevationData, mapCanvas, segments = 64, depth = 0) {
  if (!latlngs) return createTerrainMesh(southWest, northEast, referencePoint, elevationData, mapCanvas, segments);

  const { sampleAtLatLng, minElevation } = elevationData;

  // Build the clipping polygon once
  let clipPoly = null;
  try {
    if (latlngs.center && latlngs.radius) {
      clipPoly = turf.circle([latlngs.center.lng, latlngs.center.lat], latlngs.radius / 1000, { steps: 64 });
    } else if (Array.isArray(latlngs) && latlngs.length >= 3) {
      const ring = latlngs.map((ll) => [ll.lng, ll.lat]);
      if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) ring.push(ring[0]);
      clipPoly = turf.polygon([ring]);
    }
  } catch { /* ignore */ }

  if (!clipPoly) return createTerrainMesh(southWest, northEast, referencePoint, elevationData, mapCanvas, segments);

  const sw = toLocal(southWest.lng, southWest.lat, referencePoint);
  const ne = toLocal(northEast.lng, northEast.lat, referencePoint);
  const uRange = sw.y - ne.y;
  const vRange = ne.x - sw.x;

  const rows = segments + 1;
  const cols = segments + 1;

  // Pre-compute all grid vertices and inside/outside flags
  const vx = [], vy = [], vz = [], vu = [], vv = [], inside = [];
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const t = i / (rows - 1);
      const s = j / (cols - 1);
      const lat = northEast.lat + (southWest.lat - northEast.lat) * t;
      const lng = southWest.lng + (northEast.lng - southWest.lng) * s;
      const { x: sx, y: sy } = toLocal(lng, lat, referencePoint);
      const elev = sampleAtLatLng(lat, lng) - minElevation;
      vx.push(-sy); vy.push(elev); vz.push(-sx);
      vu.push(uRange !== 0 ? (sw.y - sy) / uRange : s);
      vv.push(vRange !== 0 ? (sx - sw.x) / vRange : (1 - t));
      let inPoly = false;
      try { inPoly = turf.booleanPointInPolygon(turf.point([lng, lat]), clipPoly); } catch { inPoly = true; }
      inside.push(inPoly);
    }
  }

  // Emit only triangles whose 3 vertices are all inside the polygon (non-indexed for simplicity)
  const pos = [], uv = [];
  const emit = (idx) => { pos.push(vx[idx], vy[idx], vz[idx]); uv.push(vu[idx], vv[idx]); };
  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < cols - 1; j++) {
      const a = i * cols + j, b = i * cols + j + 1;
      const c = (i + 1) * cols + j, d = (i + 1) * cols + j + 1;
      if (inside[a] && inside[c] && inside[b]) { emit(a); emit(c); emit(b); }
      if (inside[b] && inside[c] && inside[d]) { emit(b); emit(c); emit(d); }
    }
  }

  if (pos.length === 0) return createTerrainMesh(southWest, northEast, referencePoint, elevationData, mapCanvas, segments);

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geom.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
  geom.computeVertexNormals();

  const material = mapCanvas
    ? new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(mapCanvas), side: THREE.DoubleSide })
    : new THREE.MeshStandardMaterial({ color: 0xdddddd, side: THREE.DoubleSide });

  const mesh = new THREE.Mesh(geom, material);
  mesh.name = 'Terrain';

  if (depth <= 0) return mesh;

  // Skirt: trace the clipPoly boundary, dropping from terrain surface to y = -depth.
  const ring = clipPoly.geometry.coordinates[0]; // [[lng, lat], ...]
  const skirtPos = new Float32Array(ring.length * 6);
  for (let k = 0; k < ring.length; k++) {
    const [lng, lat] = ring[k];
    const { x: sx, y: sy } = toLocal(lng, lat, referencePoint);
    const elev = sampleAtLatLng(lat, lng) - minElevation;
    skirtPos[k * 6]     = -sy; skirtPos[k * 6 + 1] = elev;   skirtPos[k * 6 + 2] = -sx; // top
    skirtPos[k * 6 + 3] = -sy; skirtPos[k * 6 + 4] = -depth; skirtPos[k * 6 + 5] = -sx; // bottom
  }
  const skirtIdx = [];
  for (let k = 0; k < ring.length; k++) {
    const next = (k + 1) % ring.length;
    const at = k * 2, ab = k * 2 + 1, bt = next * 2, bb = next * 2 + 1;
    skirtIdx.push(at, bt, ab);
    skirtIdx.push(bt, bb, ab);
  }
  const skirtGeom = new THREE.BufferGeometry();
  skirtGeom.setAttribute('position', new THREE.BufferAttribute(skirtPos, 3));
  skirtGeom.setIndex(skirtIdx);
  skirtGeom.computeVertexNormals();
  const skirtMesh = new THREE.Mesh(skirtGeom, new THREE.MeshStandardMaterial({ color: 0xaaaaaa, side: THREE.DoubleSide }));
  skirtMesh.name = 'TerrainSkirt';

  // Bottom cap: flat polygon at y = -depth using the clip ring as outline.
  const bottomShapeVerts = ring.map(([lng, lat]) => {
    const { x: sx, y: sy } = toLocal(lng, lat, referencePoint);
    return new THREE.Vector2(sx, sy);
  });
  const bottomShape = new THREE.Shape(bottomShapeVerts);
  const bottomGeom = new THREE.ShapeGeometry(bottomShape);
  bottomGeom.rotateX(-Math.PI / 2);
  bottomGeom.rotateY(Math.PI / 2);
  bottomGeom.translate(0, -depth, 0);
  const bottomMesh = new THREE.Mesh(bottomGeom, new THREE.MeshStandardMaterial({ color: 0xaaaaaa, side: THREE.BackSide }));
  bottomMesh.name = 'TerrainBottom';

  const group = new THREE.Group();
  group.name = 'Terrain';
  group.add(mesh);
  group.add(skirtMesh);
  group.add(bottomMesh);
  return group;
}

// Build a terrain mesh grid covering the bbox, displaced vertically by sampled elevation.
//
// Coordinate system: shape (sx, sy) → 3D (-sy, Y, -sx)
// (same as applying rotateX(-π/2) + rotateY(π/2) — computed directly here).
//
// Winding analysis: for adjacent vertices a(i,j), b(i,j+1), c(i+1,j):
//   Moving east (j+1): x increases (sy decreases → -sy increases)
//   Moving south (i+1): z increases (sx decreases → -sx increases)
// So a→b is +x, a→c is +z. Cross product (a→c) × (a→b) = +y (upward normal).
// Correct CCW winding from above: (a, c, b) and (b, c, d).
export function createTerrainMesh(southWest, northEast, referencePoint, elevationData, mapCanvas, segments = 64, depth = 0) {
  const { sampleAtLatLng, minElevation } = elevationData;

  const sw = toLocal(southWest.lng, southWest.lat, referencePoint);
  const ne = toLocal(northEast.lng, northEast.lat, referencePoint);
  const uRange = sw.y - ne.y;
  const vRange = ne.x - sw.x;

  const rows = segments + 1;
  const cols = segments + 1;
  const positions = new Float32Array(rows * cols * 3);
  const uvs = new Float32Array(rows * cols * 2);
  const indices = [];

  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const t = i / (rows - 1); // 0 = north edge, 1 = south edge
      const s = j / (cols - 1); // 0 = west edge, 1 = east edge
      const lat = northEast.lat + (southWest.lat - northEast.lat) * t;
      const lng = southWest.lng + (northEast.lng - southWest.lng) * s;

      const { x: sx, y: sy } = toLocal(lng, lat, referencePoint);
      const elev = sampleAtLatLng(lat, lng) - minElevation;

      const idx = i * cols + j;
      // Direct 3D placement: (-sy, elev, -sx) — same as shape-space then rotating
      positions[idx * 3]     = -sy;
      positions[idx * 3 + 1] = elev;
      positions[idx * 3 + 2] = -sx;

      // UV: same formulas as ground plane / splitByFaceOrientation
      // u=0=west, u=1=east  |  v=0=south, v=1=north (flipY=true → matches canvas)
      uvs[idx * 2]     = uRange !== 0 ? (sw.y - sy) / uRange : s;
      uvs[idx * 2 + 1] = vRange !== 0 ? (sx - sw.x) / vRange : (1 - t);
    }
  }

  // CCW winding from above (+y): (a, c, b) gives upward-facing normal.
  // See winding analysis in function comment above.
  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < cols - 1; j++) {
      const a = i * cols + j;       // NW
      const b = i * cols + j + 1;   // NE
      const c = (i + 1) * cols + j; // SW
      const d = (i + 1) * cols + j + 1; // SE
      indices.push(a, c, b); // NW→SW→NE  (upward-facing)
      indices.push(b, c, d); // NE→SW→SE  (upward-facing)
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geom.setIndex(indices);
  geom.computeVertexNormals();

  const material = mapCanvas
    ? new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(mapCanvas), side: THREE.DoubleSide })
    : new THREE.MeshStandardMaterial({ color: 0xdddddd, side: THREE.DoubleSide });

  const mesh = new THREE.Mesh(geom, material);
  mesh.name = 'Terrain';

  if (depth <= 0) return mesh;

  // Skirt: perimeter edges of the grid drop straight down by `depth`.
  // Traverse the boundary clockwise so outward normals face outward.
  const perimeter = [];
  for (let j = 0; j < cols; j++) perimeter.push(0 * cols + j);           // N: W→E
  for (let i = 1; i < rows; i++) perimeter.push(i * cols + (cols - 1));  // E: N→S
  for (let j = cols - 2; j >= 0; j--) perimeter.push((rows - 1) * cols + j); // S: E→W
  for (let i = rows - 2; i >= 0; i--) perimeter.push(i * cols + 0);      // W: S→N

  const skirtPos = new Float32Array(perimeter.length * 6);
  for (let k = 0; k < perimeter.length; k++) {
    const vi = perimeter[k] * 3;
    const x = positions[vi], y = positions[vi + 1], z = positions[vi + 2];
    skirtPos[k * 6]     = x; skirtPos[k * 6 + 1] = y;         skirtPos[k * 6 + 2] = z; // top
    skirtPos[k * 6 + 3] = x; skirtPos[k * 6 + 4] = y - depth; skirtPos[k * 6 + 5] = z; // bottom
  }
  const skirtIdx = [];
  for (let k = 0; k < perimeter.length; k++) {
    const next = (k + 1) % perimeter.length;
    const at = k * 2, ab = k * 2 + 1, bt = next * 2, bb = next * 2 + 1;
    skirtIdx.push(at, bt, ab);
    skirtIdx.push(bt, bb, ab);
  }
  const skirtGeom = new THREE.BufferGeometry();
  skirtGeom.setAttribute('position', new THREE.BufferAttribute(skirtPos, 3));
  skirtGeom.setIndex(skirtIdx);
  skirtGeom.computeVertexNormals();
  const skirtMesh = new THREE.Mesh(
    skirtGeom,
    new THREE.MeshStandardMaterial({ color: 0xaaaaaa, side: THREE.DoubleSide })
  );
  skirtMesh.name = 'TerrainSkirt';

  const group = new THREE.Group();
  group.name = 'Terrain';
  group.add(mesh);
  group.add(skirtMesh);
  return group;
}
