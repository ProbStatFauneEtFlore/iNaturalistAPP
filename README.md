# 🌿 iNaturalistAPP – Fauna & Flora Explorer (Switzerland)

An interactive web application for exploring **iNaturalist biodiversity observations in Switzerland**, with a strong focus on **spatial analysis**, **performance**, and **scientific usability**.

The project combines a **Julia backend** (Genie + DataFrames) with a **Leaflet-based frontend** to visualize millions of observations through **tiles, grids, and ecosystem clusters**.

---

## ✨ Key Features

### 🗺️ Interactive Map

* **Multiple display modes**

  * **Points**: raw observations via vector tiles
  * **Grid**: spatial aggregation (density / intensity)
  * **Ecosystems**: clustered ecological regions
  * **Both**: combined visualization
* Smooth navigation with **bbox-based queries**
* Optimized rendering using **Canvas layers**

### 📊 Analytics & Trends

* Annual observation trends
* Seasonal (monthly) distributions
* Live **summary statistics** for the visible map area:

  * Observations count
  * Unique taxa
  * Clusters
  * Elevation min / mean / max

### ⚡ Performance-Oriented Design

* Server-side **vector tiling**
* Client-side **lazy loading**
* Strict **bbox enforcement** (no full-table scans)
* Abortable requests to prevent UI overload

---

## 🧱 Architecture Overview

```
┌────────────┐     HTTP / JSON     ┌──────────────┐
│  Frontend  │  ─────────────────▶│   Julia API  │
│  Leaflet   │                    │  (Genie.jl)  │
└────────────┘◀───────────────────└──────────────┘
        ▲            GeoJSON / CSV / GZip
        │
  Vector Tiles
```

### Backend (Julia)

* **Framework**: Genie.jl
* **Data**: CSV / GeoJSON (Git LFS)
* **Processing**:

  * Spatial filtering (bbox)
  * Aggregation (grid, summary)
  * Precomputed clusters (ecosystems)
* **Philosophy**:

  * Backend is now **API-contract stable**
  * No frontend-driven schema changes

### Frontend (HTML + JS)

* **Leaflet** for mapping
* **Plotly** for charts
* **Pako** for gzip decoding
* Single-page application (no framework)
* Explicit layer management (points / grid / ecosystems)

---

## 📁 Project Structure

```
iNaturalistAPP/
├── data/
│   ├── observations_swiss.csv
│   └── clusters/
│       └── clusters-YYYY_MM_DD-HH_MM/
│           ├── *.csv
│           └── *.geojson
│
├── tiles/
│   └── {z}/{x}/{y}.geojson.gz
│
├── src/
│   ├── RoutesApi.jl        # API endpoints
│   ├── RoutesStatic.jl     # Static assets
│   └── iNaturalistAPP.jl
│
├── static/
│   ├── js/app.js           # Map logic
│   └── css/style.css
│
├── run.jl                  # Entry point
└── README.md
```

---

## 🔌 API Contract (Stable)

The backend API is **contractual**:
Frontend development assumes these endpoints will **not change**.

### Core Endpoints

| Endpoint                        | Description                              |
| ------------------------------- | ---------------------------------------- |
| `/api/grid`                     | Spatial aggregation grid (bbox required) |
| `/api/summary`                  | Metrics for current viewport             |
| `/api/ecosystems`               | Clustered ecological regions             |
| `/api/trends/annual`            | Observations per year                    |
| `/api/trends/seasonal`          | Observations per month                   |
| `/tiles/{z}/{x}/{y}.geojson.gz` | Vector tiles for raw points              |

All spatial endpoints **require a `bbox`** parameter:

```
lon_min,lat_min,lon_max,lat_max
```

---

## 🧠 Design Principles

* **Spatial-first**: everything is bbox-driven
* **Scalable**: works with millions of points
* **Deterministic frontend**: no hidden state
* **Clear separation**:

  * Backend = data + logic
  * Frontend = visualization only

---

## 🚀 Running the Project

### Requirements

* Julia ≥ 1.10
* Git LFS (for large datasets)

### Start the server

```bash
julia run.jl
```

Then open:

```
http://127.0.0.1:8000
```

---

## 📌 Current Status

* ✅ Backend API finalized
* ✅ Map features implemented and stable
* ✅ Performance validated
* ⏸️ Feature development paused at mapping layer
* 🔜 Future work may include:

  * Advanced filters
  * Export tools
  * Comparative species analysis

