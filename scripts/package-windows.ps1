param(
    [string]$OutputDirectory = '.state/portable-build',
    [string]$NodeVersion = ''
)
$ErrorActionPreference = 'Stop'
function Get-PackageSha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose(); $stream.Dispose() }
}
if (-not $IsWindows -and $env:OS -ne 'Windows_NT') { throw 'Portable packaging requires Windows x64.' }
$repo = Split-Path $PSScriptRoot -Parent
$output = [IO.Path]::GetFullPath((Join-Path $repo $OutputDirectory))
$work = Join-Path $output ([Guid]::NewGuid().ToString('N'))
$bundle = Join-Path $work 'DSHcontroller'
$source = Join-Path $work 'source'
New-Item -ItemType Directory -Path $bundle, $source -Force | Out-Null
Push-Location $repo
try {
    if (-not $NodeVersion) {
        $NodeVersion = (& node.exe -p 'process.versions.node').Trim()
        if ($LASTEXITCODE -ne 0) { throw 'Node.js is unavailable.' }
    }
    if ($NodeVersion -notmatch '^24\.\d+\.\d+$') { throw 'Use a released Node.js 24 version.' }
    & npm.cmd exec -- tsc
    if ($LASTEXITCODE -ne 0) { throw 'TypeScript compilation failed.' }

    # Include corresponding source from explicitly tracked files, using current contents.
    $tracked = @(& git ls-files)
    if ($LASTEXITCODE -ne 0 -or -not $tracked.Count) { throw 'Package from a Git checkout with the release files staged or committed.' }
    foreach ($file in $tracked) {
        if ($file -match '(^|/)(\.git|\.state|\.codex|node_modules|dist)(/|$)|^native/.*/(bin|obj|portable)/') { throw "Private/build data was tracked: $file" }
        $target = Join-Path $source $file
        New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $repo $file) -Destination $target
    }
    $sourceZip = Join-Path $output 'DSHcontroller-source.zip'
    Compress-Archive -Path (Join-Path $source '*') -DestinationPath $sourceZip -Force
    Copy-Item -LiteralPath $sourceZip -Destination (Join-Path $bundle 'DSHcontroller-source.zip')

    foreach ($file in @('package.json', 'package-lock.json', 'LICENSE', 'README.md')) {
        Copy-Item -LiteralPath (Join-Path $repo $file) -Destination $bundle
    }
    Copy-Item -LiteralPath (Join-Path $repo 'dist') -Destination $bundle -Recurse
    Copy-Item -LiteralPath (Join-Path $repo 'docs') -Destination $bundle -Recurse
    Copy-Item -LiteralPath (Join-Path $repo 'examples') -Destination $bundle -Recurse
    $scripts = Join-Path $bundle 'scripts'
    New-Item -ItemType Directory -Path $scripts -Force | Out-Null
    foreach ($file in @('discover.ps1', 'verify-package.mjs')) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination $scripts
    }
    Get-ChildItem -LiteralPath (Join-Path $repo 'packaging') -File | Copy-Item -Destination $bundle

    & npm.cmd ci --omit=dev --ignore-scripts --prefix $bundle
    if ($LASTEXITCODE -ne 0) { throw 'Production dependency installation failed.' }
    $native = Join-Path $bundle 'native/DshUiBridge/portable'
    & dotnet publish native/DshUiBridge/DshUiBridge.csproj -c Release -r win-x64 --self-contained true -p:PublishTrimmed=false -p:DebugType=None -p:DebugSymbols=false --nologo -o $native
    if ($LASTEXITCODE -ne 0) { throw 'Self-contained native publish failed.' }
    if (-not (Test-Path -LiteralPath (Join-Path $native 'coreclr.dll'))) { throw 'Native runtime is missing from the portable publish.' }

    $nodeArchive = "node-v$NodeVersion-win-x64.zip"
    $base = "https://nodejs.org/dist/v$NodeVersion"
    $sums = (Invoke-WebRequest -UseBasicParsing -Uri "$base/SHASUMS256.txt" -TimeoutSec 60).Content
    $line = @($sums -split "`n" | Where-Object { $_.TrimEnd().EndsWith("  $nodeArchive") })
    if ($line.Count -ne 1) { throw 'No unique official checksum found for the Node archive.' }
    $expected = ($line[0] -split '\s+')[0]
    $cache = Join-Path $output 'node-cache'
    New-Item -ItemType Directory -Path $cache -Force | Out-Null
    $download = Join-Path $cache $nodeArchive
    if (-not (Test-Path -LiteralPath $download)) {
        Invoke-WebRequest -UseBasicParsing -Uri "$base/$nodeArchive" -OutFile $download -TimeoutSec 120
    }
    if ((Get-PackageSha256 $download) -ne $expected) { throw 'Node archive SHA-256 mismatch.' }
    $nodeUnpack = Join-Path $work 'node-download'
    Expand-Archive -LiteralPath $download -DestinationPath $nodeUnpack
    $node = Join-Path $bundle 'runtime/node'
    New-Item -ItemType Directory -Path $node -Force | Out-Null
    foreach ($file in @('node.exe', 'LICENSE')) {
        Copy-Item -LiteralPath (Join-Path $nodeUnpack "node-v$NodeVersion-win-x64/$file") -Destination $node
    }
    # Preserve runtime licenses and notices from the exact restored Microsoft packs.
    $nugetLine = (& dotnet nuget locals global-packages --list) -join "`n"
    if ($LASTEXITCODE -ne 0 -or $nugetLine -notmatch 'global-packages:\s*(.+)') { throw 'Cannot locate runtime package notices.' }
    $nugetRoot = $Matches[1].Trim()
    $deps = Get-Content -LiteralPath (Join-Path $native 'DshUiBridge.deps.json') -Raw | ConvertFrom-Json
    $notices = Join-Path $bundle 'runtime/dotnet-notices'
    foreach ($library in $deps.libraries.PSObject.Properties.Name) {
        if ($library -notmatch '^(?:runtimepack\.)?Microsoft\.(NETCore|WindowsDesktop)\.App\.Runtime\.win-x64/(.+)$') { continue }
        $packageRoot = Join-Path $nugetRoot ($library -replace '^runtimepack\.', '').ToLowerInvariant()
        $destination = Join-Path $notices ($library -replace '/', '-')
        New-Item -ItemType Directory -Path $destination -Force | Out-Null
        $noticeFiles = @(Get-ChildItem -LiteralPath $packageRoot -File -Force | Where-Object { $_.Name -match 'license|notice' })
        if (-not $noticeFiles.Count) { throw "Runtime license missing: $library" }
        $noticeFiles | Copy-Item -Destination $destination
    }
    if (-not (Test-Path -LiteralPath $notices)) { throw 'Resolved .NET runtime pack identities were not found.' }

    $commit = (& git rev-parse HEAD).Trim()
    $dirty = [bool](& git status --porcelain)
    $info = @{ version = (Get-Content package.json -Raw | ConvertFrom-Json).version; commit = $commit; dirty = $dirty; node = $NodeVersion; nodeArchiveSha256 = $expected; architecture = 'win-x64'; builtAt = [DateTime]::UtcNow.ToString('o') }
    [IO.File]::WriteAllText((Join-Path $bundle 'BUILD_INFO.json'), ($info | ConvertTo-Json) + "`n", [Text.UTF8Encoding]::new($false))
    & (Join-Path $node 'node.exe') --disable-warning=ExperimentalWarning (Join-Path $scripts 'verify-package.mjs') $bundle
    if ($LASTEXITCODE -ne 0) { throw 'Portable package acceptance failed.' }

    # The acceptance check creates .state locally. Only ship this explicit file list.
    $public = @('dist', 'node_modules', 'native', 'runtime', 'scripts', 'docs', 'examples', 'package.json', 'package-lock.json', 'LICENSE', 'README.md', 'DSHcontroller-source.zip', 'BUILD_INFO.json', 'start-mcp.cmd', 'dshcontroller.cmd', 'check.cmd', 'setup.cmd', 'configure-mcp.ps1')
    $archive = Join-Path $output 'DSHcontroller-win-x64.zip'
    Compress-Archive -LiteralPath @($public | ForEach-Object { Join-Path $bundle $_ }) -DestinationPath $archive -Force
    $checksums = @($archive, $sourceZip) | ForEach-Object { "{0}  {1}" -f (Get-PackageSha256 $_), (Split-Path $_ -Leaf) }
    [IO.File]::WriteAllText((Join-Path $output 'SHA256SUMS.txt'), ($checksums -join "`n") + "`n", [Text.UTF8Encoding]::new($false))
    Write-Host "Portable package: $archive"
} finally { Pop-Location }
