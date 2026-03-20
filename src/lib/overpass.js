import osmtogeojson from 'osmtogeojson';
import * as turf from '@turf/turf';

export async function fetchData(latlngs, osmGeoJSONStore, setSouthWest, setNorthEast, onStatus) {
  if (!latlngs) return;

  let southWest, northEast;
  if (latlngs.center && latlngs.radius) {
    const { center, radius } = latlngs;
    const latDeg = radius / 111320;
    const lngDeg = radius / (111320 * Math.cos((center.lat * Math.PI) / 180));
    southWest = { lat: center.lat - latDeg, lng: center.lng - lngDeg };
    northEast = { lat: center.lat + latDeg, lng: center.lng + lngDeg };
  } else if (Array.isArray(latlngs) && latlngs.length > 0) {
    const bounds = L.latLngBounds(latlngs);
    southWest = bounds.getSouthWest();
    northEast = bounds.getNorthEast();
  } else {
    return;
  }

  setSouthWest(southWest);
  setNorthEast(northEast);

  // bbox shorthand for the query
  const bbox = `${southWest.lat},${southWest.lng},${northEast.lat},${northEast.lng}`;

  // A single union of buildings + parts is enough — roof:shape/colour are
  // already tags on those same elements, no need for separate queries.
  // `out geom qt` embeds coordinates directly into each element — avoids the
  // expensive recursive node lookup (`>`) that caused 504s on larger queries.
  const query = `[out:json][timeout:60];(way["building"](${bbox});relation["building"](${bbox});way["building:part"](${bbox});relation["building:part"](${bbox});way["highway"](${bbox});way["railway"~"rail|tram|subway|light_rail|monorail|narrow_gauge"](${bbox});way["landuse"](${bbox});relation["landuse"](${bbox});way["leisure"~"park|garden|pitch|playground|golf_course|recreation_ground"](${bbox});relation["leisure"~"park|garden|golf_course"](${bbox});way["natural"~"water|wood|forest|scrub|heath|grassland|beach|sand|wetland"](${bbox});relation["natural"~"water|wood|forest|wetland"](${bbox});way["waterway"~"river|stream|canal|drain"](${bbox});way["amenity"~"parking"](${bbox}););out geom qt;`;

  // Multiple public Overpass endpoints — tried in order on failure
  const endpoints = [
    { label: 'overpass-api.de', url: 'https://overpass-api.de/api/interpreter' },
    { label: 'kumi.systems', url: 'https://overpass.kumi.systems/api/interpreter' },
    { label: 'mail.ru mirror', url: 'https://maps.mail.ru/osm/tools/overpass/api/interpreter' },
  ];

  let lastErr;
  for (let i = 0; i < endpoints.length; i++) {
    const { label, url } = endpoints[i];
    onStatus?.(`Fetching via ${label}… (${i + 1}/${endpoints.length})`);
    try {
      const controller = new AbortController();
      // 35s client timeout — shorter than gateway timeouts so we can fail fast
      const timer = setTimeout(() => controller.abort(), 35_000);
      const response = await fetch(url, {
        method: 'POST',
        body: `data=${encodeURIComponent(query)}`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      osmGeoJSONStore.set(osmtogeojson(await response.json()));
      onStatus?.('');
      return;
    } catch (err) {
      console.warn(`Overpass endpoint failed (${url}):`, err.message);
      lastErr = err;
    }
  }
  onStatus?.('');
  throw new Error('All Overpass servers are unavailable. Try a smaller area or retry later.');
}

export function clipData(latlngs, osmGeoJSONStore, clippedGeoJSONStore) {
  let originalGeoJSON;
  osmGeoJSONStore.subscribe((d) => { originalGeoJSON = d; })();
  if (!originalGeoJSON || !latlngs) return;

  let clippingPolygon;
  try {
    if (latlngs.center && latlngs.radius) {
      clippingPolygon = turf.circle(
        [latlngs.center.lng, latlngs.center.lat],
        latlngs.radius / 1000,
        { steps: 64 }
      );
    } else {
      const closed = [...latlngs];
      if (latlngs[0].lat !== latlngs[latlngs.length - 1].lat || latlngs[0].lng !== latlngs[latlngs.length - 1].lng) {
        closed.push(latlngs[0]);
      }
      clippingPolygon = turf.polygon([closed.map((p) => [p.lng, p.lat])]);
    }

    const clippedFeatures = originalGeoJSON.features
      .map((feature) => {
        const { geometry } = feature;
        if (!geometry?.coordinates || !['Polygon', 'MultiPolygon'].includes(geometry.type)) return null;
        try {
          const intersection = turf.intersect(
            turf.featureCollection([turf.feature(geometry), clippingPolygon])
          );
          return intersection?.geometry ? { ...feature, geometry: intersection.geometry } : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    if (clippedFeatures.length === 0) return;
    clippedGeoJSONStore.set({ type: 'FeatureCollection', features: clippedFeatures });
  } catch (err) {
    console.error('clipData error:', err);
  }
}
