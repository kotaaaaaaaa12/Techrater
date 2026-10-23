#include <drogon/drogon.h>
#include <plugins/NoticeManager.h>

using namespace drogon;
using namespace std;
using namespace techmino::helpers;
using namespace techmino::plugins;

NoticeManager::NoticeManager() = default;

void NoticeManager::initAndStart(const Json::Value &config) {
    _fallbackLanguage = config.get("fallbackLanguage", "en_us").asString();
    LOG_INFO << "NoticeManager loaded with D1 storage.";
}

void NoticeManager::shutdown() {
    LOG_INFO << "NoticeManager shutdown.";
}

uint64_t NoticeManager::createNotice(const Json::Value &contents) {
    Json::Value payload;
    payload["values"] = contents;
    return D1Store::call("notice.create", payload).asUInt64();
}

Json::Value NoticeManager::retrieveNotice(uint64_t lastCount, const string &language) {
    Json::Value payload;
    payload["lastCount"] = Json::UInt64(lastCount);
    payload["language"] = language;
    payload["fallbackLanguage"] = _fallbackLanguage;
    return D1Store::call("notice.list", payload);
}

Json::Value NoticeManager::retrieveNotice(uint64_t pageIndex, uint64_t pageSize, const string &language) {
    Json::Value payload;
    payload["pageIndex"] = Json::UInt64(pageIndex);
    payload["pageSize"] = Json::UInt64(pageSize);
    payload["language"] = language;
    payload["fallbackLanguage"] = _fallbackLanguage;
    return D1Store::call("notice.list", payload);
}

void NoticeManager::updateNotice(uint64_t noticeId, const Json::Value &contents) {
    Json::Value payload;
    payload["noticeId"] = Json::UInt64(noticeId);
    payload["values"] = contents;
    D1Store::call("notice.update", payload);
}

void NoticeManager::deleteNotice(uint64_t noticeId) {
    Json::Value payload;
    payload["noticeId"] = Json::UInt64(noticeId);
    D1Store::call("notice.delete", payload);
}
