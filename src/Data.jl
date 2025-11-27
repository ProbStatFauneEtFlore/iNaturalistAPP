module Data

using CSV, DataFrames, Dates
using Logging: @info

export OBS, project_root, data_path

"Path to project root (folder containing Project.toml)."
project_root() = dirname(@__DIR__)  # src/ -> project root

"Helper to build paths from project root."
data_path(parts...) = joinpath(project_root(), parts...)

const OBS = let
    path = data_path("data", "observations_swiss.csv")
    @info "Loading CSV: $path"
    df = CSV.read(path, DataFrame; dateformat="auto", normalizenames=true)

    @info "Colums loaded : $(names(df))"
    required = ["taxon_id", "observed_on"]
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
