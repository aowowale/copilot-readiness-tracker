// Read-only GCC High collector + API infrastructure for the Copilot Readiness dashboard.
// Deploy into a customer-owned Azure Government subscription. No secrets are defined here;
// the collector uses a user-assigned managed identity.

@description('Azure Government region, e.g. usgovvirginia or usgovtexas.')
param location string = resourceGroup().location

@description('Short prefix for resource names, e.g. samgov.')
@minLength(3)
@maxLength(11)
param namePrefix string

@description('Customer Entra tenant (directory) ID used by the collector.')
param tenantId string

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

@description('Resource tags.')
param tags object = {}

var storageName = toLower('${take(replace(namePrefix, '-', ''), 8)}stg${take(uniqueString(resourceGroup().id), 13)}')
var identityName = '${namePrefix}-collector-id'
var planName = '${namePrefix}-plan'
var functionAppName = '${namePrefix}-func-${uniqueString(resourceGroup().id)}'
var insightsName = '${namePrefix}-ai'
var tableName = 'workspaces'
var storageTableEndpoint = 'https://${storageName}.table.${environment().suffixes.storage}'

resource collectorIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: identityName
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
  sku: {
    name: 'Y1'
    tier: 'Dynamic'
  }
  properties: {}
}

resource functionApp 'Microsoft.Web/sites@2023-12-01' = {
  name: functionAppName
  location: location
  tags: tags
  kind: 'functionapp'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${collectorIdentity.id}': {}
    }
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
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
          name: 'WEBSITE_NODE_DEFAULT_VERSION'
          value: '~20'
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
      ]
    }
  }
}

// Storage Table Data Contributor for the collector identity (host storage + snapshots).
var tableContributorRoleId = '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'

resource tableRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, collectorIdentity.id, tableContributorRoleId)
  scope: storage
  properties: {
    principalId: collectorIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', tableContributorRoleId)
  }
}

output functionAppName string = functionApp.name
output collectorIdentityClientId string = collectorIdentity.properties.clientId
output collectorIdentityPrincipalId string = collectorIdentity.properties.principalId
output storageAccountName string = storage.name
output workspacesApiPath string = 'https://${functionApp.properties.defaultHostName}/api/workspaces'
