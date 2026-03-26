import * as THREE from 'three';
import * as turf from '@turf/turf';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { toLocal } from '$lib/coords.js';

// ─── Y layers (metres above ground) ──────────────────────────────────────────
// Each category sits on its own unique plane — no two types share the same Y,
// so overlapping polygons can never produce depth-buffer z-fighting.
// Visual priority (higher Y = drawn on top): urban < sand < green < forest < water < parking < road < rail < bridge
const Y_URBAN   = 0.02;  // residential / commercial / industrial base fill
const Y_SAND    = 0.04;  // beach, sand
const Y_GREEN   = 0.06;  // parks, grass, meadow, cemetery, farmland
const Y_FOREST  = 0.08;  // wood, scrub, heath
const Y_WATER   = 0.12;  // water bodies (slightly raised for visual clarity)
const Y_PARKING = 0.18;  // parking lots (above landuse, below roads)
const Y_ROAD    = 0.25;  // all road types
const Y_RAIL    = 0.30;  // railways
const Y_BRIDGE  = 3.0;   // rough visual elevation for bridges

// ─── Default colour palette (user-editable) ───────────────────────────────────
export const DEFAULT_PALETTE = {
  green:   '#c8dfb0',  // parks, gardens, grass, pitch, playground
  forest:  '#6aab5e',  // forest, wood, scrub, heath
  water:   '#aad4f0',  // lakes, rivers, canals, waterways
  sand:    '#f0ddb0',  // beach, sand
  road:    '#f0ede8',  // all highway types
  railway: '#c0b8b0',  // rail, tram, subway, light_rail
  urban:   '#e8e4e0',  // residential, commercial, industrial, retail
  parking: '#d0ccb8',  // parking lots
};

export const PALETTE_LABELS = {
  green:   'Parks & grass',
  forest:  'Forest & trees',
  water:   'Water',
  sand:    'Sand & beach',
  road:    'Roads',
  railway: 'Railways',
  urban:   'Urban areas',
  parking: 'Parking',
};

// Road half-widths in metres (visual width / 2)
const ROAD_HALF_WIDTHS = {
  motorway:       7,
  motorway_link:  4,
  trunk:          6,
  trunk_link:     3.5,
  primary:        5,
  primary_link:   3,
  secondary:      4,
  secondary_link: 2.5,
  tertiary:       3,
  tertiary_link:  2,
  unclassified:   2.5,
  residential:    2.5,
  living_street:  2,
  service:        1.5,
  pedestrian:     3,
  footway:        1,
  path:           0.75,
  cycleway:       1,
  steps:          1,
  track:          2,
};

const RAILWAY_HALF_WIDTHS = {
  rail:         1.5,
  tram:         0.75,
  subway:       1.5,
  light_rail:   1.2,
  monorail:     1,
  narrow_gauge: 1,
  preserved:    1,
  funicular:    0.75,
};

// ─── Geometry helpers ─────────────────────────────────────────────────────────

function shapeFromRing(ring, reference) {
  const valid = ring.filter(c => Array.isArray(c) && c.length >= 2 && isFinite(c[0]) && isFinite(c[1]));
  if (valid.length < 3) return null;
  try {
    // Remove GeoJSON closing duplicate and near-duplicate adjacent points.
    let r = valid;
    const f = r[0], l = r[r.length - 1];
    if (f[0] === l[0] && f[1] === l[1]) r = r.slice(0, -1);
    if (r.length < 3) return null;
    let pts = r.map(c => toLocal(c[0], c[1], reference));
    pts = pts.filter((p, i) => {
      const prev = pts[(i + pts.length - 1) % pts.length];
      const dx = p.x - prev.x, dy = p.y - prev.y;
      return Math.sqrt(dx * dx + dy * dy) > 0.05;
    });
    if (pts.length < 3) return null;
    // Ensure CCW so ShapeGeometry normals point upward.
    let area = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      area += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
    }
    if (area < 0) pts = pts.slice().reverse();
    return new THREE.Shape(pts);
  } catch { return null; }
}

function flatGeom(shape, y) {
  const geom = new THREE.ShapeGeometry(shape);
  geom.rotateX(-Math.PI / 2);
  geom.rotateY(Math.PI / 2);
  geom.translate(0, y, 0);
  return geom;
}

