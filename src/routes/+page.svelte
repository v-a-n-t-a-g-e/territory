<script>
  import "../app.css";
  import {
    osmGeoJSON,
    clippedGeoJSON,
    referencePoint,
    heightStore,
    fallbackHeightStore,
  } from "$lib/stores.js";
  import { fetchData, clipData } from "$lib/overpass.js";
  import { downloadData } from "$lib/utils.js";
  import { DEFAULT_PALETTE, PALETTE_LABELS } from "$lib/featureFactory.js";
  import Map from "$lib/Map.svelte";
  import Layers from "$lib/Layers.svelte";
  import ThreePreview from "$lib/ThreePreview.svelte";
  import * as turf from "@turf/turf";

  // Map state
  let area = $state(null);
  let selectedLayer = $state(null);
  let latlngs = $state([]);
  let flyTo = $state(null);
  let activeTool = $state(null); // 'polygon' | 'rectangle' | 'circle' | null

  // Fetch state
  let southWest = $state(null);
  let northEast = $state(null);
  let loading = $state("");
  let fetchStatus = $state("");
  let error = $state("");

  // Search
  let searchQuery = $state("");
  let searchError = $state("");
  let searching = $state(false);
  let searchResults = $state([]);

  // Settings (export + 3D preview)
  let height = $state(4);
  let fallbackHeight = $state(1);
  let groundDepth = $state(20);
  let textureGround = $state(true);
  let textureBuildings = $state(true);
  let useElevation = $state(false);
  let groundColor = $state("#cccccc");
  let buildingColor = $state("#fafafa");
  let featurePalette = $state({ ...DEFAULT_PALETTE });

  $effect(() => {
    $heightStore = height;
  });
  $effect(() => {
    $fallbackHeightStore = fallbackHeight;
  });

  $effect(() => {
    if ($clippedGeoJSON) {
      $referencePoint = turf.centroid($clippedGeoJSON).geometry.coordinates;
    } else {
      $referencePoint = null;
    }
  });

  const canFetch = $derived(!!area && area <= 8_000_000);
  const tooLarge = $derived(!!area && area > 8_000_000);

  async function searchLocation() {
    const q = searchQuery.trim();
    if (!q) return;
    searching = true;
    searchError = "";
    searchResults = [];
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=5`,
        { headers: { "Accept-Language": "en" } },
      );
      const results = await res.json();
      if (results.length > 0) {
        searchResults = results;
      } else {
        searchError = "Not found";
        setTimeout(() => (searchError = ""), 2000);
      }
    } catch {
      searchError = "Search failed";
      setTimeout(() => (searchError = ""), 2000);
    }
    searching = false;
  }

  function selectResult(result) {
    flyTo = {
      lat: parseFloat(result.lat),
      lng: parseFloat(result.lon),
      zoom: 14,
    };
    searchQuery = "";
    searchResults = [];
  }

  function handleShapeDrawn({ layer }) {
    if (layer instanceof L.Circle) {
      area = Math.PI * Math.pow(layer.getRadius(), 2);
      latlngs = { center: layer.getLatLng(), radius: layer.getRadius() };
    } else {
      area = L.GeometryUtil.geodesicArea(layer._latlngs[0]);
      latlngs = layer._latlngs[0];
    }
  }

  function handleShapeEdited({ area: a, latlngs: l }) {
    area = a;
    latlngs = l;
    $clippedGeoJSON = null;
  }

  async function getData() {
    loading = "fetch";
    error = "";
    fetchStatus = "";
    try {
      await fetchData(
        latlngs,
        osmGeoJSON,
        (v) => (southWest = v),
        (v) => (northEast = v),
        (msg) => (fetchStatus = msg),
      );
      clipData(latlngs, osmGeoJSON, clippedGeoJSON);
    } catch (err) {
      error = err.message ?? "Overpass API unavailable.";
    }
    loading = "";
    fetchStatus = "";
  }

  async function download() {
    loading = "download";
    error = "";
    try {
      await downloadData({
        clippedGeoJSON: $clippedGeoJSON,
        latlngs,
        southWest,
        northEast,
        selectedLayer,
        referencePoint: $referencePoint,
        textureGround,
        textureBuildings,
        useElevation,
        groundDepth,
        featurePalette,
      });
    } catch (err) {
      error = err.message ?? "Export failed.";
    }
    loading = "";
  }

  function redraw() {
    $clippedGeoJSON = null;
  }
</script>

<div class="relative w-screen h-screen overflow-hidden font-sans">
  <!-- Map (always mounted to preserve drawn shape, hidden after fetch) -->
  <div
    class="absolute inset-0"
    style:visibility={$clippedGeoJSON ? "hidden" : "visible"}
  >
    <Map
      {selectedLayer}
      {flyTo}
      bind:drawTool={activeTool}
      onshapeDrawn={handleShapeDrawn}
      onshapeEdited={handleShapeEdited}
    />
  </div>

  <!-- 3D Preview (full screen, only after fetch) -->
  {#if $clippedGeoJSON}
    <div class="absolute inset-0">
      <ThreePreview
        {featurePalette}
        {southWest}
        {northEast}
        {latlngs}
        {selectedLayer}
        {textureGround}
        {textureBuildings}
        {groundDepth}
        {useElevation}
        {groundColor}
        {buildingColor}
      />
    </div>
  {/if}

  <!-- ── Left overlay: search + layers + actions ──────────────────────────── -->
  <div
    class="absolute top-4 left-4 z-[1000] w-80 flex flex-col gap-3 max-h-[calc(100vh-2rem)] overflow-y-auto"
  >
    {#if !$clippedGeoJSON}
      <!-- Search -->
      <div class="flex flex-col bg-white border border-black">
        <div class="flex divide-x divide-black">
          <input
            type="text"
            bind:value={searchQuery}
            placeholder={searchError || "Search location…"}
            onkeydown={(e) => {
              if (e.key === "Enter") searchLocation();
              if (e.key === "Escape") searchResults = [];
            }}
            class="h-10 flex-1 text-base px-3 focus:outline-none {searchError
              ? 'placeholder-red-500'
              : ''}"
          />
          <button
            onclick={searchLocation}
            disabled={searching || !searchQuery.trim()}
            class="h-10 text-base px-3 transition-colors
            {searching || !searchQuery.trim()
              ? 'text-gray-300 cursor-not-allowed'
              : 'hover:bg-accent'}"
          >
            {searching ? "…" : "Go"}
          </button>
        </div>
        {#if searchResults.length > 0}
          <div
            class="flex flex-col divide-y divide-black border-t border-black"
          >
            {#each searchResults as result}
              <button
                onclick={() => selectResult(result)}
                class="px-3 py-2 text-left text-sm hover:bg-accent transition-colors leading-snug"
              >
                {result.display_name}
              </button>
            {/each}
          </div>
        {/if}
      </div>

      <!-- Tile layers -->
      <Layers bind:selectedLayer />

      <!-- Draw tools -->
      <div class="flex divide-x divide-black bg-white border border-black">
        {#each [["Polygon", "polygon"], ["Rectangle", "rectangle"], ["Circle", "circle"]] as [label, tool]}
          <button
            onclick={() => (activeTool = activeTool === tool ? null : tool)}
            class="h-10 flex-1 text-base transition-colors
            {activeTool === tool ? 'bg-accent' : 'hover:bg-gray-100'}"
            >{label}</button
          >
        {/each}
      </div>
    {/if}

    <!-- Actions -->
    <div
      class="flex flex-col divide-y divide-black bg-white border border-black"
    >
      {#if $clippedGeoJSON}
        <button
          onclick={redraw}
          class="h-10 text-left text-base px-3 transition-colors hover:bg-accent"
        >
          ← Redraw
        </button>
      {:else if !area}
        <div class="h-10 px-3 flex items-center text-base text-gray-400">
          Draw a shape on the map.
        </div>
      {:else if tooLarge}
        <div class="h-10 px-3 flex items-center text-base text-red-600">
          Area too large — reduce selection.
        </div>
      {/if}

      {#if error}
        <div class="px-3 py-2 text-base text-red-600">{error}</div>
      {/if}
      {#if fetchStatus}
        <div class="h-10 px-3 flex items-center text-base text-gray-400">
          {fetchStatus}
        </div>
      {/if}

      <button
        onclick={getData}
        disabled={!canFetch || loading === "fetch"}
        class="h-10 text-left text-base px-3 transition-colors
          {!canFetch || loading === 'fetch'
          ? 'text-gray-300 cursor-not-allowed'
          : 'hover:bg-accent'}"
      >
        {loading === "fetch" ? "Fetching…" : "1. Fetch & Clip"}
      </button>

      <button
        onclick={download}
        disabled={!$clippedGeoJSON || loading === "download"}
        class="h-10 text-left text-base px-3 transition-colors
          {!$clippedGeoJSON || loading === 'download'
          ? 'text-gray-300 cursor-not-allowed'
          : 'hover:bg-accent'}"
      >
        {loading === "download" ? "Exporting…" : "2. Export Scene"}
      </button>
    </div>
  </div>

  <!-- ── Right overlay: scene settings (only after fetch) ─────────────────── -->
  {#if $clippedGeoJSON}
    <div
      class="absolute top-4 right-4 z-[1000] w-72 bg-white border border-black overflow-y-auto flex flex-col divide-y divide-black max-h-[calc(100vh-2rem)]"
    >
      <!-- <div class="h-10 px-3 flex items-center text-base font-semibold shrink-0">
        Scene Settings
      </div> -->

      <!-- Map layer -->
      <Layers bind:selectedLayer class="" />

      <!-- Level height -->
      <div class="h-10 px-3 flex items-center justify-between">
        <label for="level-height" class="text-base text-gray-500">Level height</label>
        <div class="flex items-center gap-1">
          <input
            id="level-height"
            type="number"
            bind:value={height}
            min="2"
            max="12"
            step="0.5"
            class="w-16 text-base text-right border border-black px-1 focus:outline-none"
          />
          <span class="text-base text-gray-400">m</span>
        </div>
      </div>

      <!-- Fallback height -->
      <div class="h-10 px-3 flex items-center justify-between">
        <label for="fallback-height" class="text-base text-gray-500">Fallback height</label>
        <div class="flex items-center gap-1">
          <input
            id="fallback-height"
            type="number"
            bind:value={fallbackHeight}
            min="1"
            max="100"
            step="1"
            class="w-16 text-base text-right border border-black px-1 focus:outline-none"
          />
          <span class="text-base text-gray-400">m</span>
        </div>
      </div>

      <!-- Ground depth -->
      <div class="h-10 px-3 flex items-center justify-between">
        <label for="ground-depth" class="text-base text-gray-500">Ground depth</label>
        <div class="flex items-center gap-1">
          <input
            id="ground-depth"
            type="number"
            bind:value={groundDepth}
            min="0"
            max="200"
            step="5"
            class="w-16 text-base text-right border border-black px-1 focus:outline-none"
          />
          <span class="text-base text-gray-400">m</span>
        </div>
      </div>

      <!-- Texture options -->
      <div class="px-3 py-3 flex flex-col gap-2">
        <p class="text-base text-gray-500">Projection</p>
        <label class="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            bind:checked={textureGround}
            class="border border-black"
          />
          <span class="text-base">Ground plane</span>
        </label>
        <label class="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            bind:checked={textureBuildings}
            class="border border-black"
          />
          <span class="text-base">Buildings (top)</span>
        </label>
      </div>

      <!-- Elevation -->
      <div class="px-3 py-3 flex flex-col gap-2">
        <p class="text-base text-gray-500">Terrain</p>
        <label class="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            bind:checked={useElevation}
            class="border border-black"
          />
          <span class="text-base">Use elevation data (DEM)</span>
        </label>
        <!-- {#if useElevation}
          <p class="text-base text-gray-400">Fetches AWS Terrarium tiles.</p>
        {/if} -->
      </div>

      <!-- Feature colours (hidden when satellite/map is projected) -->
      <div class="px-3 py-3 flex flex-col gap-2">
        <p class="text-base text-gray-500">Colours</p>
        <div class="h-10 flex items-center justify-between">
          <label for="color-ground" class="text-base">Ground</label>
          <input
            id="color-ground"
            type="color"
            bind:value={groundColor}
            class="w-7 h-7 border border-black cursor-pointer p-0"
          />
        </div>
        <div class="h-10 flex items-center justify-between">
          <label for="color-buildings" class="text-base">Buildings</label>
          <input
            id="color-buildings"
            type="color"
            bind:value={buildingColor}
            class="w-7 h-7 border border-black cursor-pointer p-0"
          />
        </div>
        {#if !textureGround}
          {#each Object.keys(DEFAULT_PALETTE) as key}
            <div class="h-10 flex items-center justify-between">
              <label for="color-{key}" class="text-base">{PALETTE_LABELS[key]}</label>
              <input
                id="color-{key}"
                type="color"
                bind:value={featurePalette[key]}
                class="w-7 h-7 border border-black cursor-pointer p-0"
              />
            </div>
          {/each}
        {/if}
      </div>
    </div>
  {/if}
</div>
