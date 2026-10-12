<#
.SYNOPSIS
    SharePoint half of the test-tenant seed: adds direct site members who are not in the Team (shadow users)
    and starts Data Access Governance reports. Run Seed-TestTenant.ps1 first, in a normal PowerShell window
    that is already signed in with Connect-SPOService (or let this script connect).

.DESCRIPTION
    WRITES to a TEST tenant only. Adds users to site Visitors groups and starts report jobs. It touches
    only sites whose URL contains 'samtest-'. Reports take time to generate; check them afterwards with
    Get-SPODataAccessGovernanceInsight. With -ProvisionOneDrive it also requests personal sites for the
    active seeded users and governance personas; it does not add files or read content.

.PARAMETER ProvisionOneDrive
    Requests OneDrive personal sites for the active seeded users and governance personas. Users must
    already have a SharePoint/OneDrive-capable licence. Provisioning is asynchronous; wait and then run
    Seed-TestTenant.ps1 -SeedOneDriveContent to add harmless files and sharing scenarios.

.PARAMETER TemporarySiteCollectionAdminLoginName
    Administrator UPN to elevate temporarily on seeded sites that reject direct Visitors changes.
    The script removes the elevation before it exits. Use a dedicated test-tenant administrator.

.PARAMETER SkipReports
    Do not start another set of Data Access Governance reports. Use for a shadow-access-only rerun.

.EXAMPLE
    .\Seed-TestTenant-SharePoint.ps1 -AdminUrl https://contoso-admin.sharepoint.us -ThisIsATestTenant -ProvisionOneDrive
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$AdminUrl,
    [Parameter(Mandatory)][switch]$ThisIsATestTenant,
    [switch]$ProvisionOneDrive,
    [string]$TemporarySiteCollectionAdminLoginName = '',
    [switch]$SkipReports
)

$ErrorActionPreference = 'Stop'
Import-Module Microsoft.Online.SharePoint.PowerShell -DisableNameChecking
if (-not (Get-Command Get-SPOSite -ErrorAction SilentlyContinue) -or -not (Get-SPOTenant -ErrorAction SilentlyContinue)) {
    if (([uri]$AdminUrl).Host.EndsWith('.sharepoint.us')) {
        Connect-SPOService -Url $AdminUrl -Region ITAR -ModernAuth $true -UseSystemBrowser $true
    } else {
        Connect-SPOService -Url $AdminUrl -ModernAuth $true -UseSystemBrowser $true
    }
}

$domain = ([uri]$AdminUrl).Host -replace '-admin\.sharepoint\.(com|us)$', '.onmicrosoft.$1'

if ($ProvisionOneDrive) {
    $oneDriveKeys = @('alex', 'megan', 'patti', 'lee', 'adele', 'nestor', 'pradeep', 'johanna', 'diego', 'isaiah', 'reader', 'operator', 'approver', 'executor', 'auditor', 'workspaceowner')
    $oneDriveUsers = @($oneDriveKeys | ForEach-Object { "samtest.$_@$domain" })
    Request-SPOPersonalSite -UserEmails $oneDriveUsers -NoWait
    Write-Host "Requested OneDrive provisioning for $($oneDriveUsers.Count) seeded users. Provisioning is asynchronous." -ForegroundColor Cyan
}

# Users who get direct site access without Team membership: (site url fragment) -> user
$shadow = @(
    @{ Site = 'samtest-finance-ops';    User = "samtest.isaiah@$domain" }
    @{ Site = 'samtest-fy24-acq';       User = "samtest.patti@$domain" }
    @{ Site = 'samtest-vendor-collab';  User = "samtest.johanna@$domain" }
    @{ Site = 'samtest-vendor-collab';  User = "samtest.megan@$domain" }
)

$sites = @(Get-SPOSite -Limit All | Where-Object { $_.Url -match 'samtest-' })
Write-Host "Found $($sites.Count) seeded sites."
$elevatedSites = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($s in $shadow) {
    $site = $sites | Where-Object { $_.Url -match [regex]::Escape($s.Site) } | Select-Object -First 1
    if (-not $site) { Write-Warning "Site for $($s.Site) not found yet (provisioning can lag). Re-run later."; continue }
    $group = "$($site.Title) Visitors"
    try {
        Add-SPOUser -Site $site.Url -LoginName $s.User -Group $group
        Write-Host "Added $($s.User) to '$group' on $($site.Url)"
    } catch {
        if (-not $TemporarySiteCollectionAdminLoginName -or $_.Exception.Message -notmatch 'unauthorized') {
            Write-Warning "Could not add $($s.User) to $($site.Url): $($_.Exception.Message)"
            continue
        }
        try {
            if ($elevatedSites.Add($site.Url)) {
                Set-SPOUser -Site $site.Url -LoginName $TemporarySiteCollectionAdminLoginName -IsSiteCollectionAdmin $true | Out-Null
                Write-Host "Temporarily elevated $TemporarySiteCollectionAdminLoginName on $($site.Url)"
            }
            Add-SPOUser -Site $site.Url -LoginName $s.User -Group $group
            Write-Host "Added $($s.User) to '$group' on $($site.Url)"
        } catch { Write-Warning "Could not add $($s.User) to $($site.Url) after temporary elevation: $($_.Exception.Message)" }
    }
}
foreach ($siteUrl in $elevatedSites) {
    try {
        Set-SPOUser -Site $siteUrl -LoginName $TemporarySiteCollectionAdminLoginName -IsSiteCollectionAdmin $false | Out-Null
        Write-Host "Removed temporary site-admin elevation from $siteUrl"
    } catch { Write-Warning "Remove $TemporarySiteCollectionAdminLoginName as a site admin on $siteUrl manually: $($_.Exception.Message)" }
}

if (-not $SkipReports) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmm'
    $reports = @(
        @{ ReportEntity = 'SharingLinks_Anyone';                   Name = "SAM anyone links $stamp" }
        @{ ReportEntity = 'SharingLinks_PeopleInYourOrg';          Name = "SAM org links $stamp" }
        @{ ReportEntity = 'SharingLinks_Guests';                   Name = "SAM guest links $stamp" }
        @{ ReportEntity = 'EveryoneExceptExternalUsersAtSite';     Name = "SAM everyone at site $stamp" }
        @{ ReportEntity = 'PermissionedUsers';                     Name = "SAM permissioned users $stamp"; CountOfUsersMoreThan = 3 }
    )
    foreach ($r in $reports) {
        try {
            $splat = @{ ReportEntity = $r.ReportEntity; Workload = 'SharePoint'; ReportType = 'Snapshot'; Name = $r.Name }
            if ($r.CountOfUsersMoreThan) { $splat.CountOfUsersMoreThan = $r.CountOfUsersMoreThan }
            Start-SPODataAccessGovernanceInsight @splat | Out-Null
            Write-Host "Started report: $($r.Name)"
        } catch { Write-Warning "Report $($r.ReportEntity) did not start: $($_.Exception.Message)" }
    }
}
Write-Host "Done. Reports can take hours. List them with: Get-SPODataAccessGovernanceInsight -ReportEntity PermissionedUsers" -ForegroundColor Green
