param(
    [string]$DocumentPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'artifacts\Microsoft-365-Copilot-Readiness-Customer-Guide.docx'),
    [string]$PdfPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'artifacts\Microsoft-365-Copilot-Readiness-Customer-Guide.pdf')
)

$ErrorActionPreference = 'Stop'
$documentPath = (Resolve-Path $DocumentPath).Path
$word = $null
$document = $null

try {
    $word = New-Object -ComObject Word.Application
    $word.Visible = $false
    $document = $word.Documents.Open($documentPath, $false, $true)
    $document.Repaginate()
    $document.ExportAsFixedFormat($PdfPath, 17)
    $pageCount = $document.ComputeStatistics(2)
    Write-Output "Rendered $pageCount Word pages without modifying the DOCX."
}
finally {
    if ($null -ne $document) { $document.Close($false) }
    if ($null -ne $word) { $word.Quit() }
}