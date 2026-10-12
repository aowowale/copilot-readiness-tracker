<#
.SYNOPSIS
    One-command install of the Copilot Readiness governance dashboard into any Azure tenant
    (commercial or Azure Government). Safe to re-run.

.DESCRIPTION
    1. Preflight: tools, sign-in, tenant, subscription, permissions, providers. Stops on any failure.
    2. Registers resource providers and creates the resource group.
    3. Creates (or updates) the Entra API app registration with the governance app roles, a sign-in
       secret, and a pre-authorized Azure CLI scope so the smoke test can call the API.
    4. Deploys infra/main.bicep (function app, storage, identity, roles, sign-in).
    5. Registers the sign-in redirect URI and grants the collector identity READ-ONLY Graph permissions.
    6. Assigns the governance reader and operator roles to the installing user.
    7. Publishes the backend and the dashboard page.
    Nothing here grants write access to Microsoft 365 content.

    Run Test-Deployment.ps1 afterwards to prove the install works end to end.

.PARAMETER TenantId        Entra tenant (directory) ID that owns the workspaces to govern.
.PARAMETER SubscriptionId  Azure subscription that will host the resources.
.PARAMETER Location        Azure region, for example eastus or usgovvirginia.
.PARAMETER Cloud           AzureCloud or AzureUSGovernment. Defaults to the Azure CLI's active cloud.
.PARAMETER PreflightOnly   Run the checks and stop without changing anything.
.PARAMETER IncludeUsageReports  Also grant Reports.Read.All (for Teams activity reports).
.PARAMETER IncludeCopilot  Collect Copilot licences, adoption and the agent inventory. Grants Organization.Read.All,
                    Reports.Read.All and AppCatalog.Read.All (all read-only).
.PARAMETER SkipGraphGrants  Do not grant Graph permissions (use when a different admin consents).
.PARAMETER EnableExecution  Create the separate executor identity and let owners remove members they pick.
                    It stays in dry-run (records only, removes nothing) unless -ExecutionMode live.
.PARAMETER ExecutionMode  dry-run (default) or live. Live needs -EnableExecution.
.PARAMETER EnableProvisioning  Let the Executor role create workspaces for approved requests. Grants the executor
                    identity Group.Create and Team.Create. Needs -EnableExecution.
.PARAMETER EnableLinkRevocation  Let owners review and revoke sharing links and direct grants in their library.
                    Grants the collector Sites.Read.All and the executor Sites.ReadWrite.All. These apply to every
                    site in the tenant, so keep execution in dry-run until the pilot is reviewed. Needs -EnableExecution.
.PARAMETER EnableOneDriveSharingReview  Grant the collector Files.Read.All for an on-demand, bounded (100 item / 3 folder-depth)
                    OneDrive permission scan. It reads item names and permission metadata, not contents. This is tenant-wide consent.
.PARAMETER EnableOneDriveSharingRevocation  Grant the executor Files.ReadWrite.All for selected OneDrive permissions. Requires
                    -EnableOneDriveSharingReview and -EnableExecution. Dry-run remains the default unless execution mode is live.
.PARAMETER EnableLifecycleExecution  Arm Approver-approved Team archive and soft-delete actions. Requires -EnableExecution;
                    live actions also require -ExecutionMode live and fresh, verified hold/retention evidence for deletion.
.PARAMETER EnableSensitivityLabels  Apply the request's sensitivity label during live provisioning. Requires -EnableExecution,
                    -EnableProvisioning, and -SensitivityLabelIdsJson. The label is set during group creation and read back.
.PARAMETER SensitivityLabelIdsJson  JSON object mapping catalog label names to tenant label GUIDs, for example
                    {"Internal":"<label-guid>","Confidential":"<label-guid>"}. Obtain IDs from the customer-approved label inventory.
.PARAMETER NotificationMode  off, dry-run (default; records what would be sent) or live (sends email). Live needs
                    -EnableExecution, -NotificationSender, and grants the executor identity Mail.Send.
.PARAMETER NotificationSender  Mailbox the messages come from, for example governance@contoso.com.
.PARAMETER NotificationOperatorEmail  Governance team address that receives governance-queue escalations.

.EXAMPLE
    .\Install-Governance.ps1 -TenantId <tenant> -SubscriptionId <sub> -Location eastus
