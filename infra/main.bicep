// Read-only collector + API infrastructure for the Copilot Readiness dashboard.
// Deploys to Azure Government or commercial Azure; pass the cloud-specific endpoints as parameters.
// The sign-in client secret is written to Key Vault and referenced by App Service Authentication.
// The collector and secret reader use separate user-assigned managed identities.

type alertEmail = {
  @description('Unique receiver name within the action group.')
  name: string
  @description('Email address that receives production alerts.')
  emailAddress: string
}

@description('Azure region, e.g. usgovvirginia, usgovtexas or eastus.')
param location string = resourceGroup().location

@description('Short prefix for resource names, e.g. samgov.')
@minLength(3)
@maxLength(11)
param namePrefix string

@description('Customer Entra tenant (directory) ID used by the collector.')
param tenantId string

@description('Client ID of the single-tenant Entra app registration that protects the governance API.')
param apiClientId string

@description('Application ID URI accepted as the governance API token audience.')
param apiAudience string = 'api://${apiClientId}'

@description('Client secret of the API app registration, used by App Service sign-in for browser users. Rotate it before it expires.')
@secure()
param authClientSecret string

@description('Log Analytics retention in days.')
@minValue(30)
@maxValue(730)
param logRetentionDays int = 30

@description('Log Analytics daily ingestion cap in GB. Use -1 for no cap.')
param logDailyQuotaGb int = 1

@description('Application Insights sampling percentage.')
@minValue(1)
@maxValue(100)
param telemetrySamplingPercentage int = 20

@description('Email receivers for production alerts.')
param alertEmails alertEmail[] = []

@description('Total HTTP 5xx responses within 15 minutes that trigger an alert.')
@minValue(0)
param http5xxAlertThreshold int = 5

@description('Monthly resource-group budget. Set to 0 to omit the budget.')
@minValue(0)
param monthlyBudgetAmount int = 40

@description('Budget notification recipients.')
param budgetContactEmails string[] = []

@description('Budget start date. Defaults to the first day of the current month.')
param budgetStartDate string = utcNow('yyyy-MM-01')

@description('Create VNet integration, private endpoints, and linked private DNS zones.')
param privateNetworkingEnabled bool = false

@description('Disable public Function App ingress. Enable only after private DNS and deployment-agent connectivity are verified.')
param disablePublicIngress bool = false

@description('Address space for the deployment VNet.')
param vnetAddressPrefix string = '10.42.0.0/16'

@description('Dedicated Function App integration subnet.')
param integrationSubnetPrefix string = '10.42.1.0/24'

@description('Private endpoint subnet.')
param privateEndpointSubnetPrefix string = '10.42.2.0/24'

@description('Dedicated Linux App Service plan SKU. Basic (B1) or higher; the collector timer needs Always On.')
param planSkuName string = 'B1'

@description('Storage redundancy. Use GRS or GZRS for production recovery objectives.')
@allowed([
  'Standard_LRS'
  'Standard_GRS'
  'Standard_GZRS'
])
param storageSkuName string = 'Standard_GRS'

@description('Optional comma-separated Team (group) IDs. Leave empty to enumerate the entire tenant.')
param pilotTeamIds string = ''

@description('Safety cap on workspaces collected per run. 0 = no cap (whole tenant).')
param maxWorkspaces int = 0

@description('Microsoft Graph base URL for the target cloud.')
param graphBaseUrl string = 'https://graph.microsoft.us/v1.0'

@description('Microsoft Graph token scope for the target cloud.')
param graphScope string = 'https://graph.microsoft.us/.default'

@description('Entra authority host for the target cloud.')
param authorityHost string = 'https://login.microsoftonline.us'

@description('NCRONTAB schedule for the daily collector.')
param collectorSchedule string = '0 0 3 * * *'

@description('Optional normalized role-change feed JSON for a controlled pilot. Leave empty until an approved HR/Entra feed is configured.')
@secure()
param roleChangeFeedJson string = ''

