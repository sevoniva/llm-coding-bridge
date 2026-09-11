param(
    [ValidateSet('Install', 'Validate', 'Stop', 'Uninstall', 'Status')][string]$Action,
    [Parameter(Mandatory = $true)][string]$Name,
    [string]$Launcher
)
$ErrorActionPreference = 'Stop'
# Avoid loading incompatible PowerShell 7 modules inherited through Node.
$env:PSModulePath = [System.IO.Path]::Combine($PSHOME, 'Modules')
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
    $scheduler = New-Object -ComObject 'Schedule.Service'
    $scheduler.Connect()
    $folder = $scheduler.GetFolder('\')
    $task = $null
    try { $task = $folder.GetTask($Name) }
    catch {
        $exception = $_.Exception
        while ($null -ne $exception.InnerException) { $exception = $exception.InnerException }
        if ($exception.HResult -ne -2147024894) { throw }
    }
    if ($Action -eq 'Status') {
        if ($null -eq $task) {
            [Console]::Out.Write('{"installed":false,"running":false}')
        } else {
            [Console]::Out.Write((@{
                installed = $true; running = ($task.State -eq 4)
                enabled = $task.Enabled; lastExitCode = $task.LastTaskResult
            } | ConvertTo-Json -Compress))
        }
        exit 0
    }
    if ($Action -ne 'Validate' -and $null -ne $task -and $task.GetInstances(0).Count -gt 0) {
        $task.Stop(0)
        $deadline = [DateTime]::UtcNow.AddSeconds(10)
        while ($task.GetInstances(0).Count -gt 0) {
            if ([DateTime]::UtcNow -ge $deadline) { throw 'Timed out stopping task.' }
            Start-Sleep -Milliseconds 100
        }
    }
    if ($Action -eq 'Uninstall') {
        if ($null -ne $task) { $folder.DeleteTask($Name, 0) }
    } elseif ($Action -eq 'Install' -or $Action -eq 'Validate') {
        $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $definition = $scheduler.NewTask(0)
        $definition.RegistrationInfo.Description = 'LLM Coding Bridge: starts after this user logs in; restart-service applies configuration or npm updates.'
        $definition.Principal.UserId = $sid
        $definition.Principal.LogonType = 3 # InteractiveToken: no saved account password.
        $definition.Principal.RunLevel = 0 # Current user, limited privileges.
        $definition.Settings.Enabled = $true
        $definition.Settings.StartWhenAvailable = $true
        $definition.Settings.DisallowStartIfOnBatteries = $false
        $definition.Settings.StopIfGoingOnBatteries = $false
        $definition.Settings.ExecutionTimeLimit = 'PT0S'
        $definition.Settings.MultipleInstances = 2 # IgnoreNew
        $definition.Settings.RestartInterval = 'PT1M'
        $definition.Settings.RestartCount = 999
        $trigger = $definition.Triggers.Create(9) # LogonTrigger
        $trigger.UserId = $sid
        $trigger.Enabled = $true
        $execAction = $definition.Actions.Create(0)
        $execAction.Path = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $execAction.Arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $Launcher + '"'
        $execAction.WorkingDirectory = Split-Path -Parent $Launcher
        if ($Action -eq 'Validate') {
            $null = $folder.RegisterTaskDefinition($Name, $definition, 1, $sid, $null, 3, $null)
        } else {
            $task = $folder.RegisterTaskDefinition($Name, $definition, 6, $sid, $null, 3, $null)
            $null = $task.Run($null)
        }
    }
} catch {
    [Console]::Error.WriteLine('Task Scheduler operation failed. Check current-user permissions and Task Scheduler availability.')
    exit 1
}
