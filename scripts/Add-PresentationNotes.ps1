param(
    [string]$PresentationPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'artifacts\Microsoft-365-Copilot-Readiness-Customer-Presentation.pptx'),
    [string]$NotesPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'artifacts\presentation-notes.json')
)

$ErrorActionPreference = 'Stop'
$presentationPath = (Resolve-Path $PresentationPath).Path
$notes = Get-Content $NotesPath -Raw | ConvertFrom-Json
$powerPoint = $null
$presentation = $null

try {
    $powerPoint = New-Object -ComObject PowerPoint.Application
    $presentation = $powerPoint.Presentations.Open($presentationPath, $false, $false, $false)

    if ($presentation.Slides.Count -ne $notes.Count) {
        throw "Slide count $($presentation.Slides.Count) does not match notes count $($notes.Count)."
    }

    for ($index = 1; $index -le $presentation.Slides.Count; $index++) {
        $notesPage = $presentation.Slides.Item($index).NotesPage
        $body = $null
        foreach ($shape in $notesPage.Shapes.Placeholders) {
            if ($shape.PlaceholderFormat.Type -eq 2) {
                $body = $shape
                break
            }
        }
        if ($null -eq $body) {
            throw "Slide $index does not contain a notes body placeholder."
        }
        $body.TextFrame.TextRange.Text = [string]$notes[$index - 1]
    }

    $presentation.Save()
}
finally {
    if ($null -ne $presentation) { $presentation.Close() }
    if ($null -ne $powerPoint) { $powerPoint.Quit() }
}

Write-Output "Added speaker notes to $($notes.Count) slides."