// =====================
// Globals
// =====================

let mapInstance = null;
let currentTaxonFilter = null; // number or null
let clusterGroup = null;

// Tile config (matches your Python tiler)
const TILE_URL_TEMPLATE = "/tiles/{z}/{x}/{y}.geojson.gz";
const TILE_MIN_Z = 5;
const TILE_MAX_Z = 12;

// cache of active tile layers: key = "z/x/y" -> L.GeoJSON layer
const activeTileLayers = new Map();


// =====================
// Helpers
// =====================

function setStatus(message, type = "") {
  const el = document.getElementById("status-message");
  if (!el) return;
  el.textContent = message || "";
  el.classList.remove("error", "success");
  if (type) el.classList.add(type);
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

    // reset tiles when filter changes
    clearAllTiles();
    updateTiles();

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
  for (const [, layer] of activeTileLayers.entries()) {
    if (clusterGroup) {
      clusterGroup.removeLayer(layer);
    } else if (mapInstance) {
      mapInstance.removeLayer(layer);
    }
  }
  activeTileLayers.clear();
}


function unloadTilesNotVisible(visibleSet) {
  for (const [key, layer] of activeTileLayers.entries()) {
    if (!visibleSet.has(key)) {
      if (clusterGroup) {
        clusterGroup.removeLayer(layer);
      } else if (mapInstance) {
        mapInstance.removeLayer(layer);
      }
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

  try {
    const resp = await fetch(url);
    if (!resp.ok) return; // tile not present
    const buf = await resp.arrayBuffer();
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

    // create a GeoJSON layer for this tile
    const layer = L.geoJSON(geojson, {
      pointToLayer: (feat, latlng) => {
        return L.circleMarker(latlng, {
          radius: 3,
          weight: 0,
          fillOpacity: 0.7,
        });
      },
      onEachFeature: (feat, layer) => {
        const p = feat.properties || {};
        const taxon = p.taxon_id ?? "—";
        const link =
            taxon && taxon !== "—"
                ? `<br><a href="https://www.inaturalist.org/taxa/${taxon}" target="_blank" rel="noopener">View on iNaturalist</a>`
                : "";

        layer.bindPopup(
            `<b>Observation:</b> ${p.observation_uuid || "—"}<br>` +
            `Taxon ID: ${taxon || "—"}${link}<br>` +
            `Quality: ${p.quality_grade || "—"}<br>` +
            `Observed on: ${p.observed_on || "—"}<br>` +
            `Observer ID: ${p.observer_id || "—"}<br>` +
            `Positional accuracy: ${p.positional_accuracy || "—"} m`
        );

        layer.bindTooltip(
            `Taxon ${taxon} • ${p.quality_grade || "—"}`
        );
      },
    });

// instead of adding directly to map, add to the global cluster group
    if (clusterGroup) {
      clusterGroup.addLayer(layer);
    } else {
      // fallback, shouldn't really happen
      layer.addTo(mapInstance);
    }

// remember tile -> layer mapping so we can remove later
    activeTileLayers.set(key, layer);

  } catch (_e) {
    // ignore broken tiles for now
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

  // --- create global MarkerCluster group ---
  clusterGroup = L.markerClusterGroup({
    maxClusterRadius: 40,          // how "tight" clusters are
    disableClusteringAtZoom: 11,   // at high zoom show individual points
    spiderfyOnEveryZoom: false,
    showCoverageOnHover: false,
  });
  mapInstance.addLayer(clusterGroup);
  // -----------------------------------------

  mapInstance.on("moveend zoomend", updateTiles);
  updateTiles();

  return mapInstance;
}



// =====================
// Boot
// =====================

document.addEventListener("DOMContentLoaded", () => {
  initMap();

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
