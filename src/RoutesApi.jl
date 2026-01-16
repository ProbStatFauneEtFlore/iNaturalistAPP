module RoutesApi

using Genie, Genie.Router
using Genie.Requests
using DataFrames
using HTTP
using Dates
using Statistics
using JSON3

using ..Data: OBS, data_path
using ..Util: respond_json

export setup_api_routes

# =========================
# Params helpers (robust)
# =========================

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

@inline function to_int(x; default=nothing)
    x === nothing && return default
    s = strip(string(x))
    isempty(s) && return default
    v = tryparse(Int, s)
    v === nothing ? default : v
end

@inline function to_float(x; default=nothing)
    x === nothing && return default
    s = strip(string(x))
    isempty(s) && return default
    v = tryparse(Float64, s)
    v === nothing ? default : v
end

@inline function error_json(code::Int, msg::AbstractString)
    return HTTP.Response(code, ["Content-Type" => "application/json; charset=utf-8"],
        JSON3.write(Dict("error" => msg)))
end

# =========================
# Filters
# =========================

"""
Parse query params into a Dict{Symbol,Any}.

Supported:
- taxon_id (Int)
- year_from (Int)
- year_to (Int)
- month (one or multiple)
- quality_grade (String)
- elevation_min/max (Float64)
- bbox (lon1,lat1,lon2,lat2)
- limit (Int, clamped)
- sample ("random")
"""
function parse_filters(p)::Dict{Symbol,Any}
    f = Dict{Symbol,Any}()

    # taxon
    if phaskey(p, "taxon_id")
        f[:taxon_id] = to_int(pget(p, "taxon_id"); default=nothing)
    end

    # year range
    if phaskey(p, "year_from")
        f[:year_from] = to_int(pget(p, "year_from"); default=nothing)
    end
    if phaskey(p, "year_to")
        f[:year_to] = to_int(pget(p, "year_to"); default=nothing)
    end

    # months: month=1&month=2 OR month=1
    if phaskey(p, "month")
        raw = pget(p, "month")
        months_raw = raw isa Vector ? raw : [raw]
        months = Int[]
        for m in months_raw
            mi = to_int(m; default=nothing)
            mi === nothing && continue
            1 <= mi <= 12 || continue
            push!(months, mi)
        end
        !isempty(months) && (f[:months] = months)
    end

    # quality
    if phaskey(p, "quality_grade")
        q = strip(string(pget(p, "quality_grade", "")))
        !isempty(q) && (f[:quality] = q)
    end

    # elevation
    if phaskey(p, "elevation_min")
        f[:elev_min] = to_float(pget(p, "elevation_min"); default=nothing)
    end
    if phaskey(p, "elevation_max")
        f[:elev_max] = to_float(pget(p, "elevation_max"); default=nothing)
    end

    # bbox (stored normalized as (lon_min, lat_min, lon_max, lat_max))
    if phaskey(p, "bbox")
        vals = split(strip(string(pget(p, "bbox", ""))), ",")
        if length(vals) == 4
            a = to_float(vals[1]; default=nothing)
            b = to_float(vals[2]; default=nothing)
            c = to_float(vals[3]; default=nothing)
            d = to_float(vals[4]; default=nothing)
            if a !== nothing && b !== nothing && c !== nothing && d !== nothing
                lon_min, lon_max = min(a, c), max(a, c)
                lat_min, lat_max = min(b, d), max(b, d)
                f[:bbox] = (lon_min, lat_min, lon_max, lat_max)
            end
        end
    end

    # limit
    lim = phaskey(p, "limit") ? to_int(pget(p, "limit"); default=100_000) : 100_000
    lim = lim === nothing ? 100_000 : lim
    f[:limit] = clamp(lim, 1, 100_000)

    # sample
    if phaskey(p, "sample")
        s = strip(string(pget(p, "sample", "")))
        !isempty(s) && (f[:sample] = s)
    end

    return f
