import * as THREE from 'three';
import * as turf from '@turf/turf';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { get } from 'svelte/store';
import { heightStore, fallbackHeightStore } from '$lib/stores.js';
import { toLocal } from '$lib/coords.js';

function parseLength(val) {
  if (typeof val === 'string') {
    const cleaned = val.trim().replace(/ m$/, '');
    return parseFloat(cleaned);
  }
  return val != null ? parseFloat(val) : NaN;
}

function parseColor(val, fallback = '#999999') {
  if (!val) return fallback;
  // OSM sometimes uses names without #, THREE.Color handles CSS names natively
  const s = String(val).trim();
  try {
    new THREE.Color(s);
    return s;
  } catch {
    return fallback;
  }
}

function shapeFromCoords(coords, referencePoint) {
  try {
    const valid = coords.filter(
      (c) => Array.isArray(c) && c.length >= 2 && isFinite(c[0]) && isFinite(c[1])
    );
    if (valid.length < 3) return null;

    // Remove GeoJSON closing point (rings always end with coord[0] repeated).
    // Keeping it creates a zero-length edge that breaks Earcut triangulation on
    // irregular shapes (hexagons, L-shapes, etc.).
    let ring = valid;
    const f = ring[0], l = ring[ring.length - 1];
    if (f[0] === l[0] && f[1] === l[1]) ring = ring.slice(0, -1);
    if (ring.length < 3) return null;

    // Convert to local metres.
    let pts = ring.map((c) => toLocal(c[0], c[1], referencePoint));

    // Remove near-duplicate adjacent vertices (< 5 cm).
    // OSM coordinate rounding can produce several near-identical points in a row,
    // which create degenerate triangles that stall the ear-clipper.
    pts = pts.filter((p, i) => {
      const prev = pts[(i + pts.length - 1) % pts.length];
      const dx = p.x - prev.x, dy = p.y - prev.y;
      return Math.sqrt(dx * dx + dy * dy) > 0.05;
    });
    if (pts.length < 3) return null;

    // Ensure CCW winding. ExtrudeGeometry emits outward-facing normals only when
    // the shape ring is CCW (positive signed area). CW rings — common in
    // building:part ways — produce all inward normals, making the mesh invisible
    // under FrontSide rendering (looks "not extruded").
    let area = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      area += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
    }
    if (area < 0) pts = pts.slice().reverse();

    return new THREE.Shape(pts);
  } catch {
    return null;
  }
}

// Rotations applied consistently: extrusion in XY+Z → rotate to stand upright
function applyBuildingRotations(geometry) {
  geometry.rotateX(-Math.PI / 2);
  geometry.rotateY(Math.PI / 2);
  return geometry;
}

// Tiny lift so roof bottom faces never sit exactly coplanar with the wall's top cap.
const ROOF_LIFT = 0.01;

function createWallGeometry(shape, wallHeight) {
  const geom = new THREE.ExtrudeGeometry(shape, {
    depth: wallHeight,
    bevelEnabled: false,
    curveSegments: 1,
  });
  return applyBuildingRotations(geom);
}

