module Util

using HTTP, JSON3

export respond_json, mime_of

respond_json(x) =
    HTTP.Response(200, ["Content-Type" => "application/json"], JSON3.write(x))

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

end
