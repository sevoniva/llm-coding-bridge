param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('ProtectFile', 'VerifyFile', 'Encrypt', 'Decrypt')]
    [string]$Action,
    [string]$File
)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
    if ($Action -eq 'ProtectFile') {
        $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
        $acl = New-Object System.Security.AccessControl.FileSecurity
        $acl.SetOwner($sid)
        $acl.SetAccessRuleProtection($true, $false)
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')
        $acl.AddAccessRule($rule)
        Set-Acl -LiteralPath $File -AclObject $acl
    } elseif ($Action -eq 'VerifyFile') {
        $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
        $acl = Get-Acl -LiteralPath $File
        if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or !$acl.AreAccessRulesProtected) {
            throw 'Private file ACL is invalid.'
        }
        $allowed = $false
        foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
            if ($rule.AccessControlType -eq 'Allow') {
                if ($rule.IdentityReference.Value -ne $sid.Value) { throw 'Private file ACL is invalid.' }
                $allowed = $true
            }
        }
        if (!$allowed) { throw 'Private file ACL is invalid.' }
    } elseif ($Action -eq 'Encrypt') {
        $plain = [Console]::In.ReadToEnd()
        if ([string]::IsNullOrWhiteSpace($plain)) { throw 'Empty credential.' }
        $secure = ConvertTo-SecureString -String $plain -AsPlainText -Force
        [Console]::Out.Write((ConvertFrom-SecureString -SecureString $secure))
        $secure.Dispose()
    } else {
        $encrypted = [System.IO.File]::ReadAllText($File)
        $secure = ConvertTo-SecureString -String $encrypted
        $pointer = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try { [Console]::Out.Write([System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)) }
        finally {
            [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
            $secure.Dispose()
        }
    }
} catch {
    # Never include PowerShell exception details: they may contain the secret input.
    [Console]::Error.WriteLine('Windows credential or private-file operation failed.')
    exit 1
}
