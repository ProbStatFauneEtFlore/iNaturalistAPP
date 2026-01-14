# iNaturalistAPP API Contract

## Principles

1. **Stability**: Field names and response formats defined here are treated as stable. Any breaking change requires a version bump or explicit migration note.
2. **Arrays by default**: All endpoints return JSON arrays **except** `/api/ecosystems`, which returns a GeoJSON FeatureCollection object for Leaflet compatibility.
3. **Filtering model**: A shared set of query parameters is supported across endpoints (when applicable).
4. **Empty results**: If nothing matches, endpoints return `[]` (or an empty `FeatureCollection` for ecosystems).
5. **Missing data**: Rows with missing core fields may be skipped by endpoints that require them (notably grid aggregation).

---

## Shared filter parameters (where applicable)

| Parameter       |            Type | Example                  | Meaning                                 |
| --------------- | --------------: | ------------------------ | --------------------------------------- |
| `taxon_id`      |             int | `taxon_id=123`           | Filter by taxon id                      |
| `year_from`     |             int | `year_from=2018`         | Minimum year (inclusive)                |
| `year_to`       |             int | `year_to=2024`           | Maximum year (inclusive)                |
| `month`         | int or repeated | `month=6&month=7`        | Month filter (1–12), can repeat         |
| `quality_grade` |          string | `quality_grade=research` | One of `research`, `needs_id`, `casual` |
| `elevation_min` |           float | `elevation_min=800`      | Minimum elevation (meters)              |
| `elevation_max` |           float | `elevation_max=2000`     | Maximum elevation (meters)              |
| `bbox`          |          string | `bbox=6.9,46.2,7.2,46.5` | `lon1,lat1,lon2,lat2` viewport filter   |
| `limit`         |             int | `limit=50000`            | Max rows returned (server-capped)       |
| `sample`        |          string | `sample=random`          | Optional sampling mode                  |

**bbox format**: `lon_min,lat_min,lon_max,lat_max` (order can be reversed; server normalizes).

---

## Endpoints

### 1) List species counts

**GET** `/api/species`

**Purpose**: Returns taxon IDs and their global observation counts.

**Query parameters**: none

**Response** (array):

```json
[
  { "taxon_id": 123, "count": 4567 },
  { "taxon_id": 456, "count": 3210 }
]
```

**Guarantees**

* Sorted by `count` descending (current behavior).

---

### 2) Annual trends

**GET** `/api/trends/annual`

**Purpose**: Time series of observation counts per year.

**Query parameters**

| name       | required | type | notes                   |
| ---------- | -------- | ---: | ----------------------- |
| `taxon_id` | no       |  int | If omitted/0 → all taxa |

**Response** (array):

```json
[
  { "year": 2018, "count": 1200 },
  { "year": 2019, "count": 1400 }
]
```

**Guarantees**

* Sorted by `year` ascending.

---

### 3) Seasonal trends

**GET** `/api/trends/seasonal`

**Purpose**: Monthly distribution of observation counts.

**Query parameters**

| name       | required | type | notes                   |
| ---------- | -------- | ---: | ----------------------- |
| `taxon_id` | no       |  int | If omitted/0 → all taxa |

**Response** (array):

```json
[
  { "month": 1, "count": 120 },
  { "month": 2, "count": 180 }
]
```

**Guarantees**

* Sorted by `month` ascending.
* Month is 1–12.

---

### 4) Observations (raw points)

**GET** `/api/observations`

**Purpose**: Returns filtered observation points for map rendering and analysis.

**Query parameters**

* Supports shared filter parameters.
* `limit` default: `100000` (server-capped to `100000`)

**Response** (array):

```json
[
  {
    "lat": 46.82,
    "lon": 8.31,
    "taxon_id": 123,
    "year": 2021,
    "month": 7,
    "quality_grade": "research",
    "cluster_id": 42,
    "elevation_m": 1320.0
  }
]
```

**Guarantees**

* Always returns an array.
* Points are filtered by bbox when provided.
* If `sample=random` is used, result is a random subset up to `limit`.

