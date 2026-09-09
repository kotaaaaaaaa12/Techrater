//
// Created by particleg on 2021/9/27.
//

#include <filters/CheckAccessToken.h>
#include <helpers/ResponseJson.h>
#include <plugins/PlayerManager.h>
#include <structures/Exceptions.h>
#include <types/ResultCode.h>

using namespace drogon;
using namespace std;
using namespace techmino::filters;
using namespace techmino::helpers;
using namespace techmino::plugins;
using namespace techmino::structures;
using namespace techmino::types;

void CheckAccessToken::doFilter(
        const HttpRequestPtr &req,
        FilterCallback &&failedCb,
        FilterChainCallback &&nextCb
) {
    LOG_INFO << "TECHRATER_WS_FILTER_BEGIN path=" << req->path();
    auto accessToken = req->getHeader("x-access-token");
    if (accessToken.empty()) {
        accessToken = req->getParameter("access_token");
    }
    if (accessToken.empty()) {
        LOG_WARN << "TECHRATER_WS_FILTER_REJECT reason=missing_token";
        ResponseJson(k400BadRequest, ResultCode::InvalidArguments)
                .setMessage(i18n("invalidArguments"))
                .to(failedCb);
        return;
    }
    try {
        const auto playerManager = app().getPlugin<PlayerManager>();
        if (playerManager->tryRefresh(accessToken)) {
            req->attributes()->insert("accessToken", accessToken);
        }
        const auto playerId = playerManager->getPlayerIdByAccessToken(accessToken);
        req->attributes()->insert("playerId", playerId);
        LOG_INFO << "TECHRATER_WS_FILTER_ACCEPT playerId=" << playerId;
    } catch (const ResponseException &e) {
        LOG_WARN << "TECHRATER_WS_FILTER_REJECT reason=invalid_token";
        e.toJson().to(failedCb);
        return;
    } catch (const exception &e) {
        LOG_ERROR << "TECHRATER_WS_FILTER_ERROR reason=" << e.what();
        throw;
    }
    nextCb();
}
