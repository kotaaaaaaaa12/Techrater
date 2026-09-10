(() => {
  "use strict";

  const serverUrl = globalThis.TECHMINO_SERVER_URL;
  if (!serverUrl) throw new Error("TECHMINO_SERVER_URL is not configured");

  const sockets = new Map();
  const guestNameKey = "techmino.guestName";
  const refreshTokenKey = "techmino.supabaseRefreshToken";
  const accountKey = "techmino.account";
  const memoryStorage = new Map();
  const errorOverlayId = "techmino-multiplayer-error";
  const accountOverlayId = "techmino-account-overlay";
  let accountNotice = "";

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
      setStoredValue(accountKey, JSON.stringify(account));
      if (typeof account.displayName === "string" && account.displayName) {
        setStoredValue(guestNameKey, account.displayName.slice(0, 24));
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

  async function createSession(authRequest) {
    const refreshToken = authRequest ? null : getStoredValue(refreshTokenKey);
    let response = await requestSession(authRequest || (refreshToken ? { refreshToken } : { mode: "guest" }));
    if (!response.ok && refreshToken && !authRequest) {
      removeStoredValue(refreshTokenKey);
      removeStoredValue(accountKey);
      response = await requestSession({ mode: "guest" });
    }
    if (!response.ok) {
      let reason = `Authentication failed (${response.status})`;
      try {
        const body = await response.json();
        if (typeof body.error === "string" && body.error) reason = body.error;
      } catch {
        // Keep the HTTP status when the server does not return JSON.
      }
      throw new Error(reason);
    }
    const session = await response.json();
    if (session.confirmationRequired) return session;
    if (!session.refreshToken || !session.accessToken || !session.playerId) {
      throw new Error("The authentication server returned an incomplete session.");
    }
    setStoredValue(refreshTokenKey, session.refreshToken);
    storeAccount(session.account);
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

  function showAccountDialog(message = accountNotice) {
    document.getElementById(accountOverlayId)?.remove();
    accountNotice = "";

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
    });
    overlay.id = accountOverlayId;

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
    title.textContent = "Techmino Account";
    const closeButton = accountButton("Close");
    closeButton.addEventListener("click", () => overlay.remove());
    header.append(title, closeButton);

    const account = storedAccount();
    const accountText = style(document.createElement("p"), {
      margin: "0 0 14px",
      color: "#d4d4d4",
      lineHeight: "1.5",
    });
    accountText.textContent = account?.isAnonymous
      ? "You are playing as a guest."
      : account?.email
        ? `Signed in as ${account.email}`
        : "Sign in to keep the same account across devices.";

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
    };
    const email = style(document.createElement("input"), inputStyle);
    email.type = "email";
    email.autocomplete = "email";
    email.placeholder = "Email address";
    email.setAttribute("aria-label", "Email address");

    const password = style(document.createElement("input"), { ...inputStyle, marginTop: "10px" });
    password.type = "password";
    password.autocomplete = "current-password";
    password.placeholder = "Password (8 characters minimum)";
    password.setAttribute("aria-label", "Password");

    const emailActions = style(document.createElement("div"), {
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: "10px",
      marginTop: "12px",
    });
    const signInButton = accountButton("Sign in", true);
    const signUpButton = accountButton("Create account");
    emailActions.append(signInButton, signUpButton);

    const divider = style(document.createElement("div"), {
      margin: "18px 0",
      borderTop: "1px solid #404040",
    });
    const providerActions = style(document.createElement("div"), {
      display: "grid",
      gap: "10px",
    });
    const googleButton = accountButton("Continue with Google");
    const guestButton = accountButton(account?.isAnonymous ? "Refresh guest account" : "Continue as guest");
    const signOutButton = accountButton("Sign out");
    providerActions.append(googleButton, guestButton);
    if (account && !account.isAnonymous) providerActions.append(signOutButton);

    function setStatus(text, isError = false) {
      status.style.display = "block";
      status.style.color = isError ? "#fecaca" : "#bfdbfe";
      status.textContent = text;
    }

    async function emailAuth(mode) {
      const emailValue = email.value.trim();
      const passwordValue = password.value;
      if (!emailValue || passwordValue.length < 8) {
        setStatus("Enter a valid email address and a password with at least 8 characters.", true);
        return;
      }
      signInButton.disabled = true;
      signUpButton.disabled = true;
      setStatus(mode === "email-sign-in" ? "Signing in..." : "Creating account...");
      try {
        const session = await createSession({ mode, email: emailValue, password: passwordValue });
        if (session.confirmationRequired) {
          password.value = "";
          setStatus("Check your email to confirm the account, then return here and sign in.");
          return;
        }
        globalThis.location.reload();
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "Authentication failed.", true);
      } finally {
        signInButton.disabled = false;
        signUpButton.disabled = false;
      }
    }

    signInButton.addEventListener("click", () => emailAuth("email-sign-in"));
    signUpButton.addEventListener("click", () => emailAuth("email-sign-up"));
    googleButton.addEventListener("click", () => {
      const returnTo = `${globalThis.location.origin}${globalThis.location.pathname}`;
      const url = new URL("/_worker/auth/google", serverUrl);
      url.searchParams.set("return_to", returnTo);
      globalThis.location.assign(url.href);
    });
    guestButton.addEventListener("click", async () => {
      guestButton.disabled = true;
      setStatus("Creating guest session...");
      try {
        removeStoredValue(refreshTokenKey);
        removeStoredValue(accountKey);
        await createSession({ mode: "guest" });
        globalThis.location.reload();
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "Could not create a guest session.", true);
        guestButton.disabled = false;
      }
    });
    signOutButton.addEventListener("click", () => {
      removeStoredValue(refreshTokenKey);
      removeStoredValue(accountKey);
      globalThis.location.reload();
    });

    panel.append(header, accountText, status, email, password, emailActions, divider, providerActions);
    overlay.append(panel);
    document.body.append(overlay);
  }

  async function handleOAuthCallback() {
    const query = new URLSearchParams(globalThis.location.search);
    if (query.get("techmino_auth") !== "google") return;

    const hash = new URLSearchParams(globalThis.location.hash.slice(1));
    const refreshToken = hash.get("refresh_token");
    const authError = hash.get("error_description") || hash.get("error");
    const cleanUrl = `${globalThis.location.origin}${globalThis.location.pathname}`;
    globalThis.history.replaceState(null, "", cleanUrl);

    if (authError) {
      accountNotice = authError;
    } else if (!refreshToken) {
      accountNotice = "Google did not return a usable session.";
    } else {
      setStoredValue(refreshTokenKey, refreshToken);
      try {
        await createSession();
        accountNotice = "Google sign-in completed.";
      } catch (error) {
        accountNotice = error instanceof Error ? error.message : "Google sign-in failed.";
      }
    }
  }

  function installAccountButton() {
    const button = accountButton("Account");
    button.id = "techmino-account-button";
    style(button, {
      position: "fixed",
      top: "12px",
      right: "12px",
      zIndex: "2147483645",
      background: "rgba(23, 23, 23, 0.92)",
    });
    button.addEventListener("click", () => showAccountDialog());
    document.body.append(button);
    if (accountNotice) showAccountDialog(accountNotice);
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
      showConnectionError(reason);
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

  handleOAuthCallback().finally(() => {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", installAccountButton, { once: true });
    } else {
      installAccountButton();
    }
  });

  globalThis.TechminoSocket = { connect, send, close };
})();