@description('Optional site-principals feed JSON keyed by workspace id, used to detect shadow users. Leave empty until a SharePoint permissions report is exported. Shadow users then stay Unknown.')
@secure()
param sitePrincipalsFeedJson string = ''

@description('Hours after which a data source is shown as stale.')
param staleSourceHours int = 36

@description('Hours after which an uploaded evidence feed is ignored and its facts return to Unknown.')
param evidenceMaxAgeHours int = 72

@description('Create a separate executor identity that can remove group members on behalf of owners. Off by default; the collector identity stays read-only.')
param enableExecution bool = false

@description('dry-run records what would be removed and changes nothing. live removes members and needs enableExecution.')
@allowed([
  'dry-run'
  'live'
])
param executionMode string = 'dry-run'

@description('Explicitly arm approved archive/delete actions. They remain dry-run unless executionMode is live.')
param enableLifecycleExecution bool = false

@description('Allow the separate executor identity to revoke selected OneDrive item permissions. Off by default.')
param enableOneDriveSharingRevocation bool = false

@description('JSON map of requested sensitivity-label display names to tenant label GUIDs.')
@secure()
param sensitivityLabelIdsJson string = ''

@description('Notification delivery: off, dry-run (records only) or live (sends mail; needs enableExecution and notifySender).')
@allowed(['off', 'dry-run', 'live'])
param notificationMode string = 'dry-run'

@description('Mailbox the executor identity sends from when notificationMode is live.')
param notifySender string = ''

@description('Governance team address for escalations to the governance queue.')
param notifyOperatorEmail string = ''

@description('Public address of the dashboard, used in message links. Leave empty to set after deployment.')
param appUrl string = ''

@description('Resource tags.')
param tags object = {}

var storageName = toLower('${take(replace(namePrefix, '-', ''), 8)}stg${take(uniqueString(resourceGroup().id), 13)}')
var identityName = '${namePrefix}-collector-id'
var planName = '${namePrefix}-plan'
var functionAppName = '${namePrefix}-func-${uniqueString(resourceGroup().id)}'
var insightsName = '${namePrefix}-ai'
var logAnalyticsName = '${namePrefix}-law'
var keyVaultName = take(toLower('${replace(namePrefix, '-', '')}kv${uniqueString(resourceGroup().id)}'), 24)
var tableName = 'workspaces'
var storageTableEndpoint = 'https://${storageName}.table.${environment().suffixes.storage}'
var storageBlobEndpoint = 'https://${storageName}.blob.${environment().suffixes.storage}'
var isGovernmentCloud = contains(toLower(authorityHost), 'microsoftonline.us')
var appServicePrivateDnsZoneName = isGovernmentCloud ? 'privatelink.azurewebsites.us' : 'privatelink.azurewebsites.net'
var blobPrivateDnsZoneName = 'privatelink.blob.${environment().suffixes.storage}'
var tablePrivateDnsZoneName = 'privatelink.table.${environment().suffixes.storage}'
var keyVaultPrivateDnsZoneName = isGovernmentCloud ? 'privatelink.vaultcore.usgovcloudapi.net' : 'privatelink.vaultcore.azure.net'

resource collectorIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: identityName
  location: location
  tags: tags
}

resource authSecretIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-auth-secret-id'
  location: location
  tags: tags
}

resource executorIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = if (enableExecution) {
  name: '${namePrefix}-executor-id'
  location: location
  tags: tags
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  tags: tags
  sku: {
    name: storageSkuName
  }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
    publicNetworkAccess: privateNetworkingEnabled ? 'Disabled' : 'Enabled'
  }
}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  tags: tags
  properties: {
    tenantId: tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    enablePurgeProtection: true
    softDeleteRetentionInDays: 90
    publicNetworkAccess: privateNetworkingEnabled ? 'Disabled' : 'Enabled'
  }
}

resource easyAuthSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'easy-auth-client-secret'
  properties: {
    value: authClientSecret
    contentType: 'App Service Authentication client credential'
  }
}

resource authSecretReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, authSecretIdentity.id, 'Key Vault Secrets User')
  scope: keyVault
  properties: {
    principalId: authSecretIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
  }
}

resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource workspacesTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: tableName
}

resource findingsTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: 'findings'
}

resource casesTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: 'cases'
}

resource actionsTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: 'actions'
}

resource exceptionsTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: 'exceptions'
}

resource approvalsTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: 'approvals'
}

resource verificationsTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: 'verifications'
}

resource auditTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: 'audit'
}

resource ownerTasksTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: 'ownertasks'
}

resource decisionsTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: 'decisions'
}

resource runsTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: 'runs'
}

resource suppressionsTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: 'suppressions'
}

resource trendTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: 'trend'
}

resource riskDefinitionsTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: 'riskdefs'
}

resource changesTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: 'changes'
}

resource requestsTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: 'requests'
}

resource workspaceMetadataTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: 'workspacemeta'
}

resource agentsTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: 'agents'
}

resource copilotTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: 'copilot'
}

resource notificationsTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: 'notifications'
}

resource oneDriveTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: 'onedrive'
}

resource oneDriveReviewsTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: 'onedrivereviews'
}

resource baselinesTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: 'baselines'
}

resource driftAlertsTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: 'driftalerts'
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource feedsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'feeds'
  properties: {
    publicAccess: 'None'
  }
}

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: logAnalyticsName
  location: location
  tags: tags
  properties: {
    retentionInDays: logRetentionDays
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
    workspaceCapping: {
      dailyQuotaGb: logDailyQuotaGb
    }
  }
}

resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: insightsName
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalytics.id
    SamplingPercentage: telemetrySamplingPercentage
  }
}

resource alertActionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: '${namePrefix}-alerts'
  location: 'global'
  tags: tags
  properties: {
    groupShortName: take('${namePrefix}Ops', 12)
    enabled: true
    emailReceivers: [for receiver in alertEmails: {
      name: receiver.name
      emailAddress: receiver.emailAddress
      useCommonAlertSchema: true
    }]
  }
}

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: planName
  location: location
  tags: tags
  kind: 'linux'
  sku: {
    name: planSkuName
  }
  properties: {
    reserved: true
  }
}

resource virtualNetwork 'Microsoft.Network/virtualNetworks@2023-11-01' = if (privateNetworkingEnabled) {
  name: '${namePrefix}-vnet'
  location: location
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: [
        vnetAddressPrefix
      ]
    }
  }
}

resource integrationSubnet 'Microsoft.Network/virtualNetworks/subnets@2023-11-01' = if (privateNetworkingEnabled) {
  parent: virtualNetwork
  name: 'function-integration'
  properties: {
    addressPrefix: integrationSubnetPrefix
    delegations: [
      {
        name: 'Microsoft.Web.serverFarms'
        properties: {
          serviceName: 'Microsoft.Web/serverFarms'
        }
      }
    ]
  }
}

resource privateEndpointSubnet 'Microsoft.Network/virtualNetworks/subnets@2023-11-01' = if (privateNetworkingEnabled) {
  parent: virtualNetwork
  name: 'private-endpoints'
  properties: {
    addressPrefix: privateEndpointSubnetPrefix
    privateEndpointNetworkPolicies: 'Disabled'
  }
}

