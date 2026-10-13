<#
.SYNOPSIS
    Restricts the governance executor's Mail.Send permission to an approved mailbox scope.

.DESCRIPTION
    Creates an Exchange Online application access policy for an existing mail-enabled security
    group, then tests the approved sender and an optional out-of-scope mailbox. Exchange policy
    propagation can take over an hour; rerun the tests before enabling live notifications.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-fA-F-]{36}$')][string]$ExecutorAppId,
    [Parameter(Mandatory)][string]$PolicyScopeGroupId,
    [Parameter(Mandatory)][string]$ApprovedSender,
    [string]$DeniedMailbox
)

$ErrorActionPreference = 'Stop'
if (-not (Get-Command New-ApplicationAccessPolicy -ErrorAction SilentlyContinue)) {
    throw 'Connect to Exchange Online with the ExchangeOnlineManagement module before running this script.'
}
$existing = @(Get-ApplicationAccessPolicy | Where-Object { $_.AppId -eq $ExecutorAppId -and $_.ScopeName -eq $PolicyScopeGroupId })
if (-not $existing -and $PSCmdlet.ShouldProcess($ExecutorAppId, "Restrict Mail.Send to $PolicyScopeGroupId")) {
    New-ApplicationAccessPolicy -AppId $ExecutorAppId -PolicyScopeGroupId $PolicyScopeGroupId -AccessRight RestrictAccess -Description 'Microsoft 365 Copilot Readiness notification sender restriction' | Out-Null
}
$approved = Test-ApplicationAccessPolicy -Identity $ApprovedSender -AppId $ExecutorAppId
if ($approved.AccessCheckResult -ne 'Granted') { throw "Approved sender is not granted yet: $($approved.AccessCheckResult). Allow for Exchange policy propagation and retry." }
if ($DeniedMailbox) {
    $denied = Test-ApplicationAccessPolicy -Identity $DeniedMailbox -AppId $ExecutorAppId
    if ($denied.AccessCheckResult -ne 'Denied') { throw "Out-of-scope mailbox was not denied: $($denied.AccessCheckResult)." }
}
[pscustomobject]@{ ExecutorAppId = $ExecutorAppId; ApprovedSender = $ApprovedSender; Approved = $true; DeniedMailbox = $DeniedMailbox; Denied = [bool]$DeniedMailbox }