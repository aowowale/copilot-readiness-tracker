<#
.SYNOPSIS
    Lists every tenant and subscription the Azure CLI already knows about, across all isolated
    profiles (~/.azure and ~/.azure-*), so you can see which tenants can host a deployment.

.DESCRIPTION
    Read-only and offline: it reads the cached account lists and does not refresh tokens, so a
    tenant with an expired sign-in is still listed (marked 'sign in again'). A tenant that shows
    only a tenant-level account has no Azure subscription and cannot run the Bicep deployment.

.EXAMPLE
    .\Get-TenantInventory.ps1
#>
[CmdletBinding()]
param()

$originalConfigDir = $env:AZURE_CONFIG_DIR
$profiles = @([pscustomobject]@{ Name = '.azure (default)'; Path = (Join-Path $HOME '.azure') })
$profiles += Get-ChildItem -Path $HOME -Directory -Filter '.azure-*' | ForEach-Object { [pscustomobject]@{ Name = $_.Name; Path = $_.FullName } }

$rows = foreach ($p in $profiles) {
    if (-not (Test-Path (Join-Path $p.Path 'azureProfile.json'))) { continue }
    $env:AZURE_CONFIG_DIR = $p.Path
    $raw = az account list --all --output json 2>$null
    try { $accounts = @($raw | ConvertFrom-Json) } catch { continue }
    $cloud = (az cloud show --query name --output tsv 2>$null)
    foreach ($group in ($accounts | Group-Object tenantId, { $_.user.name }, environmentName)) {
        $first = $group.Group[0]
        $real = @($group.Group | Where-Object { $_.name -notmatch '^N/A' -and $_.state -eq 'Enabled' })
        [pscustomobject]@{
            Profile       = $p.Name
            Cloud         = $cloud
            Tenant        = $first.tenantId
            Account       = $first.user.name
            Subscriptions = $real.Count
            CanDeploy     = if ($real.Count) { 'Yes' } else { 'No - tenant-level only' }
            Example       = ($real | Select-Object -First 1).name
        }
    }
}

if ($null -eq $originalConfigDir) { Remove-Item Env:AZURE_CONFIG_DIR -ErrorAction SilentlyContinue } else { $env:AZURE_CONFIG_DIR = $originalConfigDir }

$rows | Sort-Object Cloud, Tenant | ForEach-Object {
    "{0}`n    tenant {1}`n    {2} ({3})`n    subscriptions: {4}  deployable: {5}{6}`n" -f $_.Profile, $_.Tenant, $_.Account, $_.Cloud, $_.Subscriptions, $_.CanDeploy, $(if ($_.Example) { "  e.g. $($_.Example)" })
}
Write-Host 'Refresh an expired sign-in with: $env:AZURE_CONFIG_DIR = "$HOME\<profile>"; az login --tenant <tenantId>' -ForegroundColor DarkGray
