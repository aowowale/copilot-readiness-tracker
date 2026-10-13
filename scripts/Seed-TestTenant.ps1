<#
.SYNOPSIS
    Seeds a TEST Microsoft 365 tenant with users, guests, Teams, files and sharing links so the
    governance dashboard has realistic data to collect. Use -Remove to delete everything it made.

.DESCRIPTION
    WRITES to the tenant. Never run against a customer or production tenant. Every object is
    prefixed (users samtest.*, guests "SAMTest Guest", groups samtest-*) so -Remove only touches
    what this script created.

    Scenarios created (each exercises a dashboard rule):
      Finance Operations     two owners, public, two guests, anonymous link, one direct share
      Facilities Projects    single owner
      FY24 Acquisition       single owner, four guests, direct share to a non-member
      Legacy Intranet WG     OWNERLESS (the only owner is deleted at the end)
      HR Leadership          two owners, healthy baseline
      Vendor Collaboration   single owner, eight guests, anonymous link
      Copilot Pilot Comm.    public, many members, organization-wide link
      Records Modernization  two owners
    Users get managers, except two (reassignment then falls back to the governance queue).
    Guest invitations are created without sending email. Ordinary test users get random passwords
    that are never shown. Optional governance personas prompt for passwords directly in the
    administrator's PowerShell window so credentials never enter source, logs, or chat.

.PARAMETER TenantId
    Tenant to seed. The script stops if the sign-in lands in a different tenant.

.PARAMETER EnableGuestInvites
    Some tenants block all guest invitations, even for admins. This switch sets the tenant-wide
    external collaboration setting to adminsAndGuestInviters while the guests are created, then
    restores the original value. Without it, a blocked tenant gets no guests.

.PARAMETER LicenseSkuPartNumber
    One or more exact skuPartNumber values from GET /subscribedSkus. When supplied, assigns those
    licences to all active seeded users and governance personas. Product catalog IDs are not valid
    here. The script prints available skuPartNumber values when a requested value is not found.

.PARAMETER CreateSignInPersonas
    Creates six interactive users for Reader, Operator, Approver, Executor, Auditor and Workspace
    Owner testing. The script securely prompts for each initial password and never prints it.

.PARAMETER DeferPersonaPasswordSetup
    With -CreateSignInPersonas, creates each persona with an unknown random temporary password and
    requires the tenant administrator to reset it in Entra before sign-in testing. This avoids
    transmitting or storing credentials during unattended seeding.

.PARAMETER CreateGovernanceGroups
    Creates one security group per dashboard app role and adds the matching sign-in persona.

.PARAMETER ApiClientId
    Optional dashboard API application client ID. With -CreateGovernanceGroups, assigns each
    governance group to its matching application role after Install-Governance.ps1 has run.

.PARAMETER CreateChannels
    Adds standard, private and shared channels to the Finance test Team.

.PARAMETER SeedOneDriveContent
    Adds harmless files and representative sharing links to three already-provisioned seeded
    OneDrive sites. Run Seed-TestTenant-SharePoint.ps1 -ProvisionOneDrive first and allow time for
    personal-site provisioning.

.PARAMETER SharePointAdminUrl
    With SeedOneDriveContent, connects to SharePoint and temporarily grants the specified administrator
    site-level access to the three target personal sites. Use with TemporaryOneDriveAdminLoginName.

.PARAMETER TemporaryOneDriveAdminLoginName
    Administrator UPN to elevate on the three target personal sites during OneDrive seeding. Elevation
    is removed in a finally block even when a file or sharing operation fails.

.PARAMETER UseDeviceAuthentication
    Use the device-code flow instead of the default interactive browser sign-in. Device codes expire
    quickly; use this only when the browser flow is unavailable.

.PARAMETER UseAzureCliToken
    Reuse the current Azure CLI profile's Microsoft Graph token. Set AZURE_CONFIG_DIR and verify the
    tenant and AzureUSGovernment cloud before using this option. Cannot be combined with device auth.

.EXAMPLE
    .\Seed-TestTenant.ps1 -TenantId 00000000-0000-0000-0000-000000000000 -ThisIsATestTenant