resource functionApp 'Microsoft.Web/sites@2023-12-01' = {
  name: functionAppName
  location: location
  tags: tags
  kind: 'functionapp,linux'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: union({
      '${collectorIdentity.id}': {}
      '${authSecretIdentity.id}': {}
    }, enableExecution ? {
      '${executorIdentity.id}': {}
    } : {})
  }
  properties: {
    serverFarmId: plan.id
    keyVaultReferenceIdentity: authSecretIdentity.id
    publicNetworkAccess: disablePublicIngress ? 'Disabled' : 'Enabled'
    virtualNetworkSubnetId: privateNetworkingEnabled ? integrationSubnet.id : null
    vnetRouteAllEnabled: privateNetworkingEnabled
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'Node|24'
      alwaysOn: true
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      appSettings: [
        {
          name: 'AzureWebJobsStorage__accountName'
          value: storageName
        }
        {
          name: 'AzureWebJobsStorage__credential'
          value: 'managedidentity'
        }
        {
          name: 'AzureWebJobsStorage__clientId'
          value: collectorIdentity.properties.clientId
        }
        {
          name: 'FUNCTIONS_EXTENSION_VERSION'
          value: '~4'
        }
        {
          name: 'FUNCTIONS_WORKER_RUNTIME'
          value: 'node'
        }
        {
          name: 'AzureWebJobsDisableHomepage'
          value: 'true'
        }
        {
          name: 'MICROSOFT_PROVIDER_AUTHENTICATION_SECRET'
          value: '@Microsoft.KeyVault(SecretUri=https://${keyVault.name}.${environment().suffixes.keyvaultDns}/secrets/${easyAuthSecret.name}/)'
        }
        {
          name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
          value: insights.properties.ConnectionString
        }
        {
          name: 'AZURE_AUTHORITY_HOST'
          value: authorityHost
        }
        {
          name: 'GRAPH_BASE_URL'
          value: graphBaseUrl
        }
        {
          name: 'GRAPH_SCOPE'
          value: graphScope
        }
        {
          name: 'GRAPH_TENANT_ID'
          value: tenantId
        }
        {
          name: 'COLLECTOR_CLIENT_ID'
          value: collectorIdentity.properties.clientId
        }
        {
          name: 'PILOT_TEAM_IDS'
          value: pilotTeamIds
        }
        {
          name: 'MAX_WORKSPACES'
          value: string(maxWorkspaces)
        }
        {
          name: 'STORAGE_TABLE_ENDPOINT'
          value: storageTableEndpoint
        }
        {
          name: 'STORAGE_TABLE_NAME'
          value: tableName
        }
        {
          name: 'COLLECTOR_SCHEDULE'
          value: collectorSchedule
        }
        {
          name: 'ROLE_CHANGE_FEED_JSON'
          value: roleChangeFeedJson
        }
        {
          name: 'SITE_PRINCIPALS_FEED_JSON'
          value: sitePrincipalsFeedJson
        }
        {
          name: 'STALE_SOURCE_HOURS'
          value: string(staleSourceHours)
        }
        {
          name: 'STORAGE_BLOB_ENDPOINT'
          value: storageBlobEndpoint
        }
        {
          name: 'EVIDENCE_MAX_AGE_HOURS'
          value: string(evidenceMaxAgeHours)
        }
        {
          name: 'EXECUTION_MODE'
          value: enableExecution ? executionMode : 'dry-run'
        }
        {
          name: 'ENABLE_LIFECYCLE_EXECUTION'
          value: string(enableLifecycleExecution)
        }
        {
          name: 'ENABLE_ONEDRIVE_SHARING_REVOCATION'
          value: string(enableOneDriveSharingRevocation)
        }
        {
          name: 'SENSITIVITY_LABEL_IDS'
          value: sensitivityLabelIdsJson
        }
        {
          name: 'EXECUTOR_CLIENT_ID'
          value: enableExecution ? executorIdentity.?properties.clientId ?? '' : ''
        }
        {
          name: 'NOTIFICATION_MODE'
          value: notificationMode == 'live' && !enableExecution ? 'dry-run' : notificationMode
        }
        {
          name: 'NOTIFY_SENDER'
          value: notifySender
        }
        {
          name: 'NOTIFY_OPERATOR_EMAIL'
          value: notifyOperatorEmail
        }
        {
          name: 'APP_URL'
          value: appUrl
        }
      ]
    }
  }
}

resource appServicePrivateDnsZone 'Microsoft.Network/privateDnsZones@2020-06-01' = if (privateNetworkingEnabled) {
  name: appServicePrivateDnsZoneName
  location: 'global'
  tags: tags
}

resource blobPrivateDnsZone 'Microsoft.Network/privateDnsZones@2020-06-01' = if (privateNetworkingEnabled) {
  name: blobPrivateDnsZoneName
  location: 'global'
  tags: tags
}

