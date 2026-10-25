param([switch]$PrepareOnly,[switch]$NoOpen,[ValidateRange(1024,65535)][int]$Port=8789)
$ErrorActionPreference='Stop'
$radarCandidates=@($env:THEME_RADAR_NODE)
$radarOnPath=Get-Command node -ErrorAction SilentlyContinue
if($radarOnPath){$radarCandidates+=$radarOnPath.Source}
$radarCandidates+=@((Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'),(Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'))
$radarNode=$null
foreach($candidate in $radarCandidates){if(-not $candidate -or -not(Test-Path -LiteralPath $candidate)){continue};$radarVersion=(& $candidate -e 'process.stdout.write(process.versions.node)');if($LASTEXITCODE -eq 0 -and [version]$radarVersion -ge [version]'24.14.0' -and [version]$radarVersion -lt [version]'25.0.0'){$radarNode=$candidate;break}}
if(-not $radarNode){throw '需要Node24.14+的24.x；可用THEME_RADAR_NODE指定已有node.exe。'}
$radarArgs=@((Join-Path $PSScriptRoot 'tools\launch-dsh.ts'))
if($PrepareOnly){$radarArgs+='--prepare'}
if($NoOpen){$radarArgs+='--no-open'}
$radarArgs+=@('--port',[string]$Port)
& $radarNode @radarArgs
if($LASTEXITCODE -ne 0){throw ('DSH入口未完成，退出码 '+$LASTEXITCODE)}
