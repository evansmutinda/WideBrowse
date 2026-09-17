/** WideBrowse extension service worker — WebSocket bridge + session state */

const DEFAULT_PORT = 17321;
const RECONNECT_MS = 2000;
const SESSION_TIMEOUT_MS = 120000;

/** @type {WebSocket | null} */
let socket = null;
/** @type {'idle' | 'pending' | 'active'} */
let sessionState = "idle";
/** @type {string | null} */
let sessionId = null;
/** @type {number | null} */
let sessionTabId = null;
/** @type {((approved: boolean) => void) | null} */
let pendingDecision = null;
/** @type {Map<string, { resolve: Function, reject: Function, timer: ReturnType<typeof setTimeout> }>} */
const pendingRequests = new Map();
let reconnectTimer = null;
let port = DEFAULT_PORT;
/** When false, do not auto-reconnect after user clicks Disconnect */
let autoReconnect = true;

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    port: DEFAULT_PORT,
    connected: false,
    sessionState: "idle",
    autoReconnect: true,
  });
});

chrome.storage.local.get(["port", "autoReconnect"]).then((data) => {
  if (typeof data.port === "number") port = data.port;
  if (typeof data.autoReconnect === "boolean") autoReconnect = data.autoReconnect;
  if (autoReconnect) connect();
});

chrome.alarms.create("widebrowse-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "widebrowse-keepalive") {
    if (!autoReconnect) return;
    if (!socket || socket.readyState > 1) connect();
  }
});

chrome.notifications.onClicked.addListener(async () => {
  if (sessionTabId != null) {
    try {
      await focusTabForUser(sessionTabId, { flashTitle: false });
    } catch {
      /* ignore */
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleRuntimeMessage(message, sender)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true;
});

async function handleRuntimeMessage(message, sender) {
  switch (message?.type) {
    case "session.userDecision":
      if (pendingDecision) {
        pendingDecision(Boolean(message.approved));
        pendingDecision = null;
      }
      return { handled: true };
    case "session.takeControl":
      await endSession("user_take_control");
      await notifyUser(
        "WideBrowse session cancelled",
        "You took control and cancelled the agent session. Approve a new session to let the agent browse again."
      );
      return { ended: true };
    case "content.ready":
      if (sessionState === "active" && sender.tab?.id != null) {
        if (sessionTabId == null || sessionTabId === sender.tab.id) {
          sessionTabId = sender.tab.id;
          await sendToTab(sender.tab.id, { action: "session.setActive", params: { active: true } });
        }
      }
      return { ok: true };
    case "popup.getStatus":
      return getStatus();
    case "popup.disconnect":
      autoReconnect = false;
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      await chrome.storage.local.set({ autoReconnect: false });
      await endSession("popup_disconnect");
      if (socket) {
        try {
          socket.close(1000, "User disconnected");
        } catch {
          /* ignore */
        }
        socket = null;
      }
      await setConnected(false);
      return { ...getStatus(), disconnected: true };
    case "popup.reconnect":
      autoReconnect = true;
      await chrome.storage.local.set({ autoReconnect: true });
      if (typeof message.port === "number") {
        port = message.port;
        await chrome.storage.local.set({ port });
      }
      connect();
      return getStatus();
    case "popup.endSession":
      await endSession("popup_end");
      return getStatus();
    default:
      return { ignored: true };
  }
}

function getStatus() {
  return {
    connected: Boolean(socket && socket.readyState === WebSocket.OPEN),
    autoReconnect,
    sessionState,
    sessionId,
    sessionTabId,
    port,
  };
}

async function setConnected(connected) {
  await chrome.storage.local.set({ connected, sessionState });
}

function connect() {
  if (!autoReconnect) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  clearTimeout(reconnectTimer);
  try {
    socket = new WebSocket(`ws://127.0.0.1:${port}/widebrowse`);
  } catch (err) {
    scheduleReconnect();
    return;
  }

  socket.addEventListener("open", () => {
    setConnected(true);
    sendRaw({ type: "hello", role: "extension", protocolVersion: 1 });
    emitEvent("extension.ready", { sessionState });
  });

  socket.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    void onSocketMessage(msg);
  });

  socket.addEventListener("close", () => {
    socket = null;
    void onDisconnect();
    if (autoReconnect) scheduleReconnect();
  });

  socket.addEventListener("error", () => {
    // close handler will reconnect
  });
}

