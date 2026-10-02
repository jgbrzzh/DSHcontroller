$ErrorActionPreference = 'Stop'
$all = @(Get-CimInstance Win32_Process)
$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue)
$windows = @(Get-Process | Where-Object { $_.ProcessName -eq 'PCL-Deepseek-Harness-Launcher' -and $_.MainWindowHandle -ne 0 } | ForEach-Object {
    [pscustomobject]@{ pid=$_.Id; handle=$_.MainWindowHandle.ToString(); title=$_.MainWindowTitle; path=$_.Path }
})
$instances = @($all | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'dsh[\\/]lib[\\/]bin\.js' } | ForEach-Object {
    $proc = $_
    $m = [regex]::Match($proc.CommandLine, '([A-Za-z]:[^"\r\n]*?[\\/]versions[\\/]([^\\/]+))[\\/]node_modules')
    if (-not $m.Success) { return }
    $profile = [regex]::Match($proc.CommandLine, '--profile\s+["'']?([^\s"'']+)').Groups[1].Value
    $ports = @($listeners | Where-Object { $_.OwningProcess -eq $proc.ProcessId -and $_.LocalAddress -in @('127.0.0.1','::1') } | ForEach-Object { $_.LocalPort } | Sort-Object -Unique)
    foreach ($port in $ports) {
        $ancestor = $proc
        $window = $null
        for ($i=0; $i -lt 12 -and $ancestor; $i++) {
            $window = $windows | Where-Object { $_.pid -eq $ancestor.ProcessId } | Select-Object -First 1
            if ($window) { break }
            $parentId = $ancestor.ParentProcessId
            $ancestor = $all | Where-Object { $_.ProcessId -eq $parentId } | Select-Object -First 1
        }
        [pscustomobject]@{ pid=$proc.ProcessId; startedAt=$proc.CreationDate.ToUniversalTime().ToString('o'); version=$m.Groups[2].Value; versionDir=$m.Groups[1].Value; profile=$profile; baseUrl="http://127.0.0.1:$port"; window=$window }
    }
})
ConvertTo-Json -InputObject @{instances=$instances;windows=$windows} -Depth 6 -Compress
