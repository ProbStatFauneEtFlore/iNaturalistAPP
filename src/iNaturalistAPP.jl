module iNaturalistAPP

using Genie

include("Util.jl")
include("Data.jl")
include("RoutesStatic.jl")
include("RoutesApi.jl")

using .Util
using .Data
using .RoutesStatic
using .RoutesApi

export start

function start()
    Genie.config.run_as_server = true

    setup_static_routes()
    setup_api_routes()

    Genie.up()
end

end # module
