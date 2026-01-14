module RoutesApi

using Genie, Genie.Router
using Genie.Requests
using DataFrames
using ..Data: OBS
using ..Data: data_path
using ..Util: respond_json
using HTTP
using Dates
using Statistics
using JSON3

# ---------------- Helpers ----------------

function get_int_param(name::AbstractString, default::Int)
    p = params()
    v = get(p, name, "")
    isempty(v) && return default
    try
        parse(Int, v)
    catch
        default
    end
end

function get_string_param(name::AbstractString, default::AbstractString = "")
    get(params(), name, default)
end

export setup_api_routes

function parse_filters(p)
    f = Dict{Symbol,Any}()

    if phaskey(p, "taxon_id")
        f[:taxon_id] = tryparse(Int, string(pget(p, "taxon_id", "")))
    end

    if phaskey(p, "year_from")
        f[:year_from] = tryparse(Int, string(pget(p, "year_from", "")))
    end

    if phaskey(p, "year_to")
        f[:year_to] = tryparse(Int, string(pget(p, "year_to", "")))
    end

    if phaskey(p, "month")
        raw = pget(p, "month")
        months = raw isa Vector ? raw : [raw]
        f[:months] = parse.(Int, string.(months))
    end

    if phaskey(p, "quality_grade")
        f[:quality] = string(pget(p, "quality_grade"))
    end

    if phaskey(p, "elevation_min")
        f[:elev_min] = tryparse(Float64, string(pget(p, "elevation_min", "")))
    end

    if phaskey(p, "elevation_max")
        f[:elev_max] = tryparse(Float64, string(pget(p, "elevation_max", "")))
    end

    if phaskey(p, "bbox")
        vals = split(string(pget(p, "bbox")), ",")
        if length(vals) == 4
            f[:bbox] = parse.(Float64, vals)
        end
    end

    if phaskey(p, "limit")
        lim = something(tryparse(Int, string(pget(p, "limit", ""))), 100_000)
        f[:limit] = min(lim, 100_000)
    else
        f[:limit] = 100_000
    end

    if phaskey(p, "sample")
        f[:sample] = string(pget(p, "sample"))
    end

    return f
end


function apply_filters(df, f)
    out = df

    if haskey(f, :taxon_id) && f[:taxon_id] !== nothing
        out = out[out.taxon_id .== f[:taxon_id], :]
    end

    if haskey(f, :year_from) && f[:year_from] !== nothing
        out = out[out.year .>= f[:year_from], :]
    end

    if haskey(f, :year_to) && f[:year_to] !== nothing
        out = out[out.year .<= f[:year_to], :]
    end

    if haskey(f, :months)
        out = out[in.(out.month, Ref(f[:months])), :]
    end

    if haskey(f, :quality)
        out = out[out.quality_grade .== f[:quality], :]
    end

    if haskey(f, :elev_min) && f[:elev_min] !== nothing
        out = out[out.elevation_m .>= f[:elev_min], :]
    end

    if haskey(f, :elev_max) && f[:elev_max] !== nothing
        out = out[out.elevation_m .<= f[:elev_max], :]
    end

    if haskey(f, :bbox)
        lon1, lat1, lon2, lat2 = f[:bbox]
        lo = min(lon1, lon2)
        hi = max(lon1, lon2)
        la = min(lat1, lat2)
        lb = max(lat1, lat2)

        out = out[
            (out.longitude .>= lo) .&
            (out.longitude .<= hi) .&
            (out.latitude  .>= la) .&
            (out.latitude  .<= lb),
            :
        ]
    end

    if haskey(f, :sample) && f[:sample] == "random"
        n = min(nrow(out), f[:limit])
        out = out[rand(1:nrow(out), n), :]
    end

    if nrow(out) > f[:limit]
        out = out[1:f[:limit], :]
    end

    return out
end



function list_cluster_runs()::Vector{String}
    clusters_root = data_path("data", "clusters")
    isdir(clusters_root) || return String[]
    runs = filter(name -> startswith(name, "clusters-") && isdir(joinpath(clusters_root, name)),
                  readdir(clusters_root))
    sort!(runs)
    return runs
end

function latest_cluster_run()::Union{String,Nothing}
    runs = list_cluster_runs()
    isempty(runs) ? nothing : last(runs)
end

function pick_best_geojson_4326(run_dir::AbstractString)::Union{String,Nothing}
    files = readdir(run_dir)
    # Prefer *_4326.geojson for Leaflet
    candidates = filter(f -> endswith(lowercase(f), "_4326.geojson"), files)
    if isempty(candidates)
        candidates = filter(f -> endswith(lowercase(f), ".geojson"), files)
    end
    isempty(candidates) ? nothing : joinpath(run_dir, first(candidates))
end

# -------------------------
# Geometry bbox utilities
# -------------------------