.EXAMPLE
    .\Install-Governance.ps1 -TenantId <tenant> -SubscriptionId <sub> -Location usgovvirginia -PreflightOnly
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$TenantId,
    [Parameter(Mandatory)][string]$SubscriptionId,
    [Parameter(Mandatory)][string]$Location,
    [ValidateSet('AzureCloud', 'AzureUSGovernment')][string]$Cloud,
    [string]$ResourceGroup = 'rg-sam-governance',
    [ValidatePattern('^[a-z][a-z0-9]{2,10}$')][string]$NamePrefix = 'samgov',
    [string]$PilotTeamIds = '',
    [int]$MaxWorkspaces = 0,
    [string]$PlanSkuName = 'B1',
    [switch]$PreflightOnly,
    [switch]$IncludeUsageReports,
    [switch]$IncludeCopilot,
    [switch]$SkipGraphGrants,
    [switch]$EnableExecution,
    [ValidateSet('dry-run', 'live')][string]$ExecutionMode = 'dry-run',
    [switch]$EnableProvisioning,
    [switch]$EnableLinkRevocation,
    [switch]$EnableOneDriveSharingReview,
    [switch]$EnableOneDriveSharingRevocation,
    [switch]$EnableLifecycleExecution,
    [switch]$EnableSensitivityLabels,
    [string]$SensitivityLabelIdsJson = '{}',
    [ValidateSet('off', 'dry-run', 'live')][string]$NotificationMode = 'dry-run',
    [string]$NotificationSender = '',
    [string]$NotificationOperatorEmail = '',
    [switch]$SkipCodeDeploy
)

$ErrorActionPreference = 'Stop'
if (($EnableProvisioning -or $EnableLinkRevocation -or $EnableLifecycleExecution -or $EnableSensitivityLabels) -and -not $EnableExecution) { throw 'Provisioning, link revocation, lifecycle execution, and label application need -EnableExecution.' }
if ($EnableOneDriveSharingRevocation -and (-not $EnableExecution -or -not $EnableOneDriveSharingReview)) { throw '-EnableOneDriveSharingRevocation requires -EnableExecution and -EnableOneDriveSharingReview.' }
if ($EnableSensitivityLabels -and -not $EnableProvisioning) { throw '-EnableSensitivityLabels needs -EnableProvisioning.' }
if ($NotificationMode -eq 'live' -and (-not $EnableExecution -or -not $NotificationSender)) { throw '-NotificationMode live needs -EnableExecution (the executor identity sends the mail) and -NotificationSender.' }
$labelMap = $SensitivityLabelIdsJson | ConvertFrom-Json -AsHashtable
if ($null -eq $labelMap -or $labelMap -isnot [System.Collections.IDictionary]) { throw '-SensitivityLabelIdsJson must be a JSON object mapping label names to GUIDs.' }
if ($EnableSensitivityLabels) {
    if (-not $labelMap.Count) { throw '-EnableSensitivityLabels needs a non-empty -SensitivityLabelIdsJson map.' }
    foreach ($entry in $labelMap.GetEnumerator()) {
        $parsedLabelId = [guid]::Empty
        if (-not $entry.Key -or -not [guid]::TryParse([string]$entry.Value, [ref]$parsedLabelId)) { throw "Invalid sensitivity-label mapping for '$($entry.Key)' (expected a label GUID)." }
    }
}
$repoRoot = Split-Path -Parent $PSScriptRoot
$azureCliAppId = '04b07795-8ddb-461a-bbee-02f9e1bf7b46'
$graphAppId = '00000003-0000-0000-c000-000000000000'

# ------------------------------------------------------------------ helpers
function Invoke-Az {
    param([Parameter(Mandatory)][scriptblock]$Command, [string]$Context = 'Azure CLI')
    $output = & $Command 2>&1
    if ($LASTEXITCODE -ne 0) { throw "$Context failed: $(($output | Out-String).Trim())" }
    $output
}

function Invoke-AzJson {
    param([Parameter(Mandatory)][scriptblock]$Command, [string]$Context = 'Azure CLI')
    $text = (Invoke-Az -Command $Command -Context $Context | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }) -join "`n"
    if ([string]::IsNullOrWhiteSpace($text)) { return $null }
    $text | ConvertFrom-Json
}

