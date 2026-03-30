import * as turf from '@turf/turf';
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { generateMergedBuildingsGeometry } from '$lib/buildingFactory.js';
import { generateFeaturesGeometry, DEFAULT_PALETTE } from '$lib/featureFactory.js';
import { fetchElevationData, createClippedTerrainMesh } from '$lib/elevation.js';
import { toLocal, latLngToTile, latLngToPixel } from '$lib/coords.js';

export async function downloadData({
  clippedGeoJSON, latlngs, southWest, northEast, selectedLayer, referencePoint,
  textureGround = true, textureBuildings = false, useElevation = false, groundDepth = 0,
  featurePalette = DEFAULT_PALETTE, groundColor = '#cccccc', buildingColor = '#fafafa',
}) {
  if (!clippedGeoJSON) return;

  if (!referencePoint) {
    referencePoint = turf.centroid(clippedGeoJSON).geometry.coordinates;
  }

  const bbox = [southWest.lng, southWest.lat, northEast.lng, northEast.lat];

  let mapCanvas = null;
  try {
    mapCanvas = await fetchTilesAndRenderCanvas(latlngs, southWest, northEast, selectedLayer);
  } catch (err) {
    console.error('Map tile error:', err);
  }

  // Fetch elevation data if requested
  let elevationData = null;
  if (useElevation) {
    try {
      elevationData = await fetchElevationData(southWest, northEast);
    } catch (err) {
      console.error('Elevation fetch error:', err);
    }
  }

  // getElevation(lat, lng) → metres above terrain minimum (0 = lowest point in bbox)
  const getElevation = elevationData
    ? (lat, lng) => elevationData.sampleAtLatLng(lat, lng) - elevationData.minElevation
    : null;

  const scene = new THREE.Scene();
  // Geo metadata embedded in GLB extras
  scene.userData = {
    source: 'https://github.com/v-a-n-t-a-g-e/territory',
    bbox,
    referencePoint,
    clipPath: latlngs,
  };

  try {
    const buildingGeometry = generateMergedBuildingsGeometry(clippedGeoJSON, referencePoint, getElevation);
    if (buildingGeometry) {
      const group = new THREE.Group();
      group.name = 'Buildings';
      if (textureBuildings && mapCanvas) {
        const uvRef = bboxToLocalUVRef(southWest, northEast, referencePoint);
        const texture = new THREE.CanvasTexture(mapCanvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        const { tops, sides } = splitByFaceOrientation(buildingGeometry, uvRef);
        if (tops)  group.add(new THREE.Mesh(tops,  new THREE.MeshBasicMaterial({ map: texture })));
        if (sides) group.add(new THREE.Mesh(sides, new THREE.MeshBasicMaterial({ color: new THREE.Color(buildingColor) })));
      } else {
        group.add(new THREE.Mesh(buildingGeometry, new THREE.MeshBasicMaterial({ color: new THREE.Color(buildingColor) })));
      }
      // buildingFactory may produce Groups with MeshStandardMaterial — flatten to Basic
      group.traverse((child) => {
        if (child.isMesh && child.material?.type === 'MeshStandardMaterial') {
          const color = child.material.color?.clone();
          child.material.dispose();
          child.material = new THREE.MeshBasicMaterial({ color });
        }
      });
      scene.add(group);
    }

    // Land features (roads, parks, water, etc.) — omitted when ground texture is projected
    if (!textureGround) {
      const featureMeshes = generateFeaturesGeometry(clippedGeoJSON, referencePoint, getElevation, featurePalette);
      for (const m of featureMeshes) {
        // Convert to MeshBasicMaterial so colors are viewer-independent
        if (m.material) {
          const color = m.material.color?.clone();
          m.material.dispose();
          m.material = new THREE.MeshBasicMaterial({ color });
        }
        scene.add(m);
      }
    }

    // Ground: terrain mesh when elevation is enabled, flat polygon otherwise
    const groundObj = elevationData
      ? createClippedTerrainMesh(latlngs, southWest, northEast, referencePoint, elevationData, textureGround ? mapCanvas : null, 64, groundDepth)
      : createTexturedGround(latlngs, southWest, northEast, referencePoint, textureGround ? mapCanvas : null, groundDepth);

    if (groundObj) {
      groundObj.traverse((child) => {
        if (!child.isMesh) return;
        if (textureGround && child.material?.map) {
          const tex = child.material.map;
          child.material.dispose();
          child.material = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide });
        } else {
          child.material.dispose();
          child.material = new THREE.MeshBasicMaterial({ color: new THREE.Color(groundColor), side: THREE.DoubleSide });
        }
      });
      scene.add(groundObj);
    }

    const exporter = new GLTFExporter();
    const glbBuffer = await new Promise((resolve, reject) => {
      exporter.parse(scene, resolve, reject, { binary: true });
    });
    const url = URL.createObjectURL(new Blob([glbBuffer], { type: 'model/gltf-binary' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'territory.glb';
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error('3D export error:', err);
    throw err;
  }
}

// Compute the UV reference values (sw, ne in local meters) for a given bbox.
export function bboxToLocalUVRef(southWest, northEast, referencePoint) {
  const sw = toLocal(southWest.lng, southWest.lat, referencePoint);
  const ne = toLocal(northEast.lng, northEast.lat, referencePoint);
  return {
    uRange: sw.y - ne.y, // west.y − east.y
    vRange: ne.x - sw.x, // north.x − south.x
    swY: sw.y,
    swX: sw.x,
  };
}

// Split a non-indexed merged building geometry into two geometries:
//   tops  — faces whose normal points upward (ny > 0.1), UV-mapped from above
//   sides — all other faces, no UV needed (plain material)
//
// Face normals are computed directly from the cross product so we don't depend
// on pre-existing normal attributes.
export function splitByFaceOrientation(geom, { uRange, vRange, swY, swX }) {
  const pos = geom.attributes.position;

  const topPos = [], topUV = [];
  const sidePos = [];

  const vA = new THREE.Vector3();
  const vB = new THREE.Vector3();
  const vC = new THREE.Vector3();
  const edge1 = new THREE.Vector3();
  const edge2 = new THREE.Vector3();
  const faceNormal = new THREE.Vector3();

  for (let i = 0; i < pos.count; i += 3) {
    vA.fromBufferAttribute(pos, i);
    vB.fromBufferAttribute(pos, i + 1);
    vC.fromBufferAttribute(pos, i + 2);
    edge1.subVectors(vB, vA);
    edge2.subVectors(vC, vA);
    faceNormal.crossVectors(edge1, edge2).normalize();

    if (faceNormal.y > 0.1) {
      // Top face — project UV from above: sx = -pos.z, sy = -pos.x
      for (let j = 0; j < 3; j++) {
        const idx = i + j;
        topPos.push(pos.getX(idx), pos.getY(idx), pos.getZ(idx));
        const sx = -pos.getZ(idx);
        const sy = -pos.getX(idx);
        topUV.push(
          uRange !== 0 ? (swY - sy) / uRange : 0.5,
          vRange !== 0 ? (sx - swX) / vRange : 0.5
        );
      }
    } else {
      for (let j = 0; j < 3; j++) {
        const idx = i + j;
        sidePos.push(pos.getX(idx), pos.getY(idx), pos.getZ(idx));
      }
    }
  }

  const makeGeom = (positions, uvArray) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    if (uvArray) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvArray), 2));
    g.computeVertexNormals();
    return g;
  };

  return {
    tops:  topPos.length  > 0 ? makeGeom(topPos, topUV)   : null,
    sides: sidePos.length > 0 ? makeGeom(sidePos, null)   : null,
  };
}

