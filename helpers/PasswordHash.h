#pragma once

#include <drogon/drogon.h>
#include <cryptopp/pwdbased.h>
#include <cryptopp/sha.h>
#include <cryptopp/hex.h>
#include <cryptopp/misc.h>
#include <cstdlib>
#include <trantor/net/EventLoopThread.h>

namespace techmino::helpers {
    inline void registerPasswordHashRoute() {
        drogon::app().registerHandler("/_internal/password-hash",
            [](const drogon::HttpRequestPtr &request,
               std::function<void(const drogon::HttpResponsePtr &)> &&callback) {
                static trantor::EventLoopThread passwordThread;
                static const bool started = []() { passwordThread.run(); return true; }();
                (void)started;
                passwordThread.getLoop()->queueInLoop([request, callback = std::move(callback)]() {
                const char *token = std::getenv("TECHRATER_AUTH_TOKEN");
                const std::string expected = std::string("Bearer ") + (token ? token : "");
                const std::string provided = request->getHeader("authorization");
                if (!token || provided.size() != expected.size() ||
                    !CryptoPP::VerifyBufsEqual(reinterpret_cast<const CryptoPP::byte *>(provided.data()),
                        reinterpret_cast<const CryptoPP::byte *>(expected.data()), expected.size())) {
                    auto response = drogon::HttpResponse::newHttpResponse();
                    response->setStatusCode(drogon::k403Forbidden);
                    callback(response);
                    return;
                }
                const auto body = request->getJsonObject();
                if (!body || !(*body)["password"].isString() || !(*body)["saltHex"].isString() ||
                    !(*body)["iterations"].isUInt() || (*body)["password"].asString().size() > 512 ||
                    (*body)["saltHex"].asString().size() != 32 ||
                    (*body)["iterations"].asUInt() < 100000 || (*body)["iterations"].asUInt() > 1000000) {
                    auto response = drogon::HttpResponse::newHttpResponse();
                    response->setStatusCode(drogon::k400BadRequest);
                    callback(response);
                    return;
                }
                try {
                    const std::string password = (*body)["password"].asString();
                    std::string salt;
                    CryptoPP::StringSource saltSource((*body)["saltHex"].asString(), true,
                        new CryptoPP::HexDecoder(new CryptoPP::StringSink(salt)));
                    CryptoPP::byte output[32];
                    CryptoPP::PKCS5_PBKDF2_HMAC<CryptoPP::SHA256> pbkdf;
                    pbkdf.DeriveKey(output, sizeof(output), 0,
                        reinterpret_cast<const CryptoPP::byte *>(password.data()), password.size(),
                        reinterpret_cast<const CryptoPP::byte *>(salt.data()), salt.size(),
                        (*body)["iterations"].asUInt());
                    std::string hex;
                    CryptoPP::StringSource outputSource(output, sizeof(output), true,
                        new CryptoPP::HexEncoder(new CryptoPP::StringSink(hex), false));
                    Json::Value result;
                    result["hashHex"] = hex;
                    auto response = drogon::HttpResponse::newHttpJsonResponse(result);
                    response->addHeader("Cache-Control", "no-store");
                    callback(response);
                } catch (const std::exception &) {
                    auto response = drogon::HttpResponse::newHttpResponse();
                    response->setStatusCode(drogon::k400BadRequest);
                    callback(response);
                }
                });
            }, {drogon::Post});
    }
}