.EXAMPLE
    .\Seed-TestTenant.ps1 -TenantId 00000000-0000-0000-0000-000000000000 -ThisIsATestTenant -Remove
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$TenantId,
    [Parameter(Mandatory)][switch]$ThisIsATestTenant,
    [switch]$Remove,
    [switch]$EnableGuestInvites,
    [string[]]$LicenseSkuPartNumber = @(),
    [switch]$CreateSignInPersonas,
    [switch]$DeferPersonaPasswordSetup,
    [switch]$CreateGovernanceGroups,
    [string]$ApiClientId = '',
    [switch]$CreateChannels,
    [switch]$SeedOneDriveContent,
    [string]$SharePointAdminUrl = '',
    [string]$TemporaryOneDriveAdminLoginName = '',
    [switch]$UseDeviceAuthentication,
    [switch]$UseAzureCliToken,
    [ValidateSet('Global', 'USGov', 'USGovDoD')][string]$Environment = 'Global'
)

$ErrorActionPreference = 'Stop'
Import-Module Microsoft.Graph.Authentication
if ($UseDeviceAuthentication -and $UseAzureCliToken) { throw 'Choose either -UseDeviceAuthentication or -UseAzureCliToken, not both.' }
if (($SharePointAdminUrl -or $TemporaryOneDriveAdminLoginName) -and
    (-not $SeedOneDriveContent -or -not $SharePointAdminUrl -or -not $TemporaryOneDriveAdminLoginName)) {
    throw 'SharePointAdminUrl and TemporaryOneDriveAdminLoginName must be used together with SeedOneDriveContent.'
}
if ($TemporaryOneDriveAdminLoginName -and $UseAzureCliToken) {
    throw 'Temporary OneDrive elevation requires the interactive Graph login; do not use UseAzureCliToken.'
}

$scopes = [System.Collections.Generic.List[string]]@(
    'User.ReadWrite.All', 'User.Invite.All', 'Group.ReadWrite.All', 'Directory.ReadWrite.All',
    'Team.Create', 'Files.ReadWrite.All', 'Sites.ReadWrite.All'
)
if ($EnableGuestInvites) { $scopes.Add('Policy.ReadWrite.Authorization') }
if ($LicenseSkuPartNumber.Count) { $scopes.Add('LicenseAssignment.ReadWrite.All'); $scopes.Add('Organization.Read.All') }
if ($ApiClientId) { $scopes.Add('Application.Read.All'); $scopes.Add('AppRoleAssignment.ReadWrite.All') }
if ($CreateChannels) { $scopes.Add('ChannelMember.ReadWrite.All') }
$connectParameters = @{
    TenantId = $TenantId; Environment = $Environment; ContextScope = 'Process'; NoWelcome = $true
    Scopes = ($scopes | Select-Object -Unique)
}
if ($UseAzureCliToken) {
    $graphResource = if ($Environment -eq 'Global') { 'https://graph.microsoft.com' } else { 'https://graph.microsoft.us' }
    $token = az account get-access-token --tenant $TenantId --resource $graphResource --query accessToken --output tsv
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($token)) { throw 'Could not obtain a Microsoft Graph token from the current Azure CLI profile.' }
    Connect-MgGraph -AccessToken (ConvertTo-SecureString $token -AsPlainText -Force) -Environment $Environment -NoWelcome
    $token = $null
} else {
    if ($UseDeviceAuthentication -or $TemporaryOneDriveAdminLoginName) {
        $connectParameters.UseDeviceCode = $true
        Write-Host 'Graph device-code sign-in is required. Complete the displayed code promptly as the code expires quickly.' -ForegroundColor Yellow
    }
    Connect-MgGraph @connectParameters
}
$ctx = Get-MgContext
if ($ctx.TenantId -ne $TenantId) { throw "Signed in to tenant $($ctx.TenantId), expected $TenantId. Nothing was changed." }
if ($TemporaryOneDriveAdminLoginName -and $ctx.Account -ne $TemporaryOneDriveAdminLoginName) {
    throw "Signed in to Graph as $($ctx.Account), but temporary OneDrive access was requested for $TemporaryOneDriveAdminLoginName. Nothing was changed."
}

$graphRoot = if ($Environment -eq 'Global') { 'https://graph.microsoft.com' } else { 'https://graph.microsoft.us' }
$prefix = 'samtest'
$report = [System.Collections.Generic.List[string]]::new()

function Graph([string]$Method, [string]$Uri, $Body = $null, [hashtable]$Headers = $null, [string]$ContentType = 'application/json') {
    $p = @{ Method = $Method; Uri = $Uri; OutputType = 'PSObject' }
    if ($null -ne $Body) { $p.Body = $Body; $p.ContentType = $ContentType }
    if ($Headers) { $p.Headers = $Headers }
    Invoke-MgGraphRequest @p
}

function Retry([scriptblock]$Action, [int]$Tries = 14, [int]$DelaySeconds = 15) {
    for ($i = 1; $i -le $Tries; $i++) {
        try { return & $Action } catch { if ($i -eq $Tries) { throw }; Start-Sleep -Seconds $DelaySeconds }
    }
}

