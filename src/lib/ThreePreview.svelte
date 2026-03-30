<script>
  import { onMount, onDestroy, untrack } from 'svelte';
  import { clippedGeoJSON, referencePoint, heightStore, fallbackHeightStore } from '$lib/stores.js';
  import { generateMergedBuildingsGeometry } from '$lib/buildingFactory.js';
  import { generateFeaturesGeometry } from '$lib/featureFactory.js';
  import { fetchTilesAndRenderCanvas, createTexturedGround, bboxToLocalUVRef, splitByFaceOrientation } from '$lib/utils.js';
  import { fetchElevationData, createClippedTerrainMesh } from '$lib/elevation.js';
  import * as THREE from 'three';
  import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

  let { featurePalette, southWest, northEast, latlngs, selectedLayer,
        textureGround, textureBuildings, groundDepth, useElevation,
        groundColor, buildingColor } = $props();

  let containerEl;
  let renderer, scene, camera, controls, rafId;
  let currentGeoData = null;
  let currentRefPoint = null;
  let satelliteCanvas = null;
  let elevationData   = null;
  let cameraFitted    = false;

  // Geometry cache — only invalidated when data/heights/elevation actually changes.
  // Never disposed between material-only swaps so texture toggles are instant.
  let cachedBuildingGeometry = null;   // merged BufferGeometry
  let cachedSplitGeometry    = null;   // { tops, sides } BufferGeometries
  let cachedBuildingElevData = undefined; // which elevationData the cache was built with

  function invalidateBuildingCache() {
    cachedBuildingGeometry?.dispose();
    cachedBuildingGeometry = null;
    cachedSplitGeometry?.tops?.dispose();
    cachedSplitGeometry?.sides?.dispose();
    cachedSplitGeometry = null;
    cachedBuildingElevData = undefined;
  }

  // ── Effects — each tracks only what it explicitly voids ───────────────────────

  // Elevation toggle: full rebuild (may trigger elevation fetch)
  $effect(() => {
    void useElevation;
    if (scene && currentGeoData && currentRefPoint) untrack(applySettings);
  });

  // Ground-only: swap material, no building geometry rebuild
  $effect(() => {
    void textureGround;
    void groundDepth;
    if (scene && currentGeoData && currentRefPoint) {
      untrack(() => {
        buildGroundMesh(satelliteCanvas, useElevation ? elevationData : null);
        buildFeatureMeshes(useElevation ? elevationData : null);
      });
    }
  });

  // Height changes: must regenerate building geometry
  $effect(() => {
    void $heightStore;
    void $fallbackHeightStore;
    if (scene && currentGeoData && currentRefPoint) {
      untrack(() => {
        invalidateBuildingCache();
        buildBuildingMeshes(satelliteCanvas, useElevation ? elevationData : null);
      });
    }
  });

  // Texture toggle: reuse cached geometry, swap materials only
  $effect(() => {
    void textureBuildings;
    if (scene && currentGeoData && currentRefPoint) {
      untrack(() => buildBuildingMeshes(satelliteCanvas, useElevation ? elevationData : null));
    }
  });

  $effect(() => {
    void groundColor;
    if (scene) untrack(() => {
      scene.traverse((child) => {
        if (!child.isMesh || !child.material || child.material.map) return;
        if (child.userData.ground) child.material.color.set(groundColor);
      });
    });
  });

  $effect(() => {
    void buildingColor;
    if (scene) untrack(() => {
      scene.traverse((child) => {
        if (!child.isMesh || !child.material || child.material.map) return;
        if (child.parent?.userData?.buildings) child.material.color.set(buildingColor);
      });
    });
  });

  // Feature palette: rebuild feature meshes only (fast, no I/O)
  $effect(() => {
    if (featurePalette) for (const k in featurePalette) void featurePalette[k];
    if (scene && currentGeoData && currentRefPoint) {
      untrack(() => buildFeatureMeshes(useElevation ? elevationData : null));
    }
  });

  // Layer change: re-fetch tiles (and elevation if needed)
  $effect(() => {
    void selectedLayer;
    if (scene && currentGeoData && currentRefPoint && southWest && northEast && latlngs) {
      untrack(() => rebuildGround(southWest, northEast, latlngs, selectedLayer, currentRefPoint));
    }
  });

  // ── Helpers ───────────────────────────────────────────────────────────────────

  function disposeObject(obj) {
    obj.traverse((child) => {
      if (!child.isMesh) return;
      child.geometry?.dispose();
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      mats.forEach((m) => { m.map?.dispose(); m.dispose(); });
    });
  }

  function clearByTag(tag) {
    scene.children
      .filter((c) => c.userData[tag])
      .forEach((c) => { disposeObject(c); scene.remove(c); });
  }

  // Clear building meshes without disposing cached geometries.
  function clearBuildingMeshes() {
    scene.children
      .filter((c) => c.userData.buildings)
      .forEach((c) => {
        c.traverse((child) => {
          if (!child.isMesh) return;
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          mats.forEach((m) => { m.map?.dispose(); m.dispose(); });
          // Only dispose geometry if it's not from the cache
          const isCache = child.geometry === cachedBuildingGeometry
            || child.geometry === cachedSplitGeometry?.tops
            || child.geometry === cachedSplitGeometry?.sides;
          if (!isCache) child.geometry?.dispose();
        });
        scene.remove(c);
      });
  }