end

@inline asboolmask(v) = coalesce.(v, false)

"""
Apply filters to DataFrame safely (handles missing in columns).

Important: every boolean mask is coalesced to `false` for missing entries.
"""
function apply_filters(df::DataFrame, f::Dict{Symbol,Any})::DataFrame
    out = df

    if get(f, :taxon_id, nothing) !== nothing
        out = out[asboolmask(out.taxon_id .== f[:taxon_id]), :]
    end

    if get(f, :year_from, nothing) !== nothing
        out = out[asboolmask(out.year .>= f[:year_from]), :]
    end

    if get(f, :year_to, nothing) !== nothing
        out = out[asboolmask(out.year .<= f[:year_to]), :]
    end

    if haskey(f, :months)
        out = out[asboolmask(in.(out.month, Ref(f[:months]))), :]
    end

    if haskey(f, :quality)
        out = out[asboolmask(out.quality_grade .== f[:quality]), :]
    end

    if get(f, :elev_min, nothing) !== nothing
        out = out[asboolmask(out.elevation_m .>= f[:elev_min]), :]
    end

    if get(f, :elev_max, nothing) !== nothing
        out = out[asboolmask(out.elevation_m .<= f[:elev_max]), :]
    end

    if haskey(f, :bbox)
        lon_min, lat_min, lon_max, lat_max = f[:bbox]
        mask =
            (out.longitude .>= lon_min) .&
            (out.longitude .<= lon_max) .&
            (out.latitude  .>= lat_min) .&
            (out.latitude  .<= lat_max)
        out = out[asboolmask(mask), :]
    end

    # sampling (optional)
    if get(f, :sample, nothing) == "random"
        n = min(nrow(out), f[:limit])
        if n > 0
            out = out[rand(1:nrow(out), n), :]
        end
    end

    # limit (always)
    if nrow(out) > f[:limit]
        out = out[1:f[:limit], :]
    end

    return out
end

# =========================
# Ecosystems helpers
# =========================

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
    candidates = filter(f -> endswith(lowercase(f), "_total_4326.geojson"), files)
    if isempty(candidates)
        candidates = filter(f -> endswith(lowercase(f), ".geojson"), files)
    end
    isempty(candidates) ? nothing : joinpath(run_dir, first(candidates))
end

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
    all(isfinite, b) ? b : nothing
end

@inline function bbox_intersects(a, b)::Bool
    return !(a[3] < b[1] || a[1] > b[3] || a[4] < b[2] || a[2] > b[4])
end

const ECOSYSTEMS_CACHE = Dict{String, Any}()

function load_ecosystems_cached(run::String)
    cached = get(ECOSYSTEMS_CACHE, run, nothing)
    cached !== nothing && return cached

    clusters_root = data_path("data", "clusters")
    run_dir = joinpath(clusters_root, run)

    path = pick_best_geojson_4326(run_dir)
    path === nothing && return nothing

    obj = JSON3.read(open(read, path), Dict{String,Any})
    feats = get(obj, "features", Any[])

    bboxes = Vector{Union{NTuple{4,Float64},Nothing}}(undef, length(feats))
    for i in eachindex(feats)
        bboxes[i] = feature_bbox(feats[i])
    end

    data = (path=path, obj=obj, feats=feats, bboxes=bboxes)
    ECOSYSTEMS_CACHE[run] = data
    return data
end

# =========================
# Grid helpers
# =========================

@inline function lonlat_to_grid(lon::Float64, lat::Float64, z::Int)
    lat = clamp(lat, -85.05112878, 85.05112878)
    n = 2.0^z
    x = Int(floor((lon + 180.0) / 360.0 * n))
    s = sin(lat * pi / 180.0)
    y = Int(floor((1.0 - log((1.0 + s) / (1.0 - s)) / pi) / 2.0 * n))
    return x, y
end

# =========================
# Routes
# =========================

