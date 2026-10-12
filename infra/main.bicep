// Read-only collector + API infrastructure for the Copilot Readiness dashboard.
// Deploys to Azure Government or commercial Azure; pass the cloud-specific endpoints as parameters.
// The only secret is the sign-in client secret, passed as a secure parameter. The collector uses a
// user-assigned managed identity.

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

@description('Dedicated Linux App Service plan SKU. Basic (B1) or higher; the collector timer needs Always On.')
param planSkuName string = 'B1'

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
var tableName = 'workspaces'
var storageTableEndpoint = 'https://${storageName}.table.${environment().suffixes.storage}'
var storageBlobEndpoint = 'https://${storageName}.blob.${environment().suffixes.storage}'

resource collectorIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: identityName
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
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
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

resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: insightsName
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
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

resource functionApp 'Microsoft.Web/sites@2023-12-01' = {
  name: functionAppName
  location: location
  tags: tags
  kind: 'functionapp,linux'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: union({
      '${collectorIdentity.id}': {}
    }, enableExecution ? {
      '${executorIdentity.id}': {}
    } : {})
  }
  properties: {
    serverFarmId: plan.id
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
          value: authClientSecret
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
output workspacesApiPath string = 'https://${functionApp.properties.defaultHostName}/api/workspaces'
