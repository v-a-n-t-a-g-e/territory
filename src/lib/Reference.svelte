<script>
  import * as turf from '@turf/turf';
  import { clippedGeoJSON, referencePoint, heightStore, fallbackHeightStore } from '$lib/stores.js';

  let height = $state(4);
  let fallbackHeight = $state(1);
  let newReference = $state('');
  let copied = $state(false);

  $effect(() => {
    $heightStore = height;
    $fallbackHeightStore = fallbackHeight;
  });

  $effect(() => {
    if ($clippedGeoJSON) {
      $referencePoint = turf.centroid($clippedGeoJSON).geometry.coordinates;
    }
  });

  function copyReferencePoint() {
    if ($referencePoint) {
      const text = `${$referencePoint[1]}, ${$referencePoint[0]}`;
      navigator.clipboard.writeText(text).then(() => {
        copied = true;
        setTimeout(() => (copied = false), 2000);
      });
    }
  }

  function setNewReferencePoint() {
    const parts = newReference.split(',').map((p) => parseFloat(p.trim()));
    if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
      $referencePoint = [parts[1], parts[0]];
      newReference = '';
    }
  }
</script>

{#if $clippedGeoJSON}
  <div class="bg-white border border-black flex flex-col divide-y divide-black">
    <!-- <div class="h-10 px-3 flex items-center text-base font-bold">Scene Settings</div> -->

    <!-- Reference point -->
    <div class="px-3 py-3 flex flex-col gap-2">
      <p class="text-base font-semibold">Reference Point</p>
      {#if $referencePoint}
        <p class="text-base font-mono bg-gray-50 rounded px-2 py-1 truncate">
          {$referencePoint[1].toFixed(5)}, {$referencePoint[0].toFixed(5)}
        </p>
      {/if}
      <div class="flex gap-2">
        <input
          type="text"
          bind:value={newReference}
          placeholder="lat, lon"
          class="h-10 flex-1 text-base border border-black rounded px-3 focus:outline-none"
        />
        <button
          onclick={setNewReferencePoint}
          class="h-10 px-3 bg-black text-white text-base rounded hover:bg-gray-700 transition-colors"
        >Set</button>
      </div>
      <button
        onclick={copyReferencePoint}
        class="h-10 w-full text-base border border-black rounded py-1 text-gray-600 hover:bg-gray-50 transition-colors"
      >
        {copied ? '✓ Copied!' : 'Copy Reference'}
      </button>
    </div>

    <!-- Height settings -->
    <div class="px-3 py-3 flex flex-col gap-3">
      <div class="flex flex-col gap-2">
        <div class="flex justify-between">
          <label for="level-height" class="text-base">Level height</label>
          <span class="text-base font-medium">{height} m</span>
        </div>
        <input
          id="level-height"
          type="range"
          bind:value={height}
          min="2" max="6" step="0.5"
          class="w-full accent-green-500"
        />
      </div>
      <div class="flex flex-col gap-2">
        <div class="flex justify-between">
          <label for="fallback-height" class="text-base">Fallback height</label>
          <span class="text-base font-medium">{fallbackHeight} m</span>
        </div>
        <input
          id="fallback-height"
          type="range"
          bind:value={fallbackHeight}
          min="1" max="20" step="1"
          class="w-full accent-green-500"
        />
      </div>
    </div>
  </div>
{/if}
