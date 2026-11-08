# Cai server ChotLive tu chay moi khi dang nhap Windows, khong hien cua so.
#   Cai : bam dup scripts\cai-tu-chay-server.cmd (chon Yes de mo cong 3000 cho dien thoai)
#   Go  : powershell -ExecutionPolicy Bypass -File scripts\cai-tu-chay-server.ps1 -Uninstall
param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'

$TaskName = 'ChotLive Server'
$RuleName = 'ChotLive Server'
$AppPort = 3000
$ProjectDir = Split-Path -Parent $PSScriptRoot
$Runner = Join-Path $PSScriptRoot 'run-server.cmd'

$IsAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

function Stop-ServerTask {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  # Dung server node con giu cong 3000 tu lan chay truoc.
  Get-NetTCPConnection -LocalPort $AppPort -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue } |
    Where-Object { $_.ProcessName -eq 'node' } |
    ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
}

if ($Uninstall) {
  Stop-ServerTask
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  if ($IsAdmin) { Remove-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue }
  Write-Host "Da go tac vu '$TaskName'. Du lieu van con nguyen."
  exit 0
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Chua cai Node.js. Hay cai Node.js ban 22.13 tro len roi chay lai.' }

# 1. Tac vu chay khi dang nhap. conhost --headless de khong hien cua so den.
$Conhost = Join-Path $env:WINDIR 'System32\conhost.exe'
$Action = New-ScheduledTaskAction -Execute $Conhost -Argument "--headless cmd.exe /c `"$Runner`"" -WorkingDirectory $ProjectDir
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$Principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)

Stop-ServerTask
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal -Force | Out-Null

# 2. Mo cong 3000 cho dien thoai cung Wi-Fi va Tailscale (can quyen Administrator).
if ($IsAdmin) {
  Remove-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue
  New-NetFirewallRule -DisplayName $RuleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $AppPort `
    -RemoteAddress LocalSubnet, '100.64.0.0/10' -Profile Any | Out-Null
  Write-Host "Da mo cong $AppPort cho mang noi bo va Tailscale."
} else {
  Write-Host "Chua mo cong $AppPort (can quyen Administrator). Bam dup scripts\cai-tu-chay-server.cmd va chon Yes."
}

Start-ScheduledTask -TaskName $TaskName
Write-Host "Xong. Server da chay va se tu chay moi khi dang nhap Windows. Nhat ky: data\server.log"
Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.InterfaceAlias -match 'Wi-Fi|Ethernet|Tailscale' -and $_.IPAddress -notlike '169.254*' } |
  ForEach-Object { Write-Host ("  Dia chi cho dien thoai ({0}): http://{1}:{2}" -f $_.InterfaceAlias, $_.IPAddress, $AppPort) }
