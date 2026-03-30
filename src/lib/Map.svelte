<script>
  import { onMount } from 'svelte';
  import { osmGeoJSON, clippedGeoJSON } from '$lib/stores.js';
  import L from 'leaflet';
  import 'leaflet/dist/leaflet.css';
  import 'leaflet-draw/dist/leaflet.draw.css';
  import 'leaflet-draw';

  let { selectedLayer, flyTo, drawTool = $bindable(null), onshapeDrawn, onshapeEdited } = $props();

  let mapContainer;
  let map = null;
  let currentLayer = null;
  let geoJSONLayer = null;
  let searchMarker = null;
  let drawHandlersReady = $state(false);
  const handlers = {};

  function setupLayer(layer) {
    if (!map) return;
    if (currentLayer) { map.removeLayer(currentLayer); currentLayer = null; }
    if (!layer?.value) return;
    currentLayer = L.tileLayer(layer.value, { attribution: layer.attribution ?? '' }).addTo(map);
  }

  function addGeoJSONToMap(geoJSON) {
    if (!map) return;
    if (geoJSONLayer) { map.removeLayer(geoJSONLayer); geoJSONLayer = null; }
    if (!geoJSON) return;
    geoJSONLayer = L.geoJSON(geoJSON, {
      style: { color: '#0000ff', fillColor: '#0000ff', fillOpacity: 0.15, weight: 1 },
    }).addTo(map);
  }

  $effect(() => {
    const u1 = osmGeoJSON.subscribe((g) => { if (g && map) addGeoJSONToMap(g); });
    const u2 = clippedGeoJSON.subscribe((g) => { if (g && map) addGeoJSONToMap(g); });
    return () => { u1(); u2(); };
  });

  $effect(() => { if (selectedLayer !== undefined) setupLayer(selectedLayer); });
  $effect(() => {
    if (flyTo && map) {
      map.flyTo([flyTo.lat, flyTo.lng], flyTo.zoom ?? 14);
      if (searchMarker) { map.removeLayer(searchMarker); }
      const pinIcon = L.divIcon({
        className: '',
        html: `<svg width="24" height="36" viewBox="0 0 24 36" xmlns="http://www.w3.org/2000/svg"><path d="M12 0C5.373 0 0 5.373 0 12c0 9 12 24 12 24s12-15 12-24C24 5.373 18.627 0 12 0z" fill="#000"/><circle cx="12" cy="12" r="5" fill="#fff"/></svg>`,
        iconSize: [24, 36],
        iconAnchor: [12, 36],
      });
      searchMarker = L.marker([flyTo.lat, flyTo.lng], { icon: pinIcon }).addTo(map);
    }
  });

  // Activate / deactivate draw handlers based on drawTool prop
  $effect(() => {
    if (!drawHandlersReady) return;
    Object.values(handlers).forEach((h) => h.disable?.());
    if (drawTool && handlers[drawTool]) handlers[drawTool].enable();
  });

  onMount(() => {
    if (L.GeometryUtil) {
      L.GeometryUtil.readableArea = (area, isMetric) => {
        const units = isMetric ? ['m²', 'ha', 'km²'] : ['ft²', 'ac', 'mi²'];
        const thresholds = isMetric ? [10000, 1000000] : [43560, 27878400];
        let i = 0;
        while (area > thresholds[i] && i < thresholds.length - 1) { area /= thresholds[i]; i++; }
        return `${area.toFixed(2)} ${units[i]}`;
      };
    }

    map = L.map(mapContainer, { zoomControl: false }).setView([20, 0], 2);
    setupLayer(selectedLayer);

    const drawnItems = new L.FeatureGroup().addTo(map);

    const shapeOpts = { shapeOptions: { color: '#000', fillColor: '#000', fillOpacity: 0.08, weight: 1 } };
    handlers.polygon   = new L.Draw.Polygon(map, shapeOpts);
    handlers.rectangle = new L.Draw.Rectangle(map, shapeOpts);
    handlers.circle    = new L.Draw.Circle(map);
    drawHandlersReady = true;

    map.on(L.Draw.Event.CREATED, (event) => {
      const { layer } = event;
      drawnItems.clearLayers();
      layer.setStyle?.({ color: '#000', fillColor: '#000', fillOpacity: 0.08, weight: 1 });
      drawnItems.addLayer(layer);
      drawTool = null;
      onshapeDrawn?.({ layer });
    });

    // Reset button state if user presses Escape
    map.on('draw:drawstop', () => { drawTool = null; });

    map.on('draw:edited', (event) => {
      event.layers.eachLayer((layer) => {
        onshapeEdited?.({
          area: L.GeometryUtil.geodesicArea(layer.getLatLngs()[0]),
          latlngs: layer.getLatLngs()[0],
        });
      });
    });
  });
</script>

<div bind:this={mapContainer} class="absolute inset-0"></div>
