import * as turf from '@turf/turf';

const TILE_SIZE = 256;

/**
 * Convert a geographic point to local metres relative to a reference.
 * ref may be [lng, lat] array or { lng, lat } object.
 *
 * Returns { x, y } in shape-space:
 *   North of reference → x > 0,  South → x < 0
 *   West  of reference → y > 0,  East  → y < 0
 *
 * After the standard building rotations (rotateX(-π/2) then rotateY(π/2)),
 * shape (x, y) maps to world (-y, 0, -x).
 */
export function toLocal(lng, lat, ref) {
  const refCoord = Array.isArray(ref) ? ref : [ref.lng, ref.lat];
  const dist    = turf.rhumbDistance([lng, lat], refCoord) * 1000;
  const bearing = (turf.rhumbBearing([lng, lat], refCoord) * Math.PI) / 180;
  return { x: dist * Math.cos(bearing) * -1, y: dist * Math.sin(bearing) };
}

/** Web Mercator tile indices for a given lat/lng/zoom. */
export function latLngToTile(lat, lng, zoom) {
  const scale = 2 ** zoom;
  return {
    x: Math.floor(((lng + 180) / 360) * scale),
    y: Math.floor(
      ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * scale,
    ),
  };
}

/** Global pixel coordinates for a given lat/lng/zoom. */
export function latLngToPixel(lat, lng, zoom) {
  const scale = 2 ** zoom * TILE_SIZE;
  return {
    x: ((lng + 180) / 360) * scale,
    y: ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * scale,
  };
}