function bufferLine(coords, halfWidthM, y, reference) {
  const valid = coords.filter(c => Array.isArray(c) && c.length >= 2 && isFinite(c[0]) && isFinite(c[1]));
  if (valid.length < 2) return null;
  try {
    const buf = turf.buffer(turf.lineString(valid), halfWidthM / 1000, { units: 'kilometers', steps: 2 });
    const ring = buf?.geometry?.coordinates?.[0];
    if (!ring) return null;
    const shape = shapeFromRing(ring, reference);
    return shape ? flatGeom(shape, y) : null;
  } catch { return null; }
}

// ─── Feature classification ───────────────────────────────────────────────────
// Returns { paletteKey, kind, subtype?, y } or null if unrecognised.

const WATERWAY_HALF_WIDTHS = { river: 4, stream: 1, canal: 3, drain: 0.5 };

const NATURAL_CLASS = {
  water:     { paletteKey: 'water',  kind: 'polygon', y: Y_WATER  },
  wetland:   { paletteKey: 'water',  kind: 'polygon', y: Y_WATER  },
  wood:      { paletteKey: 'forest', kind: 'polygon', y: Y_FOREST },
  forest:    { paletteKey: 'forest', kind: 'polygon', y: Y_FOREST },
  scrub:     { paletteKey: 'forest', kind: 'polygon', y: Y_FOREST },
  heath:     { paletteKey: 'forest', kind: 'polygon', y: Y_FOREST },
  grassland: { paletteKey: 'green',  kind: 'polygon', y: Y_GREEN  },
  meadow:    { paletteKey: 'green',  kind: 'polygon', y: Y_GREEN  },
  beach:     { paletteKey: 'sand',   kind: 'polygon', y: Y_SAND   },
  sand:      { paletteKey: 'sand',   kind: 'polygon', y: Y_SAND   },
};

const LANDUSE_CLASS = {
  reservoir:    { paletteKey: 'water',  kind: 'polygon', y: Y_WATER  },
  basin:        { paletteKey: 'water',  kind: 'polygon', y: Y_WATER  },
  forest:       { paletteKey: 'forest', kind: 'polygon', y: Y_FOREST },
  grass:        { paletteKey: 'green',  kind: 'polygon', y: Y_GREEN  },
  meadow:       { paletteKey: 'green',  kind: 'polygon', y: Y_GREEN  },
  village_green:{ paletteKey: 'green',  kind: 'polygon', y: Y_GREEN  },
  cemetery:     { paletteKey: 'green',  kind: 'polygon', y: Y_GREEN  },
  allotments:   { paletteKey: 'green',  kind: 'polygon', y: Y_GREEN  },
  farmland:     { paletteKey: 'green',  kind: 'polygon', y: Y_GREEN  },
  farmyard:     { paletteKey: 'green',  kind: 'polygon', y: Y_GREEN  },
  residential:  { paletteKey: 'urban',  kind: 'polygon', y: Y_URBAN  },
  commercial:   { paletteKey: 'urban',  kind: 'polygon', y: Y_URBAN  },
  industrial:   { paletteKey: 'urban',  kind: 'polygon', y: Y_URBAN  },
  retail:       { paletteKey: 'urban',  kind: 'polygon', y: Y_URBAN  },
};

const LEISURE_CLASS = {
  park:              { paletteKey: 'green', kind: 'polygon', y: Y_GREEN },
  garden:            { paletteKey: 'green', kind: 'polygon', y: Y_GREEN },
  recreation_ground: { paletteKey: 'green', kind: 'polygon', y: Y_GREEN },
  pitch:             { paletteKey: 'green', kind: 'polygon', y: Y_GREEN },
  playground:        { paletteKey: 'green', kind: 'polygon', y: Y_GREEN },
  golf_course:       { paletteKey: 'green', kind: 'polygon', y: Y_GREEN },
};

function classify(props) {
  const { highway, railway, waterway, natural, landuse, leisure, amenity, bridge } = props;
  const isBridge = bridge === 'yes' || bridge === '1' || bridge === 'aqueduct';

  if (highway && ROAD_HALF_WIDTHS[highway])
    return { paletteKey: 'road', kind: 'road', subtype: highway, y: isBridge ? Y_BRIDGE : Y_ROAD };

  if (railway && RAILWAY_HALF_WIDTHS[railway])
    return { paletteKey: 'railway', kind: 'railway', subtype: railway, y: isBridge ? Y_BRIDGE + 0.1 : Y_RAIL };

  if (waterway && WATERWAY_HALF_WIDTHS[waterway])
    return { paletteKey: 'water', kind: 'waterline', subtype: waterway, y: Y_WATER };

  if (natural  && NATURAL_CLASS[natural])  return NATURAL_CLASS[natural];
  if (landuse  && LANDUSE_CLASS[landuse])  return LANDUSE_CLASS[landuse];
  if (leisure  && LEISURE_CLASS[leisure])  return LEISURE_CLASS[leisure];
  if (amenity === 'parking')               return { paletteKey: 'parking', kind: 'polygon', y: Y_PARKING };

  return null;
}

