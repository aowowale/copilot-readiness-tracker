[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory)][string]$ConfigPath,
    [Parameter(Mandatory)][string]$PreviousReleaseZip,
    [Parameter(Mandatory)][string]$PreviousReleaseSha256,
    [string]$BackupDirectory
)

$ErrorActionPreference = 'Stop'
$expected = (Get-Content -LiteralPath $PreviousReleaseSha256 -Raw).Trim().Split(' ')[0].ToLowerInvariant()
$actual = (Get-FileHash -LiteralPath $PreviousReleaseZip -Algorithm SHA256).Hash.ToLowerInvariant()
if ($expected -ne $actual) { throw 'Previous release checksum verification failed.' }
if (-not $PSCmdlet.ShouldProcess($PreviousReleaseZip, 'Deploy previous release and optionally restore its data backup')) { return }
$temp = Join-Path ([IO.Path]::GetTempPath()) "sam-rollback-$([guid]::NewGuid().ToString('N'))"
try {
    Expand-Archive -LiteralPath $PreviousReleaseZip -DestinationPath $temp
    $releaseRoot = Get-ChildItem -LiteralPath $temp -Directory | Select-Object -First 1
    $entry = Join-Path $releaseRoot.FullName 'scripts\Deploy-Customer.ps1'
    if (-not (Test-Path -LiteralPath $entry)) { throw 'Previous release does not contain the unified deployment entry script.' }
    $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    & $entry -ConfigPath ([IO.Path]::GetFullPath($ConfigPath))
    if ($LASTEXITCODE) { throw 'Previous release deployment failed; data was not restored.' }
    if ($BackupDirectory) {
        & (Join-Path $releaseRoot.FullName 'scripts\Restore-Governance.ps1') -TenantId $config.azure.tenantId -BackupDirectory $BackupDirectory -Confirm:$false
    }
    $rollbackState = Join-Path $releaseRoot.FullName ".install\$($config.azure.tenantId).json"
    if (Test-Path -LiteralPath $rollbackState) {
        $currentStateDirectory = if ($env:SAM_INSTALL_STATE_DIR) { [IO.Path]::GetFullPath($env:SAM_INSTALL_STATE_DIR) } else { Join-Path (Split-Path -Parent $PSScriptRoot) '.install' }
        New-Item -ItemType Directory -Path $currentStateDirectory -Force | Out-Null
        Copy-Item -LiteralPath $rollbackState -Destination $currentStateDirectory -Force
    }
} finally {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}