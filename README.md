# WideBrowse

Control your **normal Chrome or Edge** tabs from Cursor — the same mental model as the built-in browser tools — with **per-session approval** and a soft teal **viewport hue** while the agent is in control.

## What’s included

| Piece | Role |
|---|---|
| [`extension/`](extension/) | Chromium MV3 extension (approval UI, hue frame, Take control, page actions) |
| [`mcp-server/`](mcp-server/) | Local MCP server + WebSocket bridge (`127.0.0.1:17321`) |
| [`shared/`](shared/) | Wire protocol constants |

```text
Cursor agent  --stdio-->  WideBrowse MCP  --ws-->  Extension  -->  your tabs
```

## Setup

Clone or copy this repo anywhere on the machine. Paths below are relative to the repo root — no fixed drive or folder is required.

### Quick install (Windows)

From the repo root, double-click [`install.cmd`](install.cmd), or in PowerShell:

```powershell
cd path\to\WideBrowse
.\install.ps1
```

This builds the MCP server and registers `widebrowse` in `%USERPROFILE%\.cursor\mcp.json` using **absolute paths derived from this repo’s location** (and the `node` executable on PATH).  
Use `.\install.ps1 -SkipCursorConfig` to build only.  
Use `.\install.ps1 -OpenExtensionPages` to also try opening the browser extensions pages.

Then load the unpacked extension (step 2 below) and reload MCP / restart Cursor.

### Manual setup

#### 1. Install and build the MCP server

```powershell
cd path\to\WideBrowse\mcp-server
npm install
npm run build
```

#### 2. Load the extension

**Chrome:** `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the repo’s `extension` folder

**Edge:** `edge://extensions` → same steps.

The extension reconnects automatically to `ws://127.0.0.1:17321/widebrowse`. Use the toolbar popup to check connection status or change the port.

#### 3. Add MCP to Cursor

Prefer `.\install.ps1` so paths match this machine. Or edit `%USERPROFILE%\.cursor\mcp.json` with the absolute path to this clone:

```json
{
  "mcpServers": {
    "widebrowse": {
      "command": "node",
      "args": ["C:/absolute/path/to/WideBrowse/mcp-server/dist/index.js"]
    }
  }
}
```

On Windows, if Cursor cannot find `node`, set `command` to the full path of `node.exe` (e.g. from `where.exe node`).

Optional: set `WIDEBROWSE_PORT` if you need a different bridge port (must match the extension popup).

Restart MCP / reload Cursor so the `browse_*` tools appear.

## Usage (agent)

1. `browse_list_tabs` — see open http(s) tabs (no approval needed yet).
2. **Ask the user** which tab to grant access to.
3. `browse_request_session` with that `tabId` — user Approves/Denies on that tab.
4. Use `browse_snapshot`, `browse_click`, `browse_navigate`, etc. on the approved tab.
5. `browse_end_session` (or user **Take control** → **Cancel**) when done.

Interaction tools fail until a session is approved for a specific tab.

When access is requested, WideBrowse **focuses that tab**, draws attention to the window, prefixes the tab title with `⚡ WideBrowse —`, and shows an OS notification so you can find it if you were on another tab.

## Tools

- `browse_list_tabs` — list open tabs (call first; ask user which to grant)
- `browse_request_session` / `browse_end_session` — requires `tabId` from the user's choice
- `browse_lock` / `browse_unlock`
- `browse_tabs` (`list` | `select` | `create` | `close`)
- `browse_navigate`
- `browse_snapshot`
- `browse_click` / `browse_type` / `browse_fill` / `browse_select_option`
- `browse_press_key` / `browse_scroll`
- `browse_take_screenshot`
- `browse_status`

## Notes

- Bridge accepts **localhost only**.
- If port `17321` is already a WideBrowse hub (another Cursor window / `hub-only`), this process **joins as a peer**. If that hub dies, the peer **self-heals** (rejoins or takes over the port).
- If the port is busy with a **non-WideBrowse** process, startup **waits and logs** (default 60s, override with `WIDEBROWSE_PORT_WAIT_MS`) or set `WIDEBROWSE_PORT`.
- Restricted pages (`chrome://`, Web Store, etc.) cannot run content scripts — pick a normal http(s) tab.
- v1 does not deep-automate cross-origin iframes, file uploads, or Firefox.

## Develop

```powershell
cd mcp-server
npm run build
npm start
```

`npm start` alone runs the bridge + MCP over stdio (what Cursor uses). For a quick bridge smoke test without Cursor, the HTTP health check is `http://127.0.0.1:17321/`.
