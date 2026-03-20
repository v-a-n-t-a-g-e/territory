import { writable } from "svelte/store";

export const osmGeoJSON = writable(null);
export const clippedGeoJSON = writable(null);
export const referencePoint = writable(null);
export const fallbackHeightStore = writable(1);
export const heightStore = writable(4);