function Invoke-GraphRest {
    param([Parameter(Mandatory)][string]$Method, [Parameter(Mandatory)][string]$Path, $Body)
    $arguments = @('rest', '--method', $Method, '--url', "$script:GraphRoot$Path", '--resource', $script:GraphRoot, '--output', 'json')
    $file = $null
    if ($null -ne $Body) {
        $file = New-TemporaryFile
        ($Body | ConvertTo-Json -Depth 12) | Set-Content -LiteralPath $file -Encoding utf8
        $arguments += @('--headers', 'Content-Type=application/json', '--body', "@$file")
    }
    try {
        $out = & az @arguments 2>&1
        if ($LASTEXITCODE -ne 0) { throw "Graph $Method $Path failed: $(($out | Out-String).Trim())" }
        $text = (($out | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }) | Out-String).Trim()
        if ($text) { $text | ConvertFrom-Json }
    } finally { if ($file) { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue } }
}

function Invoke-WithRetry {
    param([Parameter(Mandatory)][scriptblock]$Action, [int]$Tries = 8, [int]$DelaySeconds = 10)
    for ($i = 1; $i -le $Tries; $i++) {
        try { return & $Action } catch { if ($i -eq $Tries) { throw }; Start-Sleep -Seconds $DelaySeconds }
    }
}

function New-StableGuid([string]$Text) {
    $md5 = [System.Security.Cryptography.MD5]::Create()
    [guid]::new($md5.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)))
}

$checks = [System.Collections.Generic.List[object]]::new()
function Add-Check([string]$Name, [bool]$Ok, [string]$Detail, [bool]$Fatal = $true) {
    $checks.Add([pscustomobject]@{ Name = $Name; Ok = $Ok; Fatal = $Fatal; Detail = $Detail })
}

function Step([string]$Text) { Write-Host "`n== $Text" -ForegroundColor Cyan }

# ------------------------------------------------------------------ preflight
Step 'Preflight'
$azVersion = try { (az version --output json | ConvertFrom-Json).'azure-cli' } catch { $null }
Add-Check 'Azure CLI installed' ([bool]$azVersion) $(if ($azVersion) { $azVersion } else { 'Install from https://aka.ms/installazurecli' })

$nodeVersion = try { (node --version) -replace '^v', '' } catch { $null }
Add-Check 'Node.js 24 or later' ($nodeVersion -and [version]($nodeVersion -replace '^(\d+\.\d+\.\d+).*', '$1') -ge [version]'24.0.0') $(if ($nodeVersion) { "found $nodeVersion" } else { 'Install Node.js 24 LTS' })
Add-Check 'npm installed' ([bool](Get-Command npm -ErrorAction SilentlyContinue)) 'needed to install backend dependencies'

if (-not $azVersion) {
    $checks | Format-Table Name, Ok, Detail -AutoSize -Wrap
    throw 'Install the Azure CLI and run again.'
}

$activeCloud = (az cloud show --query name --output tsv)
if (-not $Cloud) { $Cloud = $activeCloud }
Add-Check "Azure CLI is on cloud $Cloud" ($activeCloud -eq $Cloud) $(if ($activeCloud -eq $Cloud) { 'ok' } else { "active cloud is $activeCloud. Run: az cloud set --name $Cloud ; az login --tenant $TenantId" })

$cloudSettings = @{
    AzureCloud        = @{ GraphRoot = 'https://graph.microsoft.com'; Authority = 'https://login.microsoftonline.com' }
    AzureUSGovernment = @{ GraphRoot = 'https://graph.microsoft.us'; Authority = 'https://login.microsoftonline.us' }
}[$Cloud]
$script:GraphRoot = $cloudSettings.GraphRoot

$account = $null
try { $account = az account show --output json 2>$null | ConvertFrom-Json } catch { }
Add-Check 'Signed in to Azure CLI' ([bool]$account) $(if ($account) { $account.user.name } else { "Run: az login --tenant $TenantId" })

