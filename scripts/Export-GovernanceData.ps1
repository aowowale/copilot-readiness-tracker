<#
.SYNOPSIS
    Exports read-only Teams / group governance data from a Microsoft 365 tenant into the
    JSON shape the Copilot Readiness dashboard imports (Manual import mode).

.DESCRIPTION
    Uses Microsoft Graph PowerShell with read-only delegated or application permissions.
    Nothing is modified in the tenant. Activity and exposure that cannot be reliably
    determined are left null / "Unknown" — never guessed and never reported as "Inactive".

    Requirements:
      Install-Module Microsoft.Graph -Scope CurrentUser
    GCC High note: connect with -Environment USGov.

.PARAMETER TeamIds
    Optional list of group/team IDs to export. If omitted, the ENTIRE tenant is exported
    (every Teams-enabled group).

.PARAMETER TeamsActivityCsv
    Optional path to a Teams activity report CSV (Teams admin center > Usage reports > Teams
    activity, or Get-MgReportTeamActivityDetail). When supplied, 'Last Activity Date' and
    'Active Channels' are merged in to fill activityDays / activeChannels. Rows that do not
    match a Team Id (e.g. when the report conceals identifiers) are left as Unknown.

.PARAMETER OutFile
    Path to write the import JSON (default governance-import.json).

.EXAMPLE
    .\Export-GovernanceData.ps1 -Environment USGov -OutFile governance-import.json

.EXAMPLE
    .\Export-GovernanceData.ps1 -Environment USGov -TeamsActivityCsv .\TeamsActivity.csv
#>
[CmdletBinding()]
param(
    [string[]]$TeamIds,
    [ValidateSet('Global', 'USGov', 'USGovDoD')]
    [string]$Environment = 'USGov',
    [string]$OutFile = 'governance-import.json',
    [string]$TeamsActivityCsv
)

$ErrorActionPreference = 'Stop'

# Read-only scopes. A tenant administrator may need to consent.
$scopes = @('Group.Read.All', 'TeamMember.Read.All', 'Channel.ReadBasic.All', 'Sites.Read.All')
Connect-MgGraph -Scopes $scopes -Environment $Environment | Out-Null

function Get-ExposureFromVisibility {
    param($group)
    # Conservative mapping. Real exposure requires SharePoint sharing review;
    # leave "Unknown" unless you have a validated signal.
    return 'Unknown'
}

# Optional: load a Teams activity report CSV to fill activityDays / activeChannels.
$activityByTeam = @{}
if ($TeamsActivityCsv) {
    if (-not (Test-Path -LiteralPath $TeamsActivityCsv)) { throw "Teams activity CSV not found: $TeamsActivityCsv" }
    Write-Host "Merging Teams activity from $TeamsActivityCsv..." -ForegroundColor Cyan
    $today = (Get-Date).Date
    foreach ($row in (Import-Csv -LiteralPath $TeamsActivityCsv)) {
        $tid = $row.'Team Id'
        if (-not $tid) { continue }
        $days = $null
        if ($row.'Last Activity Date') {
            try { $days = [int]((New-TimeSpan -Start ([datetime]$row.'Last Activity Date').Date -End $today).TotalDays) } catch {}
        }
        $active = $null
        if ($row.PSObject.Properties['Active Channels'] -and $row.'Active Channels' -ne '') {
            try { $active = [int]$row.'Active Channels' } catch {}
        }
        $activityByTeam[$tid] = [pscustomobject]@{ activityDays = $days; activeChannels = $active }
    }
    if ($activityByTeam.Count -eq 0) {
        Write-Warning 'Activity CSV parsed but no Team Id values were found. If the report conceals identifiers, activity cannot be merged and stays Unknown.'
    }
}

if (-not $TeamIds -or $TeamIds.Count -eq 0) {
    Write-Host 'Enumerating Teams-enabled groups...' -ForegroundColor Cyan
    $groups = Get-MgGroup -Filter "resourceProvisioningOptions/Any(x:x eq 'Team')" -All
    $TeamIds = $groups.Id
}

$records = New-Object System.Collections.Generic.List[object]

foreach ($id in $TeamIds) {
    try {
        $group = Get-MgGroup -GroupId $id -Property 'id,displayName,visibility,createdDateTime'
    }
    catch {
        Write-Warning "Skipping $id (group not found): $($_.Exception.Message)"
        continue
    }

    $owners = @()
    try { $owners = (Get-MgGroupOwner -GroupId $id -All).AdditionalProperties.displayName | Where-Object { $_ } }
    catch { Write-Warning "Owners unavailable for $id" }

    $memberList = @()
    try { $memberList = Get-MgGroupMember -GroupId $id -All }
    catch { Write-Warning "Members unavailable for $id" }
    $guestCount = ($memberList | Where-Object { $_.AdditionalProperties.userType -eq 'Guest' }).Count
    $memberCount = $memberList.Count

    $channelCount = 0
    try { $channelCount = (Get-MgTeamChannel -TeamId $id -All).Count }
    catch { Write-Warning "Channels unavailable for $id" }

    $visibility = if ($group.Visibility) { $group.Visibility } else { 'Private' }
    $act = $activityByTeam[$group.Id]

    $records.Add([ordered]@{
        id            = $group.Id
        name          = $group.DisplayName
        type          = "$visibility team"
        activityDays  = if ($act) { $act.activityDays } else { $null }   # From Teams activity CSV if provided, else Unknown.
        activeChannels = if ($act) { $act.activeChannels } else { $null } # From Teams activity CSV if provided, else Unknown.
        channelCount  = $channelCount
        owners        = @($owners)
        members       = $memberCount
        guests        = $guestCount
        exposure      = (Get-ExposureFromVisibility $group)
        exposureCount = 0
        rcd           = $false             # Set from your Restricted Content Discovery report.
        lifecycle     = 'Review'
        site          = ''                 # Fill from Get-SPOSite export if available.
        findings      = @()
    })
}

$payload = [ordered]@{
    format     = 'sam-governance-workspaces'
    version    = 1
    collectedAt = (Get-Date).ToString('o')
    status     = 'manual-export'
    warnings   = @(
        if ($TeamsActivityCsv) { 'Activity merged from Teams activity report; exposure/RCD/site still require validated sources.' }
        else { 'Activity and exposure require additional read-only reports; fields left Unknown were not validated.' }
    )
    workspaces = $records
}

$payload | ConvertTo-Json -Depth 6 | Set-Content -Path $OutFile -Encoding UTF8
Write-Host "Wrote $($records.Count) workspace records to $OutFile" -ForegroundColor Green
Write-Host 'Review the file, fill in validated activity/exposure/RCD/site fields, then import it in the dashboard (Tenant governance -> Import data).'
Disconnect-MgGraph | Out-Null
