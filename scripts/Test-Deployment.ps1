<#
.SYNOPSIS
    Proves an installed deployment works end to end: sign-in protection, every API route, app roles,
    the dashboard page, and a real collector run against the tenant.

.DESCRIPTION
    Reads .install\<TenantId>.json written by Install-Governance.ps1. Needs the installing user to
    hold the Governance.Reader role (the installer assigns it) and to be signed in to the Azure CLI
    for the same tenant. It triggers one collector run, which reads the tenant (read-only) and
    writes snapshots to the deployment's own storage.

.EXAMPLE
    .\Test-Deployment.ps1 -TenantId <tenant>
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$TenantId,
    [switch]$SkipCollector,
    [int]$CollectorTimeoutMinutes = 6
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$stateDirectory = if ($env:SAM_INSTALL_STATE_DIR) { [IO.Path]::GetFullPath($env:SAM_INSTALL_STATE_DIR) } else { Join-Path $repoRoot '.install' }
$stateFile = Join-Path $stateDirectory "$TenantId.json"
if (-not (Test-Path -LiteralPath $stateFile)) { throw "No install record for tenant $TenantId. Run Install-Governance.ps1 first." }
$state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
$appUrl = $state.appUrl.TrimEnd('/')

$results = [System.Collections.Generic.List[object]]::new()
function Record([string]$Name, [bool]$Ok, [string]$Detail = '') {
    $results.Add([pscustomobject]@{ Name = $Name; Ok = $Ok; Detail = $Detail })
    Write-Host ('{0,-4} {1}{2}' -f $(if ($Ok) { 'PASS' } else { 'FAIL' }), $Name, $(if ($Detail) { " ($Detail)" }))
}

function Read-JwtPayload([string]$Token) {
    $part = $Token.Split('.')[1].Replace('-', '+').Replace('_', '/')
    $part = $part.PadRight($part.Length + (4 - $part.Length % 4) % 4, '=')
    [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($part)) | ConvertFrom-Json
}

function Call([string]$Path, [hashtable]$Headers, [string]$Method = 'GET', [int]$TimeoutSec = 60) {
    try {
        $r = Invoke-WebRequest -Uri "$appUrl$Path" -Method $Method -Headers $Headers -MaximumRedirection 0 -SkipHttpErrorCheck -TimeoutSec $TimeoutSec
        [pscustomobject]@{ Status = [int]$r.StatusCode; Body = $r.Content }
    } catch { [pscustomobject]@{ Status = 0; Body = $_.Exception.Message } }
}

function Call-WithoutRedirect([string]$Path) {
    $handler = [Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect = $false
    $client = [Net.Http.HttpClient]::new($handler)
    try {
        $client.Timeout = [TimeSpan]::FromSeconds(60)
        $response = $client.GetAsync("$appUrl$Path").GetAwaiter().GetResult()
        [pscustomobject]@{ Status = [int]$response.StatusCode; Body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult() }
    } catch {
        [pscustomobject]@{ Status = 0; Body = $_.Exception.Message }
    } finally {
        $client.Dispose()
        $handler.Dispose()
    }
}

Write-Host "Testing $appUrl`n"

# 1. Easy Auth must have its confidential-client credential.
$appSettings = az functionapp config appsettings list --resource-group $state.resourceGroup --name $state.functionApp --subscription $state.subscriptionId --output json 2>$null | ConvertFrom-Json
$authSecretConfigured = [bool]($appSettings | Where-Object { $_.name -eq 'MICROSOFT_PROVIDER_AUTHENTICATION_SECRET' -and $_.value })
Record 'Easy Auth client secret is configured' $authSecretConfigured $(if (-not $authSecretConfigured) { 'browser sign-in callbacks will return 401; rerun Install-Governance.ps1 to rotate and restore the credential' })

# 2. The platform must refuse anonymous requests.
$anonymous = Call-WithoutRedirect '/api/policies'
Record 'Anonymous requests are refused' ($anonymous.Status -in 301, 302, 401, 403) "status $($anonymous.Status)"

# 3. Token for the signed-in user.
$token = $null
try {
    $token = (az account get-access-token --tenant $TenantId --scope "api://$($state.apiClientId)/user_impersonation" --query accessToken --output tsv 2>&1 | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }) -join ''
    if ($LASTEXITCODE -ne 0 -or -not $token) { throw 'no token' }
} catch { $token = $null }
Record 'Got an API token for the signed-in user' ([bool]$token) $(if (-not $token) { "Run: az login --tenant $TenantId" })
if (-not $token) { throw 'Cannot continue without a token.' }

