async function refresh() {
  const res = await chrome.runtime.sendMessage({ type: "popup.getStatus" });
  const status = res?.result || {};
  const connected = Boolean(status.connected);
  document.getElementById("connDot").className = `dot${connected ? " on" : ""}`;
  document.getElementById("connText").textContent = connected ? "connected" : "offline";
  const session = status.sessionState || "idle";
  document.getElementById("sessionText").textContent = session;

  const hint = document.getElementById("hint");
  if (!connected) {
    hint.textContent = "Bridge offline. Click Reconnect bridge to allow Cursor to talk to this browser.";
  } else if (session === "active") {
    hint.textContent = "Agent session active. End session clears the hue; Disconnect also drops the MCP bridge.";
  } else if (session === "pending") {
    hint.textContent = "Waiting for Approve/Deny on the focused tab.";
  } else {
    hint.textContent = "Bridge connected. End session only clears an agent session — bridge stays up until Disconnect.";
  }

  if (typeof status.port === "number") {
    document.getElementById("port").value = String(status.port);
  }
}

document.getElementById("reconnect").addEventListener("click", async () => {
  const port = Number(document.getElementById("port").value) || 17321;
  await chrome.runtime.sendMessage({ type: "popup.reconnect", port });
  await refresh();
});

document.getElementById("disconnect").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "popup.disconnect" });
  await refresh();
});

document.getElementById("endSession").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "popup.endSession" });
  await refresh();
});

refresh();
setInterval(refresh, 1500);
