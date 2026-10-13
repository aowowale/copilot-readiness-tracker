targetScope = 'subscription'

@description('Resource group to which this budget applies.')
param resourceGroupName string

@description('Budget resource name.')
param budgetName string

@description('Monthly budget amount in the billing currency.')
@minValue(1)
param amount int

@description('First day covered by the budget, formatted yyyy-MM-dd.')
param startDate string

@description('Budget notification recipients.')
param contactEmails string[]

resource budget 'Microsoft.Consumption/budgets@2023-05-01' = {
  name: budgetName
  properties: {
    amount: amount
    category: 'Cost'
    timeGrain: 'Monthly'
    timePeriod: {
      startDate: startDate
    }
    filter: {
      dimensions: {
        name: 'ResourceGroupName'
        operator: 'In'
        values: [
          resourceGroupName
        ]
      }
    }
    notifications: {
      Actual80: {
        enabled: length(contactEmails) > 0
        operator: 'GreaterThanOrEqualTo'
        threshold: 80
        thresholdType: 'Actual'
        contactEmails: contactEmails
      }
      Forecast100: {
        enabled: length(contactEmails) > 0
        operator: 'GreaterThanOrEqualTo'
        threshold: 100
        thresholdType: 'Forecasted'
        contactEmails: contactEmails
      }
    }
  }
}

output budgetId string = budget.id