$claims = Read-JwtPayload $token
Record 'Token carries a governance app role' ([bool]($claims.roles | Where-Object { $_ -like 'Governance.*' -or $_ -in 'Approver', 'Executor', 'Auditor' })) "roles: $($claims.roles -join ', ')"
$auth = @{ Authorization = "Bearer $token" }

# 4. Every read route.
$routes = '/api/policies', '/api/workspaces', '/api/findings', '/api/cases', '/api/exceptions', '/api/decisions', '/api/posture', '/api/sources', '/api/owner/tasks?scope=all'
foreach ($route in $routes) {
    $response = Call $route $auth
    $json = $null; try { $json = $response.Body | ConvertFrom-Json } catch { }
    Record "GET $route" ($response.Status -eq 200 -and $null -ne $json) "status $($response.Status)"
}

$page = Call '/' $auth
Record 'Dashboard page is served' ($page.Status -eq 200 -and $page.Body -match 'Copilot') "status $($page.Status)"
$missing = Call '/api/does-not-exist' $auth
Record 'Unknown API route returns 404, not the page' ($missing.Status -eq 404) "status $($missing.Status)"

# 5. A real collector run.
if (-not $SkipCollector) {
    Write-Host "`nTriggering one collector run (reads the tenant, read-only)..."
    $startedAt = (Get-Date).ToUniversalTime()
    $trigger = Call '/api/collector/run' $auth 'POST' ([Math]::Max(60, $CollectorTimeoutMinutes * 60))
    Record 'Collector trigger accepted' ($trigger.Status -eq 200) "status $($trigger.Status)"

    if ($trigger.Status -eq 200) {
        $sources = (Call '/api/sources' $auth).Body | ConvertFrom-Json
        $source = $sources.sources | Where-Object { $_.source -eq 'graph-teams' -and [datetime]$_.finishedAt -ge $startedAt } | Select-Object -First 1
        Record 'Collector finished and recorded its run' ([bool]$source) $(if (-not $source) { 'no graph-teams run was recorded. Check the function app logs.' })
        if ($source) {
            Record 'Graph collection succeeded' ($source.status -in 'ok', 'partial') "status $($source.status), $($source.recordsRead) workspaces$(if ($source.warnings) { '; ' + ($source.warnings -join ' ') })$(if ($source.error) { '; ' + $source.error })"
            $workspaces = ((Call '/api/workspaces' $auth).Body | ConvertFrom-Json)
            Record 'Workspaces are stored' ($workspaces.workspaces.Count -gt 0) "$($workspaces.workspaces.Count) workspaces"
            $tasks = ((Call '/api/owner/tasks?scope=all' $auth).Body | ConvertFrom-Json)
            Record 'Owner tasks were created' ($tasks.tasks.Count -gt 0) "$($tasks.tasks.Count) tasks"
            $risky = @($workspaces.workspaces | Where-Object { $_.risk })
            Record 'Risk was scored for every workspace' ($risky.Count -eq $workspaces.workspaces.Count) "$($risky.Count) of $($workspaces.workspaces.Count)"
        }
    }
}

$failed = @($results | Where-Object { -not $_.Ok })
Write-Host ''
if ($failed.Count) { Write-Host "$($failed.Count) of $($results.Count) checks failed." -ForegroundColor Red; exit 1 }
Write-Host "All $($results.Count) checks passed." -ForegroundColor Green