$subscription = $null
if ($account) {
    $subscription = try { az account show --subscription $SubscriptionId --output json 2>$null | ConvertFrom-Json } catch { $null }
    Add-Check 'Subscription found and enabled' ($subscription -and $subscription.state -eq 'Enabled') $(if ($subscription) { "$($subscription.name) ($($subscription.state))" } else { 'Not visible to this sign-in. Run scripts\Get-TenantInventory.ps1 to see what you have.' })
    if ($subscription) {
        Add-Check 'Subscription belongs to the target tenant' ($subscription.tenantId -eq $TenantId) "subscription tenant $($subscription.tenantId), target $TenantId"
        $armRoot = (az cloud show --query endpoints.resourceManager --output tsv).TrimEnd('/')
        $locations = @(az rest --method get --url "$armRoot/subscriptions/$SubscriptionId/locations?api-version=2022-12-01" --query 'value[].name' --output tsv 2>$null)
        Add-Check "Region '$Location' is available" ($locations -contains $Location) $(if ($locations -contains $Location) { 'ok' } else { 'Pick a name from: az account list-locations --query [].name' })
    }
}

$signedInId = $null
if ($subscription -and $subscription.tenantId -eq $TenantId) {
    # No 'az account set': that would change the default subscription for every window sharing this profile.
    $signedInId = try { az ad signed-in-user show --query id --output tsv 2>$null } catch { $null }
    $roleNames = @()
    if ($signedInId) {
        $roleNames = @(az role assignment list --assignee $signedInId --include-inherited --scope "/subscriptions/$SubscriptionId" --query '[].roleDefinitionName' --output tsv 2>$null)
    }
    $canAssign = [bool]($roleNames | Where-Object { $_ -in 'Owner', 'User Access Administrator', 'Role Based Access Control Administrator' })
    $canDeploy = [bool]($roleNames | Where-Object { $_ -in 'Owner', 'Contributor' })
    Add-Check 'Can create resources (Owner or Contributor)' $canDeploy $(if ($canDeploy) { 'ok' } else { 'Needs Contributor or Owner on the subscription' })
    Add-Check 'Can assign roles (Owner or User Access Administrator)' $canAssign $(if ($canAssign) { 'ok' } else { 'The template assigns storage roles to the collector identity' })

    $org = try { Invoke-GraphRest -Method GET -Path '/v1.0/organization?$select=displayName,id' } catch { $null }
    Add-Check 'Microsoft Graph reachable' ([bool]$org) $(if ($org) { "$($org.value[0].displayName)" } else { 'Cannot reach Graph from this machine (secure-session or conditional access?)' })

    $directoryRoles = @()
    $rolesReadable = $false
    try { $directoryRoles = @((Invoke-GraphRest -Method GET -Path '/v1.0/me/transitiveMemberOf/microsoft.graph.directoryRole?$select=displayName').value.displayName); $rolesReadable = $true } catch { }
    $canRegister = [bool]($directoryRoles | Where-Object { $_ -in 'Global Administrator', 'Application Administrator', 'Cloud Application Administrator' })
    $canConsent = [bool]($directoryRoles | Where-Object { $_ -in 'Global Administrator', 'Privileged Role Administrator' })
    $unverified = 'Could not read your directory roles; the install will fail later if you lack them'
    Add-Check 'Can create app registrations' ($canRegister -or -not $rolesReadable) $(if ($canRegister) { 'ok' } elseif (-not $rolesReadable) { $unverified } else { 'Needs Application Administrator or Global Administrator' })
    Add-Check 'Can grant Graph permissions' ($canConsent -or $SkipGraphGrants -or -not $rolesReadable) $(if ($canConsent) { 'ok' } elseif ($SkipGraphGrants) { 'skipped by request; another admin must consent' } elseif (-not $rolesReadable) { $unverified } else { 'Needs Global or Privileged Role Administrator, or use -SkipGraphGrants' })
}

$checks | ForEach-Object { '{0,-4} {1}{2}' -f $(if ($_.Ok) { 'PASS' } else { 'FAIL' }), $_.Name, $(if ($_.Detail) { " ($($_.Detail))" }) }
$failed = @($checks | Where-Object { -not $_.Ok -and $_.Fatal })
if ($failed.Count) { throw "$($failed.Count) preflight check(s) failed. Fix them and run again. Nothing was changed." }
if ($PreflightOnly) { Write-Host "`nPreflight passed. Nothing was changed." -ForegroundColor Green; return }