function scheduleReconnect() {
  if (!autoReconnect) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    if (autoReconnect) connect();
  }, RECONNECT_MS);
}

async function onDisconnect() {
  await setConnected(false);
  if (sessionState !== "idle") {
    await clearSessionUi();
    sessionState = "idle";
    sessionId = null;
    sessionTabId = null;
    if (pendingDecision) {
      pendingDecision(false);
      pendingDecision = null;
    }
  }
}

function sendRaw(obj) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(obj));
  }
}

function emitEvent(name, data = {}) {
  sendRaw({ type: "event", name, data });
}

function respond(id, ok, result, error) {
  sendRaw({ type: "response", id, ok, result, error });
}

async function onSocketMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "hello") return;
  if (msg.type === "event") return;
  if (msg.type === "response") {
    const pending = pendingRequests.get(msg.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingRequests.delete(msg.id);
    if (msg.ok) pending.resolve(msg.result);
    else pending.reject(new Error(msg.error || "Request failed"));
    return;
  }
  if (msg.type === "request") {
    try {
      const result = await handleMethod(msg.method, msg.params || {});
      respond(msg.id, true, result);
    } catch (err) {
      respond(msg.id, false, undefined, String(err?.message || err));
    }
  }
}

async function handleMethod(method, params) {
  switch (method) {
    case "ping":
      return { pong: true, sessionState };
    case "session.request":
      return requestSession(params);
    case "session.end":
      await endSession("agent_end");
      return { ended: true, notified: true };
    case "session.lock":
      return setLock(true);
    case "session.unlock":
      return setLock(false);
    case "tabs.list":
      return listTabs();
    case "tabs.select":
      return selectTab(params);
    case "tabs.create":
      return createTab(params);
    case "tabs.close":
      return closeTab(params);
    case "navigate":
      return navigate(params);
    case "snapshot":
      return tabAction("snapshot", params);
    case "click":
      requireActive();
      return tabAction("click", params);
    case "type":
      requireActive();
      return tabAction("type", params);
    case "fill":
      requireActive();
      return tabAction("fill", params);
    case "selectOption":
      requireActive();
      return tabAction("selectOption", params);
    case "pressKey":
      requireActive();
      return tabAction("pressKey", params);
    case "scroll":
      requireActive();
      return tabAction("scroll", params);
    case "screenshot":
      requireActive();
      return takeScreenshot(params);
    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

function requireActive() {
  if (sessionState !== "active") {
    throw new Error("No active WideBrowse session. Call browse_request_session and get user approval first.");
  }
}

async function requestSession(params = {}) {
  if (sessionState === "active") {
    return { status: "active", sessionId, alreadyActive: true, tabId: sessionTabId };
  }
  if (sessionState === "pending") {
    return {
      status: "pending",
      sessionId,
      tabId: sessionTabId,
      message: "Approval prompt already showing — Approve or Deny in the browser.",
    };
  }

  if (params.tabId == null || params.tabId === "") {
    const listed = await listControllableTabs();
    return {
      status: "need_tab",
      message:
        "Pick a tab with the user first. Call browse_list_tabs, ask which tab to control, then call browse_request_session with that tabId.",
      tabs: listed.tabs,
    };
  }

  const tab = await getTargetTab(params.tabId);
  if (!tab?.id) throw new Error(`Tab not found: ${params.tabId}`);
  if (isRestrictedUrl(tab.url)) {
    throw new Error(
      `Cannot control restricted URL (${tab.url}). Choose a normal http(s) tab.`
    );
  }

  sessionState = "pending";
  sessionId = params.sessionId || crypto.randomUUID();
  sessionTabId = tab.id;
  await chrome.storage.local.set({ sessionState, sessionId, sessionTabId });

  await focusTabForUser(tab.id, { flashTitle: true });
  await ensureContentScript(tab.id);
  await sendToTab(tab.id, {
    action: "session.showPrompt",
    params: { reason: params.reason || "A Cursor agent wants to control this browser." },
  });
  await notifyUser(
    "WideBrowse needs approval",
    "The target tab is focused — Approve or Deny the agent session there."
  );

  const timeoutMs = params.timeoutMs || SESSION_TIMEOUT_MS;
  void (async () => {
    const approved = await waitForDecision(timeoutMs);
    await restoreTabTitle(tab.id);
    if (sessionState !== "pending") return;
    if (!approved) {
      sessionState = "idle";
      const deniedId = sessionId;
      sessionId = null;
      await clearSessionUi();
      await chrome.storage.local.set({ sessionState: "idle", sessionId: null });
      emitEvent("session.denied", { sessionId: deniedId });
      return;
    }
    sessionState = "active";
    await chrome.storage.local.set({ sessionState });
    try {
      await sendToTab(tab.id, { action: "session.setActive", params: { active: true } });
    } catch {
      /* page may have navigated; content.ready will re-apply */
    }
    emitEvent("session.approved", { sessionId, tabId: tab.id });
  })();

  return {
    status: "pending",
    sessionId,
    tabId: tab.id,
    url: tab.url,
    title: tab.title,
    message: "Approval prompt shown on the selected tab — Approve or Deny in the browser.",
  };
}

async function listControllableTabs() {
  const tabs = await chrome.tabs.query({});
  return {
    tabs: tabs
      .filter((t) => t.id != null && !isRestrictedUrl(t.url))
      .map((t) => ({
        id: t.id,
        title: t.title || "(untitled)",
        url: t.url,
        active: t.active,
        windowId: t.windowId,
        index: t.index,
      })),
  };
}

function isRestrictedUrl(url) {
  if (!url) return true;
  return /^(chrome|chrome-extension|edge|devtools|about|view-source):/i.test(url);
}

function waitForDecision(timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingDecision) {
        pendingDecision = null;
        resolve(false);
      }
    }, timeoutMs);
    pendingDecision = (approved) => {
      clearTimeout(timer);
      resolve(approved);
    };
  });
}

