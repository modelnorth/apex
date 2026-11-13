$Host.UI.RawUI.WindowTitle = "Apex Screen Recorder Bridge"
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   APEX SCREEN RECORDER BRIDGE (ACTIVE DESKTOP SESSION)   " -ForegroundColor Yellow
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "This process grants your AI agents direct programmatic access"
Write-Host "to record your desktop screen, browser, and terminal workflows."
Write-Host ""
Set-Location "c:\Users\DELL\Documents\antigravity\nod-sovereign"
node scripts/screen-recorder-bridge.mjs
