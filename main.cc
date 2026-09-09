#include <drogon/drogon.h>
#include <controllers/WebSocket.h>
#include <memory>

int main() {
    drogon::app().loadConfigFile("config.json");
    drogon::app().registerController(
            std::make_shared<techmino::ws::v1::WebSocket>()
    );

    drogon::app().registerBeginningAdvice([]() {
        bool routeFound = false;
        for (const auto &handler : drogon::app().getHandlersInfo()) {
            if (std::get<0>(handler) == "/techmino/ws/v1" &&
                std::get<2>(handler).find("WebsocketController") != std::string::npos) {
                routeFound = true;
            }
        }

        if (routeFound) {
            LOG_INFO << "TECHRATER_WS_CONTROLLER_BOUND path=/techmino/ws/v1";
        } else {
            LOG_ERROR << "TECHRATER_WS_ROUTE_MISSING path=/techmino/ws/v1";
        }
        LOG_INFO << "TECHRATER_SERVER_READY port=8080";
    });

    drogon::app().run();
    return 0;
}