async function endSession(reason) {
  const wasActive = sessionState !== "idle";
  const id = sessionId;
  const tabId = sessionTabId;
  sessionState = "idle";
  sessionId = null;

  const agentEnded = reason === "agent_end" || reason === "agent_unlock";
  const userTookOver = reason === "user_take_control";
  let notifyMessage = null;
  if (wasActive && agentEnded) {
    notifyMessage = "Agent finished — session ended. You have full control again.";
  } else if (wasActive && reason === "popup_end") {
    notifyMessage = "WideBrowse session ended from the extension popup.";
  } else if (wasActive && reason === "popup_disconnect") {
    notifyMessage = "WideBrowse disconnected — session ended.";
  }

  // Clear hue/lock first
  await clearSessionUi();
  sessionTabId = null;
  await chrome.storage.local.set({ sessionState: "idle", sessionId: null, sessionTabId: null });
  if (pendingDecision) {
    pendingDecision(false);
    pendingDecision = null;
  }
  if (wasActive) emitEvent("session.ended", { reason, sessionId: id });

  // Toast AFTER teardown so it is not wiped; also OS notify
  if (wasActive && notifyMessage && !userTookOver && tabId != null) {
    await showTabToast(tabId, notifyMessage);
    await notifyUser("WideBrowse session ended", notifyMessage);
  } else if (wasActive && notifyMessage && !userTookOver) {
    await notifyUser("WideBrowse session ended", notifyMessage);
  }
}