function Note([string]$Text) { $report.Add($Text); Write-Host $Text }

$org = (Graph GET '/v1.0/organization').value[0]
$domain = ($org.verifiedDomains | Where-Object { $_.isInitial }).name
Write-Host "Tenant: $($org.displayName) ($domain)" -ForegroundColor Cyan

if ($SeedOneDriveContent) {
    $oneDriveScenarios = @(
        @{ Key = 'alex'; File = 'SAMTest-Budget.txt'; Link = 'organization'; Direct = 'isaiah' }
        @{ Key = 'adele'; File = 'SAMTest-HR-Plan.txt'; Link = $null; Direct = 'patti' }
        @{ Key = 'patti'; File = 'SAMTest-Facilities.txt'; Link = 'anonymous'; Direct = $null }
    )
    $elevatedOneDriveSites = [System.Collections.Generic.List[string]]::new()
    try {
        if ($SharePointAdminUrl) {
            Import-Module Microsoft.Online.SharePoint.PowerShell -DisableNameChecking
            if (([uri]$SharePointAdminUrl).Host.EndsWith('.sharepoint.us')) {
                Connect-SPOService -Url $SharePointAdminUrl -Region ITAR -ModernAuth $true -UseSystemBrowser $true
            } else {
                Connect-SPOService -Url $SharePointAdminUrl -ModernAuth $true -UseSystemBrowser $true
            }
            $personalSites = @(Get-SPOSite -IncludePersonalSite $true -Limit All | Where-Object { $_.Url -match '/personal/samtest_(alex|adele|patti)_' })
            foreach ($scenario in $oneDriveScenarios) {
                $site = $personalSites | Where-Object { $_.Url -match "/personal/samtest_$($scenario.Key)_" } | Select-Object -First 1
                if (-not $site) { throw "The personal site for $prefix.$($scenario.Key) was not found. Re-run OneDrive provisioning and try again." }
                Set-SPOUser -Site $site.Url -LoginName $TemporaryOneDriveAdminLoginName -IsSiteCollectionAdmin $true | Out-Null
                $elevatedOneDriveSites.Add($site.Url)
                Note "Temporarily elevated $TemporaryOneDriveAdminLoginName on $($site.Url)"
            }
        }
        foreach ($scenario in $oneDriveScenarios) {
            $upn = "$prefix.$($scenario.Key)@$domain"
            try {
                $user = Graph GET "/v1.0/users/$upn`?`$select=id,userPrincipalName"
                $drive = Retry { Graph GET "/v1.0/users/$($user.id)/drive" } 6 15
                $item = Graph PUT "/v1.0/drives/$($drive.id)/root:/$($scenario.File):/content" "Harmless test content for the Copilot Readiness OneDrive review." -ContentType 'text/plain'
                if ($scenario.Link) {
                    try { Graph POST "/v1.0/drives/$($drive.id)/items/$($item.id)/createLink" @{ type = 'view'; scope = $scenario.Link } | Out-Null }
                    catch { Note "OneDrive $($scenario.Link) link refused for ${upn}: $($_.Exception.Message)" }
                }
                if ($scenario.Direct) {
                    Graph POST "/v1.0/drives/$($drive.id)/items/$($item.id)/invite" @{
                        requireSignIn = $true; sendInvitation = $false; roles = @('read')
                        recipients = @(@{ email = "$prefix.$($scenario.Direct)@$domain" })
                    } | Out-Null
                }
                Note "Seeded OneDrive content for $upn"
            } catch { Note "OneDrive for $upn is not ready or accessible: $($_.Exception.Message)" }
        }
    } finally {
        foreach ($siteUrl in $elevatedOneDriveSites) {
            try {
                Set-SPOUser -Site $siteUrl -LoginName $TemporaryOneDriveAdminLoginName -IsSiteCollectionAdmin $false | Out-Null
                Note "Removed temporary site-admin elevation from $siteUrl"
            } catch { Note "WARNING: Remove $TemporaryOneDriveAdminLoginName as a site admin on $siteUrl manually: $($_.Exception.Message)" }
        }
        if (Get-MgContext) { Disconnect-MgGraph | Out-Null }
    }
    Write-Host "`nOneDrive summary" -ForegroundColor Green
    $report | ForEach-Object { "  $_" }
    return
}

