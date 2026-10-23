#pragma once

#include <drogon/drogon.h>
#include <trantor/net/EventLoopThread.h>
#include <cstdlib>
#include <structures/Exceptions.h>

namespace techmino::helpers {
    class D1Store {
    public:
        static Json::Value call(const std::string &operation, Json::Value payload = Json::objectValue) {
            const char *origin = std::getenv("TECHRATER_DATA_ORIGIN");
            const char *token = std::getenv("TECHRATER_AUTH_TOKEN");
            if (!origin || !token) {
                throw std::runtime_error("The D1 bridge is not configured.");
            }

            // Keep synchronous legacy controller calls off the HTTP client's event loop.
            static trantor::EventLoopThread networkThread;
            static const bool started = []() { networkThread.run(); return true; }();
            (void)started;
            auto client = drogon::HttpClient::newHttpClient(origin, networkThread.getLoop(), false, true);
            payload["operation"] = operation;
            auto request = drogon::HttpRequest::newHttpJsonRequest(payload);
            request->setMethod(drogon::Post);
            request->setPath("/_worker/internal/core-data");
            request->addHeader("Authorization", std::string("Bearer ") + token);
            const auto [result, response] = client->sendRequest(request, 10);
            if (result != drogon::ReqResult::Ok || !response) {
                throw structures::ResponseException("The data service is unavailable.",
                    types::ResultCode::DatabaseError, drogon::k503ServiceUnavailable);
            }
            const auto body = response->getJsonObject();
            if (response->statusCode() != drogon::k200OK || !body || !body->isMember("data")) {
                throw structures::ResponseException("The data service rejected the request.",
                    types::ResultCode::DatabaseError, drogon::k503ServiceUnavailable);
            }
            return (*body)["data"];
        }
    };
}
