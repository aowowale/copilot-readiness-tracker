<#
.SYNOPSIS
    Builds the workspace evidence feed that the collector reads from the 'feeds' blob container.

.DESCRIPTION
    Some facts have no Microsoft Graph source: SharePoint exposure and high-risk objects (Data
    Access Governance), legal hold and retention (Purview), site permissions, and SharePoint
    activity. This script collects what SharePoint Online can report directly (RCD and last
    content change per site) and merges an optional administrator-supplied overrides file for
    the rest. It is read-only: it changes nothing in the tenant.

    Rules that keep the dashboard honest:
      - Leave a fact OUT of the overrides file unless you verified it. Missing means Unknown.
      - Set legalHold or retentionLocked to false ONLY when you confirmed that no eDiscovery hold,
        retention policy or records label applies to that workspace. A false value is what allows
        a delete request to reach a second approver. Unknown keeps delete blocked.
      - activityDays here is SharePoint content activity, not Teams chat or meeting activity.

    Requirements: SharePoint Online Management Shell and either an existing connection or the
    certificate parameters below. For -Upload, Azure CLI must hold Storage Blob Data Contributor.

.PARAMETER OverridesJson
    Optional JSON file: { "<teamId>": { "exposure": "High", "exposureCount": 3,
    "highRiskObjects": 12, "legalHold": false, "retentionLocked": false, "activeChannels": 4,
    "sitePrincipals": [ { "id": "<userObjectId>", "name": "Display name" } ] } }

.PARAMETER AgentsJson
    Optional JSON file with an array of agents the tenant APIs do not list (Copilot Studio, Power Platform or
    Agent 365 exports): [ { "id": "...", "name": "Claims Bot", "platform": "Copilot Studio",
    "owners": ["a@contoso.com"], "lastModifiedAt": "2026-09-01", "status": "Published",
    "sharedWith": "Everyone", "connectors": ["SharePoint"] } ]. Leave a field out when unknown: an agent
    with no "owners" is shown as owner unknown; only an empty list means it has no owner.

.PARAMETER TeamsActivityCsv
    Optional customer-approved Teams activity report. Required columns are Team Id, Last Activity
    Date, and Active Channels. Matching values replace SharePoint content activity for that Team.

.PARAMETER LifecycleEvidenceCsv
    Optional customer-approved Purview/eDiscovery determination. Required columns are Team Id,
    Legal Hold, and Retention Locked; boolean values must be exactly true or false.

.PARAMETER CopilotUsageCsv
    Optional customer-approved Microsoft 365 Admin Center Copilot usage export. This is the
    supported adoption fallback when the Graph usage API is unavailable in a sovereign cloud.

.PARAMETER SkipSharePoint
    Build a feed only from approved files without connecting to SharePoint Online.

.PARAMETER IncludeOneDrive
    Includes site-level metadata for provisioned personal OneDrive sites from Get-SPOSite. It does
    not enumerate document names or contents. The export may include personal identifiers and must
    be stored with the same protections as other tenant evidence.

.PARAMETER Upload
    Uploads the feed to <StorageAccount>/feeds/evidence.json (overwrites the previous feed).

.EXAMPLE
    .\Export-WorkspaceEvidence.ps1 -OverridesJson .\overrides.json -OutFile evidence.json

.EXAMPLE
    .\Export-WorkspaceEvidence.ps1 -OverridesJson .\overrides.json -Upload -StorageAccount samstgabc123
#>
[CmdletBinding()]
param(
    [string]$OverridesJson,
    [string]$AgentsJson,
    [string]$TeamsActivityCsv,
    [string]$LifecycleEvidenceCsv,
    [string]$CopilotUsageCsv,
    [string]$OutFile = 'evidence.json',
    [switch]$Upload,
    [string]$StorageAccount,
    [switch]$IncludeOneDrive,
    [switch]$SkipSharePoint,
    [string]$SharePointAdminUrl,
    [string]$TenantId,
    [string]$ClientId,
    [string]$CertificateThumbprint
)

$ErrorActionPreference = 'Stop'
if ($Upload -and -not $StorageAccount) { throw '-Upload needs -StorageAccount.' }
$connectionValues = @($SharePointAdminUrl, $TenantId, $ClientId, $CertificateThumbprint) | Where-Object { $_ }
if ($connectionValues.Count -notin 0, 4) { throw 'SharePointAdminUrl, TenantId, ClientId, and CertificateThumbprint must be supplied together for unattended authentication.' }
if ($SkipSharePoint -and ($connectionValues.Count -or $IncludeOneDrive)) { throw '-SkipSharePoint cannot be combined with SharePoint connection parameters or -IncludeOneDrive.' }
if ($connectionValues.Count -eq 4) {
    Import-Module Microsoft.Online.SharePoint.PowerShell -MinimumVersion 16.0.24810.12000 -DisableNameChecking
    Connect-SPOService -Url $SharePointAdminUrl -TenantId $TenantId -ClientId $ClientId -CertificateThumbprint $CertificateThumbprint
}