# ---------------------------------------------------------------- cleanup
if ($Remove) {
    $groups = (Graph GET "/v1.0/groups?`$filter=startswith(mailNickname,'$prefix-')&`$select=id,displayName").value
    foreach ($g in $groups) { Graph DELETE "/v1.0/groups/$($g.id)" | Out-Null; Note "Deleted group $($g.displayName)" }
    $deleted = (Graph GET "/v1.0/directory/deletedItems/microsoft.graph.group?`$filter=startswith(mailNickname,'$prefix-')").value
    foreach ($g in $deleted) { Graph DELETE "/v1.0/directory/deletedItems/$($g.id)" | Out-Null; Note "Purged $($g.displayName)" }
    $users = (Graph GET "/v1.0/users?`$filter=startswith(userPrincipalName,'$prefix.')&`$select=id,displayName").value
    foreach ($u in $users) { Graph DELETE "/v1.0/users/$($u.id)" | Out-Null; Note "Deleted user $($u.displayName)" }
    $guests = (Graph GET "/v1.0/users?`$filter=userType eq 'Guest' and startswith(displayName,'SAMTest Guest')&`$count=true&`$select=id,displayName" -Headers @{ ConsistencyLevel = 'eventual' }).value
    foreach ($u in $guests) { Graph DELETE "/v1.0/users/$($u.id)" | Out-Null; Note "Deleted guest $($u.displayName)" }
    Disconnect-MgGraph | Out-Null
    Write-Host 'Cleanup finished.' -ForegroundColor Green
    return
}

# ---------------------------------------------------------------- users
$adminId = (Graph GET '/v1.0/me').id
$people = [ordered]@{
    alex     = @{ Name = 'Alex Wilber';      Title = 'Finance Manager';     Dept = 'Finance';     Manager = 'megan' }
    megan    = @{ Name = 'Megan Bowen';      Title = 'Marketing Director';  Dept = 'Marketing';   Manager = $null }
    patti    = @{ Name = 'Patti Fernandez';  Title = 'Facilities Lead';     Dept = 'Facilities';  Manager = 'megan' }
    lee      = @{ Name = 'Lee Gu';           Title = 'Corp Dev Manager';    Dept = 'Strategy';    Manager = 'megan' }
    adele    = @{ Name = 'Adele Vance';      Title = 'HR Director';         Dept = 'HR';          Manager = 'megan' }
    nestor   = @{ Name = 'Nestor Wilke';     Title = 'HR Partner';          Dept = 'HR';          Manager = 'adele' }
    pradeep  = @{ Name = 'Pradeep Gupta';    Title = 'Procurement Lead';    Dept = 'Procurement'; Manager = 'adele' }
    johanna  = @{ Name = 'Johanna Lorenz';   Title = 'IT Programme Manager'; Dept = 'IT';         Manager = 'megan' }
    diego    = @{ Name = 'Diego Siciliani';  Title = 'Records Manager';     Dept = 'Legal';       Manager = 'lee' }
    isaiah   = @{ Name = 'Isaiah Langer';    Title = 'Analyst';             Dept = 'Legal';       Manager = $null }
    departed = @{ Name = 'Departed Owner';   Title = 'Former employee';     Dept = 'Facilities';  Manager = $null }
}

function New-RandomPassword {
    $bytes = New-Object byte[] 24
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    'Aa1!' + [Convert]::ToBase64String($bytes).Replace('/', 'x').Replace('+', 'y')
}

function ConvertFrom-SecurePassword([Security.SecureString]$Password) {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Password)
    try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

$userId = @{}
foreach ($key in $people.Keys) {
    $p = $people[$key]
    $upn = "$prefix.$key@$domain"
    try {
        $existing = Graph GET "/v1.0/users/$upn`?`$select=id"
        $userId[$key] = $existing.id
        Write-Host "User exists: $upn"
    } catch {
        $created = Graph POST '/v1.0/users' @{
            accountEnabled = $true; displayName = "SAMTest $($p.Name)"; mailNickname = "$prefix.$key"; userPrincipalName = $upn
            jobTitle = $p.Title; department = $p.Dept; usageLocation = 'US'
            passwordProfile = @{ forceChangePasswordNextSignIn = $true; password = (New-RandomPassword) }
        }
        $userId[$key] = $created.id
        Note "Created user $upn"
    }
}
foreach ($key in $people.Keys) {
    $mgr = $people[$key].Manager
    if (-not $mgr) { continue }
    Retry { Graph PUT "/v1.0/users/$($userId[$key])/manager/`$ref" @{ '@odata.id' = "$graphRoot/v1.0/users/$($userId[$mgr])" } | Out-Null } 4 5
}
Note 'Managers set (Megan Bowen, Isaiah Langer and Departed Owner have none).'

