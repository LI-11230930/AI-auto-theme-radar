param([ValidateSet('check','configure','serve')][string]$Mode='check',[int]$Port=8767)
$ErrorActionPreference='Stop'
$radarCandidates=@($env:THEME_RADAR_NODE)
$radarPathNode=Get-Command node -ErrorAction SilentlyContinue
if($radarPathNode){$radarCandidates+=$radarPathNode.Source}
$radarCandidates+=@((Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'),(Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'))
$radarNode=$null
foreach($candidate in $radarCandidates){if(-not $candidate -or -not(Test-Path -LiteralPath $candidate)){continue};$radarVersion=(& $candidate -e 'process.stdout.write(process.versions.node)');if($LASTEXITCODE -eq 0 -and [version]$radarVersion -ge [version]'24.14.0' -and [version]$radarVersion -lt [version]'25.0.0'){$radarNode=$candidate;break}}
if(-not $radarNode){throw '请使用Node24.14+的24.x，或将THEME_RADAR_NODE指向现有node.exe；脚本不会下载或安装运行时。'}
Push-Location $PSScriptRoot
try{
 if($Mode -eq 'configure'){
  & $radarNode tools/bootstrap.ts configure
 }elseif($Mode -eq 'serve'){
  if($Port -lt 1024 -or $Port -gt 65535){throw '端口范围为1024至65535。'}
  & $radarNode src/cli.ts serve $Port
 }else{
  New-Item -ItemType Directory -Path (Join-Path $PSScriptRoot '..\.runtime') -Force | Out-Null
  & $radarNode tools/check-installation.ts
 }
 if($LASTEXITCODE -ne 0){throw ('命令未通过，退出码 '+$LASTEXITCODE)}
}finally{Pop-Location}
