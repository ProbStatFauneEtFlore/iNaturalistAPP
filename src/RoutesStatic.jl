module RoutesStatic

using Genie, Genie.Router
using Genie.Requests
using HTTP
using ..Data: project_root
using ..Util: mime_of

export setup_static_routes, serve_file

function serve_file(path::AbstractString, mime::AbstractString)
    if isfile(path)
        return HTTP.Response(200, ["Content-Type" => mime], open(read, path))
    else
        return HTTP.Response(404,
            ["Content-Type" => "text/plain; charset=utf-8"],
            "Not found")
    end
end

function setup_static_routes()
    @info "RoutesStatic loaded!"

    root = project_root()

    # Home
    route("/") do
        path = joinpath(root, "public", "index.html")
        serve_file(path, "text/html; charset=utf-8")
    end

    # CSS
    route("/static/css/style.css") do
        path = joinpath(root, "public", "css", "style.css")
        serve_file(path, "text/css; charset=utf-8")
    end

    # JS
    route("/static/js/app.js") do
        path = joinpath(root, "public", "js", "app.js")
        serve_file(path, "application/javascript")
    end

    # ============================
    # TILE SERVER: /tiles/:z/:x/:filename
    # ============================
    route("/tiles/:z/:x/:filename") do
        z        = params(:z)
        x        = params(:x)
        filename = params(:filename)   # e.g. "52.geojson.gz"

        rel  = joinpath(z, x, filename)
        path = joinpath(root, "tiles", rel)

        @info "TILE REQUEST" z=z x=x filename=filename rel=rel path=path exists=isfile(path)

        serve_file(path, mime_of(filename))
    end
end

end # module
