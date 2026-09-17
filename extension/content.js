/** WideBrowse content script — session UI, control hue, page actions */

const HUE_ID = "widebrowse-hue-frame";
const BLOCK_ID = "widebrowse-input-block";
const PROMPT_ID = "widebrowse-approve-prompt";
const TAKE_ID = "widebrowse-take-control";
const CONFIRM_ID = "widebrowse-take-confirm";
const TOAST_ID = "widebrowse-toast";

/** @type {Map<string, Element>} */
const refMap = new Map();
let refCounter = 0;
let controlActive = false;
/** @type {((ev: KeyboardEvent) => void) | null} */
let keyBlockHandler = null;
/** @type {(() => void) | null} */
let hoverCleanup = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true;
});

async function handleMessage(message) {
  const { action, params = {} } = message;
  switch (action) {
    case "session.showPrompt":
      return showApprovePrompt(params);
    case "session.hidePrompt":
      hideApprovePrompt();
      return { hidden: true };
    case "session.setActive":
      setControlActive(Boolean(params.active), params);
      return { active: Boolean(params.active) };
    case "session.notify":
      showToast(String(params.message || "WideBrowse update"));
      return { shown: true };
    case "session.flashTitle":
      flashTabTitle(params.prefix || "⚡ WideBrowse — ");
      return { flashed: true };
    case "session.restoreTitle":
      restoreFlashedTitle();
      return { restored: true };
    case "snapshot":
      return buildSnapshot(params);
    case "click":
      return doClick(params);
    case "type":
      return doType(params);
    case "fill":
      return doFill(params);
    case "selectOption":
      return doSelectOption(params);
    case "pressKey":
      return doPressKey(params);
    case "scroll":
      return doScroll(params);
    case "ping":
      return { pong: true, url: location.href };
    default:
      throw new Error(`Unknown content action: ${action}`);
  }
}

