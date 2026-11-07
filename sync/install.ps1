# Cai dat tac vu dong bo chay nen khi bat may.
#   Laptop : powershell -ExecutionPolicy Bypass -File sync\install.ps1
#   Mini PC: bam dup sync\cai-tren-mini-pc.cmd (can quyen Administrator de mo cong)
#   Go bo  : powershell -ExecutionPolicy Bypass -File sync\install.ps1 -Uninstall
param(
  [ValidateSet('laptop', 'hub')][string]$Role = 'laptop',
  [string]$Key = '',
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'

$TaskName = 'ChotLive Sync'
$RuleName = 'ChotLive Sync'
$SyncPort = 3100
$ProjectDir = Split-Path -Parent $PSScriptRoot
$Script = Join-Path $PSScriptRoot 'sync.js'
$ConfigFile = Join-Path $PSScriptRoot 'config.json'

$IsAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if ($Uninstall) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  if ($IsAdmin) { Remove-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue }
  Write-Host "Da go tac vu '$TaskName'. Du lieu va ban sao van con nguyen."
  exit 0
}

$Node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $Node) { throw 'Chua cai Node.js. Hay cai Node.js ban 22.13 tro len roi chay lai.' }

if ($Role -eq 'hub' -and -not $IsAdmin) { throw 'Mini PC can chay bang quyen Administrator de mo cong dong bo.' }

# 1. Cau hinh
$InitArgs = @('--no-warnings', $Script, 'init')
if ($Role -eq 'hub') {
  if (-not (Test-Path $ConfigFile) -and -not $Key) {
    $Key = Read-Host 'Dan ma ket noi cua laptop (tren laptop chay: node sync/sync.js show-key)'
  }
  $InitArgs += '--hub'
}
if ($Key) { $InitArgs += @('--key', $Key) }
& $Node @InitArgs
if ($LASTEXITCODE -ne 0) { throw 'Khong tao duoc cau hinh.' }

# 2. Tac vu chay nen
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)

if ($Role -eq 'hub') {
  # Chay ngay khi mini PC khoi dong, khong can dang nhap. S4U khong mo cua so.
  $Action = New-ScheduledTaskAction -Execute $Node -Argument "--no-warnings `"$Script`" agent" -WorkingDirectory $ProjectDir
  $Trigger = New-ScheduledTaskTrigger -AtStartup
  $Principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited
} else {
  # Chay khi dang nhap laptop. conhost --headless de khong hien cua so den.
  $Conhost = Join-Path $env:WINDIR 'System32\conhost.exe'
  $Action = New-ScheduledTaskAction -Execute $Conhost -Argument "--headless `"$Node`" --no-warnings `"$Script`" agent" -WorkingDirectory $ProjectDir
  $Trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $Principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
}

Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal -Force | Out-Null

# 3. Rieng mini PC: mo cong cho mang noi bo va khong cho may tu ngu khi cam dien
if ($Role -eq 'hub') {
  Remove-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue
  New-NetFirewallRule -DisplayName $RuleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $SyncPort `
    -RemoteAddress LocalSubnet, '100.64.0.0/10' -Profile Any | Out-Null
  & powercfg /change standby-timeout-ac 0
  Write-Host "Da mo cong $SyncPort cho mang noi bo va tat che do ngu khi cam dien."
}

Start-ScheduledTask -TaskName $TaskName
Write-Host "Xong. Tac vu '$TaskName' da chay va se tu chay lai moi khi bat may."
if ($Role -eq 'hub') {
  Write-Host 'Tren laptop, bam dup sync\them-mini-pc.cmd roi nhap ten may hoac IP o tren.'
}
