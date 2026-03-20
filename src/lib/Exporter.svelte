<script>
  import { osmGeoJSON, clippedGeoJSON, referencePoint } from '$lib/stores.js';
  import { fetchData, clipData, downloadData } from '$lib/utils.js';
  import Reference from '$lib/Reference.svelte';

  let { area, latlngs, selectedLayer } = $props();

  let southWest = $state(null);
  let northEast = $state(null);
  let loading = $state('');
  let fetchStatus = $state('');
  let error = $state('');
  let settingsOpen = $state(false);

  const canFetch = $derived(area && area <= 8_000_000);
  const tooLarge = $derived(area && area > 8_000_000);

  async function getData() {
    loading = 'fetch';
    error = '';
    fetchStatus = '';
    try {
      await fetchData(
        latlngs,
        osmGeoJSON,
        (v) => (southWest = v),
        (v) => (northEast = v),
        (msg) => (fetchStatus = msg)
      );
    } catch (err) {
      error = err.message ?? 'Overpass API unavailable — try again in a moment.';
    }
    loading = '';
    fetchStatus = '';
  }

  function clip() {
    loading = 'clip';
    error = '';
    clipData(latlngs, osmGeoJSON, clippedGeoJSON);
    loading = '';
  }

  async function download() {
    loading = 'download';
    error = '';
    try {
      await downloadData({
        clippedGeoJSON: $clippedGeoJSON,
        latlngs,
        southWest,
        northEast,
        selectedLayer,
        referencePoint: $referencePoint,
      });
    } catch {
      error = 'Export failed — check the console for details.';
    }
    loading = '';
  }
</script>

<div class="flex flex-col items-end gap-4">
  <!-- Settings panel (Reference) -->
  {#if settingsOpen}
    <Reference />
  {/if}

  <!-- Action panel -->
  <div class="bg-white border border-black flex flex-col divide-y divide-black min-w-52">
    {#if !area}
      <div class="h-10 px-3 flex items-center text-base text-gray-500 text-center">Draw a shape on the map to begin</div>
    {:else if tooLarge}
      <div class="h-10 px-3 flex items-center text-base text-red-500 text-center">Area too large — reduce selection</div>
    {/if}
    {#if error}
      <div class="h-10 px-3 flex items-center text-base text-red-500 bg-red-50">{error}</div>
    {/if}

    <button
      onclick={getData}
      disabled={!canFetch || loading === 'fetch'}
      class="h-10 w-full text-base font-medium px-3 transition-colors
        {!canFetch || loading === 'fetch'
          ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
          : 'bg-black text-white hover:bg-gray-700'}"
    >
      {loading === 'fetch' ? '⏳ Fetching…' : '① Fetch OSM Data'}
    </button>
    {#if fetchStatus}
      <div class="h-10 px-3 flex items-center text-base text-gray-500 text-center">{fetchStatus}</div>
    {/if}

    <button
      onclick={clip}
      disabled={!$osmGeoJSON || loading === 'clip'}
      class="h-10 w-full text-base font-medium px-3 transition-colors
        {!$osmGeoJSON || loading === 'clip'
          ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
          : 'bg-black text-white hover:bg-gray-700'}"
    >
      {loading === 'clip' ? '⏳ Clipping…' : '② Clip to Shape'}
    </button>

    <button
      onclick={download}
      disabled={!$clippedGeoJSON || loading === 'download'}
      class="h-10 w-full text-base font-medium px-3 transition-colors
        {!$clippedGeoJSON || loading === 'download'
          ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
          : 'bg-green-500 text-white hover:bg-green-600'}"
    >
      {loading === 'download' ? '⏳ Exporting…' : '③ Download GLB'}
    </button>

    {#if $clippedGeoJSON}
      <button
        onclick={() => (settingsOpen = !settingsOpen)}
        class="h-10 w-full text-base text-gray-500 hover:text-gray-800 px-3 transition-colors"
      >
        {settingsOpen ? '✕ Hide settings' : '⚙ Scene settings'}
      </button>
    {/if}
  </div>
</div>
