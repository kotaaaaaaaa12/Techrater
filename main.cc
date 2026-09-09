#include <drogon/drogon.h>
#include <controllers/WebSocket.h>

int main() {
    drogon::app().loadConfigFile("config.json");
    techmino::ws::v1::WebSocket::initPathRouting();

    drogon::app().registerBeginningAdvice([]() {
        bool routeFound = false;
        for (const auto &handler : drogon::app().getHandlersInfo()) {
            LOG_INFO << "TECHRATER_ROUTE path=" << std::get<0>(handler)
                     << " handler=" << std::get<2>(handler);
            if (std::get<0>(handler) == "/techmino/ws/v1" &&
                std::get<2>(handler).find("WebsocketController") != std::string::npos) {
                routeFound = true;
            }
        }

        if (routeFound) {
            LOG_INFO << "TECHRATER_WS_ROUTE_READY path=/techmino/ws/v1";
        } else {
            LOG_ERROR << "TECHRATER_WS_ROUTE_MISSING path=/techmino/ws/v1";
        }
        LOG_INFO << "TECHRATER_SERVER_READY port=8080";
    });

    drogon::app().run();
    return 0;
}
