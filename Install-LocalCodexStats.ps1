param(
    [string]$TargetRoot = (Join-Path $env:USERPROFILE ".vscode\extensions")
)

$sourceRoot = $PSScriptRoot
$manifestPath = Join-Path $sourceRoot "package.json"
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$folderName = "{0}.{1}-{2}" -f $manifest.publisher, $manifest.name, $manifest.version
$targetPath = Join-Path $TargetRoot $folderName

if (Test-Path -LiteralPath $targetPath) {
    Remove-Item -LiteralPath $targetPath -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $targetPath | Out-Null
Copy-Item -Path (Join-Path $sourceRoot "*") -Destination $targetPath -Recurse -Force

Write-Host "Installed Local Codex Stats to $targetPath"
Write-Host "Reload VS Code to activate the extension."