function ensureStyle() {
  let style = document.getElementById("widebrowse-styles");
  if (!style) {
    style = document.createElement("style");
    style.id = "widebrowse-styles";
    (document.documentElement || document.head).appendChild(style);
  }
  style.textContent = `
    #${HUE_ID} {
      position: fixed;
      inset: 0;
      z-index: 2147483645;
      pointer-events: none;
      box-sizing: border-box;
      background: transparent;
      border: 6px solid rgba(8, 48, 44, 0.55);
      box-shadow:
        inset 0 0 0 1px rgba(6, 36, 32, 0.40),
        inset 0 0 32px rgba(6, 36, 32, 0.55),
        inset 0 0 64px rgba(6, 36, 32, 0.35);
      border-radius: 0;
      animation: widebrowse-hue-pulse 2.8s ease-in-out infinite;
    }
    @keyframes widebrowse-hue-pulse {
      0%, 100% {
        border-color: rgba(8, 48, 44, 0.48);
        box-shadow:
          inset 0 0 0 1px rgba(6, 36, 32, 0.35),
          inset 0 0 28px rgba(6, 36, 32, 0.48),
          inset 0 0 56px rgba(6, 36, 32, 0.30);
      }
      50% {
        border-color: rgba(8, 48, 44, 0.62);
        box-shadow:
          inset 0 0 0 1px rgba(6, 36, 32, 0.45),
          inset 0 0 40px rgba(6, 36, 32, 0.62),
          inset 0 0 72px rgba(6, 36, 32, 0.40);
      }
    }
    #${BLOCK_ID} {
      position: fixed;
      inset: 0;
      z-index: 2147483646;
      pointer-events: auto;
      cursor: not-allowed;
      background: transparent;
    }
    #${TAKE_ID} {
      position: fixed;
      top: 50%;
      left: 50%;
      z-index: 2147483647;
      pointer-events: none;
      font: 700 20px/1.25 system-ui, sans-serif;
      color: #062824;
      background: rgba(232, 250, 245, 0.98);
      border: 3px solid rgba(20, 110, 100, 0.95);
      border-radius: 16px;
      padding: 22px 40px;
      min-width: 240px;
      cursor: pointer;
      box-shadow: 0 12px 40px rgba(0,0,0,0.28);
      opacity: 0;
      visibility: hidden;
      transform: translate(-50%, -50%) scale(0.96);
      transition: opacity 0.15s ease, transform 0.15s ease, visibility 0.15s;
    }
    #${TAKE_ID}.wb-visible {
      opacity: 1;
      visibility: visible;
      pointer-events: auto;
      transform: translate(-50%, -50%) scale(1);
    }
    #${TAKE_ID}:hover,
    #${TAKE_ID}:focus-visible {
      background: #fff;
      outline: none;
      box-shadow: 0 14px 44px rgba(0,0,0,0.32);
    }
    #${CONFIRM_ID} {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: auto;
      background: rgba(6, 24, 22, 0.35);
      font: 14px/1.4 system-ui, sans-serif;
    }
    #${CONFIRM_ID} .wb-confirm-card {
      width: min(420px, 92vw);
      background: rgba(255,255,255,0.98);
      color: #102a27;
      border: 1px solid rgba(20, 110, 100, 0.65);
      border-radius: 14px;
      padding: 20px 20px 16px;
      box-shadow: 0 16px 48px rgba(0,0,0,0.28);
    }
    #${CONFIRM_ID} .wb-title { font-weight: 700; font-size: 16px; margin-bottom: 6px; }
    #${CONFIRM_ID} .wb-sub { color: #445; font-size: 13px; margin-bottom: 16px; }
    #${CONFIRM_ID} .wb-actions { display: flex; gap: 10px; justify-content: flex-end; }
    #${CONFIRM_ID} button {
      font: 700 13px system-ui, sans-serif;
      border-radius: 10px;
      padding: 10px 16px;
      cursor: pointer;
      border: 1px solid transparent;
    }
    #${CONFIRM_ID} .wb-cancel-session {
      background: #b42318;
      color: #fff;
    }
    #${CONFIRM_ID} .wb-resume {
      background: #1a6b61;
      color: #fff;
    }
    #${TOAST_ID} {
      position: fixed;
      bottom: 32px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 2147483647;
      pointer-events: none;
      font: 700 15px/1.35 system-ui, sans-serif;
      color: #062824;
      background: #e8faf5;
      border: 2px solid rgba(20, 110, 100, 0.85);
      border-radius: 14px;
      padding: 14px 20px;
      max-width: min(480px, 92vw);
      box-shadow: 0 12px 40px rgba(0,0,0,0.28);
      animation: widebrowse-toast-in 0.2s ease;
    }
    @keyframes widebrowse-toast-in {
      from { opacity: 0; transform: translate(-50%, 8px); }
      to { opacity: 1; transform: translate(-50%, 0); }
    }
    #${PROMPT_ID} {
      position: fixed;
      top: 16px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 2147483647;
      font: 14px/1.4 system-ui, sans-serif;
      color: #102a27;
      background: rgba(255,255,255,0.98);
      border: 1px solid rgba(20, 110, 100, 0.7);
      border-radius: 12px;
      padding: 14px 16px;
      min-width: 280px;
      max-width: min(420px, 92vw);
      box-shadow: 0 12px 40px rgba(0,0,0,0.18);
    }
    #${PROMPT_ID} .wb-title { font-weight: 700; margin-bottom: 4px; }
    #${PROMPT_ID} .wb-sub { color: #445; font-size: 12px; margin-bottom: 12px; }
    #${PROMPT_ID} .wb-actions { display: flex; gap: 8px; justify-content: flex-end; }
    #${PROMPT_ID} button {
      font: 600 12px system-ui, sans-serif;
      border-radius: 8px;
      padding: 8px 12px;
      cursor: pointer;
      border: 1px solid transparent;
    }
    #${PROMPT_ID} .wb-approve {
      background: #1a6b61;
      color: #fff;
    }
    #${PROMPT_ID} .wb-deny {
      background: #f4f4f5;
      color: #222;
      border-color: #ddd;
    }
  `;
}

function showApprovePrompt(params = {}) {
  ensureStyle();
  hideApprovePrompt();
  const reason = params.reason || "A Cursor agent wants to control this browser tab.";
  const el = document.createElement("div");
  el.id = PROMPT_ID;
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", "WideBrowse session approval");
  el.innerHTML = `
    <div class="wb-title">WideBrowse session</div>
    <div class="wb-sub">${escapeHtml(reason)}</div>
    <div class="wb-actions">
      <button type="button" class="wb-deny">Deny</button>
      <button type="button" class="wb-approve">Approve</button>
    </div>
  `;
  el.querySelector(".wb-approve").addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "session.userDecision", approved: true });
    hideApprovePrompt();
  });
  el.querySelector(".wb-deny").addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "session.userDecision", approved: false });
    hideApprovePrompt();
  });
  document.documentElement.appendChild(el);
  return { shown: true };
}