// Ground plane matching the exact drawn polygon shape, textured with the map canvas.
//
// Coordinate system (from toMeters analysis):
//   North of reference  →  sx > 0   |   South  →  sx < 0
//   West  of reference  →  sy > 0   |   East   →  sy < 0
//   After rotateX(-π/2) + rotateY(π/2): shape (sx,sy) → 3D (-sy, 0, -sx)
//
// UV mapping (Three.js default flipY=true: v=0 = image bottom = south, v=1 = image top = north):
//   u = (sw.y - sy) / (sw.y - ne.y)   →  0=west, 1=east
//   v = (sx - sw.x) / (ne.x - sw.x)   →  0=south, 1=north
export function createTexturedGround(latlngs, southWest, northEast, referencePoint, mapCanvas, depth = 0) {
  if (!referencePoint) return null;

  let ring;
  if (latlngs?.center && latlngs.radius) {
    ring = turf.circle([latlngs.center.lng, latlngs.center.lat], latlngs.radius / 1000, { steps: 64 })
      .geometry.coordinates[0];
  } else if (Array.isArray(latlngs) && latlngs.length >= 3) {
    ring = latlngs.map((ll) => [ll.lng, ll.lat]);
  } else {
    return null;
  }

  const shapeVerts = ring.map(([lng, lat]) => {
    const { x, y } = toLocal(lng, lat, referencePoint);
    return new THREE.Vector2(x, y);
  });

  const shape = new THREE.Shape(shapeVerts);
  const geom = new THREE.ShapeGeometry(shape);

  const { uRange, vRange, swY, swX } = bboxToLocalUVRef(southWest, northEast, referencePoint);
  const pos = geom.attributes.position;
  const uvs = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const sx = pos.getX(i);
    const sy = pos.getY(i);
    uvs[i * 2]     = uRange !== 0 ? (swY - sy) / uRange : 0.5;
    uvs[i * 2 + 1] = vRange !== 0 ? (sx - swX) / vRange : 0.5;
  }
  geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));

  geom.rotateX(-Math.PI / 2);
  geom.rotateY(Math.PI / 2);
  // Small offset keeps the top face just below building bases to prevent z-fighting.
  // Sides and bottom are built from y=0 / y=-depth so the slab aligns cleanly.
  geom.translate(0, -0.05, 0);

  const material = mapCanvas
    ? new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(mapCanvas) })
    : new THREE.MeshStandardMaterial({ color: 0xdddddd });

  const topMesh = new THREE.Mesh(geom, material);
  topMesh.name = 'Ground';

  if (depth <= 0) return topMesh;

  // Side walls: top flush with building base (y=0), bottom at y=-depth.
  // Shape (sx, sy) → 3D (-sy, y, -sx) after rotation.
  const outline = shape.getPoints(128);
  const sidePos = new Float32Array(outline.length * 6);
  for (let i = 0; i < outline.length; i++) {
    const sx = outline[i].x, sy = outline[i].y;
    sidePos[i * 6]     = -sy; sidePos[i * 6 + 1] = 0;      sidePos[i * 6 + 2] = -sx; // top
    sidePos[i * 6 + 3] = -sy; sidePos[i * 6 + 4] = -depth; sidePos[i * 6 + 5] = -sx; // bottom
  }
  const sideIdx = [];
  for (let i = 0; i < outline.length; i++) {
    const next = (i + 1) % outline.length;
    const at = i * 2, ab = i * 2 + 1, bt = next * 2, bb = next * 2 + 1;
    sideIdx.push(at, bt, ab);
    sideIdx.push(bt, bb, ab);
  }
  const sideGeom = new THREE.BufferGeometry();
  sideGeom.setAttribute('position', new THREE.BufferAttribute(sidePos, 3));
  sideGeom.setIndex(sideIdx);
  sideGeom.computeVertexNormals();
  const sideMesh = new THREE.Mesh(sideGeom, new THREE.MeshStandardMaterial({ color: 0xaaaaaa, side: THREE.DoubleSide }));
  sideMesh.name = 'GroundSides';

  // Bottom cap: same shape as the top face shifted to y=-depth, DoubleSide so it's visible from below.
  const bottomGeom = geom.clone();
  bottomGeom.translate(0, -depth + 0.05, 0); // geom sits at -0.05; move it to -depth
  const bottomMesh = new THREE.Mesh(
    bottomGeom,
    new THREE.MeshStandardMaterial({ color: 0xaaaaaa, side: THREE.DoubleSide }),
  );
  bottomMesh.name = 'GroundBottom';

  const group = new THREE.Group();
  group.name = 'Ground';
  group.add(topMesh);
  group.add(sideMesh);
  group.add(bottomMesh);
  return group;
}

