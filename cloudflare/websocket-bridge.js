(() => {
  "use strict";

  const serverUrl = globalThis.TECHMINO_SERVER_URL;
  if (!serverUrl) throw new Error("TECHMINO_SERVER_URL is not configured");

  const sockets = new Map();
  const guestNameKey = "techmino.guestName";
  const sessionTokenKey = "techmino.sessionToken";
  const accountKey = "techmino.account";
  const cloudSaveMetaPrefix = "techmino.cloudSaveMeta";
  const cloudSaveFixedFiles = Object.freeze([
    "conf/data",
    "conf/unlock",
    "conf/settings",
    "conf/key",
    "conf/virtualkey",
    "conf/vkSave1",
    "conf/vkSave2",
  ]);
  const cloudSaveRecordPattern = /^record\/[A-Za-z0-9_-]+\.rec$/;
  const cloudSaveMaxBytes = 1_500_000;
  const memoryStorage = new Map();
  const errorOverlayId = "techmino-multiplayer-error";
  const accountOverlayId = "techmino-account-overlay";
  const defaultAccountStrings = Object.freeze({
    title: "Account",
    choosePlay: "Sign in to play",
    intro: "Sign in with your ID and password to use multiplayer.",
    signedInAs: "Signed in as %s",
    signInPrompt: "Sign in to keep the same account across devices.",
    close: "Close",
    accountId: "ID",
    accountName: "Account name",
    passwordHint: "Password (8 characters minimum)",
    signIn: "Sign in",
    createAccount: "Create account",
    registrationPrompt: "Choose an ID, account name, and password.",
    signOut: "Sign out",
    signInRequired: "Sign in before using multiplayer.",
    sessionExpired: "Your session expired. Sign in again.",
    invalidCredentials: "Enter a valid ID and a password with at least 8 characters.",
    invalidRegistration: "Enter a valid ID, account name, and password with at least 8 characters.",
    idTaken: "This ID is already taken.",
    rateLimited: "Too many sign-in attempts. Try again later.",
    signingIn: "Signing in...",
    creatingAccount: "Creating account...",
    authFailed: "Authentication failed.",
  });
  let accountNotice = "";
  let accountStrings = { ...defaultAccountStrings };
  let pendingAccountDialog = false;
  let accountFullscreenTarget = null;
  let cloudSaveDirectory = null;
  let cloudSaveInitialized = false;
  let cloudSaveTimer = null;
  let cloudSavePromise = null;
  let cloudSaveStatus = { state: "idle" };

  class SignInRequiredError extends Error {
    constructor(message) {
      super(message);
      this.name = "SignInRequiredError";
    }
  }

  function currentFullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }

  async function leaveFullscreenForAccount() {
    const activeElement = currentFullscreenElement();
    if (!activeElement) return;
    accountFullscreenTarget = activeElement;
    try {
      if (document.exitFullscreen) {
        await document.exitFullscreen();
      } else if (document.webkitExitFullscreen) {
        document.webkitExitFullscreen();
      }
    } catch (error) {
      console.warn("Could not exit fullscreen before opening account settings.", error);
    }
  }

  function restoreAccountFullscreen() {
    const target = accountFullscreenTarget;
    accountFullscreenTarget = null;
    if (!target || !target.isConnected || currentFullscreenElement()) return;
    try {
      const request = target.requestFullscreen
        ? target.requestFullscreen()
        : target.webkitRequestFullscreen
          ? target.webkitRequestFullscreen()
          : target.webkitRequestFullScreen
            ? target.webkitRequestFullScreen()
            : null;
      if (request && typeof request.catch === "function") {
        request.catch((error) => console.warn("Could not restore fullscreen.", error));
      }
    } catch (error) {
      console.warn("Could not restore fullscreen.", error);
    }
  }

  function removeConnectionError() {
    document.getElementById(errorOverlayId)?.remove();
  }

  function showConnectionError(message) {
    removeConnectionError();

    const overlay = document.createElement("div");
    overlay.id = errorOverlayId;
    Object.assign(overlay.style, {
      position: "fixed",
      inset: "0",
      zIndex: "2147483647",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "24px",
      background: "rgba(0, 0, 0, 0.72)",
      fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
    });

    const panel = document.createElement("div");
    Object.assign(panel.style, {
      width: "min(560px, 100%)",
      padding: "24px",
      border: "1px solid rgba(255, 255, 255, 0.2)",
      borderRadius: "16px",
      background: "#171717",
      color: "#f5f5f5",
      boxShadow: "0 24px 80px rgba(0, 0, 0, 0.45)",
    });

    const title = document.createElement("div");
    title.textContent = "Multiplayer connection failed";
    Object.assign(title.style, {
      marginBottom: "12px",
      fontSize: "22px",
      fontWeight: "700",
    });

    const description = document.createElement("div");
    description.textContent = "The game returned to the main menu because the online connection could not be established.";
    Object.assign(description.style, {
      marginBottom: "16px",
      color: "#d4d4d4",
      fontSize: "15px",
      lineHeight: "1.5",
    });

    const details = document.createElement("pre");
    details.textContent = String(message || "Unknown connection error");
    Object.assign(details.style, {
      margin: "0 0 20px",
      padding: "14px",
      overflowWrap: "anywhere",
      whiteSpace: "pre-wrap",
      borderRadius: "10px",
      background: "#0a0a0a",
      color: "#fca5a5",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: "13px",
      lineHeight: "1.45",
    });

    const actions = document.createElement("div");
    Object.assign(actions.style, {
      display: "flex",
      justifyContent: "flex-end",
      gap: "10px",
    });

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.textContent = "Close";
    Object.assign(closeButton.style, {
      padding: "10px 16px",
      border: "1px solid #525252",
      borderRadius: "10px",
      background: "transparent",
      color: "#f5f5f5",
      font: "inherit",
      cursor: "pointer",
    });
    closeButton.addEventListener("click", removeConnectionError);

    const reloadButton = document.createElement("button");
    reloadButton.type = "button";
    reloadButton.textContent = "Reload game";
    Object.assign(reloadButton.style, {
      padding: "10px 16px",
      border: "0",
      borderRadius: "10px",
      background: "#7c3aed",
      color: "#ffffff",
      font: "inherit",
      fontWeight: "700",
      cursor: "pointer",
    });
    reloadButton.addEventListener("click", () => globalThis.location.reload());

    actions.append(closeButton, reloadButton);
    panel.append(title, description, details, actions);
    overlay.append(panel);
    document.body.append(overlay);
  }

  function getStoredValue(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return memoryStorage.get(key) || null;
    }
  }

  function setStoredValue(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      memoryStorage.set(key, value);
    }
  }

  function removeStoredValue(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      memoryStorage.delete(key);
    }
  }

  function storedSessionToken() {
    return getStoredValue(sessionTokenKey);
  }

  function clearStoredSession() {
    removeStoredValue(sessionTokenKey);
    removeStoredValue(accountKey);
  }

  function storedAccount() {
    try {
      const value = getStoredValue(accountKey);
      return value ? JSON.parse(value) : null;
    } catch {
      return null;
    }
  }

  function storeAccount(account) {
    if (account && typeof account === "object") {
      const mergedAccount = { ...(storedAccount() || {}), ...account };
      setStoredValue(accountKey, JSON.stringify(mergedAccount));
      if (typeof mergedAccount.displayName === "string" && mergedAccount.displayName) {
        setStoredValue(guestNameKey, mergedAccount.displayName.slice(0, 24));
      }
    }
  }

  function defaultGuestName(playerId) {
    return `Guest-${String(playerId).slice(-6)}`;
  }

  function guestName(playerId) {
    let name = getStoredValue(guestNameKey);
    if (!name) {
      name = defaultGuestName(playerId);
      setStoredValue(guestNameKey, name);
    }
    return name.slice(0, 24);
  }

  function addGuestName(player) {
    if (player && typeof player === "object" && player.playerId && !player.username) {
      player.username = defaultGuestName(player.playerId);
    }
  }

  function normalizeServerMessage(message) {
    try {
      const body = JSON.parse(message);
      if ((body.action === 1301 || body.action === 1306) && body.errno === 0 && body.data) {
        if (Array.isArray(body.data.players)) body.data.players.forEach(addGuestName);
        else addGuestName(body.data);
        return JSON.stringify(body);
      }
    } catch {
      // Forward malformed or non-JSON payloads unchanged for the game to handle.
    }
    return message;
  }

  function writeEvent(state, event) {
    if (!state.active) return;
    state.sequence += 1;
    const sequence = String(state.sequence).padStart(8, "0");
    FS.writeFile(`${state.saveDirectory}/__techmino_ws_${state.name}_${sequence}`, JSON.stringify(event));
    FS.writeFile(`${state.saveDirectory}/__techmino_ws_${state.name}_count`, String(state.sequence));
  }

  async function requestSession(body = {}) {
    return fetch(`${serverUrl}/_worker/auth/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function updateDisplayName(displayName) {
    const name = String(displayName || "").trim();
    if (!name || name.length > 24) {
      throw new Error("Display name must be between 1 and 24 characters.");
    }
    const refreshToken = storedSessionToken();
    if (!refreshToken) throw new Error("Sign in or create a guest session first.");

    const response = await fetch(`${serverUrl}/_worker/auth/profile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken, displayName: name }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(typeof result.error === "string" ? result.error : `Could not save the display name (${response.status}).`);
    }
    if (typeof result.refreshToken === "string" && result.refreshToken) {
      setStoredValue(sessionTokenKey, result.refreshToken);
    }
    storeAccount(result.account);
    setStoredValue(guestNameKey, name);
    return name;
  }

  async function createSession(authRequest) {
    const refreshToken = authRequest ? null : storedSessionToken();
    if (!authRequest && !refreshToken) {
      throw new SignInRequiredError(accountStrings.signInRequired);
    }
    const response = await requestSession(authRequest || { refreshToken });
    if (!response.ok && refreshToken && !authRequest) {
      clearStoredSession();
      throw new SignInRequiredError(accountStrings.sessionExpired);
    }
    if (!response.ok) {
      let reason = `Authentication failed (${response.status})`;
      let code = "auth_failed";
      try {
        const body = await response.json();
        if (typeof body.error === "string" && body.error) reason = body.error;
        if (typeof body.code === "string" && body.code) code = body.code;
      } catch {
        // Keep the HTTP status when the server does not return JSON.
      }
      const error = new Error(reason);
      error.authCode = code;
      throw error;
    }
    const session = await response.json();
    if (!session.refreshToken || !session.accessToken || !session.playerId) {
      throw new Error("The authentication server returned an incomplete session.");
    }
    if (session.account?.isAnonymous) {
      clearStoredSession();
      throw new SignInRequiredError(accountStrings.signInRequired);
    }
    setStoredValue(sessionTokenKey, session.refreshToken);
    storeAccount({ ...session.account, playerId: session.playerId });
    return session;
  }

  function style(element, rules) {
    Object.assign(element.style, rules);
    return element;
  }

  function accountButton(label, primary = false) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    return style(button, {
      minHeight: "44px",
      padding: "10px 14px",
      border: primary ? "0" : "1px solid #525252",
      borderRadius: "10px",
      background: primary ? "#2563eb" : "#262626",
      color: "#ffffff",
      font: "600 15px system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
      cursor: "pointer",
    });
  }

  function setAccountStrings(strings) {
    if (strings && typeof strings === "object") {
      accountStrings = { ...defaultAccountStrings, ...strings };
    }
  }

  function formatAccountText(template, value) {
    return String(template || "").replace("%s", String(value || ""));
  }

  function hasStoredIdentity() {
    const account = storedAccount();
    return Boolean(account?.id && !account.isAnonymous && storedSessionToken());
  }

  function clearAnonymousIdentity() {
    if (storedAccount()?.isAnonymous) {
      clearStoredSession();
    }
  }

  function cloudSaveAccountId() {
    const account = storedAccount();
    return account?.playerId || account?.id || null;
  }

  function cloudSaveMetaKey() {
    const accountId = cloudSaveAccountId();
    return accountId ? `${cloudSaveMetaPrefix}.${accountId}` : null;
  }

  function readCloudSaveMeta() {
    const key = cloudSaveMetaKey();
    if (!key) return { revision: 0, dirty: false, conflict: false, lastSynced: null };
    try {
      const value = getStoredValue(key);
      const meta = value ? JSON.parse(value) : {};
      return {
        revision: Number.isSafeInteger(meta.revision) && meta.revision >= 0 ? meta.revision : 0,
        dirty: meta.dirty === true,
        conflict: meta.conflict === true,
        lastSynced: typeof meta.lastSynced === "string" ? meta.lastSynced : null,
      };
    } catch {
      return { revision: 0, dirty: false, conflict: false, lastSynced: null };
    }
  }

  function writeCloudSaveMeta(meta) {
    const key = cloudSaveMetaKey();
    if (key) setStoredValue(key, JSON.stringify(meta));
  }

  function setCloudSaveStatus(state, details = {}) {
    cloudSaveStatus = { state, ...details };
    return cloudSaveStatus;
  }

  function isCloudSavePath(path) {
    return cloudSaveFixedFiles.includes(path) || cloudSaveRecordPattern.test(path);
  }

  function fileExists(path) {
    try {
      return FS.isFile(FS.stat(path).mode);
    } catch {
      return false;
    }
  }

  function readSaveFile(path) {
    try {
      return FS.readFile(path, { encoding: "utf8" });
    } catch {
      return null;
    }
  }

  function collectCloudSave() {
    if (!cloudSaveDirectory) throw new Error("The game save directory is not ready.");
    const files = {};
    for (const path of cloudSaveFixedFiles) {
      const content = readSaveFile(`${cloudSaveDirectory}/${path}`);
      if (typeof content === "string") files[path] = content;
    }

    const recordDirectory = `${cloudSaveDirectory}/record`;
    try {
      for (const name of FS.readdir(recordDirectory)) {
        const path = `record/${name}`;
        if (!cloudSaveRecordPattern.test(path)) continue;
        const content = readSaveFile(`${cloudSaveDirectory}/${path}`);
        if (typeof content === "string") files[path] = content;
      }
    } catch {
      // A new profile may not have a record directory yet.
    }

    const payload = { schemaVersion: 1, files };
    if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > cloudSaveMaxBytes) {
      throw new Error("Cloud save exceeds the 1.5 MB limit.");
    }
    return payload;
  }

  function validateRemoteCloudSave(payload) {
    if (!payload || payload.schemaVersion !== 1 || !payload.files || typeof payload.files !== "object") {
      throw new Error("The cloud save has an unsupported format.");
    }
    const files = {};
    for (const [path, content] of Object.entries(payload.files)) {
      if (!isCloudSavePath(path) || typeof content !== "string") {
        throw new Error("The cloud save contains invalid data.");
      }
      files[path] = content;
    }
    return { schemaVersion: 1, files };
  }

  async function cloudSaveRequest(path, body) {
    const refreshToken = storedSessionToken();
    if (!refreshToken) throw new SignInRequiredError(accountStrings.signInRequired);
    const response = await fetch(`${serverUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, refreshToken }),
    });
    const result = await response.json().catch(() => ({}));
    if (typeof result.refreshToken === "string" && result.refreshToken) {
      setStoredValue(sessionTokenKey, result.refreshToken);
    }
    if (!response.ok) {
      const error = new Error(typeof result.error === "string" ? result.error : `Cloud save request failed (${response.status}).`);
      error.cloudConflict = result.conflict === true || response.status === 409;
      throw error;
    }
    return result;
  }

  async function loadCloudSave() {
    const result = await cloudSaveRequest("/_worker/save/load", {});
    if (!result.save) return null;
    return {
      revision: result.save.revision,
      payload: validateRemoteCloudSave(result.save.payload),
      updatedAt: result.save.updatedAt,
    };
  }

  async function storeCloudSave(payload, expectedRevision) {
    const result = await cloudSaveRequest("/_worker/save/store", { payload, expectedRevision });
    if (!result.save || !Number.isSafeInteger(result.save.revision)) {
      throw new Error("The cloud save server returned an incomplete response.");
    }
    return result.save;
  }

  function flushSaveFileSystem() {
    return new Promise((resolve, reject) => {
      if (!globalThis.FS || typeof FS.syncfs !== "function") {
        resolve();
        return;
      }
      FS.syncfs(false, (error) => error ? reject(error) : resolve());
    });
  }

  async function applyCloudSave(remote) {
    if (!cloudSaveDirectory) throw new Error("The game save directory is not ready.");
    const payload = validateRemoteCloudSave(remote.payload);
    const currentPaths = [...cloudSaveFixedFiles];
    try {
      for (const name of FS.readdir(`${cloudSaveDirectory}/record`)) {
        const path = `record/${name}`;
        if (cloudSaveRecordPattern.test(path)) currentPaths.push(path);
      }
    } catch {
      // The directory is created below when the cloud save contains records.
    }
    for (const path of currentPaths) {
      const fullPath = `${cloudSaveDirectory}/${path}`;
      if (fileExists(fullPath)) FS.unlink(fullPath);
    }
    FS.mkdirTree(`${cloudSaveDirectory}/conf`);
    FS.mkdirTree(`${cloudSaveDirectory}/record`);
    for (const [path, content] of Object.entries(payload.files)) {
      FS.writeFile(`${cloudSaveDirectory}/${path}`, content);
    }
    await flushSaveFileSystem();
    const meta = {
      revision: remote.revision,
      dirty: false,
      conflict: false,
      lastSynced: remote.updatedAt || new Date().toISOString(),
    };
    writeCloudSaveMeta(meta);
    setCloudSaveStatus("restored", { lastSynced: meta.lastSynced });
    globalThis.setTimeout(() => globalThis.location.reload(), 250);
    return cloudSaveStatus;
  }

  async function uploadCloudSave(expectedRevision) {
    const saved = await storeCloudSave(collectCloudSave(), expectedRevision);
    const meta = {
      revision: saved.revision,
      dirty: false,
      conflict: false,
      lastSynced: saved.updatedAt || new Date().toISOString(),
    };
    writeCloudSaveMeta(meta);
    return setCloudSaveStatus("synced", { lastSynced: meta.lastSynced, revision: meta.revision });
  }

  async function performCloudSaveSync(mode) {
    if (!hasStoredIdentity()) return setCloudSaveStatus("signed-out");
    if (!cloudSaveDirectory) throw new Error("The game save directory is not ready.");
    setCloudSaveStatus("syncing");
    const remote = await loadCloudSave();
    const meta = readCloudSaveMeta();

    if (mode === "download") {
      if (!remote) throw new Error("No cloud save exists for this account.");
      return applyCloudSave(remote);
    }
    if (mode === "upload") {
      return uploadCloudSave(remote?.revision || 0);
    }
    if (!remote) return uploadCloudSave(0);

    if (meta.revision === 0) {
      meta.conflict = true;
      writeCloudSaveMeta(meta);
      return setCloudSaveStatus("conflict", { cloudUpdatedAt: remote.updatedAt });
    }
    if (meta.revision !== remote.revision) {
      if (!meta.dirty && meta.revision < remote.revision) return applyCloudSave(remote);
      meta.conflict = true;
      writeCloudSaveMeta(meta);
      return setCloudSaveStatus("conflict", { cloudUpdatedAt: remote.updatedAt });
    }
    if (meta.dirty) return uploadCloudSave(meta.revision);
    meta.conflict = false;
    meta.lastSynced = remote.updatedAt || meta.lastSynced;
    writeCloudSaveMeta(meta);
    return setCloudSaveStatus("synced", { lastSynced: meta.lastSynced, revision: meta.revision });
  }

  function syncCloudSave(mode = "smart") {
    if (!new Set(["smart", "upload", "download"]).has(mode)) {
      return Promise.reject(new Error("Unknown cloud save mode."));
    }
    if (cloudSavePromise) return cloudSavePromise;
    cloudSavePromise = performCloudSaveSync(mode)
      .catch((error) => {
        if (error?.cloudConflict) {
          const meta = readCloudSaveMeta();
          meta.conflict = true;
          writeCloudSaveMeta(meta);
          return setCloudSaveStatus("conflict");
        }
        setCloudSaveStatus("error", { message: error instanceof Error ? error.message : String(error) });
        throw error;
      })
      .finally(() => {
        cloudSavePromise = null;
      });
    return cloudSavePromise;
  }

  function scheduleCloudSave() {
    if (!hasStoredIdentity() || readCloudSaveMeta().conflict) return;
    if (cloudSaveTimer) globalThis.clearTimeout(cloudSaveTimer);
    cloudSaveTimer = globalThis.setTimeout(() => {
      cloudSaveTimer = null;
      syncCloudSave("smart").catch((error) => console.error("Could not sync Techmino cloud save", error));
    }, 5000);
  }

  function initializeCloudSave(saveDirectory) {
    cloudSaveDirectory = String(saveDirectory || "").replace(/\/$/, "");
    if (!cloudSaveDirectory) return;
    cloudSaveInitialized = true;
    if (!hasStoredIdentity()) {
      setCloudSaveStatus("signed-out");
      return;
    }
    const meta = readCloudSaveMeta();
    setCloudSaveStatus(meta.conflict ? "conflict" : meta.lastSynced ? "synced" : "idle", {
      lastSynced: meta.lastSynced,
      revision: meta.revision,
    });
    globalThis.setTimeout(() => {
      syncCloudSave("smart").catch((error) => console.error("Could not initialize Techmino cloud save", error));
    }, 1500);
  }

  function cloudSaveFileChanged(saveDirectory, path) {
    if (!cloudSaveInitialized || !isCloudSavePath(String(path || ""))) return;
    if (cloudSaveDirectory !== String(saveDirectory || "").replace(/\/$/, "")) return;
    const meta = readCloudSaveMeta();
    meta.dirty = true;
    writeCloudSaveMeta(meta);
    setCloudSaveStatus(meta.conflict ? "conflict" : "pending", {
      lastSynced: meta.lastSynced,
      revision: meta.revision,
    });
    scheduleCloudSave();
  }

  function getCloudSaveStatus() {
    if (!hasStoredIdentity()) return JSON.stringify({ state: "signed-out" });
    const meta = readCloudSaveMeta();
    const status = cloudSaveStatus.state === "idle"
      ? { state: meta.conflict ? "conflict" : meta.lastSynced ? "synced" : "idle" }
      : cloudSaveStatus;
    return JSON.stringify({
      ...status,
      lastSynced: status.lastSynced || meta.lastSynced,
      lastSyncedText: (status.lastSynced || meta.lastSynced)
        ? new Date(status.lastSynced || meta.lastSynced).toLocaleString()
        : null,
      revision: status.revision || meta.revision,
    });
  }

  async function showAccountDialog(message = accountNotice, options = {}) {
    document.getElementById(accountOverlayId)?.remove();
    await leaveFullscreenForAccount();
    accountNotice = "";
    const initialChoice = options.initialChoice === true;
    const labels = accountStrings;

    const overlay = style(document.createElement("div"), {
      position: "fixed",
      inset: "0",
      zIndex: "2147483646",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "20px",
      background: "rgba(0, 0, 0, 0.72)",
      fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
      pointerEvents: "auto",
      touchAction: "manipulation",
    });
    overlay.id = accountOverlayId;

    for (const eventName of [
      "keydown",
      "keyup",
      "keypress",
      "beforeinput",
      "input",
      "compositionstart",
      "compositionupdate",
      "compositionend",
    ]) {
      overlay.addEventListener(eventName, (event) => event.stopPropagation());
    }

    const panel = style(document.createElement("div"), {
      width: "min(460px, 100%)",
      maxHeight: "min(680px, calc(100vh - 40px))",
      overflowY: "auto",
      padding: "22px",
      border: "1px solid rgba(255, 255, 255, 0.18)",
      borderRadius: "16px",
      background: "#171717",
      color: "#f5f5f5",
      boxShadow: "0 24px 80px rgba(0, 0, 0, 0.5)",
    });

    const header = style(document.createElement("div"), {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "16px",
      marginBottom: "8px",
    });
    const title = style(document.createElement("h2"), { margin: "0", fontSize: "24px" });
    title.textContent = initialChoice ? labels.choosePlay : labels.title;
    header.append(title);
    if (!initialChoice) {
      const closeButton = accountButton(labels.close);
      closeButton.addEventListener("click", () => {
        overlay.remove();
        restoreAccountFullscreen();
      });
      header.append(closeButton);
    }

    const account = storedAccount();
    const accountText = style(document.createElement("p"), {
      margin: "0 0 14px",
      color: "#d4d4d4",
      lineHeight: "1.5",
    });
    accountText.textContent = account?.id
      ? formatAccountText(labels.signedInAs, account.id)
      : initialChoice
        ? labels.intro
        : labels.signInPrompt;

    const status = style(document.createElement("div"), {
      display: message ? "block" : "none",
      marginBottom: "14px",
      padding: "10px 12px",
      borderRadius: "9px",
      background: "#262626",
      color: "#bfdbfe",
      fontSize: "14px",
      lineHeight: "1.4",
    });
    status.textContent = message;

    const inputStyle = {
      width: "100%",
      minHeight: "46px",
      padding: "10px 12px",
      border: "1px solid #525252",
      borderRadius: "10px",
      background: "#0a0a0a",
      color: "#ffffff",
      font: "16px system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
      boxSizing: "border-box",
      pointerEvents: "auto",
      touchAction: "auto",
      userSelect: "text",
      WebkitUserSelect: "text",
      WebkitAppearance: "none",
    };

    const form = style(document.createElement("div"), {
      display: account?.id ? "none" : "block",
    });
    const modeActions = style(document.createElement("div"), {
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: "8px",
      marginBottom: "12px",
    });
    const signInModeButton = accountButton(labels.signIn, true);
    const registerModeButton = accountButton(labels.createAccount);
    modeActions.append(signInModeButton, registerModeButton);

    const loginId = style(document.createElement("input"), inputStyle);
    loginId.type = "text";
    loginId.autocomplete = "username";
    loginId.autocapitalize = "none";
    loginId.spellcheck = false;
    loginId.placeholder = labels.accountId;
    loginId.setAttribute("aria-label", labels.accountId);

    const accountName = style(document.createElement("input"), { ...inputStyle, marginTop: "10px" });
    accountName.type = "text";
    accountName.autocomplete = "nickname";
    accountName.placeholder = labels.accountName;
    accountName.setAttribute("aria-label", labels.accountName);

    const password = style(document.createElement("input"), { ...inputStyle, marginTop: "10px" });
    password.type = "password";
    password.autocomplete = "current-password";
    password.placeholder = labels.passwordHint;
    password.setAttribute("aria-label", labels.passwordHint);

    const submitButton = accountButton(labels.signIn, true);
    submitButton.style.width = "100%";
    submitButton.style.marginTop = "12px";

    let mode = "login";

    function setStatus(text, isError = false) {
      status.style.display = "block";
      status.style.color = isError ? "#fecaca" : "#bfdbfe";
      status.textContent = text;
    }

    function setMode(nextMode) {
      mode = nextMode;
      const registering = mode === "register";
      accountName.style.display = registering ? "block" : "none";
      password.autocomplete = registering ? "new-password" : "current-password";
      accountText.textContent = registering ? labels.registrationPrompt : labels.intro;
      submitButton.textContent = registering ? labels.createAccount : labels.signIn;
      signInModeButton.style.background = registering ? "#262626" : "#2563eb";
      registerModeButton.style.background = registering ? "#2563eb" : "#262626";
      status.style.display = "none";
    }

    function localizedAuthError(error) {
      if (!(error instanceof Error)) return labels.authFailed;
      if (error.authCode === "id_taken") return labels.idTaken;
      if (error.authCode === "rate_limited") return labels.rateLimited;
      if (error.authCode === "invalid_id" || error.authCode === "invalid_password") {
        return mode === "register" ? labels.invalidRegistration : labels.invalidCredentials;
      }
      if (error.authCode === "invalid_account_name") return labels.invalidRegistration;
      return error.message || labels.authFailed;
    }

    async function submitAuth() {
      if (submitButton.disabled) return;
      const loginIdValue = loginId.value.trim();
      const accountNameValue = accountName.value.trim();
      const passwordValue = password.value;
      const validId = /^[A-Za-z0-9][A-Za-z0-9_.-]{3,31}$/.test(loginIdValue);
      if (!validId || passwordValue.length < 8 || (mode === "register" && !accountNameValue)) {
        setStatus(mode === "register" ? labels.invalidRegistration : labels.invalidCredentials, true);
        return;
      }
      submitButton.disabled = true;
      signInModeButton.disabled = true;
      registerModeButton.disabled = true;
      setStatus(mode === "login" ? labels.signingIn : labels.creatingAccount);
      try {
        await createSession({
          mode,
          loginId: loginIdValue,
          accountName: mode === "register" ? accountNameValue : undefined,
          password: passwordValue,
        });
        globalThis.location.reload();
      } catch (error) {
        setStatus(localizedAuthError(error), true);
      } finally {
        submitButton.disabled = false;
        signInModeButton.disabled = false;
        registerModeButton.disabled = false;
      }
    }

    signInModeButton.addEventListener("click", () => setMode("login"));
    registerModeButton.addEventListener("click", () => setMode("register"));
    submitButton.addEventListener("click", submitAuth);
    for (const input of [loginId, accountName, password]) {
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") submitAuth();
      });
    }

    form.append(modeActions, loginId, accountName, password, submitButton);
    setMode("login");

    const signedInActions = style(document.createElement("div"), {
      display: account?.id ? "grid" : "none",
      gap: "10px",
    });
    const signOutButton = accountButton(labels.signOut);
    signOutButton.addEventListener("click", async () => {
      const refreshToken = storedSessionToken();
      try {
        if (refreshToken) {
          await fetch(`${serverUrl}/_worker/auth/logout`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ refreshToken }),
            keepalive: true,
          });
        }
      } finally {
        clearStoredSession();
        globalThis.location.reload();
      }
    });
    signedInActions.append(signOutButton);

    panel.append(header, accountText, status, form, signedInActions);
    overlay.append(panel);
    document.body.append(overlay);
  }

  function initializeAccountUI() {
    clearAnonymousIdentity();
    window.onclick = (event) => {
      const target = event?.target;
      if (!(target instanceof Element) || !target.closest(`#${accountOverlayId}`)) {
        window.focus();
      }
    };
    document.getElementById("techmino-account-button")?.remove();
    if (accountNotice) {
      pendingAccountDialog = true;
    } else if (!hasStoredIdentity()) {
      pendingAccountDialog = true;
    }
  }

  async function connect(name, socketPath, saveDirectory) {
    close(name);
    removeConnectionError();
    const state = {
      name,
      saveDirectory,
      sequence: 0,
      socket: null,
      active: true,
      opened: false,
      manualClose: false,
    };
    FS.writeFile(`${saveDirectory}/__techmino_ws_${name}_count`, "0");
    sockets.set(name, state);

    try {
      const session = await createSession();
      writeEvent(state, {
        type: "message",
        data: JSON.stringify({
          action: 9000,
          errno: 0,
          data: { playerId: session.playerId, username: guestName(session.playerId) },
        }),
      });

      const socketBase = new URL(serverUrl);
      socketBase.protocol = socketBase.protocol === "https:" ? "wss:" : "ws:";
      const url = new URL(socketPath || "/techmino/ws/v1", socketBase);
      url.searchParams.set("access_token", session.accessToken);
      const socket = new WebSocket(url);
      state.socket = socket;
      socket.addEventListener("open", () => {
        state.opened = true;
        writeEvent(state, { type: "open" });
      });
      socket.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
          writeEvent(state, { type: "message", data: normalizeServerMessage(event.data) });
        }
      });
      socket.addEventListener("error", () => {
        writeEvent(state, { type: "error" });
        if (!state.manualClose) {
          showConnectionError("The browser could not establish a WebSocket connection to the multiplayer server.");
        }
      });
      socket.addEventListener("close", (event) => {
        const reason = event.reason || (event.code === 1006
          ? "The WebSocket closed abnormally without a server response."
          : "The multiplayer server closed the connection.");
        writeEvent(state, { type: "close", code: event.code, reason });
        if (!state.manualClose) {
          showConnectionError(`WebSocket closed (${event.code})\n${reason}`);
        }
        state.active = false;
        if (sockets.get(name) === state) sockets.delete(name);
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Authentication failed";
      writeEvent(state, {
        type: "close",
        code: 4003,
        reason,
      });
      if (error instanceof SignInRequiredError) {
        accountNotice = reason;
        showAccountDialog(reason, { initialChoice: true });
      } else {
        showConnectionError(reason);
      }
      state.active = false;
    }
  }

  function send(name, message) {
    const socket = sockets.get(name)?.socket;
    if (socket?.readyState === WebSocket.OPEN) socket.send(message);
  }

  function close(name) {
    const state = sockets.get(name);
    if (state) {
      state.active = false;
      state.manualClose = true;
    }
    if (state?.socket && state.socket.readyState < WebSocket.CLOSING) {
      state.socket.close(1000, "Client closed");
    }
    sockets.delete(name);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeAccountUI, { once: true });
  } else {
    initializeAccountUI();
  }

  globalThis.TechminoAccount = {
    setStrings(strings) {
      setAccountStrings(strings);
      if (pendingAccountDialog) {
        pendingAccountDialog = false;
        showAccountDialog(accountNotice, { initialChoice: !hasStoredIdentity() });
      }
    },
    open(strings) {
      setAccountStrings(strings);
      showAccountDialog();
    },
    getDisplayName() {
      return guestName(storedAccount()?.playerId || "");
    },
    getAccountInfo() {
      const account = storedAccount();
      if (!account || account.isAnonymous) return JSON.stringify({ state: "signed-out" });
      return JSON.stringify({
        state: "signed-in",
        id: account.id || "",
        accountName: account.displayName || "",
      });
    },
    async setDisplayName(name) {
      const savedName = await updateDisplayName(name);
      return savedName;
    },
  };
  globalThis.TechminoCloudSave = {
    initialize: initializeCloudSave,
    fileSaved: cloudSaveFileChanged,
    getStatus: getCloudSaveStatus,
    sync: syncCloudSave,
  };
  globalThis.TechminoSocket = { connect, send, close };
})();