# ---------------------------------------------------------------- interactive governance personas
$personaDefinitions = [ordered]@{
    reader         = @{ Name = 'Governance Reader';   Role = 'Governance.Reader' }
    operator       = @{ Name = 'Governance Operator'; Role = 'Governance.Operator' }
    approver       = @{ Name = 'Governance Approver'; Role = 'Approver' }
    executor       = @{ Name = 'Governance Executor'; Role = 'Executor' }
    auditor        = @{ Name = 'Governance Auditor';  Role = 'Auditor' }
    workspaceowner = @{ Name = 'Workspace Owner';     Role = 'Workspace.Owner' }
}
$personaId = @{}
if ($CreateSignInPersonas -or $CreateGovernanceGroups) {
    foreach ($key in $personaDefinitions.Keys) {
        $upn = "$prefix.$key@$domain"
        try {
            $existing = Graph GET "/v1.0/users/$upn`?`$select=id"
            $personaId[$key] = $existing.id
            Write-Host "Persona exists: $upn"
        } catch {
            if (-not $CreateSignInPersonas) {
                Write-Warning "Persona $upn does not exist. Re-run with -CreateSignInPersonas."
                continue
            }
            $securePassword = $null
            $plainPassword = if ($DeferPersonaPasswordSetup) {
                New-RandomPassword
            } else {
                $securePassword = Read-Host "Initial password for $upn (input is hidden)" -AsSecureString
                ConvertFrom-SecurePassword $securePassword
            }
            try {
                if ([string]::IsNullOrWhiteSpace($plainPassword)) { throw "A password is required for $upn." }
                $created = Graph POST '/v1.0/users' @{
                    accountEnabled = $true; displayName = "SAMTest $($personaDefinitions[$key].Name)"
                    mailNickname = "$prefix.$key"; userPrincipalName = $upn; jobTitle = $personaDefinitions[$key].Name
                    department = 'Governance'; usageLocation = 'US'
                    passwordProfile = @{ forceChangePasswordNextSignIn = $DeferPersonaPasswordSetup.IsPresent; password = $plainPassword }
                }
                $personaId[$key] = $created.id
                Note "Created sign-in persona $upn$(if ($DeferPersonaPasswordSetup) { ' (administrator password reset required)' })"
            } finally { $plainPassword = $null; if ($securePassword) { $securePassword.Dispose() } }
        }
    }
}

# ---------------------------------------------------------------- licences
if ($LicenseSkuPartNumber.Count) {
    $subscribedSkus = @((Graph GET '/v1.0/subscribedSkus').value)
    $requestedSkus = @()
    foreach ($partNumber in $LicenseSkuPartNumber) {
        $sku = $subscribedSkus | Where-Object { $_.skuPartNumber -eq $partNumber } | Select-Object -First 1
        if (-not $sku) {
            $available = ($subscribedSkus.skuPartNumber | Sort-Object) -join ', '
            throw "Subscribed SKU '$partNumber' was not found. Available skuPartNumber values: $available"
        }
        if ($sku.prepaidUnits.enabled -le $sku.consumedUnits) { throw "Subscribed SKU '$partNumber' has no unassigned licences." }
        $requestedSkus += $sku
    }
    $licenceTargets = @($userId.GetEnumerator() | Where-Object Key -ne 'departed' | ForEach-Object Value)
    $licenceTargets += @($personaId.Values)
    foreach ($targetId in ($licenceTargets | Select-Object -Unique)) {
        $user = Graph GET "/v1.0/users/$targetId`?`$select=id,userPrincipalName,assignedLicenses"
        $assigned = @($user.assignedLicenses.skuId)
        $add = @($requestedSkus | Where-Object { $assigned -notcontains $_.skuId } | ForEach-Object { @{ skuId = $_.skuId } })
        if (-not $add.Count) { Write-Host "Licences already assigned: $($user.userPrincipalName)"; continue }
        Graph POST "/v1.0/users/$targetId/assignLicense" @{ addLicenses = $add; removeLicenses = @() } | Out-Null
        Note "Assigned $($LicenseSkuPartNumber -join ', ') to $($user.userPrincipalName)"
    }
}