# ------------------------------------------------------------------ providers and group
Step 'Resource providers and resource group'
foreach ($provider in 'Microsoft.Web', 'Microsoft.Storage', 'Microsoft.Insights', 'Microsoft.OperationalInsights', 'Microsoft.ManagedIdentity', 'Microsoft.Authorization') {
    $state = az provider show --namespace $provider --subscription $SubscriptionId --query registrationState --output tsv 2>$null
    if ($state -ne 'Registered') {
        Write-Host "Registering $provider..."
        Invoke-Az { az provider register --namespace $provider --subscription $SubscriptionId --wait } "Register $provider" | Out-Null
    }
}
Invoke-Az { az group create --name $ResourceGroup --location $Location --subscription $SubscriptionId --output none } 'Create resource group' | Out-Null

# ------------------------------------------------------------------ Entra app registration
Step 'Entra API app registration'
$appName = "$NamePrefix-governance-api"
$roleDefinitions = @(
    @{ Value = 'Governance.Reader';   Name = 'Governance reader';   Description = 'Read tenant-wide dashboard data.' }
    @{ Value = 'Governance.Operator'; Name = 'Governance operator'; Description = 'Triage, assign and manage governance cases.' }
    @{ Value = 'Approver';            Name = 'Approver';            Description = 'Approve or reject decisions and exceptions.' }
    @{ Value = 'Executor';            Name = 'Executor';            Description = 'Execute and verify approved work.' }
    @{ Value = 'Auditor';             Name = 'Auditor';             Description = 'Read audit records.' }
    @{ Value = 'Workspace.Owner';     Name = 'Workspace owner';     Description = 'Work on the workspaces assigned to the signed-in owner.' }
) | ForEach-Object {
    @{ id = (New-StableGuid "sam-governance-role:$($_.Value)").ToString(); allowedMemberTypes = @('User'); displayName = $_.Name; description = $_.Description; value = $_.Value; isEnabled = $true }
}
$scopeId = (New-StableGuid 'sam-governance-scope:user_impersonation').ToString()

$existingApp = (Invoke-GraphRest -Method GET -Path "/v1.0/applications?`$filter=displayName eq '$appName'&`$select=id,appId").value | Select-Object -First 1
if (-not $existingApp) {
    $existingApp = Invoke-GraphRest -Method POST -Path '/v1.0/applications' -Body @{ displayName = $appName; signInAudience = 'AzureADMyOrg' }
    Write-Host "Created app registration $appName"
} else { Write-Host "Using existing app registration $appName" }
$appObjectId = $existingApp.id
$apiClientId = $existingApp.appId
$oauth2PermissionScopes = @(@{
    id = $scopeId; value = 'user_impersonation'; type = 'User'; isEnabled = $true
    adminConsentDisplayName = 'Access the governance API'; adminConsentDescription = 'Allows the signed-in user to call the governance API.'
    userConsentDisplayName = 'Access the governance API'; userConsentDescription = 'Allows the app to call the governance API on your behalf.'
})

Invoke-GraphRest -Method PATCH -Path "/v1.0/applications/$appObjectId" -Body @{
    identifierUris = @("api://$apiClientId")
    appRoles       = $roleDefinitions
    api            = @{
        requestedAccessTokenVersion = 2
        oauth2PermissionScopes      = $oauth2PermissionScopes
    }
    web            = @{ implicitGrantSettings = @{ enableIdTokenIssuance = $true } }
} | Out-Null

Invoke-WithRetry {
    Invoke-GraphRest -Method PATCH -Path "/v1.0/applications/$appObjectId" -Body @{
        api = @{
            requestedAccessTokenVersion = 2
            oauth2PermissionScopes      = $oauth2PermissionScopes
            preAuthorizedApplications   = @(@{ appId = $azureCliAppId; delegatedPermissionIds = @($scopeId) })
        }
    }
} | Out-Null

$apiSp = (Invoke-GraphRest -Method GET -Path "/v1.0/servicePrincipals?`$filter=appId eq '$apiClientId'&`$select=id").value | Select-Object -First 1
if (-not $apiSp) { $apiSp = Invoke-WithRetry { Invoke-GraphRest -Method POST -Path '/v1.0/servicePrincipals' -Body @{ appId = $apiClientId } } }
Invoke-GraphRest -Method PATCH -Path "/v1.0/servicePrincipals/$($apiSp.id)" -Body @{ appRoleAssignmentRequired = $true } | Out-Null

