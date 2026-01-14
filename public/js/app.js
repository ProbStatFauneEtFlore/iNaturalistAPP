// =====================
// Globals
// =====================

let mapInstance = null;
let currentTaxonFilter = null; // number or null
let ecosystemsLayer = null;
let ecosystemsLoaded = false;


// Tile config (matches your Python tiler)
const TILE_URL_TEMPLATE = "/tiles/{z}/{x}/{y}.geojson.gz";
const TILE_MIN_Z = 5;
const TILE_MAX_Z = 12;

// cache of active tile layers: key = "z/x/y" -> L.GeoJSON layer
const activeTileLayers = new Map();

// Reuse one canvas renderer for ALL point layers (avoid per-tile renderer allocations)
const pointRenderer = L.canvas({ padding: 0.5 });

// Abort in-flight requests when tiles become irrelevant
const tileRequests = new Map(); // key -> AbortController

// Debounce helper (reduces tile-load storms)
function debounce(fn, ms) {
    let t = null;
    return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), ms);
    };
}



// =====================
// Helpers
// =====================

function getDisplayMode() {
    const el = document.getElementById("display-mode");
    return el ? el.value : "points";
}

function readFilters() {
    const taxonRaw = (document.getElementById("taxon-id-input")?.value || "").trim();
    const taxonId = taxonRaw === "" ? null : Number(taxonRaw);

    const yearFromRaw = (document.getElementById("year-from")?.value || "").trim();
    const yearToRaw   = (document.getElementById("year-to")?.value || "").trim();
    const yearFrom = yearFromRaw === "" ? null : Number(yearFromRaw);
    const yearTo   = yearToRaw === "" ? null : Number(yearToRaw);

    const quality = (document.getElementById("quality-grade")?.value || "").trim() || null;

    const limitRaw = (document.getElementById("max-points")?.value || "").trim();
    const limit = limitRaw === "" ? null : Number(limitRaw);

    return {
        taxonId: Number.isFinite(taxonId) ? taxonId : null,
        yearFrom: Number.isFinite(yearFrom) ? yearFrom : null,
        yearTo: Number.isFinite(yearTo) ? yearTo : null,
        quality,
        limit: Number.isFinite(limit) ? limit : null,
    };
}


function setStatus(message, type = "") {
    const el = document.getElementById("status-message");
    if (!el) return;

    // handle new status pill structure: <span id="status-message"><span class="status-text">...</span></span>
    const textEl = el.querySelector(".status-text");

    if (textEl) {
        textEl.textContent = message || "";
    } else {
        el.textContent = message || "";
    }

    el.classList.remove("error", "success");
    if (type) el.classList.add(type);
}

async function ensureEcosystemsLayer() {
    if (ecosystemsLoaded) return;

    try {
        const resp = await fetch("/api/ecosystems");
        if (!resp.ok) {
            console.warn("Ecosystems endpoint not available:", resp.status);
            ecosystemsLoaded = true; // avoid hammering the server
            return;
        }

        const geojson = await resp.json();

        ecosystemsLayer = L.geoJSON(geojson, {
            style: () => ({
                weight: 1,
                fillOpacity: 0.25,
            }),
            onEachFeature: (feat, layer) => {
                const p = feat.properties || {};
                // properties naming differs depending on your pipeline — we keep it robust
                const clusterId = p.cluster_id ?? p.cluster ?? p.id ?? "—";
                const count = p.count ?? p.n ?? p.observations ?? "—";

                layer.bindPopup(
                    `<b>Écosystème</b><br>` +
                    `Cluster: ${clusterId}<br>` +
                    `Observations: ${count}`
                );
            },
        });

        ecosystemsLoaded = true;
    } catch (e) {
        console.error(e);
        ecosystemsLoaded = true;
    }
}

async function applyDisplayMode(mode) {
    if (!mapInstance) return;

    // Remove ecosystems overlay if present (we may re-add it)
    if (ecosystemsLayer && mapInstance.hasLayer(ecosystemsLayer)) {
        mapInstance.removeLayer(ecosystemsLayer);
    }

    if (mode === "points") {
        // show only points tiles
        clearAllTiles();
        updateTiles();
        return;
    }

    if (mode === "ecosystems") {
        // show only ecosystems polygons
        clearAllTiles();
        await ensureEcosystemsLayer();
        if (ecosystemsLayer) ecosystemsLayer.addTo(mapInstance);
        return;
    }

    // both
    clearAllTiles();
    updateTiles();
    await ensureEcosystemsLayer();
    if (ecosystemsLayer) ecosystemsLayer.addTo(mapInstance);
}

