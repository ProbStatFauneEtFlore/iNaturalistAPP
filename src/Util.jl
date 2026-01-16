module Util

using HTTP, JSON3

export respond_json, mime_of

function respond_json(x; code::Integer = 200, headers=Pair{String,String}[])
    base = ["Content-Type" => "application/json; charset=utf-8"]
    return HTTP.Response(code, vcat(base, headers), JSON3.write(x))
end

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