function hideApprovePrompt() {
  document.getElementById(PROMPT_ID)?.remove();
}

function setControlActive(active, params = {}) {
  ensureStyle();
  hideApprovePrompt();
  hideTakeConfirm();
  teardownControlListeners();
  document.getElementById(HUE_ID)?.remove();
  document.getElementById(BLOCK_ID)?.remove();
  document.getElementById(TAKE_ID)?.remove();
  controlActive = Boolean(active);
  if (!active) {
    if (params.notifyMessage) {
      showToast(String(params.notifyMessage));
    }
    return;
  }

  const hue = document.createElement("div");
  hue.id = HUE_ID;
  hue.setAttribute("aria-hidden", "true");
  document.documentElement.appendChild(hue);

  const block = document.createElement("div");
  block.id = BLOCK_ID;
  block.setAttribute("aria-hidden", "true");
  block.title = "Agent is in control — hover to show Take control";
  const swallow = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
  };
  for (const type of [
    "click",
    "mousedown",
    "mouseup",
    "dblclick",
    "contextmenu",
    "wheel",
    "pointerdown",
    "pointerup",
    "touchstart",
    "touchend",
  ]) {
    block.addEventListener(type, swallow, true);
  }
  document.documentElement.appendChild(block);

  const btn = document.createElement("button");
  btn.id = TAKE_ID;
  btn.type = "button";
  btn.textContent = params.takeLabel || "Take control";
  btn.title = "Request to end the agent session";
  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    showTakeConfirm();
  });
  document.documentElement.appendChild(btn);

  const showTakeBtn = () => {
    if (!controlActive) return;
    btn.classList.add("wb-visible");
  };
  const hideTakeBtn = () => {
    if (document.getElementById(CONFIRM_ID)) return;
    btn.classList.remove("wb-visible");
  };
  const onBlockLeave = (ev) => {
    const next = ev.relatedTarget;
    if (next === btn || (next instanceof Node && btn.contains(next))) return;
    hideTakeBtn();
  };
  const onBtnLeave = (ev) => {
    const next = ev.relatedTarget;
    if (next === block || (next instanceof Node && block.contains(next))) return;
    hideTakeBtn();
  };
  block.addEventListener("mousemove", showTakeBtn);
  block.addEventListener("mouseenter", showTakeBtn);
  block.addEventListener("mouseleave", onBlockLeave);
  btn.addEventListener("mouseenter", showTakeBtn);
  btn.addEventListener("mouseleave", onBtnLeave);
  hoverCleanup = () => {
    block.removeEventListener("mousemove", showTakeBtn);
    block.removeEventListener("mouseenter", showTakeBtn);
    block.removeEventListener("mouseleave", onBlockLeave);
    btn.removeEventListener("mouseenter", showTakeBtn);
    btn.removeEventListener("mouseleave", onBtnLeave);
    hoverCleanup = null;
  };

  keyBlockHandler = (ev) => {
    if (!controlActive) return;
    if (document.getElementById(CONFIRM_ID)) {
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        hideTakeConfirm();
      }
      return;
    }
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      showTakeBtn();
      showTakeConfirm();
      return;
    }
    if (ev.isTrusted) {
      ev.preventDefault();
      ev.stopPropagation();
    }
  };
  window.addEventListener("keydown", keyBlockHandler, true);
  window.addEventListener("keyup", keyBlockHandler, true);
  window.addEventListener("keypress", keyBlockHandler, true);

  showToast("Agent in control — hover the page to show Take control.");
}

function showTakeConfirm() {
  ensureStyle();
  hideTakeConfirm();
  const wrap = document.createElement("div");
  wrap.id = CONFIRM_ID;
  wrap.setAttribute("role", "alertdialog");
  wrap.setAttribute("aria-modal", "true");
  wrap.setAttribute("aria-label", "Cancel agent session?");
  wrap.innerHTML = `
    <div class="wb-confirm-card">
      <div class="wb-title">Cancel agent session?</div>
      <div class="wb-sub">Taking control will cancel the agent's session. You will regain full use of this tab.</div>
      <div class="wb-actions">
        <button type="button" class="wb-resume">Resume</button>
        <button type="button" class="wb-cancel-session">Cancel</button>
      </div>
    </div>
  `;
  wrap.querySelector(".wb-resume").addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    hideTakeConfirm();
    showToast("Agent session resumed — interaction stays locked.");
  });
  wrap.querySelector(".wb-cancel-session").addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    hideTakeConfirm();
    void reclaimControl();
  });
  // Clicks on backdrop keep the dialog open (do not accidentally cancel)
  wrap.addEventListener("click", (ev) => {
    if (ev.target === wrap) {
      ev.preventDefault();
      ev.stopPropagation();
    }
  });
  document.documentElement.appendChild(wrap);
}