$allowedFields = @('exposure', 'exposureCount', 'highRiskObjects', 'activityDays', 'activeChannels', 'legalHold', 'retentionLocked', 'rcd', 'sitePrincipals')
$today = (Get-Date).Date
$now = (Get-Date).ToUniversalTime()
$workspaces = @{}
$oneDriveSites = @()

if (-not $SkipSharePoint) {
    Write-Host 'Reading SharePoint sites...' -ForegroundColor Cyan
    foreach ($site in (Get-SPOSite -Limit All)) {
        $groupId = "$($site.GroupId)"
        if (-not $groupId -or $groupId -eq '00000000-0000-0000-0000-000000000000') { continue }
        $entry = [ordered]@{ rcd = [bool]$site.RestrictContentOrgWideSearch }
        if ($site.LastContentModifiedDate) {
            $entry.activityDays = [int][math]::Max(0, ($now.Date - ([datetime]$site.LastContentModifiedDate).ToUniversalTime().Date).TotalDays)
        }
        $workspaces[$groupId.ToLowerInvariant()] = $entry
    }
    Write-Host "Found $($workspaces.Count) group-connected sites." -ForegroundColor Cyan
}

if ($IncludeOneDrive) {
    Write-Host 'Reading provisioned OneDrive site metadata (no file inventory)...' -ForegroundColor Cyan
    foreach ($site in (Get-SPOSite -IncludePersonalSite $true -Limit All | Where-Object { $_.Template -like 'SPSPERS*' })) {
        $owner = "$($site.Owner)".Trim().ToLowerInvariant()
        $lastActivity = $null
        if ($site.LastContentModifiedDate) { $lastActivity = ([datetime]$site.LastContentModifiedDate).ToUniversalTime().ToString('o') }
        $oneDriveSites += [ordered]@{
            url = "$($site.Url)"
            title = "$($site.Title)"
            ownerUpn = if ($owner) { $owner } else { $null }
            lastActivityAt = $lastActivity
            storageMb = if ($null -ne $site.StorageUsageCurrent) { [double]$site.StorageUsageCurrent } else { $null }
            sharingCapability = "$($site.SharingCapability)"
            lockState = "$($site.LockState)"
            status = "$($site.Status)"
        }
    }
    Write-Host "Found $($oneDriveSites.Count) provisioned personal sites." -ForegroundColor Cyan
}

$overrideCount = 0
if ($OverridesJson) {
    if (-not (Test-Path -LiteralPath $OverridesJson)) { throw "Overrides file not found: $OverridesJson" }
    $overrides = Get-Content -LiteralPath $OverridesJson -Raw | ConvertFrom-Json -AsHashtable
    foreach ($teamId in $overrides.Keys) {
        $key = "$teamId".ToLowerInvariant()
        if (-not $workspaces.ContainsKey($key)) { $workspaces[$key] = [ordered]@{} }
        foreach ($field in $overrides[$teamId].Keys) {
            if ($allowedFields -notcontains $field) { Write-Warning "Ignoring unknown field '$field' for $teamId."; continue }
            $workspaces[$key][$field] = $overrides[$teamId][$field]
        }
        $overrideCount++
    }
    Write-Host "Merged overrides for $overrideCount workspaces." -ForegroundColor Cyan
}

if ($TeamsActivityCsv) {
    if (-not (Test-Path -LiteralPath $TeamsActivityCsv)) { throw "Teams activity file not found: $TeamsActivityCsv" }
    foreach ($row in (Import-Csv -LiteralPath $TeamsActivityCsv)) {
        $teamId = "$($row.'Team Id')".Trim().ToLowerInvariant()
        $parsedTeamId = [guid]::Empty
        if (-not [guid]::TryParse($teamId, [ref]$parsedTeamId)) { throw "Teams activity row has an invalid Team Id: $teamId" }
        if (-not $workspaces.ContainsKey($teamId)) { $workspaces[$teamId] = [ordered]@{} }
        if ($row.'Last Activity Date') {
            $lastActivity = [datetime]$row.'Last Activity Date'
            $workspaces[$teamId].activityDays = [int][math]::Max(0, ($today - $lastActivity.Date).TotalDays)
        }
        if ($row.'Active Channels' -ne '') { $workspaces[$teamId].activeChannels = [int]$row.'Active Channels' }
    }
}

