// =====================
// Globals
// =====================

let mapInstance = null;
let currentTaxonFilter = null; // number or null
let ecosystemsLayer = null;

let gridLayer = null;
let gridData = [];
let gridInFlight = null; // AbortController
let ecosystemsInFlight = null; // AbortController

let pointsGroup = null;
let tilesInFlight = null; // AbortController
let tilesEpoch = 0;        // increments when we "invalidate" pending loads



// Default UI state
const state = {
    view: {
        mode: "grid", // "points" | "grid" | "ecosystems" | "both"
        zGrid: 7
    },
    filters: {
        taxon_id: null,
        year_from: null,
        year_to: null,
        month: [], // array of ints
        quality_grade: null,
        elevation_min: null,
        elevation_max: null,
        sample: null,
        limit: 100000
    },
    viewport: {
        bbox: null
    },
    run: {
        ecosystems: null // optional: pass run=... later, else latest
    }
};


// =====================
// Tile config (points)
// =====================

// matches your Python tiler
const TILE_URL_TEMPLATE = "/tiles/{z}/{x}/{y}.geojson.gz";
const TILE_MIN_Z = 5;
const TILE_MAX_Z = 12;

// cache of active tile layers: key = "z/x/y" -> L.GeoJSON layer
const activeTileLayers = new Map();


// =====================
// Helpers
// =====================


function ensurePointsGroup() {
    if (pointsGroup) return pointsGroup;
    pointsGroup = L.layerGroup();
    return pointsGroup;
}

function clearAllPoints() {
    // Abort any pending tile downloads
    if (tilesInFlight) tilesInFlight.abort();
    tilesInFlight = null;

    // Invalidate any loads that might still resolve
    tilesEpoch++;

    // Remove layers we know about
    activeTileLayers.forEach((layer) => {
        pointsGroup?.removeLayer(layer);
    });
    activeTileLayers.clear();

    // Hard clear anything currently in the group
    if (pointsGroup) pointsGroup.clearLayers();

    // Remove group from map
    if (mapInstance && pointsGroup && mapInstance.hasLayer(pointsGroup)) {
        mapInstance.removeLayer(pointsGroup);
    }
}

function getDisplayMode() {
    const el = document.getElementById("display-mode");
    const v = el ? (el.value || "").trim() : "";
    return v || state.view.mode || "grid";
}

function setStatus(message, type = "") {
    const el = document.getElementById("status-message");
    if (!el) return;

    const textEl = el.querySelector(".status-text");
    if (textEl) textEl.textContent = message || "";
    else el.textContent = message || "";

    el.classList.remove("error", "success");
    if (type) el.classList.add(type);
}



function buildQuery(paramsObj) {
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(paramsObj || {})) {
        if (v === null || v === undefined) continue;

        if (Array.isArray(v)) {
            if (v.length === 0) continue;
            for (const item of v) usp.append(k, String(item));
            continue;
        }
        usp.set(k, String(v));
    }
    const s = usp.toString();
    return s ? `?${s}` : "";
}

function commonFilterParams() {
    const f = state.filters;
    return {
        taxon_id: f.taxon_id,
        year_from: f.year_from,
        year_to: f.year_to,
        month: f.month,
        quality_grade: f.quality_grade,
        elevation_min: f.elevation_min,
        elevation_max: f.elevation_max,
        sample: f.sample,
        limit: f.limit
    };
}



// =====================
// Plotly charts (unchanged)
// =====================

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




function getBboxStringFromMap(map) {
    const b = map.getBounds();
    const sw = b.getSouthWest();
    const ne = b.getNorthEast();
    // backend expects lon1,lat1,lon2,lat2
    return `${sw.lng},${sw.lat},${ne.lng},${ne.lat}`;
}

function debounce(fn, wait) {
    let t = null;
    return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), wait);
    };
}

