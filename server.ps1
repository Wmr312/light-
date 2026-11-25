$root = 'c:\Users\maorong.wu\Downloads\light-guide-validator-20261013'
$port = 8088

$mime = @{
    '.html'='text/html; charset=utf-8'; '.js'='application/javascript; charset=utf-8'
    '.css'='text/css; charset=utf-8'; '.json'='application/json; charset=utf-8'
    '.svg'='image/svg+xml'; '.png'='image/png'; '.jpg'='image/jpeg'
    '.gif'='image/gif'; '.ico'='image/x-icon'; '.stl'='application/octet-stream'
    '.wasm'='application/wasm'; '.map'='application/json; charset=utf-8'
    '.webmanifest'='application/manifest+json; charset=utf-8'
}

$ip = [System.Net.IPAddress]::Loopback
$server = [System.Net.Sockets.TcpListener]::new($ip, $port)
$server.Start()
Write-Host "Serving $root at http://localhost:$port/ (TCP direct)"

$enc = [System.Text.Encoding]::UTF8
$buf = New-Object byte[] 8192

function Send-Http([System.Net.Sockets.Socket]$sock, [int]$code, [string]$ct, [byte[]]$body) {
    $reason = switch ($code) { 200 {'OK'} ; 404 {'Not Found'} ; default {'Error'} }
    $header = "HTTP/1.1 $code $reason`r`nContent-Type: $ct`r`nContent-Length: $($body.Length)`r`nConnection: close`r`nAccess-Control-Allow-Origin: *`r`n`r`n"
    $hb = $enc.GetBytes($header)
    $sock.Send($hb) | Out-Null
    if ($body.Length -gt 0) { $sock.Send($body) | Out-Null }
}

while ($true) {
    $client = $server.AcceptSocket()
    try {
        $total = 0
        while ($total -lt $buf.Length) {
            $n = $client.Receive($buf, $total, $buf.Length - $total, [System.Net.Sockets.SocketFlags]::None)
            if ($n -le 0) { break }
            $total += $n
            if ($total -ge 4 -and $enc.GetString($buf, 0, $total).Contains("`r`n`r`n")) { break }
        }
        if ($total -eq 0) { $client.Close(); continue }
        $req = $enc.GetString($buf, 0, $total)
        $lines = $req -split "`r`n"
        $requestLine = $lines[0]
        if ($requestLine -notmatch '^(\w+)\s+(\S+)\s+HTTP/') { $client.Close(); continue }
        $method = $Matches[1]; $rawPath = $Matches[2]
        if ($method -ne 'GET' -and $method -ne 'HEAD') {
            Send-Http $client 405 'text/plain' ($enc.GetBytes('Method Not Allowed'))
            $client.Close(); continue
        }
        $path = ($rawPath -split '\?')[0].TrimStart('/')
        if (-not $path) { $path = 'index.html' }
        $fullPath = Join-Path $root ([System.Uri]::UnescapeDataString($path))
        if (-not (Test-Path $fullPath) -or (Get-Item $fullPath).PSIsContainer) {
            $fullPath = Join-Path $root 'index.html'
        }
        if (Test-Path $fullPath) {
            $ext = [System.IO.Path]::GetExtension($fullPath).ToLower()
            $ct = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
            $bytes = [System.IO.File]::ReadAllBytes($fullPath)
            Send-Http $client 200 $ct $bytes
            Write-Host "200  $rawPath  ($($bytes.Length) B)"
        } else {
            Send-Http $client 404 'text/plain' ($enc.GetBytes('Not Found'))
            Write-Host "404  $rawPath"
        }
    } catch {
        Write-Host "ERR $($_.Exception.Message)"
    } finally {
        try { $client.Shutdown([System.Net.Sockets.SocketShutdown]::Both) } catch {}
        try { $client.Close() } catch {}
    }
}
$server.Stop()