async function showTabToast(tabId, message) {
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true });
  } catch {
    /* ignore focus errors */
  }

  try {
    await ensureContentScript(tabId);
    await sendToTab(tabId, { action: "session.notify", params: { message } });
    return true;
  } catch {
    /* fall through to injected toast */
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (msg) => {
        const id = "widebrowse-toast";
        document.getElementById(id)?.remove();
        const el = document.createElement("div");
        el.id = id;
        el.setAttribute("role", "status");
        el.textContent = msg;
        el.style.cssText = [
          "position:fixed",
          "bottom:32px",
          "left:50%",
          "transform:translateX(-50%)",
          "z-index:2147483647",
          "pointer-events:none",
          "font:700 15px/1.35 system-ui,sans-serif",
          "color:#062824",
          "background:#e8faf5",
          "border:2px solid rgba(20,110,100,0.85)",
          "border-radius:14px",
          "padding:14px 20px",
          "max-width:min(480px,92vw)",
          "box-shadow:0 12px 40px rgba(0,0,0,0.28)",
        ].join(";");
        (document.body || document.documentElement).appendChild(el);
        setTimeout(() => el.remove(), 7000);
      },
      args: [message],
    });
    return true;
  } catch {
    return false;
  }
}

async function clearSessionUi() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id == null) return;
      try {
        await sendToTab(tab.id, { action: "session.setActive", params: { active: false } });
        await sendToTab(tab.id, { action: "session.hidePrompt" });
      } catch {
        /* tab may not allow scripts */
      }
    })
  );
}

async function setLock(locked) {
  requireActive();
  const tabId = await ensureSessionTab();
  await sendToTab(tabId, { action: "session.setActive", params: { active: locked } });
  if (!locked) await endSession("agent_unlock");
  return { locked };
}

async function listTabs() {
  const tabs = await chrome.tabs.query({});
  return {
    tabs: tabs.map((t) => ({
      id: t.id,
      title: t.title || "(untitled)",
      url: t.url,
      active: Boolean(t.active),
      windowId: t.windowId,
      index: t.index,
      controllable: t.id != null && !isRestrictedUrl(t.url),
    })),
    hint: "Ask the user which controllable tab to grant access to, then call browse_request_session with that tabId.",
  };
}

async function selectTab(params) {
  requireActive();
  const tabId = Number(params.tabId);
  if (!tabId) throw new Error("tabId required");
  const tab = await chrome.tabs.get(tabId);
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tabId, { active: true });
  sessionTabId = tabId;
  await sendToTab(tabId, { action: "session.setActive", params: { active: true } });
  return { selected: tabId, url: tab.url, title: tab.title };
}

async function createTab(params) {
  requireActive();
  const url = params.url || "about:blank";
  const tab = await chrome.tabs.create({ url, active: params.active !== false });
  sessionTabId = tab.id;
  if (tab.id != null) {
    await waitForTabComplete(tab.id);
    await ensureContentScript(tab.id);
    await sendToTab(tab.id, { action: "session.setActive", params: { active: true } });
  }
  return { id: tab.id, url: tab.url, title: tab.title };
}

async function closeTab(params) {
  requireActive();
  const tabId = Number(params.tabId || sessionTabId);
  if (!tabId) throw new Error("tabId required");
  await chrome.tabs.remove(tabId);
  if (sessionTabId === tabId) {
    const [next] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    sessionTabId = next?.id ?? null;
    if (sessionTabId != null) {
      await sendToTab(sessionTabId, { action: "session.setActive", params: { active: true } });
    }
  }
  return { closed: tabId };
}

async function navigate(params) {
  requireActive();
  const tabId = await ensureSessionTab(params.tabId);
  const url = String(params.url || "");
  if (!url) throw new Error("url required");
  await chrome.tabs.update(tabId, { url });
  await waitForTabComplete(tabId);
  await ensureContentScript(tabId);
  await sendToTab(tabId, { action: "session.setActive", params: { active: true } });
  const tab = await chrome.tabs.get(tabId);
  return { tabId, url: tab.url, title: tab.title };
}

