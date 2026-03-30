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

  const isPreset = $derived(presets.some((p) => p.value === selectedLayer?.value));
  const customActive = $derived(!isPreset && !!selectedLayer);

  let showCustomInput = $state(false);
  let customXyzUrl = $state('');

  function selectPreset(preset) {
    selectedLayer = preset;
    showCustomInput = false;
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
</div>
