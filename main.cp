#include <drogon/drogon.h>
#include <controllers/WebSocket.h>

#include <memory>
#include <tuple>

int main() {
    drogon::app().loadConfigFile("config.json");
    drogon::app().registerController(
            std::make_shared<techmino::ws::v1::WebSocket>()
    );
    drogon::app().registerBeginningAdvice([]() {
        const auto handlers = drogon::app().getHandlersInfo();
        LOG_INFO << "ROUTE_DIAGNOSTIC count=" << handlers.size();
        for (const auto &handler: handlers) {
            LOG_INFO << "ROUTE_DIAGNOSTIC path=" << std::get<0>(handler)
                     << " method=" << static_cast<int>(std::get<1>(handler))
                     << " handler=" << std::get<2>(handler);
        }
    });
    drogon::app().registerPreRoutingAdvice([](const drogon::HttpRequestPtr &req) {
        if (req->path() != "/techmino/ws/v1") {
            return;
        }
        LOG_INFO << "WS_REQUEST_DIAGNOSTIC path=" << req->path()
                 << " websocket_key="
                 << (req->getHeader("sec-websocket-key").empty() ? "missing" : "present")
                 << " websocket_version=" << req->getHeader("sec-websocket-version")
                 << " upgrade=" << req->getHeader("upgrade")
                 << " connection=" << req->getHeader("connection");
    });
    drogon::app().run();
    return 0;
}