async function takeScreenshot(params = {}) {
  const tabId = await ensureSessionTab(params.tabId);
  const tab = await chrome.tabs.get(tabId);
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tabId, { active: true });
  // brief settle for paint
  await delay(100);
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  const base64 = String(dataUrl).replace(/^data:image\/png;base64,/, "");
  return { mimeType: "image/png", base64, tabId, url: tab.url };
}

async function tabAction(action, params) {
  const tabId = await ensureSessionTab(params.tabId);
  await ensureContentScript(tabId);
  return sendToTab(tabId, { action, params });
}

async function ensureSessionTab(preferredId) {
  if (preferredId != null) {
    sessionTabId = Number(preferredId);
  }
  if (sessionTabId != null) {
    try {
      await chrome.tabs.get(sessionTabId);
      return sessionTabId;
    } catch {
      sessionTabId = null;
    }
  }
  const tab = await getTargetTab();
  if (!tab?.id) throw new Error("No browser tab available");
  sessionTabId = tab.id;
  return sessionTabId;
}

async function getTargetTab(tabId) {
  if (tabId != null) {
    try {
      const tab = await chrome.tabs.get(Number(tabId));
      if (!isRestrictedUrl(tab.url)) return tab;
    } catch {
      /* fall through */
    }
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active && !isRestrictedUrl(active.url)) return active;
  const all = await chrome.tabs.query({ currentWindow: true });
  return all.find((t) => t.id != null && !isRestrictedUrl(t.url)) || all[0] || null;
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: "ping" });
    return;
  } catch {
    /* inject */
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"],
  });
}

function sendToTab(tabId, payload) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, payload, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "Content script error"));
        return;
      }
      resolve(response.result);
    });
  });
}

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") {
        resolve();
        return;
      }
      const listener = (id, info) => {
        if (id === tabId && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, 15000);
    });
  });
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function notifyUser(title, message) {
  try {
    await chrome.notifications.create(`widebrowse-${Date.now()}`, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title,
      message,
      priority: 2,
    });
  } catch {
    /* notifications may be blocked */
  }
}

/**
 * Bring the target tab/window to the front so the user can see the approval UI
 * even if they were on another tab.
 */
async function focusTabForUser(tabId, { flashTitle = true } = {}) {
  const tab = await chrome.tabs.get(tabId);
  try {
    await chrome.windows.update(tab.windowId, { focused: true, drawAttention: true });
  } catch {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
  await chrome.tabs.update(tabId, { active: true, highlighted: true });
  try {
    await chrome.tabs.highlight({ windowId: tab.windowId, tabs: [tab.index] });
  } catch {
    /* some platforms ignore highlight */
  }

  if (!flashTitle) return;
  try {
    await ensureContentScript(tabId);
    await sendToTab(tabId, {
      action: "session.flashTitle",
      params: { prefix: "⚡ WideBrowse — " },
    });
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (prefix) => {
          if (!document.documentElement.dataset.wbTitleOrig) {
            document.documentElement.dataset.wbTitleOrig = document.title;
          }
          const base = document.documentElement.dataset.wbTitleOrig || document.title;
          document.title = prefix + base;
        },
        args: ["⚡ WideBrowse — "],
      });
    } catch {
      /* restricted pages */
    }
  }
}

async function restoreTabTitle(tabId) {
  if (tabId == null) return;
  try {
    await sendToTab(tabId, { action: "session.restoreTitle" });
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const orig = document.documentElement.dataset.wbTitleOrig;
          if (orig != null) {
            document.title = orig;
            delete document.documentElement.dataset.wbTitleOrig;
          }
        },
      });
    } catch {
      /* ignore */
    }
  }
}