resource tablePrivateDnsZone 'Microsoft.Network/privateDnsZones@2020-06-01' = if (privateNetworkingEnabled) {
  name: tablePrivateDnsZoneName
  location: 'global'
  tags: tags
}

resource keyVaultPrivateDnsZone 'Microsoft.Network/privateDnsZones@2020-06-01' = if (privateNetworkingEnabled) {
  name: keyVaultPrivateDnsZoneName
  location: 'global'
  tags: tags
}

resource appServicePrivateDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = if (privateNetworkingEnabled) {
  parent: appServicePrivateDnsZone
  name: '${namePrefix}-vnet-link'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: virtualNetwork.id
    }
  }
}

resource blobPrivateDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = if (privateNetworkingEnabled) {
  parent: blobPrivateDnsZone
  name: '${namePrefix}-vnet-link'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: virtualNetwork.id
    }
  }
}

resource tablePrivateDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = if (privateNetworkingEnabled) {
  parent: tablePrivateDnsZone
  name: '${namePrefix}-vnet-link'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: virtualNetwork.id
    }
  }
}

resource keyVaultPrivateDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = if (privateNetworkingEnabled) {
  parent: keyVaultPrivateDnsZone
  name: '${namePrefix}-vnet-link'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: virtualNetwork.id
    }
  }
}

resource functionPrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-11-01' = if (privateNetworkingEnabled) {
  name: '${namePrefix}-function-pe'
  location: location
  tags: tags
  properties: {
    subnet: {
      id: privateEndpointSubnet.id
    }
    privateLinkServiceConnections: [
      {
        name: 'function'
        properties: {
          privateLinkServiceId: functionApp.id
          groupIds: [
            'sites'
          ]
        }
      }
    ]
  }
}

resource storageBlobPrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-11-01' = if (privateNetworkingEnabled) {
  name: '${namePrefix}-blob-pe'
  location: location
  tags: tags
  properties: {
    subnet: {
      id: privateEndpointSubnet.id
    }
    privateLinkServiceConnections: [
      {
        name: 'blob'
        properties: {
          privateLinkServiceId: storage.id
          groupIds: [
            'blob'
          ]
        }
      }
    ]
  }
}

resource storageTablePrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-11-01' = if (privateNetworkingEnabled) {
  name: '${namePrefix}-table-pe'
  location: location
  tags: tags
  properties: {
    subnet: {
      id: privateEndpointSubnet.id
    }
    privateLinkServiceConnections: [
      {
        name: 'table'
        properties: {
          privateLinkServiceId: storage.id
          groupIds: [
            'table'
          ]
        }
      }
    ]
  }
}

resource keyVaultPrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-11-01' = if (privateNetworkingEnabled) {
  name: '${namePrefix}-vault-pe'
  location: location
  tags: tags
  properties: {
    subnet: {
      id: privateEndpointSubnet.id
    }
    privateLinkServiceConnections: [
      {
        name: 'vault'
        properties: {
          privateLinkServiceId: keyVault.id
          groupIds: [
            'vault'
          ]
        }
      }
    ]
  }
}

resource functionPrivateDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = if (privateNetworkingEnabled) {
  parent: functionPrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'appservice'
        properties: {
          privateDnsZoneId: appServicePrivateDnsZone.id
        }
      }
    ]
  }
}

resource blobPrivateDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = if (privateNetworkingEnabled) {
  parent: storageBlobPrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'blob'
        properties: {
          privateDnsZoneId: blobPrivateDnsZone.id
        }
      }
    ]
  }
}

resource tablePrivateDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = if (privateNetworkingEnabled) {
  parent: storageTablePrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'table'
        properties: {
          privateDnsZoneId: tablePrivateDnsZone.id
        }
      }
    ]
  }
}

resource vaultPrivateDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = if (privateNetworkingEnabled) {
  parent: keyVaultPrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'vault'
        properties: {
          privateDnsZoneId: keyVaultPrivateDnsZone.id
        }
      }
    ]
  }
}

