# 🌿 iNaturalistAPP – Swiss Biodiversity Analysis

*Interactive Web App for Visualizing iNaturalist Data*

## 📌 Overview

**iNaturalistAPP** is a Julia-based web application built with **Genie.jl** to explore, visualize and analyze biodiversity observations in Switzerland.
It loads a preprocessed dataset (`observations_swiss.csv`) and exposes:

* A **web UI** (index.html + JS/Leaflet map)
* A **REST API** for querying species, trends, and filtered observations
* A **tile server** for fast local map rendering
* Tools for temporal and spatial data analysis

This project was created as part of the **Probabilités & Statistiques** course at HES-SO Valais-Wallis (Travelletti, Desmons, 2025–2026) and contributes to the work described in the *Cahier des charges* .

---

## 📁 Project Structure

```
iNaturalistAPP/
│
├── src/
│   ├── iNaturalistAPP.jl         # main module (server bootstrap)
│   ├── Util.jl                   # JSON response + MIME helpers
│   ├── Data.jl                   # dataset loading + preprocessing
│   ├── RoutesStatic.jl           # serves HTML/CSS/JS + tiles
│   └── RoutesApi.jl              # API endpoints (species, trends, obs)
│
├── public/
│   ├── index.html                # UI map & controls
│   ├── css/style.css
│   └── js/app.js
│
├── data/
│   └── observations_swiss.csv    # main dataset
│
└── run.jl                        # simple launcher: `julia run.jl`
```

---

## 🔧 How the App Works

### **1. Data Loading**

The dataset is loaded at startup inside `Data.jl` :

* Reads `observations_swiss.csv`
* Extracts year + month
* Ensures mandatory fields (`taxon_id`, `observed_on`)
* Exposes a global DataFrame: `OBS`

### **2. Static Routes**

`RoutesStatic.jl` serves all UI files (HTML/CSS/JS) and tile maps. 
Example:

```julia
route("/") do
    serve_file("public/index.html", "text/html")
end
```

### **3. REST API**

Defined in `RoutesApi.jl` 
Endpoints:

| Endpoint               | Description                                                      |
| ---------------------- | ---------------------------------------------------------------- |
| `/api/species`         | List species and observation counts                              |
| `/api/trends/annual`   | Observations grouped by year (optionally by taxon)               |
| `/api/trends/seasonal` | Observations grouped by month                                    |
| `/api/observations`    | Map-ready filtered observations (bbox, year range, taxon, limit) |

All endpoints return JSON using the helper in `Util.jl` .

### **4. Server Bootstrap**

The `start()` function in `iNaturalistAPP.jl` launches Genie.jl and registers all routes. 

---

# 🚀 Installation & Run Guide

## ✅ Prerequisites

* **Julia 1.10+**
* Internet (only for initial package install)
* CSV dataset placed in `data/observations_swiss.csv`

---

## 📥 1. Clone the Repository

```bash
git clone https://github.com/<your-user>/iNaturalistAPP.git
cd iNaturalistAPP
```

---

## 📦 2. Install Dependencies

Open Julia inside the project:

```bash
julia --project=.
```

In the Julia REPL:

```julia
using Pkg
Pkg.instantiate()
```

This installs:

* **Genie.jl**
* **DataFrames**
* **CSV**
* **HTTP**
* and all other required packages.

---

## ▶️ 3. Run the Server

From the project root:

```bash
julia run.jl
```

or manually:

```julia
julia --project=.
julia> using iNaturalistAPP
julia> iNaturalistAPP.start()
```

---

## 🌐 4. Access the App

Open:

```
http://localhost:8000
```

You will see:

* An interactive **Leaflet map**
* Species filters
* Year sliders
* Live API-powered data visualizations

---

# 🧪 API Usage Examples

### 🔍 Get species ranking

```
GET /api/species
```

### 📈 Annual trend for taxon ID 47291

```
GET /api/trends/annual?taxon_id=47291
```

### 🗺️ Observations inside a bounding box

```
GET /api/observations?bbox=6.9,46.1,7.2,46.4&limit=500
```

---

# 👨‍💻 Author – Your Contribution

According to the project specification  you were responsible for:

### **Sebastian Morsch — Visualisation & UI**

* Designing interactive maps (Leaflet)
* Building the front-end (`index.html`, `app.js`)
* Creating visual analytics (temporal, spatial)
* Integrating the REST API with the frontend
* Data representation and performance optimization

In this Julia backend:

* Implemented clean reusable API structures
* Added filtering (bbox, year, taxon, limits)
* Built a fully functional local tile server
* Ensured fast JSON responses for large datasets
* Implemented modern frontend → backend data flow

---

# 📜 License

MIT License
Just tell me!
