# Build Coronelli: frontend → static → Python wheel
# Run from the repo root: .\scripts\build.ps1

$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

Write-Host "Building frontend..."
Set-Location "$root\apps\web"
$pnpm = (Get-Command pnpm -ErrorAction SilentlyContinue)?.Source ?? "$env:APPDATA\npm\pnpm.cmd"
& $pnpm build
if ($LASTEXITCODE -ne 0) { Write-Error "Frontend build failed"; exit 1 }

Write-Host "Copying frontend into Python package..."
$static = "$root\apps\api\app\static"
if (Test-Path $static) { Remove-Item -Recurse -Force $static }
Copy-Item -Recurse "$root\apps\web\dist" $static

Write-Host "Building Python wheel..."
Copy-Item "$root\README.md" "$root\apps\api\README.md"
Set-Location "$root\apps\api"
uv build
$buildResult = $LASTEXITCODE
Remove-Item -Force "$root\apps\api\README.md" -ErrorAction SilentlyContinue
if ($buildResult -ne 0) { Write-Error "Python build failed"; exit 1 }

Write-Host ""
Write-Host "Done. Wheel is at apps/api/dist/"
Write-Host "To install locally:  uv tool install apps/api/dist/coronelli-*.whl"
Write-Host "To publish:          uv publish apps/api/dist/"