# Keep prior managed credentials until the replacement is deployed, then prune them.
$previousAuthCredentials = @()
try {
    $previousAuthCredentials = @(az ad app credential list --id $apiClientId --output json 2>$null | ConvertFrom-Json | Where-Object { $_.displayName -like 'install-*' -or $_.displayName -like 'samgov-easyauth-*' })
} catch { }
$authSecret = Invoke-Az { az ad app credential reset --id $apiClientId --append --display-name "install-$(Get-Date -Format yyyyMMdd-HHmm)" --years 1 --query password --output tsv } 'Create sign-in secret'
$authSecret = ($authSecret | Out-String).Trim()

# ------------------------------------------------------------------ deploy infrastructure
Step 'Deploy infrastructure (Bicep)'
$paramFile = Join-Path ([IO.Path]::GetTempPath()) "sam-deploy-$([guid]::NewGuid()).json"
try {
    @{
        '$schema'      = 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#'
        contentVersion = '1.0.0.0'
        parameters     = @{
            namePrefix     = @{ value = $NamePrefix }
            tenantId       = @{ value = $TenantId }
            apiClientId    = @{ value = $apiClientId }
            authClientSecret = @{ value = $authSecret }
            graphBaseUrl   = @{ value = "$($cloudSettings.GraphRoot)/v1.0" }
            graphScope     = @{ value = "$($cloudSettings.GraphRoot)/.default" }
            authorityHost  = @{ value = $cloudSettings.Authority }
            pilotTeamIds   = @{ value = $PilotTeamIds }
            maxWorkspaces  = @{ value = $MaxWorkspaces }
            planSkuName    = @{ value = $PlanSkuName }
            enableExecution = @{ value = [bool]$EnableExecution }
            executionMode  = @{ value = $ExecutionMode }
            enableLifecycleExecution = @{ value = [bool]$EnableLifecycleExecution }
            sensitivityLabelIdsJson = @{ value = $SensitivityLabelIdsJson }
            notificationMode = @{ value = $NotificationMode }
            notifySender   = @{ value = $NotificationSender }
            notifyOperatorEmail = @{ value = $NotificationOperatorEmail }
        }
    } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $paramFile -Encoding utf8

    $deployment = Invoke-AzJson { az deployment group create --resource-group $ResourceGroup --subscription $SubscriptionId --name sam-governance --template-file (Join-Path $repoRoot 'infra\main.bicep') --parameters "@$paramFile" --output json } 'Bicep deployment'
} finally {
    Remove-Item -LiteralPath $paramFile -Force -ErrorAction SilentlyContinue
}
$outputs = $deployment.properties.outputs
$appUrl = $outputs.appUrl.value
$functionApp = $outputs.functionAppName.value
$identityPrincipalId = $outputs.collectorIdentityPrincipalId.value
Write-Host "Deployed $functionApp at $appUrl"

$deployedSettings = Invoke-AzJson { az functionapp config appsettings list --resource-group $ResourceGroup --subscription $SubscriptionId --name $functionApp --output json } 'Verify app settings'
if (-not ($deployedSettings | Where-Object { $_.name -eq 'MICROSOFT_PROVIDER_AUTHENTICATION_SECRET' -and $_.value })) {
    throw 'The Easy Auth client secret was not stored in the Function App. Prior credentials were retained.'
}
foreach ($credential in $previousAuthCredentials) {
    Invoke-Az { az ad app credential delete --id $apiClientId --key-id $credential.keyId } "Remove superseded sign-in secret $($credential.keyId)" | Out-Null
}

# ------------------------------------------------------------------ sign-in redirect, Graph permissions, roles
Step 'Sign-in redirect and permissions'
Invoke-GraphRest -Method PATCH -Path "/v1.0/applications/$appObjectId" -Body @{
    web = @{ redirectUris = @("$appUrl/.auth/login/aad/callback"); homePageUrl = $appUrl; implicitGrantSettings = @{ enableIdTokenIssuance = $true } }
} | Out-Null
Write-Host "Registered redirect URI $appUrl/.auth/login/aad/callback"