function extractXY(data, xKey, yKey) {
  if (!data) return { x: [], y: [] };

  if (Array.isArray(data)) {
    return {
      x: data.map((row) => row[xKey]),
      y: data.map((row) => row[yKey]),
    };
  }

  if (data[xKey] && data[yKey]) {
    return { x: data[xKey], y: data[yKey] };
  }

  console.warn("Unexpected data format:", data);
  return { x: [], y: [] };
}

async function fetchJson(url) {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} on ${url}`);
  }
  return resp.json();
}


// =====================
// Plotly charts
// =====================

function renderAnnualChart(data, taxonId) {
  const { x, y } = extractXY(data, "year", "count");

  const trace = {
    x,
    y,
    mode: "lines+markers",
    line: { shape: "linear" },
    marker: { size: 6 },
    hovertemplate: "Année %{x}<br>Observations %{y}<extra></extra>",
  };

  const title =
      x.length === 0
          ? "Aucune donnée"
          : taxonId
              ? `Évolution annuelle – taxon ${taxonId}`
              : "Évolution annuelle – toutes espèces";

  const layout = {
    title: { text: title, font: { size: 14 } },
    margin: { l: 40, r: 10, t: 30, b: 40 },
    xaxis: { title: "Année" },
    yaxis: { title: "Nombre d'observations" },
  };

  Plotly.newPlot("annual-chart", [trace], layout, {
    displaylogo: false,
    responsive: true,
  });
}

function renderSeasonalChart(data, taxonId) {
  const { x, y } = extractXY(data, "month", "count");

  const trace = {
    x,
    y,
    type: "bar",
    hovertemplate: "Mois %{x}<br>Observations %{y}<extra></extra>",
  };

  const title =
      x.length === 0
          ? "Aucune donnée"
          : taxonId
              ? `Évolution saisonnière – taxon ${taxonId}`
              : "Évolution saisonnière – toutes espèces";

  const layout = {
    title: { text: title, font: { size: 14 } },
    margin: { l: 40, r: 10, t: 30, b: 40 },
    xaxis: { title: "Mois", tickmode: "linear", dtick: 1 },
    yaxis: { title: "Nombre d'observations" },
  };

  Plotly.newPlot("seasonal-chart", [trace], layout, {
    displaylogo: false,
    responsive: true,
  });
}


// =====================
// Trends loading
// =====================

async function loadTrends() {
  const input = document.getElementById("taxon-id-input");
  const raw = (input.value || "").trim();
  const taxonId = raw === "" ? null : raw;

  try {
    setStatus("Chargement des tendances…", "");
    const qs = taxonId ? `?taxon_id=${encodeURIComponent(taxonId)}` : "";

    const [annual, seasonal] = await Promise.all([
      fetchJson(`/api/trends/annual${qs}`),
      fetchJson(`/api/trends/seasonal${qs}`),
    ]);

    renderAnnualChart(annual, taxonId);
    renderSeasonalChart(seasonal, taxonId);

    // update taxon filter for tiles
    if (taxonId === null) {
      currentTaxonFilter = null;
    } else {
      const n = Number(taxonId);
      currentTaxonFilter = Number.isFinite(n) ? n : null;
    }


      // Only refresh point tiles if they are part of the active display mode
      const mode = getDisplayMode();
      if (mode === "points" || mode === "both") {
          clearAllTiles();
          updateTiles();
      }


      setStatus("OK", "success");
  } catch (err) {
    console.error(err);
    setStatus("Erreur lors du chargement des tendances", "error");
  }
}


// =====================
// Tile helpers (based on your viewer.html)
// =====================

function zxyKey(z, x, y) {
  return `${z}/${x}/${y}`;
}

// lon/lat -> tile x,y
function lonLatToTile(lon, lat, z) {
  lat = Math.max(Math.min(lat, 85.05112878), -85.05112878);
  const x = Math.floor((lon + 180.0) / 360.0 * Math.pow(2, z));
  const s = Math.sin((lat * Math.PI) / 180.0);
  const y = Math.floor(
      (1.0 - Math.log((1.0 + s) / (1.0 - s)) / Math.PI) / 2.0 * Math.pow(2, z)
  );
  return [x, y];
}

function visibleTiles(z) {
  const b = mapInstance.getBounds();
  const sw = b.getSouthWest();
  const ne = b.getNorthEast();

  const [xMin0, yMax0] = lonLatToTile(sw.lng, sw.lat, z);
  const [xMax0, yMin0] = lonLatToTile(ne.lng, ne.lat, z);

  const xMin = Math.min(xMin0, xMax0);
  const xMax = Math.max(xMin0, xMax0);
  const yMin = Math.min(yMin0, yMax0);
  const yMax = Math.max(yMin0, yMax0);

  const tiles = [];
  for (let x = xMin; x <= xMax; x++) {
    for (let y = yMin; y <= yMax; y++) {
      tiles.push([z, x, y]);
    }
  }
  return tiles;
}

function clearAllTiles() {
    // remove layers
    for (const [, layer] of activeTileLayers.entries()) {
        mapInstance.removeLayer(layer);
    }
    activeTileLayers.clear();

    // abort in-flight requests
    for (const [, controller] of tileRequests.entries()) {
        controller.abort();
    }
    tileRequests.clear();
}


function unloadTilesNotVisible(visibleSet) {
    for (const [key, layer] of activeTileLayers.entries()) {
        if (!visibleSet.has(key)) {
            mapInstance.removeLayer(layer);
            activeTileLayers.delete(key);
        }
    }

    // Abort downloads for tiles that are no longer needed
    for (const [key, controller] of tileRequests.entries()) {
        if (!visibleSet.has(key)) {
            controller.abort();
            tileRequests.delete(key);
        }
    }
}


async function loadTile(z, x, y) {
    const key = zxyKey(z, x, y);
    if (activeTileLayers.has(key)) return;
    if (tileRequests.has(key)) return; // already fetching

    const url = TILE_URL_TEMPLATE
        .replace("{z}", z)
        .replace("{x}", x)
        .replace("{y}", y);

    const controller = new AbortController();
    tileRequests.set(key, controller);

    try {
        const resp = await fetch(url, { signal: controller.signal });
        if (!resp.ok) return; // tile not present
        const buf = await resp.arrayBuffer();

        // If aborted after download, stop
        if (controller.signal.aborted) return;

        const ungz = pako.ungzip(new Uint8Array(buf), { to: "string" });
        const gj = JSON.parse(ungz);

        // optional filter by taxon_id at load time
        let geojson = gj;
        if (currentTaxonFilter !== null) {
            const n = Number(currentTaxonFilter);
            if (Number.isFinite(n)) {
                const feats = (gj.features || []).filter((f) => {
                    const t = Number(f?.properties?.taxon_id);
                    return Number.isFinite(t) && t === n;
                });
                geojson = { type: "FeatureCollection", features: feats };
            }
        }

        // Create Leaflet layer (points only, non-interactive) using a SHARED renderer
        const layer = L.geoJSON(geojson, {
            interactive: false,
            pointToLayer: (_feat, latlng) =>
                L.circleMarker(latlng, {
                    renderer: pointRenderer,
                    radius: 2.0,      // slightly smaller = faster
                    weight: 0,
                    fillOpacity: 0.65,
                }),
        }).addTo(mapInstance);

        activeTileLayers.set(key, layer);
    } catch (e) {
        if (e.name !== "AbortError") {
            // keep quiet in production; log if you want
            // console.error(e);
        }
    } finally {
        tileRequests.delete(key);
    }
}



function updateTiles() {
  if (!mapInstance) return;

  let z = mapInstance.getZoom();
  z = Math.max(TILE_MIN_Z, Math.min(TILE_MAX_Z, Math.round(z)));

  const tiles = visibleTiles(z);
  const visibleSet = new Set(tiles.map(([zz, xx, yy]) => zxyKey(zz, xx, yy)));

  unloadTilesNotVisible(visibleSet);
  tiles.forEach(([zz, xx, yy]) => loadTile(zz, xx, yy));
}

const updateTilesDebounced = debounce(updateTiles, 120);



// =====================
// Map init
// =====================

function initMap() {
  mapInstance = L.map("map", {
    zoomControl: true,
    preferCanvas: true, // important for performance
    minZoom: TILE_MIN_Z,
    maxZoom: TILE_MAX_Z,
  });

  mapInstance.setView([46.8, 8.3], 7);

  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap",
  }).addTo(mapInstance);

    mapInstance.on("moveend zoomend", updateTilesDebounced);
  updateTiles();

  return mapInstance;
}


// =====================
// Boot
// =====================

document.addEventListener("DOMContentLoaded", () => {
  initMap();

    const displaySelect = document.getElementById("display-mode");
    if (displaySelect) {
        displaySelect.addEventListener("change", () => {
            applyDisplayMode(displaySelect.value);
        });

        // apply initial mode
        applyDisplayMode(displaySelect.value);
    }

  const btn = document.getElementById("load-trends-btn");
  if (btn) {
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      loadTrends();
    });
  }

  // initial load: all species trends + tiles
  loadTrends();
});