# ---------------------------------------------------------------- governance groups and optional app-role assignments
if ($CreateGovernanceGroups) {
    $apiServicePrincipal = $null
    if ($ApiClientId) {
        $apiServicePrincipal = (Graph GET "/v1.0/servicePrincipals?`$filter=appId eq '$ApiClientId'&`$select=id,appRoles").value | Select-Object -First 1
        if (-not $apiServicePrincipal) { throw "No service principal was found for dashboard API client ID $ApiClientId." }
    }
    foreach ($key in $personaDefinitions.Keys) {
        $roleValue = $personaDefinitions[$key].Role
        $nickname = "$prefix-governance-$($roleValue.ToLowerInvariant().Replace('.', '-'))"
        $group = (Graph GET "/v1.0/groups?`$filter=mailNickname eq '$nickname'&`$select=id,displayName").value | Select-Object -First 1
        if (-not $group) {
            $group = Graph POST '/v1.0/groups' @{
                displayName = "SAMTest $roleValue"; description = "TEST ONLY: dashboard role $roleValue"
                mailNickname = $nickname; mailEnabled = $false; securityEnabled = $true; groupTypes = @()
            }
            Note "Created governance group $($group.displayName)"
        }
        if ($personaId[$key]) {
            try { Graph POST "/v1.0/groups/$($group.id)/members/`$ref" @{ '@odata.id' = "$graphRoot/v1.0/directoryObjects/$($personaId[$key])" } | Out-Null }
            catch { if ($_.Exception.Message -notmatch 'added object references already exist') { throw } }
        }
        if ($apiServicePrincipal) {
            $appRole = $apiServicePrincipal.appRoles | Where-Object { $_.value -eq $roleValue -and $_.isEnabled } | Select-Object -First 1
            if (-not $appRole) { throw "The dashboard application does not publish app role '$roleValue'." }
            $assignments = @((Graph GET "/v1.0/groups/$($group.id)/appRoleAssignments").value)
            if (-not ($assignments | Where-Object { $_.resourceId -eq $apiServicePrincipal.id -and $_.appRoleId -eq $appRole.id })) {
                Graph POST "/v1.0/servicePrincipals/$($apiServicePrincipal.id)/appRoleAssignedTo" @{
                    principalId = $group.id; resourceId = $apiServicePrincipal.id; appRoleId = $appRole.id
                } | Out-Null
                Note "Assigned $($group.displayName) to app role $roleValue"
            }
        }
    }
}

# ---------------------------------------------------------------- guests
$guestId = @()
$originalInvites = $null
if ($EnableGuestInvites) {
    $originalInvites = (Graph GET '/v1.0/policies/authorizationPolicy').allowInvitesFrom
    if ($originalInvites -notin 'adminsAndGuestInviters', 'everyone') {
        Graph PATCH '/v1.0/policies/authorizationPolicy' @{ allowInvitesFrom = 'adminsAndGuestInviters' } | Out-Null
        Note "Guest invitations temporarily allowed (was '$originalInvites')."
    } else { $originalInvites = $null }
}
try {
    $existingGuests = (Graph GET "/v1.0/users?`$filter=userType eq 'Guest' and startswith(displayName,'SAMTest Guest')&`$count=true&`$select=id,displayName" -Headers @{ ConsistencyLevel = 'eventual' }).value
    foreach ($i in 1..8) {
        $name = "SAMTest Guest $i"
        $found = $existingGuests | Where-Object { $_.displayName -eq $name }
        if ($found) { $guestId += $found.id; continue }
        try {
            $inv = Retry {
                Graph POST '/v1.0/invitations' @{
                    invitedUserEmailAddress = "samtest.guest$i@example.com"; invitedUserDisplayName = $name
                    inviteRedirectUrl = 'https://myapps.microsoft.com'; sendInvitationMessage = $false
                }
            } 6 20
            $guestId += $inv.invitedUser.id
        } catch {
            Note "Guest invitations are blocked ($($_.Exception.Message.Split([char]10)[0])). Continuing without guests; rerun with -EnableGuestInvites to add them."
            break
        }
    }
} finally {
    if ($originalInvites) {
        Graph PATCH '/v1.0/policies/authorizationPolicy' @{ allowInvitesFrom = $originalInvites } | Out-Null
        Note "Guest invitation setting restored to '$originalInvites'."
    }
}
Note "Guests ready: $($guestId.Count) (no invitation email sent)."

