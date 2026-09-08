#include <drogon/drogon.h>
#include <controllers/WebSocket.h>

#include <memory>

int main() {
    drogon::app().loadConfigFile("config.json");
    drogon::app().registerController(
            std::make_shared<techmino::ws::v1::WebSocket>()
    );
    drogon::app().run();
    return 0;
}
