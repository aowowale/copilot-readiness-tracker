<#
.SYNOPSIS
    Creates a certificate-backed Entra application for unattended, read-only SharePoint evidence export.

.DESCRIPTION
    SharePoint tenant enumeration through Get-SPOSite requires the SharePoint application role
    Sites.FullControl.All even though Export-WorkspaceEvidence.ps1 performs only reads. This script
    will not grant that tenant-wide permission unless -ConsentSitesFullControlAll is explicit.
    The private key remains in the CurrentUser certificate store on the automation host.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory)][string]$TenantId,
    [Parameter(Mandatory)][string]$SharePointAdminUrl,
    [string]$DisplayName = 'SAM SharePoint Evidence Export',
    [ValidateRange(30, 730)][int]$CertificateValidityDays = 365,
    [Parameter(Mandatory)][switch]$ConsentSitesFullControlAll
)

$ErrorActionPreference = 'Stop'
if (([uri]$SharePointAdminUrl).Scheme -ne 'https') { throw 'SharePointAdminUrl must be HTTPS.' }
if (-not $PSCmdlet.ShouldProcess($TenantId, 'Create certificate app and grant SharePoint Sites.FullControl.All application permission')) { return }

$certificate = New-SelfSignedCertificate `
    -Subject "CN=$DisplayName" `
    -CertStoreLocation Cert:\CurrentUser\My `
    -KeyAlgorithm RSA `
    -KeyLength 3072 `
    -HashAlgorithm SHA256 `
    -NotAfter (Get-Date).AddDays($CertificateValidityDays) `
    -KeyExportPolicy Exportable

$graphRoot = if (([uri]$SharePointAdminUrl).Host.EndsWith('.sharepoint.us')) { 'https://graph.microsoft.us' } else { 'https://graph.microsoft.com' }
function Graph([string]$Method, [string]$Path, $Body) {
    $arguments = @('rest', '--method', $Method, '--url', "$graphRoot$Path", '--resource', $graphRoot, '--output', 'json')
    $file = $null
    if ($null -ne $Body) {
        $file = New-TemporaryFile
        $Body | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $file -Encoding UTF8
        $arguments += @('--headers', 'Content-Type=application/json', '--body', "@$file")
    }
    try {
        $result = az @arguments
        if ($LASTEXITCODE -ne 0) { throw "Graph $Method $Path failed." }
        if ($result) { ($result -join "`n") | ConvertFrom-Json }
    } finally { if ($file) { Remove-Item $file -Force } }
}

$encodedCertificate = [Convert]::ToBase64String($certificate.RawData)
$app = Graph POST '/v1.0/applications' @{
    displayName = $DisplayName
    signInAudience = 'AzureADMyOrg'
    keyCredentials = @(@{
        customKeyIdentifier = [Convert]::ToBase64String($certificate.GetCertHash())
        displayName = "SAM evidence $($certificate.Thumbprint)"
        endDateTime = $certificate.NotAfter.ToUniversalTime().ToString('o')
        key = $encodedCertificate
        startDateTime = $certificate.NotBefore.ToUniversalTime().ToString('o')
        type = 'AsymmetricX509Cert'
        usage = 'Verify'
    })
}
$servicePrincipal = Graph POST '/v1.0/servicePrincipals' @{ appId = $app.appId }
$sharePointAppId = '00000003-0000-0ff1-ce00-000000000000'
$sharePoint = (Graph GET "/v1.0/servicePrincipals?`$filter=appId eq '$sharePointAppId'&`$select=id,appRoles" $null).value | Select-Object -First 1
$permission = $sharePoint.appRoles | Where-Object { $_.value -eq 'Sites.FullControl.All' -and $_.allowedMemberTypes -contains 'Application' } | Select-Object -First 1
if (-not $permission) { throw 'SharePoint Sites.FullControl.All is not available in this cloud.' }
Graph POST "/v1.0/servicePrincipals/$($servicePrincipal.id)/appRoleAssignments" @{
    principalId = $servicePrincipal.id
    resourceId = $sharePoint.id
    appRoleId = $permission.id
} | Out-Null

$result = [ordered]@{
    tenantId = $TenantId
    sharePointAdminUrl = $SharePointAdminUrl
    clientId = $app.appId
    certificateThumbprint = $certificate.Thumbprint
    certificateExpiresUtc = $certificate.NotAfter.ToUniversalTime().ToString('o')
    permission = 'SharePoint Sites.FullControl.All (application)'
    nextCommand = ".\scripts\Export-WorkspaceEvidence.ps1 -SharePointAdminUrl '$SharePointAdminUrl' -TenantId '$TenantId' -ClientId '$($app.appId)' -CertificateThumbprint '$($certificate.Thumbprint)'"
}
$result | ConvertTo-Json -Depth 4