# returns (minLon, minLat, maxLon, maxLat)
function coords_bbox(coords)
    minLon = Inf; minLat = Inf; maxLon = -Inf; maxLat = -Inf

    function visit(x)
        if x isa AbstractVector
            if length(x) == 2 && x[1] isa Real && x[2] isa Real
                lon = Float64(x[1]); lat = Float64(x[2])
                minLon = min(minLon, lon); maxLon = max(maxLon, lon)
                minLat = min(minLat, lat); maxLat = max(maxLat, lat)
            else
                for y in x
                    visit(y)
                end
            end
        end
    end

    visit(coords)

    return (minLon, minLat, maxLon, maxLat)
end

function feature_bbox(feature)::Union{NTuple{4,Float64},Nothing}
    geom = get(feature, "geometry", nothing)
    geom === nothing && return nothing

    coords = get(geom, "coordinates", nothing)
    coords === nothing && return nothing

    b = coords_bbox(coords)
    if !all(isfinite, b)
        return nothing
    end
    return b
end

# bbox intersection test
# a = (minLon, minLat, maxLon, maxLat)
# b = (minLon, minLat, maxLon, maxLat)
@inline function bbox_intersects(a, b)::Bool
    return !(a[3] < b[1] || a[1] > b[3] || a[4] < b[2] || a[2] > b[4])
end

# -------------------------
# Ecosystems cache
# -------------------------

# Cache parsed GeoJSON + per-feature bbox list, per run
const ECOSYSTEMS_CACHE = Dict{String, Any}()

function load_ecosystems_cached(run::String)
    cached = get(ECOSYSTEMS_CACHE, run, nothing)
    cached !== nothing && return cached

    clusters_root = data_path("data", "clusters")
    run_dir = joinpath(clusters_root, run)

    path = pick_best_geojson_4326(run_dir)
    path === nothing && return nothing

    # Parse once
    obj = JSON3.read(open(read, path), Dict{String,Any})
    feats = get(obj, "features", Any[])

    # Precompute bbox per feature (same ordering as feats)
    bboxes = Vector{Union{NTuple{4,Float64},Nothing}}(undef, length(feats))
    for i in eachindex(feats)
        bboxes[i] = feature_bbox(feats[i])
    end

    data = (path=path, obj=obj, feats=feats, bboxes=bboxes)
    ECOSYSTEMS_CACHE[run] = data
    return data
end

# ---------------- Routes ----------------

@inline function lonlat_to_grid(lon::Float64, lat::Float64, z::Int)
    lat = clamp(lat, -85.05112878, 85.05112878)
    n = 2.0^z
    x = Int(floor((lon + 180.0) / 360.0 * n))
    s = sin(lat * pi / 180.0)
    y = Int(floor((1.0 - log((1.0 + s) / (1.0 - s)) / pi) / 2.0 * n))
    return x, y
end

# Robust GET for Genie params: works with String or Symbol keys
@inline function pget(p, key::AbstractString, default=nothing)
    if haskey(p, key)
        return p[key]
    end
    sk = Symbol(key)
    if haskey(p, sk)
        return p[sk]
    end
    return default
end

@inline function phaskey(p, key::AbstractString)::Bool
    return haskey(p, key) || haskey(p, Symbol(key))
end



