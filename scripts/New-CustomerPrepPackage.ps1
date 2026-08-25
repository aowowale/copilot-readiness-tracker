[CmdletBinding()]
param(
    [string]$OutputDirectory = (Join-Path (Split-Path -Parent $PSScriptRoot) 'artifacts')
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$approvedFiles = @(
    'index.html'
    'README.md'
    'CUSTOMER-DEPLOYMENT.md'
    'CLOUD-SYNC-SETUP.md'
    '.nojekyll'
)

$missingFiles = $approvedFiles | Where-Object {
    -not (Test-Path -LiteralPath (Join-Path $projectRoot $_) -PathType Leaf)
}

if ($missingFiles) {
    throw "Required package files are missing: $($missingFiles -join ', ')"
}

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$stagingDirectory = Join-Path ([System.IO.Path]::GetTempPath()) "SAM-customer-prep-$timestamp"
$archivePath = Join-Path $OutputDirectory "SAM-customer-prep-$timestamp.zip"

try {
    New-Item -ItemType Directory -Path $stagingDirectory -Force | Out-Null

    foreach ($file in $approvedFiles) {
        Copy-Item -LiteralPath (Join-Path $projectRoot $file) -Destination $stagingDirectory
    }

    $manifest = @(
        'SAM Customer Preparation Package'
        "Created (UTC): $([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ'))"
        'Purpose: Demo and pre-deployment review only; no live tenant connector is included.'
        ''
        'Approved files:'
        ($approvedFiles | ForEach-Object { "- $_" })
        '- PACKAGE-MANIFEST.txt'
        ''
        'Security statement:'
        '- No credentials, tokens, certificates, tenant configuration, or Azure CLI profiles are included.'
        '- index.html contains sample governance records and is not evidence from a customer tenant.'
        '- CLOUD-SYNC-SETUP.md describes optional program-task sync only.'
    )

    Set-Content -LiteralPath (Join-Path $stagingDirectory 'PACKAGE-MANIFEST.txt') -Value $manifest -Encoding UTF8
    $packageFiles = Get-ChildItem -LiteralPath $stagingDirectory -File -Force |
        Select-Object -ExpandProperty FullName
    Compress-Archive -LiteralPath $packageFiles -DestinationPath $archivePath -CompressionLevel Optimal
}
finally {
    if (Test-Path -LiteralPath $stagingDirectory) {
        Remove-Item -LiteralPath $stagingDirectory -Recurse -Force
    }
}

Write-Output $archivePath