# ---------------------------------------------------------------- teams
$teams = @(
    @{ Name = 'SAMTest Finance Operations';     Nick = 'samtest-finance-ops';   Vis = 'Public';  Owners = 'alex', 'megan'; Members = 'patti', 'lee', 'adele', 'nestor'; Guests = 2; Files = 'Budget-FY26.txt', 'Forecast.txt'; Anonymous = $true;  Org = $false; Direct = 'isaiah' }
    @{ Name = 'SAMTest Facilities Projects';    Nick = 'samtest-facilities';    Vis = 'Private'; Owners = 'patti';          Members = 'alex', 'nestor', 'pradeep';        Guests = 0; Files = 'Project-Plan.txt';              Anonymous = $false; Org = $false; Direct = $null }
    @{ Name = 'SAMTest FY24 Acquisition';       Nick = 'samtest-fy24-acq';      Vis = 'Private'; Owners = 'lee';            Members = 'adele', 'diego', 'isaiah';         Guests = 4; Files = 'Target-List.txt', 'Valuation.txt'; Anonymous = $false; Org = $false; Direct = 'patti' }
    @{ Name = 'SAMTest Legacy Intranet WG';     Nick = 'samtest-legacy-intranet'; Vis = 'Private'; Owners = 'departed';     Members = 'nestor', 'johanna';                 Guests = 0; Files = 'Old-Notes.txt';                 Anonymous = $false; Org = $false; Direct = $null }
    @{ Name = 'SAMTest HR Leadership';          Nick = 'samtest-hr-leadership'; Vis = 'Private'; Owners = 'adele', 'nestor'; Members = 'megan', 'lee';                     Guests = 0; Files = 'Org-Plan.txt';                  Anonymous = $false; Org = $false; Direct = $null }
    @{ Name = 'SAMTest Vendor Collaboration';   Nick = 'samtest-vendor-collab'; Vis = 'Private'; Owners = 'pradeep';        Members = 'alex', 'diego';                    Guests = 8; Files = 'Vendor-List.txt', 'Contracts.txt'; Anonymous = $true;  Org = $false; Direct = 'johanna' }
    @{ Name = 'SAMTest Copilot Pilot Community'; Nick = 'samtest-copilot-pilot'; Vis = 'Public';  Owners = 'johanna';         Members = 'alex', 'megan', 'patti', 'lee', 'adele', 'nestor', 'pradeep', 'diego', 'isaiah'; Guests = 0; Files = 'Welcome.txt'; Anonymous = $false; Org = $true;  Direct = $null }
    @{ Name = 'SAMTest Records Modernization';  Nick = 'samtest-records';       Vis = 'Private'; Owners = 'diego', 'isaiah'; Members = 'johanna';                          Guests = 0; Files = 'Retention-Schedule.txt';        Anonymous = $false; Org = $false; Direct = $null }
)

