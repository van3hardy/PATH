[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$TaskName = 'Path Phase 4 Scheduler',
    [ValidateRange(1, 1440)]
    [int]$EveryMinutes = 60,
    [switch]$Uninstall,
    [string]$RepoRoot = ''
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = (Get-Location).Path
}
$taskPath = "\$TaskName"
$schedulerScript = Join-Path $RepoRoot 'scripts\path-scheduler.mjs'
$nodeCommand = Get-Command node -ErrorAction Stop
$logDirectory = Join-Path $RepoRoot 'data\path-scheduler-logs'
$stdoutLog = Join-Path $logDirectory 'path-scheduler.out.log'
$stderrLog = Join-Path $logDirectory 'path-scheduler.err.log'

function Quote-PowerShellLiteral {
    param([Parameter(Mandatory = $true)][string]$Value)
    return "'" + ($Value -replace "'", "''") + "'"
}

if (-not (Test-Path -LiteralPath $schedulerScript)) {
    throw "Scheduler entrypoint not found: $schedulerScript"
}

if ($Uninstall) {
    $message = "Unregister scheduled task '$TaskName'"
    if ($WhatIfPreference -or $PSCmdlet.ShouldProcess($taskPath, 'Unregister Scheduled Task')) {
        if ($WhatIfPreference) {
            Write-Output "WHATIF: $message"
        } else {
            Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
            Write-Output "Removed scheduled task '$TaskName'."
        }
    }
    return
}

$repoRootLiteral = Quote-PowerShellLiteral $RepoRoot
$nodeLiteral = Quote-PowerShellLiteral $nodeCommand.Source
$schedulerLiteral = Quote-PowerShellLiteral $schedulerScript
$stdoutLiteral = Quote-PowerShellLiteral $stdoutLog
$stderrLiteral = Quote-PowerShellLiteral $stderrLog
$commandText = "& { Set-Location -LiteralPath $repoRootLiteral; & $nodeLiteral $schedulerLiteral --once 1>> $stdoutLiteral 2>> $stderrLiteral }"
$actionArgs = "-NoProfile -ExecutionPolicy Bypass -Command `"$commandText`""
$triggerDescription = "Every $EveryMinutes minute(s)"
$actionDescription = "powershell.exe $actionArgs (WorkingDirectory=$RepoRoot)"

if ($WhatIfPreference) {
    Write-Output "WHATIF: Register scheduled task '$TaskName'"
    Write-Output "WHATIF: Trigger: $triggerDescription"
    Write-Output "WHATIF: Action: $actionDescription"
    Write-Output "WHATIF: Stdout log: $stdoutLog"
    Write-Output "WHATIF: Stderr log: $stderrLog"
    return
}

if ($PSCmdlet.ShouldProcess($taskPath, 'Register Scheduled Task')) {
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $actionArgs -WorkingDirectory $RepoRoot
    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes) -RepetitionDuration (New-TimeSpan -Days 3650)
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Runs the local approval-gated Path Phase 4 scheduler.' -Force | Out-Null
    Write-Output "Registered scheduled task '$TaskName' ($triggerDescription)."
}