function setup_api_routes()

    route("/api/species") do
        g = combine(groupby(OBS, :taxon_id), nrow => :count)
        sort!(g, :count, rev=true)
        return respond_json(g[!, [:taxon_id, :count]])
    end

    route("/api/trends/annual") do
        f = parse_filters(params())
        df = apply_filters(OBS, f)
        g = combine(groupby(df, :year), nrow => :count)
        sort!(g, :year)
        return respond_json(g)
    end

    route("/api/trends/seasonal") do
        f = parse_filters(params())
        df = apply_filters(OBS, f)
        g = combine(groupby(df, :month), nrow => :count)
        sort!(g, :month)
        return respond_json(g)
    end

    route("/api/grid") do
        p = params()
        phaskey(p, "bbox") || return error_json(400, "bbox required")

        z = to_int(pget(p, "z"); default=7)
        z = clamp(z, 4, 12)

        f = parse_filters(p)
        df = apply_filters(OBS, f)

        grid = Dict{Tuple{Int,Int}, Tuple{Int, Set{Int}, Float64}}()

        for r in eachrow(df)
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

        return respond_json(result)
    end

    route("/api/summary") do
        f = parse_filters(params())
        df = apply_filters(OBS, f)

        metrics = Vector{Dict}()
        push!(metrics, Dict("metric" => "observations", "value" => nrow(df)))
        push!(metrics, Dict("metric" => "unique_taxa", "value" => length(unique(skipmissing(df.taxon_id)))))
        push!(metrics, Dict("metric" => "clusters", "value" => length(unique(skipmissing(df.cluster_id)))))

        if :elevation_m in names(df) && nrow(df) > 0
            em = collect(skipmissing(df.elevation_m))
            if !isempty(em)
                push!(metrics, Dict("metric" => "elevation_min", "value" => minimum(em)))
                push!(metrics, Dict("metric" => "elevation_mean", "value" => mean(em)))
                push!(metrics, Dict("metric" => "elevation_max", "value" => maximum(em)))
            end
        end

        return respond_json(metrics)
    end

    # ---- plots: all require bbox ----
    function require_bbox!(f)
        haskey(f, :bbox) || throw(ArgumentError("bbox required"))
    end

    route("/api/plots/annual") do
        f = parse_filters(params())
        haskey(f, :bbox) || return error_json(400, "bbox required")
        df = apply_filters(OBS, f)

        g = combine(groupby(df, :year), nrow => :count)
        sort!(g, :year)
        return respond_json(g)
    end

    route("/api/plots/annual_normalized") do
        p = params()
        f_all = parse_filters(p)
        haskey(f_all, :bbox) || return error_json(400, "bbox required")

        # total per year (all taxa) on viewport
        df_all = apply_filters(OBS, f_all)
        g_total = combine(groupby(df_all, :year), nrow => :total)
        sort!(g_total, :year)

        taxon = get(f_all, :taxon_id, nothing)
        if taxon === nothing
            out = DataFrame(year = g_total.year, value = fill(1.0, nrow(g_total)))
            return respond_json(out)
        end

        # taxon per year on same viewport
        f_tax = copy(f_all)
        f_tax[:taxon_id] = taxon
        df_tax = apply_filters(OBS, f_tax)
        g_tax = combine(groupby(df_tax, :year), nrow => :taxon_count)
        sort!(g_tax, :year)

        g = leftjoin(g_total, g_tax, on=:year)
        g.taxon_count = coalesce.(g.taxon_count, 0)

        value = Vector{Float64}(undef, nrow(g))
        @inbounds for i in 1:nrow(g)
            value[i] = g.total[i] == 0 ? 0.0 : (g.taxon_count[i] / g.total[i])
        end

        out = DataFrame(year = g.year, value = value)
        return respond_json(out)
    end

    route("/api/plots/monthly_yearly") do
        f = parse_filters(params())
        haskey(f, :bbox) || return error_json(400, "bbox required")
        df = apply_filters(OBS, f)

        g = combine(groupby(df, [:year, :month]), nrow => :count)

        result = Vector{Any}(undef, 12)
        for m in 1:12
            sub = g[g.month .== m, :]
            sort!(sub, :year)
            result[m] = Dict("month" => m, "counts" => collect(Int.(sub.count)))
        end

        return respond_json(result)
    end

    route("/api/plots/month_hist") do
        f = parse_filters(params())
        haskey(f, :bbox) || return error_json(400, "bbox required")
        df = apply_filters(OBS, f)

        g = combine(groupby(df, :month), nrow => :count)
        sort!(g, :month)

        out = [Dict("month" => m, "count" => 0) for m in 1:12]
        for r in eachrow(g)
            if !ismissing(r.month)
                m = Int(r.month)
                1 <= m <= 12 || continue
                out[m]["count"] = Int(r.count)
            end
        end

        return respond_json(out)
    end

    route("/api/plots/season_profile") do
        f = parse_filters(params())
        haskey(f, :bbox) || return error_json(400, "bbox required")
        df = apply_filters(OBS, f)

        # build seasons from month, skipping missings
        seasons = String[]
        for m in df.month
            ismissing(m) && continue
            mi = Int(m)
            push!(seasons,
                (mi == 12 || mi == 1 || mi == 2) ? "Hiver" :
                (3 <= mi <= 5) ? "Printemps" :
                (6 <= mi <= 8) ? "Été" : "Automne"
            )
        end

        df2 = DataFrame(season = seasons)
        g = combine(groupby(df2, :season), nrow => :count)

        order = ["Hiver", "Printemps", "Été", "Automne"]
        out = [Dict("season" => s, "count" => 0) for s in order]
        for r in eachrow(g)
            idx = findfirst(==(r.season), order)
            idx === nothing && continue
            out[idx]["count"] = Int(r.count)
        end

        return respond_json(out)
    end

    # ---- ecosystems ----
    route("/api/ecosystems") do
        p = params()

        run = pget(p, "run", nothing)
        if run === nothing
            run = latest_cluster_run()
        end
        run === nothing && return HTTP.Response(404, ["Content-Type" => "text/plain; charset=utf-8"],
                                               "No cluster runs found")

        data = load_ecosystems_cached(string(run))
        data === nothing && return HTTP.Response(404, ["Content-Type" => "text/plain; charset=utf-8"],
                                                "No GeoJSON found for run=$run")

        feats = data.feats
        bboxes = data.bboxes

        if phaskey(p, "bbox")
            f = parse_filters(p)
            if haskey(f, :bbox)
                q = f[:bbox]  # (lon_min, lat_min, lon_max, lat_max)
                qbb = (q[1], q[2], q[3], q[4])

                filtered = Any[]
                sizehint!(filtered, min(length(feats), 2000))

                for i in eachindex(feats)
                    bb = bboxes[i]
                    bb === nothing && continue
                    if bbox_intersects(bb, qbb)
                        push!(filtered, feats[i])
                    end
                end

                out = Dict("type" => "FeatureCollection", "features" => filtered)
                return HTTP.Response(200,
                    ["Content-Type" => "application/geo+json; charset=utf-8"],
                    JSON3.write(out)
                )
            end
        end

        out = Dict("type" => "FeatureCollection", "features" => feats)
        return HTTP.Response(200,
            ["Content-Type" => "application/geo+json; charset=utf-8"],
            JSON3.write(out)
        )
    end

    route("/api/runs") do
        runs = list_cluster_runs()
        return [Dict("run" => r) for r in runs]
    end

    route("/api/runs/latest") do
        r = latest_cluster_run()
        r === nothing ? [] : [Dict("run" => r)]
    end

    # ---- raw observations ----
    route("/api/observations") do
        f = parse_filters(params())
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

end # setup_api_routes

end # module
