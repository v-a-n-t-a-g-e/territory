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

  const activePreset = $derived(presets.find((p) => p.value === selectedLayer?.value) ?? null);

  function selectPreset(preset) {
    selectedLayer = preset;
  }
</script>

<div class="flex bg-white {className}">
  {#each presets as preset}
    <button
      onclick={() => selectPreset(preset)}
      class="h-8 flex-1 text-xs flex items-center justify-center transition-colors border-r border-black last:border-r-0
        {activePreset?.value === preset.value ? 'bg-accent' : 'hover:bg-gray-100'}"
    >
      {preset.label}
    </button>
  {/each}
</div>