$graphPermissions = @('Group.Read.All', 'Team.ReadBasic.All', 'TeamMember.Read.All', 'Channel.ReadBasic.All', 'User.Read.All')
if ($IncludeUsageReports) { $graphPermissions += 'Reports.Read.All' }
if ($IncludeCopilot) { $graphPermissions += @('Organization.Read.All', 'AppCatalog.Read.All'); if ('Reports.Read.All' -notin $graphPermissions) { $graphPermissions += 'Reports.Read.All' } }
if ($EnableLinkRevocation) { $graphPermissions += 'Sites.Read.All' }
if ($EnableOneDriveSharingReview) { $graphPermissions += 'Files.Read.All' }

function Grant-GraphPermissions([string]$PrincipalId, [string[]]$Permissions) {
    if ($SkipGraphGrants) {
        Write-Host "Skipped. A Global Administrator must grant these Graph application permissions to identity $PrincipalId : $($Permissions -join ', ')" -ForegroundColor Yellow
        return
    }
    $graphSp = (Invoke-GraphRest -Method GET -Path "/v1.0/servicePrincipals?`$filter=appId eq '$graphAppId'&`$select=id,appRoles").value | Select-Object -First 1
    $existingGrants = @((Invoke-WithRetry { Invoke-GraphRest -Method GET -Path "/v1.0/servicePrincipals/$PrincipalId/appRoleAssignments" }).value.appRoleId)
    foreach ($permission in $Permissions) {
        $role = $graphSp.appRoles | Where-Object { $_.value -eq $permission -and $_.allowedMemberTypes -contains 'Application' } | Select-Object -First 1
        if (-not $role) { Write-Warning "Graph permission $permission is not offered in this cloud. Skipped."; continue }
        if ($existingGrants -contains $role.id) { Write-Host "Already granted: $permission"; continue }
        Invoke-WithRetry { Invoke-GraphRest -Method POST -Path "/v1.0/servicePrincipals/$PrincipalId/appRoleAssignments" -Body @{ principalId = $PrincipalId; resourceId = $graphSp.id; appRoleId = $role.id } } | Out-Null
        Write-Host "Granted: $permission"
    }
}

Grant-GraphPermissions $identityPrincipalId $graphPermissions

# The executor is a separate identity so the collector never gains write access.
if ($EnableExecution) {
    $executorPrincipalId = $outputs.executorIdentityPrincipalId.value
    Write-Host "Executor identity: $executorPrincipalId (mode: $ExecutionMode)"
    $executorPermissions = @('GroupMember.ReadWrite.All')
    if ($EnableProvisioning) { $executorPermissions += @('Group.Create', 'Team.Create', 'User.Read.All') }
    if ($EnableLinkRevocation) { $executorPermissions += 'Sites.ReadWrite.All' }
    if ($EnableOneDriveSharingRevocation) { $executorPermissions += 'Files.ReadWrite.All' }
    if ($EnableLifecycleExecution) { $executorPermissions += @('Group.ReadWrite.All', 'TeamSettings.ReadWrite.All') }
    if ($NotificationMode -eq 'live') { $executorPermissions += 'Mail.Send' }
    Grant-GraphPermissions $executorPrincipalId $executorPermissions
    if ($NotificationMode -eq 'live') {
        Write-Warning "Mail.Send lets the executor send as ANY mailbox until you limit it. Create an Exchange Online application access policy that restricts it to $NotificationSender (New-ApplicationAccessPolicy)."
    }
}

# The link in each message needs the dashboard address, which is only known after deployment.
Invoke-Az { az functionapp config appsettings set --name $functionApp --resource-group $ResourceGroup --subscription $SubscriptionId --settings "APP_URL=$appUrl" --output none } 'Set APP_URL' | Out-Null

if ($signedInId) {
    $held = @((Invoke-GraphRest -Method GET -Path "/v1.0/users/$signedInId/appRoleAssignments").value | Where-Object { $_.resourceId -eq $apiSp.id }).appRoleId
    foreach ($roleValue in 'Governance.Reader', 'Governance.Operator') {
        $roleId = ($roleDefinitions | Where-Object { $_.value -eq $roleValue }).id
        if ($held -contains $roleId) { continue }
        Invoke-GraphRest -Method POST -Path "/v1.0/users/$signedInId/appRoleAssignments" -Body @{ principalId = $signedInId; resourceId = $apiSp.id; appRoleId = $roleId } | Out-Null
        Write-Host "Assigned $roleValue to the installing user"
    }
}

