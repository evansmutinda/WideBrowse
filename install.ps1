#Requires -Version 5.1
<#
.SYNOPSIS
  Install WideBrowse: build the MCP server and optionally register it in Cursor.

.EXAMPLE
  .\install.ps1

.EXAMPLE
  .\install.ps1 -SkipCursorConfig
#>
[CmdletBinding()]
param(
  [switch]$SkipCursorConfig,
  [switch]$OpenExtensionPages
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ServerDir = Join-Path $Root "mcp-server"
$ExtensionDir = Join-Path $Root "extension"
$EntryJs = Join-Path $ServerDir "dist\index.js"
$CursorMcpPath = Join-Path $env:USERPROFILE ".cursor\mcp.json"

function Write-Step($msg) {
  Write-Host ""
  Write-Host "==> $msg" -ForegroundColor Cyan
}

function Require-Command($name) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    throw "'$name' was not found on PATH. Install Node.js 18+ from https://nodejs.org and re-run."
  }
}

Write-Host "WideBrowse installer" -ForegroundColor Green
Write-Host "Root: $Root"

if (-not (Test-Path $ServerDir)) { throw "Missing mcp-server folder at $ServerDir" }
if (-not (Test-Path $ExtensionDir)) { throw "Missing extension folder at $ExtensionDir" }

Write-Step "Checking Node.js"
Require-Command "node"
Require-Command "npm"
$nodeCmd = Get-Command node -ErrorAction Stop
$NodeExe = $nodeCmd.Source
$nodeVersion = (node -v)
Write-Host "Found $nodeVersion ($NodeExe)"

Write-Step "Installing MCP dependencies"
Push-Location $ServerDir
try {
  npm install
  Write-Step "Building MCP server"
  npm run build
}
finally {
  Pop-Location
}

if (-not (Test-Path $EntryJs)) {
  throw "Build finished but entry file was not found: $EntryJs"
}
Write-Host "Built: $EntryJs" -ForegroundColor Green

# Absolute paths for this machine (repo can live anywhere)
$EntryJsAbs = [System.IO.Path]::GetFullPath($EntryJs)
$NodeExeAbs = [System.IO.Path]::GetFullPath($NodeExe)
# Normalize path for JSON (forward slashes work best in Cursor configs)
$EntryJsJson = ($EntryJsAbs -replace '\\', '/')
$NodeExeJson = ($NodeExeAbs -replace '\\', '/')

if (-not $SkipCursorConfig) {
  Write-Step "Configuring Cursor MCP ($CursorMcpPath)"
  $cursorDir = Split-Path -Parent $CursorMcpPath
  if (-not (Test-Path $cursorDir)) {
    New-Item -ItemType Directory -Force -Path $cursorDir | Out-Null
  }

  $config = @{ mcpServers = @{} }
  if (Test-Path $CursorMcpPath) {
    try {
      $raw = Get-Content -Raw -Path $CursorMcpPath
      if ($raw.Trim()) {
        $parsed = $raw | ConvertFrom-Json
        $config = @{ mcpServers = @{} }
        if ($parsed.mcpServers) {
          foreach ($prop in $parsed.mcpServers.PSObject.Properties) {
            $config.mcpServers[$prop.Name] = $prop.Value
          }
        }
      }
    }
    catch {
      Write-Warning "Could not parse existing mcp.json; creating a backup and rewriting widebrowse entry."
      Copy-Item $CursorMcpPath "$CursorMcpPath.bak-$(Get-Date -Format yyyyMMddHHmmss)" -Force
      $config = @{ mcpServers = @{} }
    }
  }

  $config.mcpServers["widebrowse"] = @{
    command = $NodeExeJson
    args    = @($EntryJsJson)
  }

  # Build JSON with ordered mcpServers object
  $mcpServersObj = [ordered]@{}
  foreach ($key in ($config.mcpServers.Keys | Sort-Object)) {
    $server = $config.mcpServers[$key]
    if ($server -is [hashtable]) {
      $mcpServersObj[$key] = $server
    }
    else {
      # ConvertFrom-Json PSCustomObject
      $ht = [ordered]@{}
      foreach ($p in $server.PSObject.Properties) {
        $ht[$p.Name] = $p.Value
      }
      $mcpServersObj[$key] = $ht
    }
  }
  $out = [ordered]@{ mcpServers = $mcpServersObj }
  $json = $out | ConvertTo-Json -Depth 8
  Set-Content -Path $CursorMcpPath -Value $json -Encoding UTF8
  Write-Host "Registered mcpServers.widebrowse in $CursorMcpPath" -ForegroundColor Green
  Write-Host "  command: $NodeExeJson"
  Write-Host "  args[0]: $EntryJsJson"
}
else {
  Write-Host "Skipped Cursor MCP config (-SkipCursorConfig)."
}

Write-Step "Load the browser extension (manual)"
Write-Host "Extension folder:"
Write-Host "  $ExtensionDir" -ForegroundColor Yellow
Write-Host ""
Write-Host "Chrome:  chrome://extensions  -> Developer mode -> Load unpacked"
Write-Host "Edge:    edge://extensions    -> Developer mode -> Load unpacked"
Write-Host "Select the extension folder above."

if ($OpenExtensionPages) {
  Start-Process "chrome://extensions" -ErrorAction SilentlyContinue
  Start-Process "msedge" "edge://extensions" -ErrorAction SilentlyContinue
}

Write-Step "Done"
Write-Host @"

Next:
  1. Load the unpacked extension (path above).
  2. Reload MCP / restart Cursor so browse_* tools appear.
  3. Open the WideBrowse toolbar popup and confirm Bridge = connected.
  4. Ask the agent to call browse_request_session, then Approve in the tab.

Optional port override: set env WIDEBROWSE_PORT (must match extension popup).
"@