// ─── Public export ────────────────────────────────────────────────────────────

export function getActivePaletteKeys(geo) {
  if (!geo?.features) return new Set();
  const keys = new Set();
  for (const feature of geo.features) {
    const props = feature.properties ?? {};
    if (props.building || props['building:part']) continue;
    const cls = classify(props);
    if (cls) keys.add(cls.paletteKey);
  }
  return keys;
}

export function generateFeaturesGeometry(geo, referencePoint, getElevation = null, palette = DEFAULT_PALETTE) {
  const byColor = new Map(); // hex color → BufferGeometry[]

  const push = (geom, color) => {
    if (!geom) return;
    if (!geom.attributes.uv) {
      geom.setAttribute('uv', new THREE.BufferAttribute(
        new Float32Array(geom.attributes.position.count * 2), 2
      ));
    }
    const g = geom.index !== null ? geom.toNonIndexed() : geom;
    if (!byColor.has(color)) byColor.set(color, []);
    byColor.get(color).push(g);
  };

  for (const feature of geo.features) {
    const props = feature.properties ?? {};
    if (props.building || props['building:part']) continue;

    const cls = classify(props);
    if (!cls) continue;

    const geomType = feature.geometry?.type;
    if (!geomType) continue;

    const color = palette[cls.paletteKey] ?? '#e0e0e0';

    // Elevation offset at feature centroid
    let elevOffset = 0;
    if (getElevation) {
      try {
        const c = turf.centroid(feature).geometry.coordinates;
        elevOffset = getElevation(c[1], c[0]);
      } catch {}
    }
    const y = cls.y + elevOffset;

    if (cls.kind === 'road') {
      const hw = ROAD_HALF_WIDTHS[cls.subtype] ?? 2.5;
      if (geomType === 'LineString') {
        push(bufferLine(feature.geometry.coordinates, hw, y, referencePoint), color);
      } else if (geomType === 'MultiLineString') {
        for (const seg of feature.geometry.coordinates)
          push(bufferLine(seg, hw, y, referencePoint), color);
      } else if (geomType === 'Polygon') {
        const s = shapeFromRing(feature.geometry.coordinates[0], referencePoint);
        if (s) push(flatGeom(s, y), color);
      }
    } else if (cls.kind === 'railway') {
      const hw = RAILWAY_HALF_WIDTHS[cls.subtype] ?? 1.5;
      if (geomType === 'LineString') {
        push(bufferLine(feature.geometry.coordinates, hw, y, referencePoint), color);
      } else if (geomType === 'MultiLineString') {
        for (const seg of feature.geometry.coordinates)
          push(bufferLine(seg, hw, y, referencePoint), color);
      }
    } else if (cls.kind === 'waterline') {
      const hw = WATERWAY_HALF_WIDTHS[cls.subtype] ?? 1;
      if (geomType === 'LineString') {
        push(bufferLine(feature.geometry.coordinates, hw, y, referencePoint), color);
      } else if (geomType === 'MultiLineString') {
        for (const seg of feature.geometry.coordinates)
          push(bufferLine(seg, hw, y, referencePoint), color);
      }
    } else {
      // Plain polygon (land fill, water area, etc.)
      if (geomType === 'Polygon') {
        const s = shapeFromRing(feature.geometry.coordinates[0], referencePoint);
        if (s) push(flatGeom(s, y), color);
      } else if (geomType === 'MultiPolygon') {
        for (const poly of feature.geometry.coordinates) {
          const s = shapeFromRing(poly[0], referencePoint);
          if (s) push(flatGeom(s, y), color);
        }
      }
    }
  }

  const meshes = [];
  for (const [color, geoms] of byColor) {
    if (!geoms.length) continue;
    try {
      const merged = mergeGeometries(geoms);
      if (!merged) continue;
      const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(color) });
      const mesh = new THREE.Mesh(merged, mat);
      mesh.name = `Feature_${color}`;
      meshes.push(mesh);
    } catch {
      for (const g of geoms) {
        meshes.push(new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: new THREE.Color(color) })));
      }
    }
  }
  return meshes;
}
