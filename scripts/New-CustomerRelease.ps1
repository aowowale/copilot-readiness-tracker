[CmdletBinding()]
param(
    [ValidatePattern('^\d+\.\d+\.\d+$')]
    [string]$Version = '1.1.0',
    [string]$OutputDirectory = (Join-Path (Split-Path -Parent $PSScriptRoot) 'artifacts'),
    [switch]$SkipCollateral
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$releaseName = "m365-copilot-readiness-v$Version"
$createdUtc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
$sourceCommit = (git -C $projectRoot rev-parse HEAD 2>$null)
if (-not $sourceCommit) { $sourceCommit = 'unavailable' }

$rootFiles = @(
    'README.md'
    'START-HERE.md'
    'CUSTOMER-DEPLOYMENT.md'
    'customer-deployment.example.json'
    'CLOUD-SYNC-SETUP.md'
    'MANUAL-IMPORT.md'
    'index.html'
    'governance-import.sample.json'
    'governance-import.role-change.sample.json'
)
$backendFiles = @(
    'backend/host.json'
    'backend/package.json'
    'backend/package-lock.json'
    'backend/local.settings.json.example'
)
$scriptFiles = Get-ChildItem -LiteralPath (Join-Path $projectRoot 'scripts') -File | ForEach-Object {
    [IO.Path]::GetRelativePath($projectRoot, $_.FullName).Replace('\', '/')
}
$collateralFiles = @(
    'artifacts/Microsoft-365-Copilot-Readiness-Customer-Guide.docx'
    'artifacts/Microsoft-365-Copilot-Readiness-Customer-Guide.pdf'
    'artifacts/Microsoft-365-Copilot-Readiness-Customer-Presentation.pptx'
    'artifacts/Microsoft-365-Copilot-Readiness-Customer-Presentation.pdf'
)
if ($SkipCollateral) { $collateralFiles = @() }
$pilotEvidence = @(
    'artifacts/read-only-pilot-2-acceptance.json'
    'artifacts/read-only-pilot-2-validation.txt'
) | Where-Object { Test-Path -LiteralPath (Join-Path $projectRoot $_) -PathType Leaf }
$sourceDirectories = @('.github', 'backend/src', 'backend/test', 'docs', 'infra')
$requiredFiles = $rootFiles + $backendFiles + $scriptFiles + $collateralFiles
$missing = @($requiredFiles | Where-Object { -not (Test-Path -LiteralPath (Join-Path $projectRoot $_) -PathType Leaf) })
if ($missing.Count) { throw "Required release files are missing: $($missing -join ', ')" }

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$stagingRoot = Join-Path ([System.IO.Path]::GetTempPath()) "$releaseName-$([guid]::NewGuid().ToString('N'))"
$releaseRoot = Join-Path $stagingRoot $releaseName
$archivePath = Join-Path $OutputDirectory "$releaseName.zip"
$checksumPath = Join-Path $OutputDirectory "$releaseName.zip.sha256"

function Copy-ReleaseFile([string]$RelativePath) {
    $source = Join-Path $projectRoot $RelativePath
    $destination = Join-Path $releaseRoot $RelativePath
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination -Force
}

try {
    New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
    foreach ($file in ($requiredFiles + $pilotEvidence)) { Copy-ReleaseFile $file }
    foreach ($directory in $sourceDirectories) {
        $destination = Join-Path $releaseRoot $directory
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $projectRoot $directory) -Destination $destination -Recurse -Force
    }

    $permissionManifest = @'
# Permission manifest

The v1 release deploys a read-only collector by default.

## Default collector permissions

- `Group.Read.All`
- `Team.ReadBasic.All`
- `TeamMember.Read.All`
- `Channel.ReadBasic.All`
- `User.Read.All`

## Optional read-only bundles

- Usage reports: `Reports.Read.All`
- Copilot and agent inventory: `Organization.Read.All`, `Reports.Read.All`, `AppCatalog.Read.All`
- Bounded OneDrive sharing review: `Files.Read.All`

## Write permissions

No write permission is enabled by this release package. Optional executor capabilities require a separate identity, explicit installer switches, customer approval, dry-run validation, and a separate live-mode change record. Review the installer output before administrator consent.
'@
    Set-Content -LiteralPath (Join-Path $releaseRoot 'PERMISSIONS.md') -Value $permissionManifest -Encoding UTF8

    $manifest = [ordered]@{
        schemaVersion = 1
        product = 'Microsoft 365 Copilot Readiness'
        releaseVersion = $Version
        createdUtc = $createdUtc
        sourceCommit = $sourceCommit
        deploymentDefault = 'read-only-dry-run'
        enabledByDefault = [ordered]@{
            collector = $true
            execution = $false
            lifecycleExecution = $false
            linkRevocation = $false
            provisioning = $false
            liveNotifications = $false
        }
        validation = [ordered]@{
            repositoryTests = 'Run npm test from backend/'
            deployment = 'Run scripts/Test-Deployment.ps1 after installation'
            secondPilot = 'Run scripts/Test-ReadOnlyPilot.ps1 to produce sanitized evidence'
            includedPilotEvidence = @($pilotEvidence)
        }
        documentation = @(
            'CUSTOMER-DEPLOYMENT.md'
            'docs/COST-AND-COMPONENTS.md'
            'docs/PUSH-BUTTON-READINESS.md'
            'artifacts/Microsoft-365-Copilot-Readiness-Customer-Guide.pdf'
            'artifacts/Microsoft-365-Copilot-Readiness-Customer-Presentation.pdf'
        )
    }
    $manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $releaseRoot 'RELEASE-MANIFEST.json') -Encoding UTF8

    $checksumLines = Get-ChildItem -LiteralPath $releaseRoot -File -Recurse | Sort-Object FullName | ForEach-Object {
        $relative = [IO.Path]::GetRelativePath($releaseRoot, $_.FullName).Replace('\', '/')
        $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        "$hash  $relative"
    }
    Set-Content -LiteralPath (Join-Path $releaseRoot 'CHECKSUMS.sha256') -Value $checksumLines -Encoding ascii

    Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue
    Compress-Archive -LiteralPath $releaseRoot -DestinationPath $archivePath -CompressionLevel Optimal
    $archiveHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    Set-Content -LiteralPath $checksumPath -Value "$archiveHash  $([IO.Path]::GetFileName($archivePath))" -Encoding ascii
}
finally {
    Remove-Item -LiteralPath $stagingRoot -Recurse -Force -ErrorAction SilentlyContinue
}

[pscustomobject]@{
    Release = $releaseName
    Archive = $archivePath
    ArchiveChecksum = $checksumPath
    Sha256 = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
}