async function fetchJson(url, opts = {}) {
    const resp = await fetch(url, opts);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} on ${url}`);
    return resp.json();
}


// =====================
// Trends loading
// =====================

async function loadTrends() {
    const input = document.getElementById("taxon-id-input");
    const raw = input ? (input.value || "").trim() : "";
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

        // update taxon filter for both grid + points tiles
        if (taxonId === null) {
            currentTaxonFilter = null;
            state.filters.taxon_id = null;
        } else {
            const n = Number(taxonId);
            currentTaxonFilter = Number.isFinite(n) ? n : null;
            state.filters.taxon_id = Number.isFinite(n) ? n : null;
        }

        // refresh only what current mode needs
        refreshActiveLayers();

        setStatus("OK", "success");
    } catch (err) {
        console.error(err);
        setStatus("Erreur lors du chargement des tendances", "error");
    }
    refreshSummaryDebounced();
}


// =====================
// Points tiles helpers
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

    const n = Math.pow(2, z);
    const clamp = (v) => Math.max(0, Math.min(n - 1, v));

    const xMin = clamp(Math.min(xMin0, xMax0));
    const xMax = clamp(Math.max(xMin0, xMax0));
    const yMin = clamp(Math.min(yMin0, yMax0));
    const yMax = clamp(Math.max(yMin0, yMax0));

    const tiles = [];
    for (let x = xMin; x <= xMax; x++) {
        for (let y = yMin; y <= yMax; y++) {
            tiles.push([z, x, y]);
        }
    }
    return tiles;
}


function unloadTilesNotVisible(visibleSet) {
    for (const [key, layer] of activeTileLayers.entries()) {
        if (!visibleSet.has(key)) {
            mapInstance.removeLayer(layer);
            activeTileLayers.delete(key);
        }
    }
}

async function loadTile(z, x, y) {
    const key = zxyKey(z, x, y);
    if (activeTileLayers.has(key)) return;

    const url = TILE_URL_TEMPLATE
        .replace("{z}", z)
        .replace("{x}", x)
        .replace("{y}", y);

    // Ensure a controller exists for this batch
    if (!tilesInFlight) tilesInFlight = new AbortController();
    try {
        const resp = await fetch(url, { signal: tilesInFlight.signal });
        if (!resp.ok) return;

        // If user switched mode while we were loading, ignore
        if (tilesEpoch !== tilesEpoch) return;

        const buf = await resp.arrayBuffer();
        const ungz = pako.ungzip(new Uint8Array(buf), { to: "string" });
        const gj = JSON.parse(ungz);

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
        L.canvas({ padding: 0.5 });
        const layer = L.geoJSON(geojson, {
            interactive: false,
        });

        // Add to pointsGroup (NOT directly to map)
        ensurePointsGroup().addLayer(layer);

        // If group isn't on the map anymore, remove immediately
        if (!mapInstance.hasLayer(pointsGroup)) {
            pointsGroup.removeLayer(layer);
            return;
        }

        activeTileLayers.set(key, layer);
    } catch (e) {
        if (e?.name === "AbortError") return;
        // ignore broken tiles
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


// =====================
// Grid layer (default mode)
// =====================

function tileToLonLat(x, y, z) {
    const n = Math.pow(2, z);

    // lon is unchanged
    const lon = (x / n) * 360 - 180;

    // Inverse of your CURRENT y formula:
    // y = floor( (1 - ln((1+s)/(1-s)) / PI) / 2 * n )
    // => ln((1+s)/(1-s)) = PI * (1 - 2y/n)
    // => s = tanh( (PI*(1 - 2y/n)) / 2 )
    // => lat = asin(s)
    const t = 1 - (2 * y) / n;
    const s = Math.tanh((Math.PI * t) / 2);
    const lat = (Math.asin(s) * 180) / Math.PI;

    return [lat, lon];
}

function computeGridZ() {
    // Grid should be slightly coarser than point tiles to keep it light
    const z = Math.round(mapInstance.getZoom());
    return Math.max(4, Math.min(12, z)); // clamp
}


function cellBoundsLatLng(x, y, z) {
    const [lat1, lon1] = tileToLonLat(x, y, z);
    const [lat2, lon2] = tileToLonLat(x + 1, y + 1, z);
    return L.latLngBounds([lat1, lon1], [lat2, lon2]);
}


function ensureGridLayer() {
    if (gridLayer) return gridLayer;

    // A simple LayerGroup of rectangles
    gridLayer = L.layerGroup();
    return gridLayer;
}

function gridStyleFromIntensity(t) {
    // t in [0..1]
    const alpha = 0.08 + 0.62 * t;
    return {
        stroke: false,          // IMPORTANT: no outline
        fill: true,
        fillOpacity: 1,
        fillColor: `rgba(79,140,255,${alpha})`,
    };
}

function renderGridCells(cells, z) {
    const layer = ensureGridLayer();
    layer.clearLayers();

    const counts = cells.map(c => Number(c.count) || 0);
    const maxCount = counts.length ? Math.max(...counts) : 1;

    for (const c of cells) {
        const x = Number(c.x);
        const y = Number(c.y);
        const count = Number(c.count) || 0;

        // Compute bounds of the tile/cell (latlng bounds)
        const b = cellBoundsLatLng(x, y, z);

        const intensity = maxCount > 0 ? (count / maxCount) : 0;

        const rect = L.rectangle(b, gridStyleFromIntensity(intensity));
        rect.addTo(layer);

        // Optional: tooltips for sanity check (enable briefly)
        // rect.bindTooltip(`x=${x} y=${y}<br>count=${count}`, { sticky: true });
    }
}



async function fetchGridForViewport() {
    if (!mapInstance) return;

    state.viewport.bbox = getBboxStringFromMap(mapInstance);

    // dynamic grid zoom
    state.view.zGrid = computeGridZ();

    const qs = buildQuery({
        ...commonFilterParams(),
        bbox: state.viewport.bbox,
        z: state.view.zGrid
    });

    if (gridInFlight) gridInFlight.abort();
    gridInFlight = new AbortController();

    return fetchJson(`/api/grid${qs}`, { signal: gridInFlight.signal });
}


const refreshGridDebounced = debounce(async () => {
    try {
        const mode = getDisplayMode();
        if (mode !== "grid" && mode !== "both") return;

        setStatus("Chargement grille…", "");
        const dataRaw = await fetchGridForViewport();

        gridData = Array.isArray(dataRaw)
            ? dataRaw
            : Object.values(dataRaw || {});

        console.log("grid cells:", gridData.length, "sample:", gridData[0]);

        renderGridCells(gridData, state.view.zGrid);

        setStatus("OK", "success");
    } catch (e) {
        if (e?.name === "AbortError") return;
        console.error(e);
        setStatus("Erreur grille", "error");
    }
}, 180);

const refreshSummaryDebounced = debounce(async () => {
    try {
        // Don’t spam summary if the card doesn’t exist in DOM
        if (!document.getElementById("summary-card")) return;

        // Optional: only refresh when grid/ecosystems/points are shown.
        // If you want summary always, remove this block.
        const mode = getDisplayMode();
        const shouldRun = (mode === "grid" || mode === "points" || mode === "ecosystems" || mode === "both");
        if (!shouldRun) return;

        const data = await fetchSummaryForViewport();
        renderSummary(data);
    } catch (e) {
        if (e?.name === "AbortError") return;
        console.error(e);
        // keep old values; do not hard-error the UI
    }
}, 220);


let summaryInFlight = null; // AbortController

function formatNumber(v) {
    if (v === null || v === undefined) return "—";
    const n = Number(v);
    if (!Number.isFinite(n)) return String(v);
    return n.toLocaleString("fr-CH");
}

function formatMeters(v) {
    if (v === null || v === undefined) return "—";
    const n = Number(v);
    if (!Number.isFinite(n)) return "—";
    return `${Math.round(n).toLocaleString("fr-CH")} m`;
}

function setMetric(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

function renderSummary(metricsArray) {
    // metricsArray: [{metric:"observations", value:123}, ...]
    const m = Object.create(null);
    if (Array.isArray(metricsArray)) {
        for (const row of metricsArray) {
            if (!row) continue;
            m[row.metric] = row.value;
        }
    }

    setMetric("m-observations", formatNumber(m.observations));
    setMetric("m-unique_taxa", formatNumber(m.unique_taxa));
    setMetric("m-clusters", formatNumber(m.clusters));

    setMetric("m-elevation_min", formatMeters(m.elevation_min));
    setMetric("m-elevation_mean", formatMeters(m.elevation_mean));
    setMetric("m-elevation_max", formatMeters(m.elevation_max));
}

async function fetchSummaryForViewport() {
    if (!mapInstance) return [];

    // bbox required (per your direction)
    state.viewport.bbox = getBboxStringFromMap(mapInstance);

    const qs = buildQuery({
        ...commonFilterParams(),
        bbox: state.viewport.bbox
    });

    if (summaryInFlight) summaryInFlight.abort();
    summaryInFlight = new AbortController();

    return fetchJson(`/api/summary${qs}`, { signal: summaryInFlight.signal });
}


// =====================
// Ecosystems layer (bbox required on client side)
// =====================

async function ensureEcosystemsLayer() {
    // ecosystemsLayer is GeoJSON layer stored in memory; we refresh its data per bbox
    if (!ecosystemsLayer) {
        ecosystemsLayer = L.geoJSON(null, {
            style: () => ({ weight: 1, fillOpacity: 0.25 }),
            onEachFeature: (feat, layer) => {
                const p = feat.properties || {};
                const clusterId = p.cluster_id ?? p.cluster ?? p.id ?? "—";
                const count = p.count ?? p.n ?? p.observations ?? "—";
                layer.bindPopup(
                    `<b>Écosystème</b><br>` +
                    `Cluster: ${clusterId}<br>` +
                    `Observations: ${count}`
                );
            },
        });
    }
    return ecosystemsLayer;
}

async function fetchEcosystemsForViewport() {
    if (!mapInstance) return;

    // We enforce bbox usage from frontend (even if backend allows full)
    state.viewport.bbox = getBboxStringFromMap(mapInstance);

    const qs = buildQuery({
        bbox: state.viewport.bbox,
        run: state.run.ecosystems // null => omitted => latest
    });

    if (ecosystemsInFlight) ecosystemsInFlight.abort();
    ecosystemsInFlight = new AbortController();

    const url = `/api/ecosystems${qs}`;
    const resp = await fetch(url, { signal: ecosystemsInFlight.signal });
    if (!resp.ok) throw new Error(`ecosystems HTTP ${resp.status}`);
    return resp.json();
}

const refreshEcosystemsDebounced = debounce(async () => {
    try {
        const mode = getDisplayMode();
        if (mode !== "ecosystems" && mode !== "both") return;

        setStatus("Chargement écosystèmes…", "");
        const layer = await ensureEcosystemsLayer();
        const geojson = await fetchEcosystemsForViewport();

        layer.clearLayers();
        layer.addData(geojson);

        setStatus("OK", "success");
    } catch (e) {
        if (e?.name === "AbortError") return;
        console.error(e);
        setStatus("Erreur écosystèmes", "error");
    }
}, 220);


// =====================
// Display mode orchestration
// =====================

function removeLayerSafe(layer) {
    if (layer && mapInstance && mapInstance.hasLayer(layer)) {
        mapInstance.removeLayer(layer);
    }
}

function addLayerSafe(layer) {
    if (layer && mapInstance && !mapInstance.hasLayer(layer)) {
        layer.addTo(mapInstance);
    }
}

function refreshActiveLayers() {
    const mode = getDisplayMode();

    // Update bbox now (used by grid/ecosystems)
    if (mapInstance) state.viewport.bbox = getBboxStringFromMap(mapInstance);

    // Points tiles
    if (mode === "points" || mode === "both") {
        addLayerSafe(ensurePointsGroup());
        updateTiles();
    } else {
        clearAllPoints(); // strong cleanup
    }


    // Grid
    if (mode === "grid" || mode === "both") {
        addLayerSafe(ensureGridLayer());
        refreshGridDebounced();
    } else {
        removeLayerSafe(gridLayer);
    }

    // Ecosystems
    if (mode === "ecosystems" || mode === "both") {
        ensureEcosystemsLayer().then((layer) => {
            addLayerSafe(layer);
            refreshEcosystemsDebounced();
        });
    } else {
        removeLayerSafe(ecosystemsLayer);
    }
}

async function applyDisplayMode(mode) {
    state.view.mode = mode || "grid";
    refreshActiveLayers();
}


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

    // Debounced refreshes for heavy layers
    mapInstance.on("moveend zoomend", () => {
        // always keep viewport bbox in sync
        state.viewport.bbox = getBboxStringFromMap(mapInstance);

        const mode = getDisplayMode();
        if (mode === "points" || mode === "both") updateTiles();
        if (mode === "grid" || mode === "both") refreshGridDebounced();
        if (mode === "ecosystems" || mode === "both") refreshEcosystemsDebounced();

        refreshSummaryDebounced();
    });

    return mapInstance;
}


// =====================
// Boot
// =====================

document.addEventListener("DOMContentLoaded", () => {
    initMap();

    // default mode: grid
    const displaySelect = document.getElementById("display-mode");
    if (displaySelect) {
        if (!displaySelect.value) displaySelect.value = "grid";
        displaySelect.addEventListener("change", () => {
            applyDisplayMode(displaySelect.value);
        });

        applyDisplayMode(displaySelect.value);
    } else {
        applyDisplayMode("grid");
    }

    const btn = document.getElementById("load-trends-btn");
    if (btn) {
        btn.addEventListener("click", (ev) => {
            ev.preventDefault();
            loadTrends();
        });
    }

    // Initial load: trends + refresh layers
    loadTrends();
});
