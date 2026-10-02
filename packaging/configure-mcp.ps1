$ErrorActionPreference = 'Stop'
# JSON strings use the same escaping needed for these TOML basic strings.
$nodePath = Join-Path $PSScriptRoot 'runtime/node/node.exe'
$entryPath = Join-Path $PSScriptRoot 'dist/entrypoints/mcp.js'
if (-not (Test-Path -LiteralPath $nodePath) -or -not (Test-Path -LiteralPath $entryPath)) {
    throw 'Extract the complete portable ZIP before running setup.'
}
$nodeValue = ConvertTo-Json $nodePath -Compress
$entryValue = ConvertTo-Json $entryPath -Compress
$cwdValue = ConvertTo-Json $PSScriptRoot -Compress
$config = @"
[mcp_servers.dshcontroller]
command = $nodeValue
args = ["--disable-warning=ExperimentalWarning", $entryValue]
cwd = $cwdValue
startup_timeout_sec = 20
tool_timeout_sec = 60
enabled = true
"@
$target = Join-Path $PSScriptRoot 'codex-mcp.toml'
[IO.File]::WriteAllText($target, $config + "`n", [Text.UTF8Encoding]::new($false))
Write-Host "Configuration saved to: $target"
Write-Host 'Copy this block into your Codex MCP configuration, then reload MCP.'
Write-Host 'If you move the extracted folder, run setup again and update the configuration.'
Write-Output $config