if ($LifecycleEvidenceCsv) {
    if (-not (Test-Path -LiteralPath $LifecycleEvidenceCsv)) { throw "Lifecycle evidence file not found: $LifecycleEvidenceCsv" }
    foreach ($row in (Import-Csv -LiteralPath $LifecycleEvidenceCsv)) {
        $teamId = "$($row.'Team Id')".Trim().ToLowerInvariant()
        $parsedTeamId = [guid]::Empty
        if (-not [guid]::TryParse($teamId, [ref]$parsedTeamId)) { throw "Lifecycle evidence row has an invalid Team Id: $teamId" }
        if (-not $workspaces.ContainsKey($teamId)) { $workspaces[$teamId] = [ordered]@{} }
        foreach ($column in @(@{ Name = 'Legal Hold'; Field = 'legalHold' }, @{ Name = 'Retention Locked'; Field = 'retentionLocked' })) {
            $value = "$($row.($column.Name))".Trim().ToLowerInvariant()
            if ($value -notin 'true', 'false') { throw "Lifecycle evidence for $teamId requires true or false in '$($column.Name)'." }
            $workspaces[$teamId][$column.Field] = $value -eq 'true'
        }
    }
}

$feed = [ordered]@{
    schemaVersion = 1
    generatedAt   = $now.ToString('o')
    sources       = [ordered]@{
        rcd             = if ($SkipSharePoint) { 'Not collected' } else { 'SharePoint Online Get-SPOSite' }
        activityDays    = if ($TeamsActivityCsv) { "Customer-approved Teams activity report $(Split-Path $TeamsActivityCsv -Leaf)" } elseif ($SkipSharePoint) { 'Not collected' } else { 'SharePoint last content modified date (not Teams activity)' }
        activeChannels  = if ($TeamsActivityCsv) { "Customer-approved Teams activity report $(Split-Path $TeamsActivityCsv -Leaf)" } else { 'Not collected' }
        legalHold       = if ($LifecycleEvidenceCsv) { "Customer-approved Purview determination $(Split-Path $LifecycleEvidenceCsv -Leaf)" } else { 'Not collected' }
        retentionLocked = if ($LifecycleEvidenceCsv) { "Customer-approved Purview determination $(Split-Path $LifecycleEvidenceCsv -Leaf)" } else { 'Not collected' }
        copilotUsage    = if ($CopilotUsageCsv) { "Customer-approved Microsoft 365 Copilot usage export $(Split-Path $CopilotUsageCsv -Leaf)" } else { 'Not collected' }
        onedrive        = if ($IncludeOneDrive) { 'SharePoint Online Get-SPOSite personal sites; metadata only' } else { 'Not collected' }
        overrides       = if ($OverridesJson) { "Administrator file $(Split-Path $OverridesJson -Leaf)" } else { 'None supplied' }
    }
    workspaces    = $workspaces
}

if ($IncludeOneDrive) {
    $feed.onedrive = @($oneDriveSites)
    $feed.onedriveComplete = $true
}

if ($AgentsJson) {
    if (-not (Test-Path -LiteralPath $AgentsJson)) { throw "Agents file not found: $AgentsJson" }
    $agents = @(Get-Content -LiteralPath $AgentsJson -Raw | ConvertFrom-Json)
    $feed.agents = $agents
    Write-Host "Included $($agents.Count) agents." -ForegroundColor Cyan
}

if ($CopilotUsageCsv) {
    if (-not (Test-Path -LiteralPath $CopilotUsageCsv)) { throw "Copilot usage file not found: $CopilotUsageCsv" }
    $usageText = Get-Content -LiteralPath $CopilotUsageCsv -Raw
    if ([Text.Encoding]::UTF8.GetByteCount($usageText) -gt 20MB) { throw 'Copilot usage file exceeds 20 MB.' }
    $feed.copilotUsageCsv = $usageText
}

$feed | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $OutFile -Encoding utf8
Write-Host "Wrote $OutFile." -ForegroundColor Green

if ($Upload) {
    az storage blob upload --account-name $StorageAccount --container-name feeds --name evidence.json --file $OutFile --overwrite --auth-mode login | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Upload failed.' }
    Write-Host "Uploaded to $StorageAccount/feeds/evidence.json. The next collector run applies it." -ForegroundColor Green
}
