<#
.SYNOPSIS
    Unified customer entry point for configuration, preflight, deployment, and validation.

.DESCRIPTION
    -Initialize creates a secret-free customer configuration through an interactive wizard.
    The default action validates that configuration and calls Install-Governance.ps1. Azure CLI
    state is isolated with the configured AZURE_CONFIG_DIR so other VS Code windows are unaffected.
#>
[CmdletBinding(DefaultParameterSetName = 'Deploy')]
param(
    [Parameter(Mandatory, ParameterSetName = 'Deploy')]
    [Parameter(Mandatory, ParameterSetName = 'Initialize')]
    [string]$ConfigPath,
    [Parameter(Mandatory, ParameterSetName = 'Initialize')]
    [switch]$Initialize,
    [Parameter(ParameterSetName = 'Deploy')]
    [switch]$PreflightOnly,
    [Parameter(ParameterSetName = 'Deploy')]
    [switch]$SkipCodeDeploy,
    [Parameter(ParameterSetName = 'Deploy')]
    [switch]$SkipLicenseChecks,
    [Parameter(ParameterSetName = 'Deploy')]
    [switch]$SkipGraphGrants,
    [Parameter(ParameterSetName = 'Deploy')]
    [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

function Read-Required([string]$Prompt, [string]$Default = '') {
    $suffix = if ($Default) { " [$Default]" } else { '' }
    $value = Read-Host "$Prompt$suffix"
    if (-not $value) { $value = $Default }
    if (-not $value) { throw "$Prompt is required." }
    $value
}

function Read-Boolean([string]$Prompt, [bool]$Default = $false) {
    $label = if ($Default) { 'Y/n' } else { 'y/N' }
    $value = Read-Host "$Prompt [$label]"
    if (-not $value) { return $Default }
    $value -match '^(y|yes|true)$'
}

if ($Initialize) {
    if (Test-Path -LiteralPath $ConfigPath) { throw "Configuration already exists: $ConfigPath" }
    $cloud = Read-Required 'Azure cloud (AzureCloud or AzureUSGovernment)' 'AzureUSGovernment'
    if ($cloud -notin 'AzureCloud', 'AzureUSGovernment') { throw 'Cloud must be AzureCloud or AzureUSGovernment.' }
    $configuration = [ordered]@{
        schemaVersion = 1
        releaseVersion = '1.2.0'
        azure = [ordered]@{
            tenantId = Read-Required 'Customer tenant ID'
            subscriptionId = Read-Required 'Azure subscription ID'
            cloud = $cloud
            location = Read-Required 'Azure region' $(if ($cloud -eq 'AzureUSGovernment') { 'usgovvirginia' } else { 'eastus' })
            resourceGroup = Read-Required 'Resource group' 'rg-sam-governance'
            namePrefix = Read-Required 'Resource name prefix (3-11 lowercase letters/numbers)' 'samgov'
            planSkuName = Read-Required 'Dedicated App Service plan SKU' 'B1'
            storageSkuName = Read-Required 'Storage redundancy (Standard_LRS, Standard_GRS, Standard_GZRS)' 'Standard_GRS'
            azureConfigDirectory = Read-Required 'Isolated Azure CLI profile directory' '~/.azure-sam-customer'
        }
        collection = [ordered]@{
            pilotTeamIds = ''
            maxWorkspaces = 0
            includeUsageReports = Read-Boolean 'Enable Teams usage reports?' $true
            includeCopilot = Read-Boolean 'Enable Copilot licensing, adoption, and agent inventory?' $true
            enableOneDriveSharingReview = Read-Boolean 'Enable bounded OneDrive sharing review?' $false
        }
        access = [ordered]@{ roleGroupObjectIds = [ordered]@{
            'Governance.Reader' = @(); 'Governance.Operator' = @(); Approver = @(); Executor = @(); Auditor = @(); 'Workspace.Owner' = @()
        } }
        operations = [ordered]@{
            logRetentionDays = 30; logDailyQuotaGb = 1; telemetrySamplingPercentage = 20
            alertEmails = @(); monthlyBudgetAmount = 40; budgetContactEmails = @()
        }
        network = [ordered]@{
            privateNetworking = Read-Boolean 'Create private endpoints, VNet integration, and private DNS?' $false
            disablePublicIngress = $false
            privateDeploymentAgentReady = $false
        }
        execution = [ordered]@{
            enabled = $false; mode = 'dry-run'; enableProvisioning = $false; enableLinkRevocation = $false
            enableOneDriveSharingRevocation = $false; enableLifecycleExecution = $false
            enableSensitivityLabels = $false; sensitivityLabelIds = [ordered]@{}
            notificationMode = 'dry-run'; notificationSender = ''; notificationOperatorEmail = ''
        }
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent ([IO.Path]::GetFullPath($ConfigPath))) -Force | Out-Null
    $configuration | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $ConfigPath -Encoding UTF8
    Write-Host "Created $ConfigPath. Add customer group IDs and alert recipients, review every value, then run:" -ForegroundColor Green
    Write-Host ".\scripts\Deploy-Customer.ps1 -ConfigPath '$ConfigPath' -PreflightOnly"
    return
}

if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw "Configuration not found: $ConfigPath" }
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
if ($config.schemaVersion -ne 1) { throw 'Unsupported customer configuration schemaVersion.' }
foreach ($idName in 'tenantId', 'subscriptionId') {
    $parsed = [guid]::Empty
    $value = [string]$config.azure.$idName
    if (-not [guid]::TryParse($value, [ref]$parsed) -or $parsed -eq [guid]::Empty) { throw "azure.$idName must be a non-empty GUID." }
}
if ($config.azure.cloud -notin 'AzureCloud', 'AzureUSGovernment') { throw 'azure.cloud must be AzureCloud or AzureUSGovernment.' }
if ([string]$config.azure.namePrefix -notmatch '^[a-z][a-z0-9]{2,10}$') { throw 'azure.namePrefix must be 3-11 lowercase letters/numbers and start with a letter.' }

$configDirectory = [Environment]::ExpandEnvironmentVariables(([string]$config.azure.azureConfigDirectory -replace '^~', $HOME))
New-Item -ItemType Directory -Path $configDirectory -Force | Out-Null
$env:AZURE_CONFIG_DIR = $configDirectory
Write-Host "Azure CLI isolation: $configDirectory" -ForegroundColor Cyan

$installerParameters = @{
    TenantId = [string]$config.azure.tenantId
    SubscriptionId = [string]$config.azure.subscriptionId
    Cloud = [string]$config.azure.cloud
    Location = [string]$config.azure.location
    ResourceGroup = [string]$config.azure.resourceGroup
    NamePrefix = [string]$config.azure.namePrefix
    PlanSkuName = [string]$config.azure.planSkuName
    StorageSkuName = [string]$config.azure.storageSkuName
    PilotTeamIds = [string]$config.collection.pilotTeamIds
    MaxWorkspaces = [int]$config.collection.maxWorkspaces
    RoleGroupObjectIdsJson = ($config.access.roleGroupObjectIds | ConvertTo-Json -Depth 5 -Compress)
    LogRetentionDays = [int]$config.operations.logRetentionDays
    LogDailyQuotaGb = [int]$config.operations.logDailyQuotaGb
    TelemetrySamplingPercentage = [int]$config.operations.telemetrySamplingPercentage
    AlertEmail = @($config.operations.alertEmails)
    MonthlyBudgetAmount = [int]$config.operations.monthlyBudgetAmount
    BudgetContactEmail = @($config.operations.budgetContactEmails)
    ExecutionMode = [string]$config.execution.mode
    NotificationMode = [string]$config.execution.notificationMode
    NotificationSender = [string]$config.execution.notificationSender
    NotificationOperatorEmail = [string]$config.execution.notificationOperatorEmail
    IncludeUsageReports = [bool]$config.collection.includeUsageReports
    IncludeCopilot = [bool]$config.collection.includeCopilot
    EnableOneDriveSharingReview = [bool]$config.collection.enableOneDriveSharingReview
    EnableExecution = [bool]$config.execution.enabled
    EnableProvisioning = [bool]$config.execution.enableProvisioning
    EnableLinkRevocation = [bool]$config.execution.enableLinkRevocation
    EnableOneDriveSharingRevocation = [bool]$config.execution.enableOneDriveSharingRevocation
    EnableLifecycleExecution = [bool]$config.execution.enableLifecycleExecution
    EnableSensitivityLabels = [bool]$config.execution.enableSensitivityLabels
    SensitivityLabelIdsJson = ($config.execution.sensitivityLabelIds | ConvertTo-Json -Depth 5 -Compress)
    PrivateNetworking = [bool]$config.network.privateNetworking
    DisablePublicIngress = [bool]$config.network.disablePublicIngress
    PrivateDeploymentAgentReady = [bool]$config.network.privateDeploymentAgentReady
    PreflightOnly = [bool]$PreflightOnly
    SkipCodeDeploy = [bool]$SkipCodeDeploy
    SkipLicenseChecks = [bool]$SkipLicenseChecks
    SkipGraphGrants = [bool]$SkipGraphGrants
}

if ($ValidateOnly) {
    [pscustomobject]@{
        schemaVersion = $config.schemaVersion
        releaseVersion = $config.releaseVersion
        cloud = $config.azure.cloud
        location = $config.azure.location
        resourceGroup = $config.azure.resourceGroup
        privateNetworking = [bool]$config.network.privateNetworking
        publicIngressDisabled = [bool]$config.network.disablePublicIngress
        executionMode = if ($config.execution.enabled) { $config.execution.mode } else { 'off' }
        configuredRoleGroups = @($config.access.roleGroupObjectIds.PSObject.Properties | Where-Object { @($_.Value).Count -gt 0 }).Count
    } | ConvertTo-Json -Depth 4
    return
}

& (Join-Path $PSScriptRoot 'Install-Governance.ps1') @installerParameters
if ($LASTEXITCODE) { exit $LASTEXITCODE }