function setup_api_routes()

    # --- Species list (taxon + count) ---
    route("/api/species") do
        g = combine(groupby(OBS, :taxon_id), nrow => :count)
        sort!(g, :count, rev = true)
        respond_json(g[!, [:taxon_id, :count]])
    end

    # --- Annual trends ---
    route("/api/trends/annual") do
        p = params()
        taxon = try
            parse(Int, get(p, "taxon_id", "0"))
        catch
            0
        end

        sub = taxon == 0 ? OBS : OBS[OBS.taxon_id .== taxon, :]
        g = combine(groupby(sub, :year), nrow => :count)
        sort!(g, :year)
        respond_json(g)
    end

    route("/api/grid") do
        p = params()

        phaskey(p, "bbox") || return HTTP.Response(400, "bbox required")
        vals = split(string(pget(p, "bbox")), ",")



        lon1, lat1, lon2, lat2 = parse.(Float64, vals)
        bbox = (min(lon1, lon2), min(lat1, lat2), max(lon1, lon2), max(lat1, lat2))

        z = something(tryparse(Int, string(pget(p, "z", ""))), 7)
        z = clamp(z, 4, 12)

        f = parse_filters(p)
        df = apply_filters(OBS, f)

        # grid[(x,y)] => (count, Set(taxa), sum_elev)
        grid = Dict{Tuple{Int,Int}, Tuple{Int, Set{Int}, Float64}}()

        for r in eachrow(df)
            # Skip incomplete rows (common in real datasets)
            if ismissing(r.longitude) || ismissing(r.latitude) || ismissing(r.taxon_id) || ismissing(r.elevation_m)
                continue
            end

            x, y = lonlat_to_grid(Float64(r.longitude), Float64(r.latitude), z)
            key = (x, y)

            tid = Int(r.taxon_id)
            elev = Float64(r.elevation_m)

            if haskey(grid, key)
                c, taxa, esum = grid[key]
                push!(taxa, tid)
                grid[key] = (c + 1, taxa, esum + elev)
            else
                grid[key] = (1, Set([tid]), elev)
            end
        end


        result = Vector{Dict}()
        sizehint!(result, length(grid))

        for ((x, y), (count, taxa, esum)) in grid
            push!(result, Dict(
                "x" => x,
                "y" => y,
                "count" => count,
                "unique_taxa" => length(taxa),
                "elev_mean" => esum / count
            ))
        end

        return result
    end


    # --- Ecosystem polygons (latest run, EPSG:4326) ---
    route("/api/ecosystems") do
        p = params()

        run = pget(p, "run", nothing)
        if run === nothing
            run = latest_cluster_run()
        end
        run === nothing && return HTTP.Response(404, ["Content-Type" => "text/plain; charset=utf-8"], "No cluster runs found")

        data = load_ecosystems_cached(run)
        data === nothing && return HTTP.Response(404, ["Content-Type" => "text/plain; charset=utf-8"], "No GeoJSON found for run=$run")

        feats = data.feats
        bboxes = data.bboxes

        # Optional bbox filter: bbox=lon1,lat1,lon2,lat2
        if phaskey(p, "bbox")
            vals = split(string(pget(p, "bbox")), ",")
            if length(vals) == 4
                lon1, lat1, lon2, lat2 = parse.(Float64, vals)
                q = (min(lon1, lon2), min(lat1, lat2), max(lon1, lon2), max(lat1, lat2))

                filtered = Any[]
                sizehint!(filtered, min(length(feats), 2000))

                for i in eachindex(feats)
                    bb = bboxes[i]
                    bb === nothing && continue
                    if bbox_intersects(bb, q)
                        push!(filtered, feats[i])
                    end
                end

                out = Dict(
                    "type" => "FeatureCollection",
                    "features" => filtered
                )

                return HTTP.Response(
                    200,
                    ["Content-Type" => "application/geo+json; charset=utf-8"],
                    JSON3.write(out)
                )
            end
            # If bbox malformed, just fall through to full
        end

        # No bbox -> full FeatureCollection (still cached, no re-parse)
        out = Dict(
            "type" => "FeatureCollection",
            "features" => feats
        )

        return HTTP.Response(
            200,
            ["Content-Type" => "application/geo+json; charset=utf-8"],
            JSON3.write(out)
        )
    end

    route("/api/runs") do
        runs = list_cluster_runs()
        # array response, as requested
        return [Dict("run" => r) for r in runs]
    end

    route("/api/runs/latest") do
        r = latest_cluster_run()
        r === nothing ? [] : [Dict("run" => r)]
    end

    route("/api/summary") do
        p= params()
        f = parse_filters(p)

        df = apply_filters(OBS, f)

        metrics = Vector{Dict}()

        push!(metrics, Dict("metric" => "observations", "value" => nrow(df)))
        push!(metrics, Dict("metric" => "unique_taxa", "value" => length(unique(df.taxon_id))))
        push!(metrics, Dict("metric" => "clusters", "value" => length(unique(df.cluster_id))))

        if :elevation_m in names(df) && nrow(df) > 0
            push!(metrics, Dict("metric" => "elevation_min", "value" => minimum(df.elevation_m)))
            push!(metrics, Dict("metric" => "elevation_mean", "value" => mean(df.elevation_m)))
            push!(metrics, Dict("metric" => "elevation_max", "value" => maximum(df.elevation_m)))
        end

        return metrics
    end




    # --- Seasonal trends ---
    route("/api/trends/seasonal") do
        p = params()
        taxon = try
            parse(Int, get(p, "taxon_id", "0"))
        catch
            0
        end

        sub = taxon == 0 ? OBS : OBS[OBS.taxon_id .== taxon, :]
        g = combine(groupby(sub, :month), nrow => :count)
        sort!(g, :month)
        respond_json(g)
    end

    # --- Raw observations for map ---
    route("/api/observations") do
        p = params()
        f = parse_filters(p)

        df = apply_filters(OBS, f)

        return [
            Dict(
                "lat" => r.latitude,
                "lon" => r.longitude,
                "taxon_id" => r.taxon_id,
                "year" => r.year,
                "month" => r.month,
                "quality_grade" => r.quality_grade,
                "cluster_id" => r.cluster_id,
                "elevation_m" => r.elevation_m
            )
            for r in eachrow(df)
        ]
    end




end # function setup_api_routes

end # module
