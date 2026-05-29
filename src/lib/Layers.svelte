<script>
  import { onMount } from 'svelte';
  import { fromBlob } from 'geotiff';

  /** @typedef {{ label: string; value: string | null; attribution: string; type?: string; imageUrl?: string; bounds?: number[][]; canvas?: HTMLCanvasElement }} Layer */

  /** @type {Layer[]} */
  const presets = [
    {
      label: 'Map',
      value: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      attribution: '&copy; OpenStreetMap contributors',
    },
    {
      label: 'Satellite',
      value: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      attribution: 'Tiles &copy; Esri',
    },
    {
      label: 'Light',
      value: 'https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
      attribution: '&copy; OpenStreetMap contributors &copy; CartoDB',
    },
    {
      label: 'Dark',
      value: 'https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
      attribution: '&copy; OpenStreetMap contributors &copy; CartoDB',
    },
  ];

  const defaultPreset = presets[1]; // Satellite

  /** @type {{ selectedLayer: Layer, class: string }} */
  let { selectedLayer = $bindable(defaultPreset), class: className = 'border border-black' } = $props();

  onMount(() => {
    if (!selectedLayer) selectedLayer = defaultPreset;
  });

  const isPreset = $derived(presets.some((p) => p.value === selectedLayer?.value));
  const customActive = $derived(!isPreset && !!selectedLayer && selectedLayer?.type !== 'geotiff');

  let showCustomInput = $state(false);
  let customXyzUrl = $state('');

  let geotiffLoading = $state(false);
  let geotiffError = $state(/** @type {string|null} */ (null));
  /** @type {HTMLInputElement|null} */
  let fileInput = $state(null);

  /** @param {Layer} preset */
  function selectPreset(preset) {
    selectedLayer = preset;
    showCustomInput = false;
    geotiffError = null;
  }

  function toggleCustom() {
    showCustomInput = !showCustomInput;
  }

  function applyCustomUrl() {
    if (!customXyzUrl?.trim()) return;
    const normalised = customXyzUrl.trim().replace('{zoom}', '{z}');
    customXyzUrl = normalised;
    const match = presets.find((p) => p.value === normalised);
    if (match) {
      selectedLayer = match;
      showCustomInput = false;
    } else {
      selectedLayer = { label: 'Custom', value: normalised, attribution: '' };
    }
  }

  /** @param {number} x @param {number} y */
  function mercatorToLatLng(x, y) {
    const lon = (x / 20037508.34) * 180;
    const lat = (180 / Math.PI) * (2 * Math.atan(Math.exp((y / 20037508.34) * Math.PI)) - Math.PI / 2);
    return [lat, lon];
  }

  /** @param {File} file */
  async function handleGeoTIFF(file) {
    geotiffLoading = true;
    geotiffError = null;
    try {
      const tiff = await fromBlob(file);
      const image = await tiff.getImage();
      const geoKeys = image.getGeoKeys();
      const epsg = geoKeys?.ProjectedCSTypeGeoKey ?? geoKeys?.GeographicTypeGeoKey;

      const [west, south, east, north] = image.getBoundingBox();
      /** @type {number[][]} */
      let boundsLatLng;

      if (epsg === 4326) {
        boundsLatLng = [[south, west], [north, east]];
      } else if (epsg === 3857) {
        const [swLat, swLng] = mercatorToLatLng(west, south);
        const [neLat, neLng] = mercatorToLatLng(east, north);
        boundsLatLng = [[swLat, swLng], [neLat, neLng]];
      } else {
        geotiffError = `Unsupported CRS (EPSG:${epsg ?? 'unknown'}). Re-export in EPSG:4326 or EPSG:3857.`;
        return;
      }

      const width  = image.getWidth();
      const height = image.getHeight();
      const rasters = /** @type {Uint8Array} */ (await image.readRasters({ interleave: true }));
      const samplesPerPixel = image.getSamplesPerPixel();

      const canvas = document.createElement('canvas');
      canvas.width  = width;
      canvas.height = height;
      const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
      const imgData = ctx.createImageData(width, height);

      for (let i = 0; i < width * height; i++) {
        const src = i * samplesPerPixel;
        imgData.data[i * 4]     = rasters[src];
        imgData.data[i * 4 + 1] = rasters[src + 1] ?? rasters[src];
        imgData.data[i * 4 + 2] = rasters[src + 2] ?? rasters[src];
        imgData.data[i * 4 + 3] = samplesPerPixel >= 4 ? rasters[src + 3] : 255;
      }
      ctx.putImageData(imgData, 0, 0);

      selectedLayer = {
        type: 'geotiff',
        label: 'GeoTIFF',
        value: canvas.toDataURL(),
        attribution: '',
        imageUrl: canvas.toDataURL(),
        bounds: boundsLatLng,
        canvas,
      };
      showCustomInput = false;
    } catch {
      geotiffError = 'Could not read GeoTIFF file.';
    } finally {
      geotiffLoading = false;
    }
  }

  /** @param {Event} e */
  function onFileChange(e) {
    const input = /** @type {HTMLInputElement} */ (e.target);
    const file = input.files?.[0];
    if (file) handleGeoTIFF(file);
    input.value = '';
  }
</script>

<div class="flex flex-col bg-white {className}">
  <div class="flex divide-x divide-black">
    {#each presets as preset}
      <button
        onclick={() => selectPreset(preset)}
        class="h-8 flex-1 text-xs flex items-center justify-center transition-colors
          {selectedLayer?.value === preset.value && !showCustomInput ? 'bg-accent' : 'hover:bg-gray-100'}"
      >
        {preset.label}
      </button>
    {/each}
    <button
      onclick={toggleCustom}
      class="h-8 flex-1 text-xs flex items-center justify-center transition-colors
        {customActive || showCustomInput ? 'bg-accent' : 'hover:bg-gray-100'}"
    >
      XYZ
    </button>

    <button
      onclick={() => fileInput?.click()}
      disabled={geotiffLoading}
      class="h-8 flex-1 text-xs flex items-center justify-center transition-colors
        {selectedLayer?.type === 'geotiff' ? 'bg-accent' : 'hover:bg-gray-100'}
        disabled:opacity-50"
    >
      {geotiffLoading ? '…' : 'GeoTIFF'}
        <input
        bind:this={fileInput}
        type="file"
        accept=".tif,.tiff"
        onchange={onFileChange}
        class="hidden"
      />
    </button>
    
  </div>

  {#if showCustomInput || customActive}
    <div class="h-8 flex items-center border-t border-black">
      <input
        type="text"
        bind:value={customXyzUrl}
        onkeydown={(e) => { if (e.key === 'Enter') applyCustomUrl(); }}
        placeholder={"https://tile.server/{z}/{x}/{y}.png"}
        class="h-8 flex-1 text-xs px-3 focus:outline-none font-mono min-w-0"
      />
      <button
        onclick={applyCustomUrl}
        class="h-8 px-3 text-xs hover:bg-accent transition-colors border-l border-black shrink-0"
      >Apply</button>
    </div>
  {/if}

  {#if geotiffError}
    <div class="border-t border-black px-3 py-1 text-xs text-red-600">{geotiffError}</div>
  {/if}
</div>