export async function fetchTilesAndRenderCanvas(latlngs, southWest, northEast, selectedLayer) {
  if (!latlngs || !selectedLayer) return null;

  const tileSize = 256;
  const zoomLevel = 18;

  const swTile = latLngToTile(southWest.lat, southWest.lng, zoomLevel);
  const neTile = latLngToTile(northEast.lat, northEast.lng, zoomLevel);
  const minX = Math.min(swTile.x, neTile.x);
  const minY = Math.min(swTile.y, neTile.y);
  const maxX = Math.max(swTile.x, neTile.x);
  const maxY = Math.max(swTile.y, neTile.y);

  const canvas = document.createElement('canvas');
  canvas.width = (maxX - minX + 1) * tileSize;
  canvas.height = (maxY - minY + 1) * tileSize;
  const ctx = canvas.getContext('2d');

  const tiles = [];
  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      tiles.push({
        url: selectedLayer.value.replace('{z}', zoomLevel).replace('{x}', x).replace('{y}', y),
        dx: (x - minX) * tileSize,
        dy: (y - minY) * tileSize,
      });
    }
  }

  await Promise.all(
    tiles.map(({ url, dx, dy }) =>
      fetch(url)
        .then((r) => r.blob())
        .then(createImageBitmap)
        .then((img) => ctx.drawImage(img, dx, dy, tileSize, tileSize))
        .catch(() => {})
    )
  );

  const topLeft = latLngToPixel(northEast.lat, southWest.lng, zoomLevel);
  const bottomRight = latLngToPixel(southWest.lat, northEast.lng, zoomLevel);
  const bboxX = topLeft.x - minX * tileSize;
  const bboxY = topLeft.y - minY * tileSize;
  const bboxW = bottomRight.x - topLeft.x;
  const bboxH = bottomRight.y - topLeft.y;

  const clipped = document.createElement('canvas');
  clipped.width = bboxW;
  clipped.height = bboxH;
  clipped.getContext('2d').drawImage(canvas, bboxX, bboxY, bboxW, bboxH, 0, 0, bboxW, bboxH);
  return clipped;
}