function hideTakeConfirm() {
  document.getElementById(CONFIRM_ID)?.remove();
}

function teardownControlListeners() {
  if (hoverCleanup) hoverCleanup();
  if (keyBlockHandler) {
    window.removeEventListener("keydown", keyBlockHandler, true);
    window.removeEventListener("keyup", keyBlockHandler, true);
    window.removeEventListener("keypress", keyBlockHandler, true);
    keyBlockHandler = null;
  }
}

async function reclaimControl() {
  if (!controlActive) return;
  setControlActive(false);
  showToast("You cancelled the agent session — you have control again.");
  try {
    await chrome.runtime.sendMessage({ type: "session.takeControl" });
  } catch {
    /* ignore */
  }
}

function showToast(message, ms = 7000) {
  ensureStyle();
  document.getElementById(TOAST_ID)?.remove();
  const el = document.createElement("div");
  el.id = TOAST_ID;
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.textContent = message;
  (document.body || document.documentElement).appendChild(el);
  setTimeout(() => {
    if (el.parentNode) el.remove();
  }, ms);
}

function flashTabTitle(prefix) {
  if (!document.documentElement.dataset.wbTitleOrig) {
    document.documentElement.dataset.wbTitleOrig = document.title;
  }
  const base = document.documentElement.dataset.wbTitleOrig || document.title;
  if (!document.title.startsWith(prefix)) {
    document.title = prefix + base;
  }
}

function restoreFlashedTitle() {
  const orig = document.documentElement.dataset.wbTitleOrig;
  if (orig != null) {
    document.title = orig;
    delete document.documentElement.dataset.wbTitleOrig;
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isVisible(el) {
  if (!(el instanceof Element)) return false;
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function getRole(el) {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  if (tag === "a") return "link";
  if (tag === "button") return "button";
  if (tag === "input") {
    const t = (el.getAttribute("type") || "text").toLowerCase();
    if (t === "checkbox") return "checkbox";
    if (t === "radio") return "radio";
    if (t === "submit" || t === "button") return "button";
    return "textbox";
  }
  if (tag === "textarea") return "textbox";
  if (tag === "select") return "combobox";
  if (tag === "img") return "img";
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "nav") return "navigation";
  if (tag === "main") return "main";
  if (tag === "label") return "label";
  return tag;
}

function getName(el) {
  const labelled = el.getAttribute("aria-label");
  if (labelled) return labelled.trim();
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (el.placeholder) return el.placeholder.trim();
    if (el.labels && el.labels[0]) return el.labels[0].innerText.trim().slice(0, 120);
  }
  if (el instanceof HTMLImageElement) return (el.alt || "").trim();
  const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  return text.slice(0, 120);
}

function assignRef(el) {
  const existing = el.getAttribute("data-widebrowse-ref");
  if (existing && refMap.get(existing) === el) return existing;
  refCounter += 1;
  const ref = `e${refCounter}`;
  el.setAttribute("data-widebrowse-ref", ref);
  refMap.set(ref, el);
  return ref;
}

function resolveRef(ref) {
  if (!ref) throw new Error("ref is required");
  let el = refMap.get(ref);
  if (!el || !document.contains(el)) {
    el = document.querySelector(`[data-widebrowse-ref="${CSS.escape(ref)}"]`);
    if (el) refMap.set(ref, el);
  }
  if (!el) throw new Error(`Element not found for ref: ${ref}`);
  return el;
}

function buildSnapshot(params = {}) {
  refMap.clear();
  refCounter = 0;
  const max = Math.min(Number(params.maxNodes) || 400, 800);
  const interesting = document.querySelectorAll(
    "a, button, input, textarea, select, [role], [onclick], [tabindex], h1, h2, h3, h4, label, img[alt]"
  );
  const lines = [];
  lines.push(`- document: ${document.title}`);
  lines.push(`  url: ${location.href}`);
  let count = 0;
  for (const el of interesting) {
    if (count >= max) break;
    if (!isVisible(el)) continue;
    if (el.closest(`#${PROMPT_ID}, #${TAKE_ID}, #${HUE_ID}, #${BLOCK_ID}, #${TOAST_ID}, #${CONFIRM_ID}`)) continue;
    const role = getRole(el);
    const name = getName(el);
    if (!name && !["textbox", "checkbox", "radio", "combobox", "img"].includes(role)) continue;
    const ref = assignRef(el);
    const rect = el.getBoundingClientRect();
    lines.push(`- ${role}${name ? ` "${name.replace(/"/g, '\\"')}"` : ""} [ref=${ref}]`);
    lines.push(`  bbox: ${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}x${Math.round(rect.height)}`);
    count += 1;
  }
  return {
    url: location.href,
    title: document.title,
    nodeCount: count,
    snapshot: lines.join("\n"),
  };
}