function createRoofGeometry(shape, roofHeight, roofType, wallHeight) {
  const type = (roofType || 'flat').toLowerCase();

  switch (type) {
    case 'flat':
    case 'terrace': {
      const geom = new THREE.ExtrudeGeometry(shape, {
        depth: Math.max(roofHeight, 0.1),
        bevelEnabled: false,
        curveSegments: 1,
      });
      applyBuildingRotations(geom);
      geom.translate(0, wallHeight + ROOF_LIFT, 0);
      return geom;
    }

    case 'pyramidal':
    case 'pyramid': {
      const points = shape.getPoints(32);
      if (points.length < 3) return null;
      const centroid = points.reduce((acc, p) => acc.add(p), new THREE.Vector2()).divideScalar(points.length);
      const verts = [];
      points.forEach((p) => verts.push(new THREE.Vector3(p.x, p.y, 0)));
      const apexIdx = verts.length;
      verts.push(new THREE.Vector3(centroid.x, centroid.y, roofHeight));
      const indices = [];
      for (let i = 0; i < points.length; i++) {
        indices.push(i, (i + 1) % points.length, apexIdx);
      }
      const geom = new THREE.BufferGeometry();
      const pos = new Float32Array(verts.length * 3);
      verts.forEach((v, i) => { pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z; });
      geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geom.setIndex(indices);
      geom.computeVertexNormals();
      applyBuildingRotations(geom);
      geom.translate(0, wallHeight + ROOF_LIFT, 0);
      return geom;
    }

    case 'dome':
    case 'onion': {
      const points = shape.getPoints();
      const bbox = new THREE.Box2();
      points.forEach((p) => bbox.expandByPoint(p));
      const center = new THREE.Vector2();
      bbox.getCenter(center);
      const size = bbox.getSize(new THREE.Vector2());
      const radius = Math.max(size.x, size.y) / 2;
      const geom = type === 'onion'
        ? new THREE.SphereGeometry(radius, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.7)
        : new THREE.SphereGeometry(radius, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
      // SphereGeometry poles are on ±Y; applyBuildingRotations maps Y→X in world space,
      // which lays the dome on its side. Pre-rotate around X so the open face points +Z,
      // which then maps to +Y (up) after applyBuildingRotations.
      geom.rotateX(Math.PI / 2);
      applyBuildingRotations(geom);
      geom.translate(-center.y, wallHeight + ROOF_LIFT, -center.x);
      return geom;
    }

    case 'gabled':
    case 'half-hipped':
    case 'hipped': {
      // Approximate: ridge runs along long axis at half-width, apex at roofHeight
      const points = shape.getPoints(32);
      if (points.length < 3) return null;
      const bbox = new THREE.Box2();
      points.forEach((p) => bbox.expandByPoint(p));
      const size = bbox.getSize(new THREE.Vector2());
      const center = new THREE.Vector2();
      bbox.getCenter(center);

      // Ridge runs along the longer axis
      const ridgeHalf = (type === 'hipped' ? size.x : size.x) * 0.4;
      const [rx, ry] = size.x >= size.y
        ? [ridgeHalf, 0]
        : [0, ridgeHalf];

      const ridge1 = new THREE.Vector3(center.x - rx, center.y - ry, roofHeight);
      const ridge2 = new THREE.Vector3(center.x + rx, center.y + ry, roofHeight);

      // Build triangles from base polygon to ridge
      const verts = points.map((p) => new THREE.Vector3(p.x, p.y, 0));
      const r1Idx = verts.length; verts.push(ridge1);
      const r2Idx = verts.length; verts.push(ridge2);

      const indices = [];
      for (let i = 0; i < points.length; i++) {
        const next = (i + 1) % points.length;
        indices.push(i, next, r1Idx);
        indices.push(i, next, r2Idx);
      }

      const geom = new THREE.BufferGeometry();
      const pos = new Float32Array(verts.length * 3);
      verts.forEach((v, i) => { pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z; });
      geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geom.setIndex(indices);
      geom.computeVertexNormals();
      applyBuildingRotations(geom);
      geom.translate(0, wallHeight + ROOF_LIFT, 0);
      return geom;
    }

    default: {
      // Fall back to flat
      const geom = new THREE.ExtrudeGeometry(shape, {
        depth: Math.max(roofHeight, 0.1),
        bevelEnabled: false,
        curveSegments: 1,
      });
      applyBuildingRotations(geom);
      geom.translate(0, wallHeight + ROOF_LIFT, 0);
      return geom;
    }
  }
}

function getFootprintCentroidLatLng(feature) {
  try {
    const c = turf.centroid(feature);
    return [c.geometry.coordinates[1], c.geometry.coordinates[0]]; // [lat, lng]
  } catch {
    return null;
  }
}

function generateEnhancedBuildingMesh(feature, referencePoint, getElevation = null, heightOverride = null) {
  const props = feature.properties;
  if (!props.building && !props['building:part']) return null;

  const geomType = feature.geometry.type;
  const coordinates = feature.geometry.coordinates;

  let outerCoords, holes;
  if (geomType === 'Polygon') {
    [outerCoords, ...holes] = coordinates;
  } else if (geomType === 'MultiPolygon') {
    [outerCoords, ...holes] = coordinates[0];
  } else {
    return null;
  }

  const shape = shapeFromCoords(outerCoords, referencePoint);
  if (!shape) return null;
  shape.holes = holes.map((h) => shapeFromCoords(h, referencePoint)).filter(Boolean);

  const levelH = get(heightStore);
  const fallbackH = get(fallbackHeightStore);

  // Terrain elevation offset at building footprint centroid
  let elevOffset = 0;
  if (getElevation) {
    const latLng = getFootprintCentroidLatLng(feature);
    if (latLng) elevOffset = getElevation(latLng[0], latLng[1]);
  }

  // Sphere buildings
  if (props['building:shape']?.toLowerCase() === 'sphere') {
    const minH = parseLength(props['min_height']) || 0;
    let totalH = parseLength(props['building:height'] ?? props['height'] ?? '');
    if (!totalH || isNaN(totalH)) {
      const levels = parseFloat(props['building:levels']);
      totalH = isFinite(levels) ? levels * levelH : levelH;
    }
    const pts = shape.getPoints();
    const bbox = new THREE.Box2();
    pts.forEach((p) => bbox.expandByPoint(p));
    const center = new THREE.Vector2();
    bbox.getCenter(center);
    const size = bbox.getSize(new THREE.Vector2());
    const r = Math.max((totalH - minH) / 2, Math.max(size.x, size.y) / 2);
    const geom = new THREE.SphereGeometry(r, 16, 16);
    applyBuildingRotations(geom);
    geom.translate(-center.y, minH + r + elevOffset, -center.x);
    const color = parseColor(props['building:colour'] ?? props['building:color']);
    return new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ color: new THREE.Color(color) }));
  }

  // Heights
  const minHeight = parseLength(props['min_height']) || 0;
  let totalHeight = parseLength(props['building:height'] ?? props['height'] ?? '');
  if (!totalHeight || isNaN(totalHeight)) {
    const levels = parseFloat(props['building:levels']);
    totalHeight = isFinite(levels) ? levels * levelH : fallbackH;
  }

  // When used as a synthetic base under floating parts, cap at the caller's height.
  if (heightOverride !== null) totalHeight = heightOverride;

  let roofHeight = heightOverride !== null ? 0 : parseLength(props['roof:height'] ?? '');
  if (isNaN(roofHeight)) roofHeight = 0;

  const wallHeight = Math.max(totalHeight - roofHeight - minHeight, 0.5);

  // Colors
  const wallColor = parseColor(props['building:colour'] ?? props['building:color']);
  const roofColor = parseColor(props['roof:colour'] ?? props['roof:color'], wallColor);

  const group = new THREE.Group();

  // Walls
  const wallGeom = createWallGeometry(shape, wallHeight);
  wallGeom.translate(0, minHeight + elevOffset, 0);
  group.add(new THREE.Mesh(wallGeom, new THREE.MeshStandardMaterial({ color: new THREE.Color(wallColor) })));

  // Roof — always attempt when there is an explicit shape tag; dome/onion derive their
  // own radius from the footprint and don't need roof:height to be set.
  // Skip when this mesh is acting as a synthetic base (heightOverride set).
  const roofShapeTag = heightOverride !== null ? '' : (props['roof:shape'] ?? '').toLowerCase();
  if (roofHeight > 0 || (roofShapeTag && !['flat', 'terrace', ''].includes(roofShapeTag))) {
    const roofGeom = createRoofGeometry(shape, roofHeight, roofShapeTag || props['roof:shape'], wallHeight + minHeight + elevOffset);
    if (roofGeom) {
      group.add(new THREE.Mesh(roofGeom, new THREE.MeshStandardMaterial({ color: new THREE.Color(roofColor) })));
    }
  }

  return group;
}

