# Wait until the local server answers, then open the browser on its page.
#
# Called in the background by start.bat (start /b, same console) so the launcher
# window can stay in the foreground running the server and therefore die
# together with it.
#
# Why the readiness probe is hand-written instead of using
# Invoke-WebRequest -TimeoutSec:
#   * Invoke-WebRequest does NOT cap the TCP connect phase, so probing a dead
#     port took ~21s per attempt (2.5 minutes for the whole loop). The probe
#     below runs under a hard 3s budget.
#   * Invoke-WebRequest goes through the system proxy. On a machine with a
#     blocked/broken proxy even http://127.0.0.1 fails ("Access is denied" /
#     "cannot connect to the remote server"), and then the browser never opened.
#     A direct socket is immune to that.
#   * With DSH_HSR_TOKEN set, /api/config answers 401; readiness must not depend
#     on that endpoint returning 200. Any HTTP status means the server is up.
#
# NOTE: this file is deliberately ASCII-only. Windows PowerShell 5.1 reads a
# BOM-less .ps1 with the ANSI codepage (GBK on zh-CN Windows), so non-ASCII
# literals here are mis-decoded and break the parser - the same trap that makes
# start.bat ASCII-only.
#
# Environment (set by start.bat):
#   DSH_HSR_URL            URL to open
#   DSH_HSR_HOSTV          host to probe (URL host, or 127.0.0.1 for wildcards)
#   DSH_HSR_PORTV          port to probe
#   DSH_HSR_OPEN_TIMEOUT   seconds to wait for readiness (default 60)
#   DSH_HSR_OPEN_CMD       optional: "program [fixed args]" to use instead of
#                          the default browser, with the URL appended. Used by
#                          tools/launcher-open-test.mjs to capture the URL
#                          instead of really opening a browser.
#   DSH_HSR_OPEN_LOG       optional: file that records each launch attempt.
#   DSH_HSR_TEST_NO_BROWSER  optional: record the selected fallback without
#                           launching it; used only by launcher-open-test.mjs.

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$url = $env:DSH_HSR_URL
$port = 0
[void][int]::TryParse($env:DSH_HSR_PORTV, [ref]$port)
$probeHost = $env:DSH_HSR_HOSTV
if ([string]::IsNullOrWhiteSpace($probeHost)) { $probeHost = '127.0.0.1' }
$openCmd = $env:DSH_HSR_OPEN_CMD

$timeoutSec = 60
$parsed = 0
if ([int]::TryParse($env:DSH_HSR_OPEN_TIMEOUT, [ref]$parsed) -and $parsed -gt 0) { $timeoutSec = $parsed }

# Set DSH_HSR_OPEN_LOG to a file to record every launch attempt. Used by
# tools/launcher-open-test.mjs to prove the correct URL is handed to the browser
# without actually starting one.
$attemptLog = $env:DSH_HSR_OPEN_LOG
function Write-Attempt {
  param([string]$Text)
  if ([string]::IsNullOrWhiteSpace($attemptLog)) { return }
  try { Add-Content -Path $attemptLog -Value $Text -Encoding UTF8 } catch { }
}

if ([string]::IsNullOrWhiteSpace($url) -or $port -le 0) {
  Write-Host '  [WARN] open-when-ready: DSH_HSR_URL / DSH_HSR_PORTV are not set; not opening a browser.' -ForegroundColor Yellow
  exit 1
}

# Cover both IP stacks: a server told to listen on ::1 is not reachable on
# 127.0.0.1 (and the other way round), and "localhost" may resolve to either.
# The configured host goes first so the common case needs a single probe.
$hosts = New-Object System.Collections.Generic.List[string]
foreach ($candidate in @($probeHost, '127.0.0.1', '::1')) {
  if (-not [string]::IsNullOrWhiteSpace($candidate) -and -not $hosts.Contains($candidate)) {
    [void]$hosts.Add($candidate)
  }
}

function Test-HsrUrl {
  param([string]$TargetHost, [int]$TargetPort)

  $client = $null
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $connect = $client.BeginConnect($TargetHost, $TargetPort, $null, $null)
    if (-not $connect.AsyncWaitHandle.WaitOne(3000, $false)) { return $false }
    $client.EndConnect($connect)
    $client.ReceiveTimeout = 3000
    $client.SendTimeout = 3000

    $stream = $client.GetStream()
    $hostHeader = if ($TargetHost.Contains(':')) { "[$TargetHost]" } else { $TargetHost }
    $request = "GET / HTTP/1.0`r`nHost: ${hostHeader}:${TargetPort}`r`nUser-Agent: hsr-launcher`r`nConnection: close`r`n`r`n"
    $bytes = [System.Text.Encoding]::ASCII.GetBytes($request)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush()
    return $true
  } catch {
    return $false
  } finally {
    if ($client) { try { $client.Close() } catch { } }
  }
}