resource functionDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'send-to-log-analytics'
  scope: functionApp
  properties: {
    workspaceId: logAnalytics.id
    logs: [
      {
        categoryGroup: 'allLogs'
        enabled: true
      }
    ]
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
      }
    ]
  }
}

resource keyVaultDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'send-to-log-analytics'
  scope: keyVault
  properties: {
    workspaceId: logAnalytics.id
    logs: [
      {
        categoryGroup: 'audit'
        enabled: true
      }
    ]
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
      }
    ]
  }
}

resource http5xxAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${namePrefix}-http5xx'
  location: 'global'
  tags: tags
  properties: {
    description: 'Function App returned repeated HTTP 5xx responses.'
    severity: 2
    enabled: true
    scopes: [
      functionApp.id
    ]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'Http5xxThreshold'
          criterionType: 'StaticThresholdCriterion'
          metricName: 'Http5xx'
          metricNamespace: 'Microsoft.Web/sites'
          operator: 'GreaterThan'
          threshold: http5xxAlertThreshold
          timeAggregation: 'Total'
        }
      ]
    }
    autoMitigate: true
    actions: [
      {
        actionGroupId: alertActionGroup.id
      }
    ]
  }
}

module costBudget 'budget.bicep' = if (monthlyBudgetAmount > 0) {
  scope: subscription()
  params: {
    resourceGroupName: resourceGroup().name
    budgetName: '${namePrefix}-monthly-budget'
    amount: max(monthlyBudgetAmount, 1)
    startDate: budgetStartDate
    contactEmails: budgetContactEmails
  }
}

resource functionAuth 'Microsoft.Web/sites/config@2022-09-01' = {
  parent: functionApp
  name: 'authsettingsV2'
  properties: {
    platform: {
      enabled: true
      runtimeVersion: '~1'
    }
    globalValidation: {
      requireAuthentication: true
      unauthenticatedClientAction: 'RedirectToLoginPage'
      redirectToProvider: 'azureactivedirectory'
    }
    httpSettings: {
      requireHttps: true
    }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        registration: {
          clientId: apiClientId
          clientSecretSettingName: 'MICROSOFT_PROVIDER_AUTHENTICATION_SECRET'
          openIdIssuer: '${authorityHost}/${tenantId}/v2.0'
        }
        validation: {
          allowedAudiences: [
            apiAudience
            apiClientId
          ]
        }
      }
    }
    login: {
      tokenStore: {
        enabled: false
      }
    }
  }
}

// Roles the collector identity needs on the storage account. The Functions host uses blobs (timer
// leases) and queues through the same identity, and the collector reads and writes tables.
var storageRoles = [
  { name: 'tableContributor', id: '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3' } // Storage Table Data Contributor
  { name: 'blobOwner', id: 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b' } // Storage Blob Data Owner
  { name: 'queueContributor', id: '974c5e8b-45b9-4653-ba55-5f855dd0fb88' } // Storage Queue Data Contributor
]

resource storageRoleAssignments 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for role in storageRoles: {
  name: guid(storage.id, collectorIdentity.id, role.id)
  scope: storage
  properties: {
    principalId: collectorIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', role.id)
  }
}]

output functionAppName string = functionApp.name
output appUrl string = 'https://${functionApp.properties.defaultHostName}'
output apiAudience string = apiAudience
output collectorIdentityClientId string = collectorIdentity.properties.clientId
output collectorIdentityPrincipalId string = collectorIdentity.properties.principalId
output executorIdentityPrincipalId string = executorIdentity.?properties.principalId ?? ''
output storageAccountName string = storage.name
output keyVaultName string = keyVault.name
output logAnalyticsWorkspaceName string = logAnalytics.name
output privateNetworkingEnabled bool = privateNetworkingEnabled
output privateDnsZones string[] = privateNetworkingEnabled ? [appServicePrivateDnsZoneName, blobPrivateDnsZoneName, tablePrivateDnsZoneName, keyVaultPrivateDnsZoneName] : []
output workspacesApiPath string = 'https://${functionApp.properties.defaultHostName}/api/workspaces'
