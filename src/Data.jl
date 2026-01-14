module Data

using CSV, DataFrames, Dates
using Logging: @info

export OBS, project_root, data_path

"Path to project root (folder containing Project.toml)."
project_root() = dirname(@__DIR__)  # src/ -> project root

"Helper to build paths from project root."
data_path(parts...) = joinpath(project_root(), parts...)

const OBS = let
        # ---- Prefer latest clustered/enriched CSV if available ----
        clusters_root = data_path("data", "clusters")

        function pick_latest_run(dir::AbstractString)
            isdir(dir) || return nothing
            runs = filter(name -> startswith(name, "clusters-") && isdir(joinpath(dir, name)),
                          readdir(dir))
            isempty(runs) && return nothing
            sort!(runs)  # timestamp format makes lexicographic sort valid
            return joinpath(dir, last(runs))
        end

        function pick_cluster_csv(run_dir::AbstractString)
            run_dir === nothing && return nothing
            csvs = filter(f -> endswith(lowercase(f), ".csv"), readdir(run_dir))
            isempty(csvs) && return nothing

            # Prefer enriched CSVs (and observations)
            preferred = filter(f -> occursin("observations", lowercase(f)) && occursin("enriched", lowercase(f)), csvs)
            chosen = !isempty(preferred) ? first(preferred) : first(csvs)
            return joinpath(run_dir, chosen)
        end

        latest_run = pick_latest_run(clusters_root)
        clustered  = pick_cluster_csv(latest_run)
        raw        = data_path("data", "observations_swiss.csv")

        @info "Clusters root: $clusters_root (exists=$(isdir(clusters_root)))"
        @info "Latest run dir: $(latest_run === nothing ? "none" : latest_run)"
        @info "Chosen clustered CSV: $(clustered === nothing ? "none" : clustered) (exists=$(clustered === nothing ? false : isfile(clustered)))"
        @info "Raw CSV fallback: $raw (exists=$(isfile(raw)))"

        path = (clustered !== nothing && isfile(clustered)) ? clustered : raw
        @info "Loading CSV: $path"


    df = CSV.read(path, DataFrame; dateformat="auto", normalizenames=true)

    @info "Colums loaded : $(names(df))"
    required = ["taxon_id", "observed_on", "latitude", "longitude"]
    msg = "CSV must have columns: " * join(required, ", ")
    @assert all(in.(required, Ref(names(df)))) msg

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


end
