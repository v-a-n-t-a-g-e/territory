<script>
  import { onMount } from 'svelte';

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

  let { selectedLayer = $bindable(defaultPreset), class: className = 'border border-black' } = $props();

  onMount(() => {
    if (!selectedLayer) selectedLayer = defaultPreset;
  });

  let xyzUrl = $state(defaultPreset.value);
  let activePreset = $state(defaultPreset);

  function selectPreset(preset) {
    activePreset = preset;
    xyzUrl = preset.value ?? '';
    selectedLayer = preset;
  }

  function normaliseUrl(url) {
    return url.trim().replace('{zoom}', '{z}');
  }

  function applyCustomUrl() {
    if (!xyzUrl?.trim()) return;
    const normalised = normaliseUrl(xyzUrl);
    xyzUrl = normalised;
    const match = presets.find((p) => p.value === normalised);
    if (match) {
      activePreset = match;
      selectedLayer = match;
    } else {
      activePreset = null;
      selectedLayer = { label: 'Custom', value: normalised, attribution: '' };
    }
  }
</script>

<div class="flex flex-col bg-white {className}">
  <!-- Preset buttons -->
  <div class="flex divide-x divide-black">
    {#each presets as preset}
      <button
        onclick={() => selectPreset(preset)}
        class="h-8 flex-1 text-xs flex items-center justify-center transition-colors
          {activePreset?.value === preset.value ? 'bg-accent' : 'hover:bg-gray-100'}"
      >
        {preset.label}
      </button>
    {/each}
  </div>

  <!-- Custom XYZ URL input -->
  <div class="h-8 flex items-center border-t border-black">
    <span class="text-xs text-gray-400 px-3 shrink-0">XYZ</span>
    <input
      type="text"
      bind:value={xyzUrl}
      onchange={applyCustomUrl}
      placeholder="https://tile.server/Z/X/Y.png"
      class="h-8 flex-1 text-xs px-3 focus:outline-none font-mono min-w-0"
    />
  </div>
</div>