foreach ($t in $teams) {
    Write-Host "`n--- $($t.Name)" -ForegroundColor Cyan
    try {
        $group = (Graph GET "/v1.0/groups?`$filter=mailNickname eq '$($t.Nick)'&`$select=id").value | Select-Object -First 1
        if (-not $group) {
            $ownerBinds = @($t.Owners | ForEach-Object { "$graphRoot/v1.0/users/$($userId[$_])" })
            $memberBinds = @($t.Members | ForEach-Object { "$graphRoot/v1.0/users/$($userId[$_])" })
            if ($t.Guests) { $memberBinds += @($guestId | Select-Object -First $t.Guests | ForEach-Object { "$graphRoot/v1.0/users/$_" }) }
            $group = Graph POST '/v1.0/groups' @{
                displayName = $t.Name; description = "Test workspace for the governance dashboard ($($t.Name))."
                mailNickname = $t.Nick; mailEnabled = $true; securityEnabled = $false; groupTypes = @('Unified'); visibility = $t.Vis
                'owners@odata.bind' = $ownerBinds; 'members@odata.bind' = $memberBinds
            }
            Retry { Graph PUT "/v1.0/groups/$($group.id)/team" @{} | Out-Null } | Out-Null
            Note "Created Team $($t.Name)"
        } else { Write-Host 'Team exists; refreshing content only.' }

        # Uploading needs access to the group's library, so the admin is an owner until the end.
        try { Graph POST "/v1.0/groups/$($group.id)/owners/`$ref" @{ '@odata.id' = "$graphRoot/v1.0/directoryObjects/$adminId" } | Out-Null } catch { }

        if ($CreateChannels -and $t.Nick -eq 'samtest-finance-ops') {
            $channelDefinitions = @(
                @{ Name = 'SAMTest Standard Review'; Type = 'standard'; Owner = $null; Members = @() }
                @{ Name = 'SAMTest Private Finance'; Type = 'private'; Owner = 'alex'; Members = @('patti') }
                @{ Name = 'SAMTest Shared Review'; Type = 'shared'; Owner = 'megan'; Members = @('johanna') }
            )
            $channels = @((Retry { Graph GET "/v1.0/teams/$($group.id)/channels?`$select=id,displayName,membershipType" } 12 10).value)
            foreach ($channelDefinition in $channelDefinitions) {
                if ($channels.displayName -contains $channelDefinition.Name) { Write-Host "  channel exists: $($channelDefinition.Name)"; continue }
                $body = @{ displayName = $channelDefinition.Name; description = 'TEST ONLY: governance channel topology'; membershipType = $channelDefinition.Type }
                if ($channelDefinition.Type -ne 'standard') {
                    $members = @(@{
                        '@odata.type' = '#microsoft.graph.aadUserConversationMember'; roles = @('owner')
                        'user@odata.bind' = "$graphRoot/v1.0/users('$($userId[$channelDefinition.Owner])')"
                    })
                    if ($channelDefinition.Type -eq 'private') {
                        $members += @($channelDefinition.Members | ForEach-Object { @{
                            '@odata.type' = '#microsoft.graph.aadUserConversationMember'; roles = @()
                            'user@odata.bind' = "$graphRoot/v1.0/users('$($userId[$_])')"
                        } })
                    }
                    $body.members = $members
                }
                try {
                    Graph POST "/v1.0/teams/$($group.id)/channels" $body | Out-Null
                    if ($channelDefinition.Type -eq 'shared') {
                        $createdChannel = Retry {
                            $found = @((Graph GET "/v1.0/teams/$($group.id)/channels?`$select=id,displayName").value) |
                                Where-Object displayName -eq $channelDefinition.Name | Select-Object -First 1
                            if (-not $found) { throw "Channel $($channelDefinition.Name) is still provisioning." }
                            $found
                        } 12 10
                        foreach ($memberKey in $channelDefinition.Members) {
                            Graph POST "/v1.0/teams/$($group.id)/channels/$($createdChannel.id)/members" @{
                                '@odata.type' = '#microsoft.graph.aadUserConversationMember'; roles = @()
                                'user@odata.bind' = "$graphRoot/v1.0/users('$($userId[$memberKey])')"
                            } | Out-Null
                        }
                    }
                    Note "  created $($channelDefinition.Type) channel $($channelDefinition.Name)"
                }
                catch { Note "  channel $($channelDefinition.Name) could not be created: $($_.Exception.Message)" }
            }
        }

        $drive = Retry { Graph GET "/v1.0/groups/$($group.id)/drive" } 24 15
        $items = @()
        foreach ($file in $t.Files) {
            $items += Retry { Graph PUT "/v1.0/drives/$($drive.id)/root:/$file`:/content" "Test content for $file in $($t.Name)." -ContentType 'text/plain' } 6 10
        }
        if ($t.Anonymous) {
            try { Graph POST "/v1.0/drives/$($drive.id)/items/$($items[0].id)/createLink" @{ type = 'view'; scope = 'anonymous' } | Out-Null; Note "  anonymous link on $($t.Files[0])" }
            catch { Note "  anonymous link refused by tenant policy: $($_.Exception.Message)" }
        }
        if ($t.Org) {
            Graph POST "/v1.0/drives/$($drive.id)/items/$($items[0].id)/createLink" @{ type = 'view'; scope = 'organization' } | Out-Null
            Note "  organization link on $($t.Files[0])"
        }
        if ($t.Direct) {
            Graph POST "/v1.0/drives/$($drive.id)/items/$($items[0].id)/invite" @{
                requireSignIn = $true; sendInvitation = $false; roles = @('read')
                recipients = @(@{ email = "$prefix.$($t.Direct)@$domain" })
            } | Out-Null
            Note "  direct share of $($t.Files[0]) to samtest.$($t.Direct) (not a member)"
        }

        # The creator is added as an owner; remove them so owner counts match the scenario.
        $owners = (Graph GET "/v1.0/groups/$($group.id)/owners?`$select=id").value
        if (($owners.id -contains $adminId) -and ($owners.Count -gt 1)) {
            Graph DELETE "/v1.0/groups/$($group.id)/owners/$adminId/`$ref" | Out-Null
            try { Graph DELETE "/v1.0/groups/$($group.id)/members/$adminId/`$ref" | Out-Null } catch { }
        }
    } catch {
        Note "FAILED $($t.Name): $($_.Exception.Message)"
    }
}

# The legacy team becomes ownerless when its only owner leaves.
try {
    Graph DELETE "/v1.0/users/$($userId['departed'])" | Out-Null
    Note 'Deleted Departed Owner, so SAMTest Legacy Intranet WG has no owner.'
} catch { Note "Could not delete the departed owner: $($_.Exception.Message)" }

Disconnect-MgGraph | Out-Null
Write-Host "`nSummary" -ForegroundColor Green
$report | ForEach-Object { "  $_" }
Write-Host "`nNext: run Seed-TestTenant-SharePoint.ps1 in your own PowerShell window (site admins and Data Access Governance reports)." -ForegroundColor Yellow
