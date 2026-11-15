$ErrorActionPreference = 'Stop'
Set-Location 'C:\Users\serge\Documents\ChatGPT\NasaSpaceHacks\team-integration'

function Invoke-GitStep {
    param([string[]] $GitArguments)
    & git @GitArguments
    if ($LASTEXITCODE -ne 0) { throw "git $GitArguments failed. Resolve the problem before continuing." }
}

if ((git branch --show-current) -ne 'solar-integration') {
    throw 'Expected solar-integration. Refusing to commit on another branch.'
}
Invoke-GitStep -GitArguments @('diff', '--check')
npm.cmd test
if ($LASTEXITCODE -ne 0) { throw 'Tests failed; nothing was committed.' }
npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'Build failed; nothing was committed.' }
Invoke-GitStep -GitArguments @('add', '--all')
Invoke-GitStep -GitArguments @('commit', '-m', 'feat(mission): add battery and resilient landing analysis')
Write-Host 'Committed locally on solar-integration. No fetch, merge, push or PR was performed.'
