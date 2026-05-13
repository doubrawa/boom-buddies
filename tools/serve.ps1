# Tiny PowerShell HTTP server for local dev (Windows PowerShell 5.1 compatible).
# Usage: powershell -ExecutionPolicy Bypass -File tools\serve.ps1 [-Port 8765]
param([int]$Port = 8765)

$root = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Mochi Mayhem dev server" -ForegroundColor Cyan
Write-Host "Serving $root on http://localhost:$Port/"
Write-Host "Press Ctrl+C to stop."

$mime = @{
  ".html"="text/html; charset=utf-8"; ".css"="text/css; charset=utf-8";
  ".js"="application/javascript; charset=utf-8"; ".json"="application/json; charset=utf-8";
  ".svg"="image/svg+xml"; ".png"="image/png"; ".jpg"="image/jpeg";
  ".jpeg"="image/jpeg"; ".gif"="image/gif"; ".ico"="image/x-icon";
  ".woff"="font/woff"; ".woff2"="font/woff2"; ".txt"="text/plain; charset=utf-8";
  ".map"="application/json; charset=utf-8";
}

function Send-Bytes($res, $bytes, $contentType, [int]$status = 200) {
  try {
    $res.StatusCode = $status
    $res.ContentType = $contentType
    $res.ContentLength64 = $bytes.Length
    if ($bytes.Length -gt 0) {
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
    }
  } catch {
    # client likely disconnected; swallow
  } finally {
    try { $res.OutputStream.Close() } catch {}
    try { $res.Close() } catch {}
  }
}

try {
  while ($listener.IsListening) {
    $ctx = $null
    try { $ctx = $listener.GetContext() } catch { continue }
    if ($null -eq $ctx) { continue }

    $req = $ctx.Request; $res = $ctx.Response
    try {
      $url = [uri]::UnescapeDataString($req.Url.LocalPath.TrimStart('/'))
      if ([string]::IsNullOrEmpty($url)) { $url = "index.html" }
      $path = Join-Path $root $url

      $full = $null
      try { $full = [IO.Path]::GetFullPath($path) } catch { $full = $null }

      if ($null -eq $full -or -not $full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
        Send-Bytes $res ([Text.Encoding]::UTF8.GetBytes("403 forbidden")) "text/plain; charset=utf-8" 403
        Write-Host "403 $url" -ForegroundColor Red
        continue
      }

      if (Test-Path $full -PathType Container) {
        $full = Join-Path $full "index.html"
      }

      if (Test-Path $full -PathType Leaf) {
        $ext = [IO.Path]::GetExtension($full).ToLower()
        $ct = $mime[$ext]
        if (-not $ct) { $ct = "application/octet-stream" }
        $bytes = [IO.File]::ReadAllBytes($full)
        Send-Bytes $res $bytes $ct 200
        Write-Host "200 $url"
      } else {
        $msg = [Text.Encoding]::UTF8.GetBytes("404: $url not found")
        Send-Bytes $res $msg "text/plain; charset=utf-8" 404
        Write-Host "404 $url" -ForegroundColor Yellow
      }
    } catch {
      Write-Host "ERR processing request: $_" -ForegroundColor Red
      try { $res.StatusCode = 500; $res.Close() } catch {}
    }
  }
} finally {
  try { $listener.Stop() } catch {}
  try { $listener.Close() } catch {}
}
