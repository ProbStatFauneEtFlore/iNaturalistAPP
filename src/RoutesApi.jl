module RoutesApi

using Genie, Genie.Router
using Genie.Requests
using DataFrames
using ..Data: OBS
using ..Util: respond_json

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

# ---------------- Routes ----------------

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
            df = OBS

            # optional taxon filter
            if haskey(p, "taxon_id")
                taxon = try
                    parse(Int, p["taxon_id"])
                catch
                    0
                end
                if taxon != 0
                    df = df[df.taxon_id .== taxon, :]
                end
            end

            # optional year range (if year exists)
            if :year in names(df)
                y_from = haskey(p, "year_from") ? get_int_param("year_from", minimum(OBS.year)) : minimum(OBS.year)
                y_to   = haskey(p, "year_to")   ? get_int_param("year_to",   maximum(OBS.year)) : maximum(OBS.year)
                df = df[(df.year .>= y_from) .& (df.year .<= y_to), :]
            end

            # optional bbox = lon_min,lat_min,lon_max,lat_max
            if haskey(p, "bbox")
                parts = split(p["bbox"], ",")
                if length(parts) == 4
                    lon_min, lat_min, lon_max, lat_max = parse.(Float64, parts)
                    df = df[(df.longitude .>= lon_min) .& (df.longitude .<= lon_max) .&
                            (df.latitude  .>= lat_min) .& (df.latitude  .<= lat_max), :]
                end
            end

            # limit number of points to avoid killing the browser
            limit = haskey(p, "limit") ? get_int_param("limit", 2000) : 2000
            n = min(nrow(df), limit)

            # build a clean array of NamedTuples for JSON
            has_year = :year in names(df)
            result = Vector{NamedTuple}(undef, n)

            if has_year
                @inbounds for i in 1:n
                    result[i] = (
                        latitude  = df.latitude[i],
                        longitude = df.longitude[i],
                        taxon_id  = df.taxon_id[i],
                        year      = df.year[i],
                    )
                end
            else
                @inbounds for i in 1:n
                    result[i] = (
                        latitude     = df.latitude[i],
                        longitude    = df.longitude[i],
                        taxon_id     = df.taxon_id[i],
                        observed_on  = string(df.observed_on[i]),
                    )
                end
            end

            respond_json(result)
        end



end # function setup_api_routes

end # module