# --- wait for the server -----------------------------------------------------
$deadline = (Get-Date).AddSeconds($timeoutSec)
$ready = $false
while (-not $ready -and (Get-Date) -lt $deadline) {
  foreach ($candidate in $hosts) {
    if (Test-HsrUrl -TargetHost $candidate -TargetPort $port) { $ready = $true; break }
  }
  if (-not $ready) { Start-Sleep -Milliseconds 350 }
}

if (-not $ready) {
  Write-Host "  [WARN] port $port did not answer within ${timeoutSec}s; not opening a browser." -ForegroundColor Yellow
  Write-Host '         The server may have failed to start - see the node output above.' -ForegroundColor Yellow
  exit 1
}

Write-Host "  Server is ready, opening the browser: $url"
Start-Sleep -Milliseconds 150

# --- open it -----------------------------------------------------------------
# Order matters. `cmd /c start` asks the shell to resolve the http:// protocol
# through the per-user URL association, which is what double-clicking a link
# does - but that whole chain (UserChoice -> ProgId -> shell\open\command) is
# outside this program's control, and when it is broken Windows answers with its
# own dialog ("Windows cannot access the specified device, path, or file")
# instead of opening anything. So after the association fails, the browsers are
# tried by their real executable paths, which needs no registry at all.

# Installed browsers, in a deliberate order: Chrome first (it is what the
# association normally points at), then Edge (always present on Windows 10/11).
$KnownBrowsers = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\BraveSoftware\Brave-Browser\Application\brave.exe",
  "$env:ProgramFiles\Mozilla Firefox\firefox.exe",
  "$env:LOCALAPPDATA\Programs\Opera\opera.exe",
  "$env:ProgramFiles\Vivaldi\Application\vivaldi.exe"
)

# A browser that refuses to start is gone again within a second or two. The URL
# is a local page, so still running after a moment means it really opened.
function Test-HsrBrowserStarted {
  param([string]$ProcessName, [int]$Milliseconds = 2000)
  for ($i = 0; $i -lt ($Milliseconds / 250); $i++) {
    Start-Sleep -Milliseconds 250
    $proc = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue
    if (-not $proc) { return $false }
  }
  return $true
}

# The browser Windows would pick for http://, read straight from the per-user URL
# association. Reporting it through DSH_HSR_OPEN_CMD lets the direct-path launch
# below be tried FIRST, which avoids the shell (and its dialogs) entirely.
function Get-HsrDefaultBrowser {
  $keys = @(
    'HKCU:\SOFTWARE\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice',
    'HKCU:\SOFTWARE\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice'
  )
  foreach ($key in $keys) {
    $progId = (Get-ItemProperty -Path $key -ErrorAction SilentlyContinue).ProgId
    if ([string]::IsNullOrWhiteSpace($progId)) { continue }
    foreach ($root in @('HKCU:\SOFTWARE\Classes', 'HKLM:\SOFTWARE\Classes')) {
      $command = (Get-ItemProperty -Path "$root\$progId\shell\open\command" -ErrorAction SilentlyContinue).'(default)'
      if ([string]::IsNullOrWhiteSpace($command)) { continue }
      $exe = $command.Trim()
      if ($exe.StartsWith('"')) {
        $end = $exe.IndexOf('"', 1)
        if ($end -gt 1) { $exe = $exe.Substring(1, $end - 1) }
      } else {
        $cut = $exe.IndexOf('.exe')
        if ($cut -ge 0) { $exe = $exe.Substring(0, $cut + 4) }
      }
      if ($exe -and (Test-Path -LiteralPath $exe)) { return $exe }
    }
  }
  return ''
}

