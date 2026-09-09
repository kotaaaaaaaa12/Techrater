#include <drogon/drogon.h>
#include <controllers/WebSocket.h>

#include <memory>

int main() {
    drogon::app().loadConfigFile("config.json");

    drogon::app().registerController(
            std::make_shared<techmino::ws::v1::WebSocket>()
    );

    drogon::app().registerBeginningAdvice([]() {
        LOG_INFO << "Techrater WebSocket controller registered";
    });
    drogon::app().registerPreRoutingAdvice([](const drogon::HttpRequestPtr &req) {
        if (req->path() != "/techmino/ws/v1") {
            return;
        }

        LOG_INFO << "WEBSOCKET_CONTAINER_DIAGNOSTIC"
                 << " key="
                 << (req->getHeader("sec-websocket-key").empty() ? "missing" : "present")
                 << " version=" << req->getHeader("sec-websocket-version")
                 << " upgrade=" << req->getHeader("upgrade")
                 << " connection=" << req->getHeader("connection");
    });

    drogon::app().run();
    return 0;
}

