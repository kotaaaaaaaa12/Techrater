#include <drogon/drogon.h>
#include <controllers/WebSocket.h>

#include <memory>

int main() {
    drogon::app().loadConfigFile("config.json");

    drogon::app().registerController(
            std::make_shared<techmino::ws::v1::WebSocket>()
    );
    LOG_INFO << "Techrater WebSocket controller registered";

    drogon::app().run();
    return 0;
}