# ------------------------------------------------------------------ publish code
if (-not $SkipCodeDeploy) {
    Step 'Publish backend and dashboard'
    $backend = Join-Path $repoRoot 'backend'
    $stage = Join-Path ([IO.Path]::GetTempPath()) "sam-stage-$([guid]::NewGuid())"
    $zip = "$stage.zip"
    try {
        New-Item -ItemType Directory -Path $stage | Out-Null
        foreach ($item in 'host.json', 'package.json', 'package-lock.json', 'src') { Copy-Item -Path (Join-Path $backend $item) -Destination $stage -Recurse }
        New-Item -ItemType Directory -Path (Join-Path $stage 'public') | Out-Null
        Copy-Item -Path (Join-Path $repoRoot 'index.html') -Destination (Join-Path $stage 'public\index.html')
        Push-Location $stage
        try { Invoke-Az { npm ci --omit=dev --no-audit --no-fund } 'npm ci' | Out-Null } finally { Pop-Location }
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [System.IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip)
        $knownDeploymentLogIds = @()
        try {
            $knownDeploymentLogIds = @(az webapp log deployment show --resource-group $ResourceGroup --subscription $SubscriptionId --name $functionApp --output json 2>$null | ConvertFrom-Json | Select-Object -ExpandProperty id)
        } catch { }
        Invoke-WithRetry {
            Invoke-Az { az functionapp deployment source config-zip --resource-group $ResourceGroup --subscription $SubscriptionId --name $functionApp --src $zip --output none } 'Zip deploy'
        } -Tries 4 -DelaySeconds 20 | Out-Null

        Write-Host 'Waiting for Kudu to finish the ZIP deployment...'
        $deployed = $false
        foreach ($attempt in 1..30) {
            try {
                $deploymentLogs = @(az webapp log deployment show --resource-group $ResourceGroup --subscription $SubscriptionId --name $functionApp --output json 2>$null | ConvertFrom-Json)
                $newLogs = @($deploymentLogs | Where-Object { $_.id -notin $knownDeploymentLogIds })
                if ($newLogs | Where-Object { $_.message -like 'Deployment successful.*' }) { $deployed = $true; break }
                $failure = $newLogs | Where-Object { $_.message -match 'Deployment failed|Error' } | Select-Object -First 1
                if ($failure) { throw $failure.message }
            } catch {
                if ($_.Exception.Message -match 'Deployment failed|Error') { throw }
            }
            Start-Sleep -Seconds 10
        }
        if (-not $deployed) { throw 'Kudu did not report a successful ZIP deployment in time.' }
    } finally {
        Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
    }

    Write-Host 'Waiting for Azure Functions to discover the deployment...'
    $ready = $false
    foreach ($attempt in 1..30) {
        try {
            $discovered = az functionapp function show --resource-group $ResourceGroup --subscription $SubscriptionId --name $functionApp --function-name collectorRun --query name --output tsv 2>$null
            if ($LASTEXITCODE -eq 0 -and $discovered) { $ready = $true; break }
        } catch { }
        Start-Sleep -Seconds 10
    }
    if (-not $ready) { throw 'Azure Functions did not discover the deployed collectorRun function in time.' }
}

# ------------------------------------------------------------------ record the result
$stateDir = Join-Path $repoRoot '.install'
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
$state = [ordered]@{
    installedAt = (Get-Date).ToUniversalTime().ToString('o'); cloud = $Cloud; tenantId = $TenantId; subscriptionId = $SubscriptionId
    resourceGroup = $ResourceGroup; functionApp = $functionApp; appUrl = $appUrl; apiClientId = $apiClientId
    collectorIdentityPrincipalId = $identityPrincipalId; storageAccount = $outputs.storageAccountName.value
    graphPermissionsGranted = if ($SkipGraphGrants) { @() } else { $graphPermissions }
    executionEnabled = [bool]$EnableExecution; executionMode = $(if ($EnableExecution) { $ExecutionMode } else { 'off' })
}
$stateFile = Join-Path $stateDir "$TenantId.json"
$state | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $stateFile -Encoding utf8

Write-Host "`nInstalled." -ForegroundColor Green
Write-Host "  Dashboard:  $appUrl"
Write-Host "  Recorded:   $stateFile (contains no secrets)"
Write-Host "  Next:       .\scripts\Test-Deployment.ps1 -TenantId $TenantId"