function buildGroundMesh(canvas, elevData) {
    clearByTag('ground');
    const obj = useElevation && elevData
      ? createClippedTerrainMesh(latlngs, southWest, northEast, currentRefPoint, elevData, textureGround ? canvas : null, 64, groundDepth)
      : createTexturedGround(latlngs, southWest, northEast, currentRefPoint, textureGround ? canvas : null, groundDepth);
    if (!obj) return;
    obj.traverse((child) => {
      if (!child.isMesh) return;
      if (textureGround && child.material?.map) {
        const tex = child.material.map;
        child.material.dispose();
        child.material = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide });
      } else {
        child.material.dispose();
        child.material = new THREE.MeshStandardMaterial({ color: new THREE.Color(groundColor), side: THREE.DoubleSide });
      }
      child.userData.ground = true;
    });
    obj.userData.ground = true;
    scene.add(obj);
  }

  function buildFeatureMeshes(elevData) {
    clearByTag('features');
    if (textureGround) return;
    const getElevation = elevData
      ? (lat, lng) => elevData.sampleAtLatLng(lat, lng) - elevData.minElevation
      : null;
    const meshes = generateFeaturesGeometry(currentGeoData, currentRefPoint, getElevation, featurePalette);
    if (!meshes.length) return;
    const group = new THREE.Group();
    group.userData.features = true;
    for (const m of meshes) group.add(m);
    scene.add(group);
  }

  function buildBuildingMeshes(canvas, elevData) {
    clearBuildingMeshes();

    // Rebuild geometry only when elevation changes or cache is empty.
    // Height store changes are handled by explicitly calling invalidateBuildingCache() first.
    if (!cachedBuildingGeometry || elevData !== cachedBuildingElevData) {
      invalidateBuildingCache();
      const getElevation = elevData
        ? (lat, lng) => elevData.sampleAtLatLng(lat, lng) - elevData.minElevation
        : null;
      cachedBuildingGeometry = generateMergedBuildingsGeometry(currentGeoData, currentRefPoint, getElevation);
      cachedBuildingElevData = elevData;
    }

    if (!cachedBuildingGeometry) return;

    const group = new THREE.Group();
    group.userData.buildings = true;

    if (textureBuildings && canvas) {
      // Compute split only once; reuse on subsequent texture-toggle calls.
      if (!cachedSplitGeometry) {
        const uvRef = bboxToLocalUVRef(southWest, northEast, currentRefPoint);
        cachedSplitGeometry = splitByFaceOrientation(cachedBuildingGeometry, uvRef);
      }
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      const { tops, sides } = cachedSplitGeometry;
      if (tops)  group.add(new THREE.Mesh(tops,  new THREE.MeshBasicMaterial({ map: texture })));
      if (sides) group.add(new THREE.Mesh(sides, new THREE.MeshStandardMaterial({ color: new THREE.Color(buildingColor) })));
    } else {
      group.add(new THREE.Mesh(
        cachedBuildingGeometry,
        new THREE.MeshStandardMaterial({ color: new THREE.Color(buildingColor) }),
      ));
    }

    scene.add(group);
  }

  function applySettings() {
    if (useElevation && !elevationData && southWest && northEast) {
      fetchElevationData(southWest, northEast).then((elevData) => {
        elevationData = elevData;
        buildGroundMesh(satelliteCanvas, elevData);
        buildBuildingMeshes(satelliteCanvas, elevData);
        buildFeatureMeshes(elevData);
      }).catch(console.error);
      return;
    }
    const elevData = useElevation ? elevationData : null;
    buildGroundMesh(satelliteCanvas, elevData);
    buildBuildingMeshes(satelliteCanvas, elevData);
    buildFeatureMeshes(elevData);
  }

  function rebuild(geoData, refPoint) {
    if (!scene) return;
    invalidateBuildingCache();
    const elevData = useElevation ? elevationData : null;
    buildBuildingMeshes(satelliteCanvas, elevData);
    buildFeatureMeshes(elevData);
    fitCamera();
  }

  async function rebuildGround(sw, ne, ltlngs, layer, refPoint) {
    if (!scene || !sw || !ne || !ltlngs || !layer || !refPoint) return;
    try {
      const [canvas, elevData] = await Promise.all([
        fetchTilesAndRenderCanvas(ltlngs, sw, ne, layer),
        useElevation ? fetchElevationData(sw, ne) : Promise.resolve(null),
      ]);
      satelliteCanvas = canvas;
      elevationData   = elevData;
      buildGroundMesh(canvas, useElevation ? elevData : null);
      buildBuildingMeshes(canvas, useElevation ? elevData : null);
      buildFeatureMeshes(useElevation ? elevData : null);
    } catch (err) {
      console.error('Ground/elevation load failed:', err);
    }
  }

  function fitCamera() {
    if (cameraFitted) return;
    const box = new THREE.Box3();
    scene.traverse((obj) => {
      if (obj.isMesh && (obj.userData.buildings || obj.parent?.userData?.buildings)) {
        box.expandByObject(obj);
      }
    });
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size   = box.getSize(new THREE.Vector3());
    const maxHoriz = Math.max(size.x, size.z);
    const distance = Math.max(maxHoriz, 50) * 1.5;
    camera.position.set(
      center.x + distance * 0.65,
      Math.max(size.y * 2, distance * 0.55),
      center.z + distance * 0.65,
    );
    controls.target.copy(center);
    controls.update();
    cameraFitted = true;
  }

  function resize() {
    if (!renderer || !containerEl) return;
    const w = containerEl.clientWidth;
    const h = containerEl.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────────

  onMount(() => {
    renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0xf0f0f0);
    containerEl.appendChild(renderer.domElement);
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf0f0f0);

    camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100000);
    camera.position.set(500, 350, 500);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;

    scene.add(new THREE.AmbientLight(0xffffff, 0.9));
    const sun = new THREE.DirectionalLight(0xffffff, 0.6);
    sun.position.set(-300, 500, 200);
    scene.add(sun);

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(containerEl);

    const u1 = clippedGeoJSON.subscribe((g) => {
      currentGeoData = g;
      if (g) cameraFitted = false;
      if (g && currentRefPoint) rebuild(g, currentRefPoint);
    });
    const u2 = referencePoint.subscribe((r) => {
      currentRefPoint = r;
      if (r && currentGeoData) {
        rebuild(currentGeoData, r);
        rebuildGround(southWest, northEast, latlngs, selectedLayer, r);
      }
    });

    function loop() {
      rafId = requestAnimationFrame(loop);
      controls.update();
      renderer.render(scene, camera);
    }
    loop();

    return () => { ro.disconnect(); u1(); u2(); };
  });

  onDestroy(() => {
    if (rafId) cancelAnimationFrame(rafId);
    invalidateBuildingCache();
    if (renderer) renderer.dispose();
  });
</script>

<div bind:this={containerEl} class="absolute inset-0"></div>
