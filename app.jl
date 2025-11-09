using Genie, Genie.Router, Genie.Renderer.Json
using HTTP
using CSV, DataFrames, JSON3, Dates, StatsBase

Genie.config.run_as_server = true

# -------- Chargement des données --------
const OBS = let
    path = joinpath(@__DIR__, "data", "observations_swiss.csv")
    @info "Loading CSV: $path"
    df = CSV.read(path, DataFrame; dateformat="auto", normalizenames=true)

    required = ["taxon_id", "observed_on"]
    msg = "CSV must have columns: " * join(required, ", ")
    @assert all(in.(required, Ref(names(df)))) msg

    # dates -> year/month
    obs = df.observed_on
    d = if eltype(obs) <: AbstractString
        try
            Date.(obs, dateformat"yyyy-mm-dd")
        catch
            Date.(obs)
        end
    else
        Date.(obs)
    end
    df.year  = year.(d)
    df.month = month.(d)
    df
end

# -------- Helpers --------
respond_json(x) = HTTP.Response(200, ["Content-Type" => "application/json"], JSON3.write(x))

function mime_of(rel::AbstractString)
    endswith(rel, ".css")  && return "text/css; charset=utf-8"
    endswith(rel, ".js")   && return "application/javascript"
    endswith(rel, ".html") && return "text/html; charset=utf-8"
    endswith(rel, ".png")  && return "image/png"
    (endswith(rel, ".jpg") || endswith(rel, ".jpeg")) && return "image/jpeg"
    endswith(rel, ".json") && return "application/json"
    (endswith(rel, ".pbf") || endswith(rel, ".mvt")) && return "application/x-protobuf"
    return "application/octet-stream"
end

# -------- Routes statiques --------
route("/") do
    path = joinpath(@__DIR__, "public", "index.html")
    return HTTP.Response(200, ["Content-Type" => "text/html; charset=utf-8"], open(read, path))
end

# ---- Fichier CSS exact ----
route("/static/css/style.css") do
    path = joinpath(@__DIR__, "public", "css", "style.css")
    return HTTP.Response(200,
        ["Content-Type" => "text/css; charset=utf-8"],
        open(read, path))
end

# JS exact
route("/static/js/app.js") do
    path = joinpath(@__DIR__, "public", "js", "app.js")
    return HTTP.Response(200,
        ["Content-Type" => "application/javascript"],
        open(read, path))
end


route("/tiles/*") do
    rel  = Genie.Requests.params(:splat)[1]
    path = joinpath(@__DIR__, "tiles", rel)
    return HTTP.Response(200, ["Content-Type" => mime_of(rel)], open(read, path))
end

# -------- API --------
route("/api/species") do
    g = combine(groupby(OBS, :taxon_id), nrow => :count)
    sort!(g, :count, rev=true)
    return respond_json(g[!, [:taxon_id, :count]])
end

route("/api/trends/annual") do
    taxon = try parse(Int, get(Genie.Requests.params(), "taxon_id", "0")) catch; 0 end
    sub = taxon == 0 ? OBS : OBS[OBS.taxon_id .== taxon, :]
    g = combine(groupby(sub, :year), nrow => :count)
    sort!(g, :year)
    return respond_json(g)
end

route("/api/trends/seasonal") do
    taxon = try parse(Int, get(Genie.Requests.params(), "taxon_id", "0")) catch; 0 end
    sub = taxon == 0 ? OBS : OBS[OBS.taxon_id .== taxon, :]
    g = combine(groupby(sub, :month), nrow => :count)
    sort!(g, :month)
    return respond_json(g)
end

# -------- Start --------
Genie.up()