---

### 5) Summary statistics (viewport / filtered)

**GET** `/api/summary`

**Purpose**: Lightweight metrics for current filters/viewport.

**Query parameters**

* Supports shared filter parameters.

**Response** (array of metric objects):

```json
[
  { "metric": "observations", "value": 40231 },
  { "metric": "unique_taxa", "value": 918 },
  { "metric": "clusters", "value": 120 },
  { "metric": "elevation_min", "value": 380.0 },
  { "metric": "elevation_mean", "value": 1240.5 },
  { "metric": "elevation_max", "value": 3120.0 }
]
```

**Guarantees**

* Always returns an array.
* When no rows match, returns at minimum:

    * `observations`, `unique_taxa`, `clusters` (values may be `0`)
* Elevation metrics are included only when elevation data exists and filtered set is non-empty.

---

### 6) Grid aggregation (density / heatmap foundation)

**GET** `/api/grid`

**Purpose**: Aggregates observations into Web Mercator grid cells for density rendering.

**Query parameters**

| name           | required |    type | default | notes                      |
| -------------- | -------- | ------: | ------: | -------------------------- |
| `bbox`         | yes      |  string |       — | Required viewport          |
| `z`            | no       |     int |       7 | Clamped to `[4..12]`       |
| Shared filters | no       | various |       — | Applied before aggregation |

**Response** (array):

```json
[
  {
    "x": 8123,
    "y": 5402,
    "count": 412,
    "unique_taxa": 37,
    "elev_mean": 1342.6
  }
]
```

**Guarantees**

* Always returns an array.
* Each entry represents one grid cell `(x,y)` at zoom `z`.
* Rows with missing required fields (lat/lon/taxon/elevation) may be skipped.
* Intended for fast rendering (grid/heatmap overlays).

---

### 7) Ecosystems polygons (GeoJSON)

**GET** `/api/ecosystems`

**Purpose**: Returns ecosystem polygons for display (cluster outputs), optionally filtered to viewport.

**Query parameters**

| name   | required |   type | notes                                                     |
| ------ | -------- | -----: | --------------------------------------------------------- |
| `run`  | no       | string | Cluster run folder name, e.g. `clusters-YYYY_MM_DD-HH_MM` |
| `bbox` | no       | string | Viewport filter; returns only intersecting features       |

**Response** (GeoJSON FeatureCollection object):

```json
{
  "type": "FeatureCollection",
  "features": [
    { "type": "Feature", "properties": { "...": "..." }, "geometry": { "...": "..." } }
  ]
}
```

**Guarantees**

* Returns GeoJSON in EPSG:4326 when available.
* With `bbox`, returned features are filtered by **feature bounding-box intersection** (fast).
* If no features match, returns:

```json
{ "type": "FeatureCollection", "features": [] }
```

---

### 8) List cluster runs

**GET** `/api/runs`

**Purpose**: Lists available clustering run directories.

**Query parameters**: none

**Response** (array):

```json
[
  { "run": "clusters-2025_12_01-16_15" },
  { "run": "clusters-2025_12_01-16_47" }
]
```

---

### 9) Latest cluster run

**GET** `/api/runs/latest`

**Purpose**: Returns the most recent run (lexicographic timestamp ordering).

**Response** (array):

```json
[
  { "run": "clusters-2025_12_01-16_47" }
]
```

**Guarantees**

* If no runs exist, returns `[]`.

---

## Error handling contract (current behavior)

* If a required parameter is missing (e.g. `/api/grid` without `bbox`), the API may return an HTTP 400 with a plain text message.
* If a run or GeoJSON is not found, `/api/ecosystems` may return HTTP 404 with a plain text message.

---

## Compatibility notes for frontend

* Prefer `bbox` filtering for `/api/ecosystems`, `/api/observations`, `/api/grid`, `/api/summary` to keep payloads and memory usage low.
* Use `/api/grid` for heatmaps/density; use `/api/observations` for point-level inspection only.