function closeRing(coords) {
  if (!coords || coords.length < 3) return null;
  const first = coords[0], last = coords[coords.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) return [...coords, first];
  return coords;
}

function getContainedParts(buildingFeature, parts) {
  if (!buildingFeature.geometry || !parts.length) return [];
  const ring = closeRing(buildingFeature.geometry.coordinates[0]);
  if (!ring) return [];
  const bPoly = turf.polygon([ring]);
  return parts.filter((part) => {
    const r = closeRing(part.geometry?.coordinates?.[0]);
    if (!r) return false;
    try { return turf.booleanContains(bPoly, turf.polygon([r])); }
    catch { return false; }
  });
}

export function generateEnhancedBuildings(geo, referencePoint, getElevation = null) {
  const buildings = [];
  const parts = [];
  for (const f of geo.features) {
    if (f.properties.building && !f.properties['building:part']) buildings.push(f);
    else if (f.properties['building:part']) parts.push(f);
  }

  const group = new THREE.Group();

  for (const building of buildings) {
    const contained = getContainedParts(building, parts);

    if (contained.length === 0) {
      // No parts — render the whole building normally.
      const mesh = generateEnhancedBuildingMesh(building, referencePoint, getElevation);
      if (mesh) group.add(mesh);
    } else {
      // Has parts. Check whether any part starts at ground level (min_height ≤ 0).
      const hasGroundPart = contained.some((p) => {
        const mh = parseLength(p.properties?.min_height);
        return !mh || isNaN(mh) || mh <= 0;
      });

      if (hasGroundPart) {
        // At least one part covers the base — hide the main building outline
        // to avoid double geometry, as in the original behaviour.
      } else {
        // All parts float above ground (e.g. a dome part with min_height > 0 and
        // no separate base part). Render the main building as a flat base up to
        // the lowest min_height so the dome has something to sit on.
        const lowestMinH = Math.min(...contained.map((p) => {
          const v = parseLength(p.properties?.min_height);
          return isFinite(v) ? v : Infinity;
        }));
        const capH = isFinite(lowestMinH) && lowestMinH > 0 ? lowestMinH : null;
        const mesh = generateEnhancedBuildingMesh(building, referencePoint, getElevation, capH);
        if (mesh) group.add(mesh);
      }
    }
  }

  // Always render all parts.
  parts
    .map((f) => generateEnhancedBuildingMesh(f, referencePoint, getElevation))
    .filter(Boolean)
    .forEach((m) => group.add(m));

  return group;
}

export function generateMergedBuildingsGeometry(geo, referencePoint, getElevation = null) {
  const group = generateEnhancedBuildings(geo, referencePoint, getElevation);
  const geometries = [];
  group.traverse((child) => {
    if (!child.isMesh) return;
    child.updateMatrix();
    let geom = child.geometry.clone().applyMatrix4(child.matrix);
    if (geom.index !== null) geom = geom.toNonIndexed();
    if (!geom.attributes.uv) {
      const count = geom.attributes.position.count;
      geom.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
    }
    geometries.push(geom);
  });
  return geometries.length > 0 ? mergeGeometries(geometries, true) : null;
}