function dispatchPointer(el, type) {
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
  el.dispatchEvent(new PointerEvent(type, { ...opts, pointerId: 1, pointerType: "mouse" }));
}

function doClick(params) {
  const el = resolveRef(params.ref);
  el.scrollIntoView({ block: "center", inline: "nearest" });
  dispatchPointer(el, "pointerdown");
  dispatchPointer(el, "mousedown");
  dispatchPointer(el, "pointerup");
  dispatchPointer(el, "mouseup");
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  if (typeof el.click === "function") el.click();
  return { clicked: params.ref };
}

function focusEl(el) {
  el.focus({ preventScroll: false });
  el.scrollIntoView({ block: "center", inline: "nearest" });
}

function doType(params) {
  const el = resolveRef(params.ref);
  focusEl(el);
  const text = String(params.text ?? "");
  const submit = Boolean(params.submit);
  if (el.isContentEditable) {
    if (params.clear) el.textContent = "";
    el.textContent = (el.textContent || "") + text;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
  } else if ("value" in el) {
    if (params.clear) el.value = "";
    el.value = (el.value || "") + text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    throw new Error("Element is not typeable");
  }
  if (submit) {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
    const form = el.closest("form");
    if (form) form.requestSubmit?.() || form.submit();
  }
  return { typed: true, ref: params.ref };
}

function doFill(params) {
  const el = resolveRef(params.ref);
  focusEl(el);
  const value = String(params.value ?? "");
  if (el.isContentEditable) {
    el.textContent = value;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }));
  } else if ("value" in el) {
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    throw new Error("Element is not fillable");
  }
  return { filled: true, ref: params.ref };
}

function doSelectOption(params) {
  const el = resolveRef(params.ref);
  if (!(el instanceof HTMLSelectElement)) throw new Error("Element is not a select");
  const values = Array.isArray(params.values) ? params.values.map(String) : [String(params.value ?? "")];
  for (const opt of el.options) {
    opt.selected = values.includes(opt.value) || values.includes(opt.textContent?.trim() || "");
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { selected: values, ref: params.ref };
}

function doPressKey(params) {
  const key = String(params.key || "");
  const target = params.ref ? resolveRef(params.ref) : document.activeElement || document.body;
  const opts = {
    key,
    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
    bubbles: true,
    cancelable: true,
    ctrlKey: Boolean(params.ctrlKey),
    metaKey: Boolean(params.metaKey),
    altKey: Boolean(params.altKey),
    shiftKey: Boolean(params.shiftKey),
  };
  target.dispatchEvent(new KeyboardEvent("keydown", opts));
  target.dispatchEvent(new KeyboardEvent("keypress", opts));
  target.dispatchEvent(new KeyboardEvent("keyup", opts));
  return { pressed: key };
}

function doScroll(params) {
  if (params.ref) {
    const el = resolveRef(params.ref);
    el.scrollIntoView({
      block: params.block || "center",
      inline: params.inline || "nearest",
      behavior: params.behavior || "instant",
    });
    return { scrolledTo: params.ref };
  }
  const dx = Number(params.deltaX) || 0;
  const dy = Number(params.deltaY) || 0;
  window.scrollBy({ left: dx, top: dy, behavior: params.behavior || "instant" });
  return { scrolled: { deltaX: dx, deltaY: dy } };
}

// Re-apply hue if SW restores session after navigation
chrome.runtime.sendMessage({ type: "content.ready", url: location.href }).catch(() => {});