function Open-HsrUrl {
  param([string]$TargetUrl, [string]$Opener)

  if ([string]::IsNullOrWhiteSpace($TargetUrl)) { return $false }

  # 1. the configured program, exactly as given
  if ($Opener) {
    # "program [fixed args]": the fixed part is passed through untouched and the
    # URL is appended, so both a plain browser path and
    # `cmd.exe /c echo %1>>"log"` style capture commands work.
    $openerExe = $Opener
    $openerArgs = ''
    if ($Opener.StartsWith('"')) {
      $closing = $Opener.IndexOf('"', 1)
      if ($closing -gt 1) {
        $openerExe = $Opener.Substring(1, $closing - 1)
        $openerArgs = $Opener.Substring($closing + 1).Trim()
      }
    } else {
      $space = $Opener.IndexOf(' ')
      if ($space -gt 0) {
        $openerExe = $Opener.Substring(0, $space)
        $openerArgs = $Opener.Substring($space + 1).Trim()
      }
    }

    try {
      Write-Attempt "via-opener=$openerExe url=$TargetUrl"
      $spArgs = @{}
      if ($openerArgs) { $spArgs.ArgumentList = @($openerArgs, $TargetUrl) }
      else { $spArgs.ArgumentList = @($TargetUrl) }
      Start-Process -FilePath $openerExe @spArgs | Out-Null
      return $true
    } catch {
      Write-Host "  [WARN] could not open the browser with $openerExe : $($_.Exception.Message)" -ForegroundColor Yellow
    }
  }

  # 2. by real path: first the browser Windows would have picked, then the
  #    installed ones. No registry lookup and no shell dialog involved.
  $browsers = New-Object System.Collections.Generic.List[string]
  $defaultBrowser = Get-HsrDefaultBrowser
  if ($defaultBrowser) { [void]$browsers.Add($defaultBrowser) }
  foreach ($candidate in $KnownBrowsers) {
    if ($candidate -and -not $browsers.Contains($candidate)) { [void]$browsers.Add($candidate) }
  }

  # The fallback regression test must never open a real browser window.
  if ($env:DSH_HSR_TEST_NO_BROWSER -eq '1') {
    if ($browsers.Count -gt 0) {
      Write-Attempt "test-fallback=browser-candidate=$($browsers[0]) url=$TargetUrl"
    } else {
      Write-Attempt "test-fallback=cmd-start url=$TargetUrl"
    }
    Write-Host '  [TEST] browser launch suppressed.'
    return $true
  }

  foreach ($browser in $browsers) {
    if (-not (Test-Path -LiteralPath $browser)) { continue }
    $name = [System.IO.Path]::GetFileNameWithoutExtension($browser)
    try {
      Write-Attempt "via-browser=$browser url=$TargetUrl"
      Start-Process -FilePath $browser -ArgumentList $TargetUrl | Out-Null
    } catch {
      Write-Host "  [WARN] could not start $browser : $($_.Exception.Message)" -ForegroundColor Yellow
      continue
    }
    if (Test-HsrBrowserStarted -ProcessName $name) {
      Write-Host "  Opened with $browser"
      return $true
    }
    Write-Host "  [WARN] $browser did not stay open; trying the next way" -ForegroundColor Yellow
  }

  # 3. finally the shell association, which is what double-clicking a link does.
  #    Checked for liveness too: when the association is broken Windows only
  #    shows a dialog ("cannot access the specified device, path, or file") and
  #    this call still reports success.
  try {
    Write-Attempt "via-cmd-start url=$TargetUrl"
    # `start` needs its title argument (the empty '') or it would treat the URL
    # as the title. -WindowStyle is invalid together with /c, and -NoNewWindow
    # keeps this from flashing a console; the URL is passed as a single quoted
    # token so cmd.exe never sees any '&' the URL itself may contain.
    Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', 'start', '""', "`"$TargetUrl`"") -NoNewWindow | Out-Null
  } catch {
    Write-Host "  [WARN] 'cmd /c start' failed: $($_.Exception.Message)" -ForegroundColor Yellow
  }
  $aliveNames = @()
  foreach ($browser in $browsers) {
    $probeName = [System.IO.Path]::GetFileNameWithoutExtension($browser)
    if ($probeName -and $aliveNames -notcontains $probeName) { $aliveNames += $probeName }
  }
  foreach ($n in @('chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi')) {
    if ($aliveNames -notcontains $n) { $aliveNames += $n }
  }
  for ($i = 0; $i -lt 16; $i++) {
    Start-Sleep -Milliseconds 250
    foreach ($n in $aliveNames) {
      if (Get-Process -Name $n -ErrorAction SilentlyContinue) {
        Write-Host '  Asked the system default browser to open it.'
        return $true
      }
    }
  }
  Write-Host '  [WARN] the shell did not open a browser either.' -ForegroundColor Yellow
  Write-Attempt 'failed'
  return $false
}

if (Open-HsrUrl -TargetUrl $url -Opener $openCmd) { exit 0 }
Write-Host "  Please open it manually: $url" -ForegroundColor Yellow
exit 1
