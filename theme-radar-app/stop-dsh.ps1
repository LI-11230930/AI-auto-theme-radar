$ErrorActionPreference='Stop'
$radarConfigFile=if($env:THEME_RADAR_CONFIG){[IO.Path]::GetFullPath($env:THEME_RADAR_CONFIG)}else{Join-Path $PSScriptRoot 'config.local.json'}
$radarDataDir='.data'
if(Test-Path -LiteralPath $radarConfigFile){$radarCfg=Get-Content -LiteralPath $radarConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json;if($radarCfg.dataDir){$radarDataDir=[string]$radarCfg.dataDir}}
if(-not [IO.Path]::IsPathRooted($radarDataDir)){$radarDataDir=Join-Path (Split-Path -Parent $radarConfigFile) $radarDataDir}
$radarRecord=Join-Path $radarDataDir 'integrations\dsh-web-process.json'
if(-not(Test-Path -LiteralPath $radarRecord)){Write-Output '没有本项目DSH入口进程记录。';return}
$radarInfo=Get-Content -LiteralPath $radarRecord -Raw -Encoding UTF8 | ConvertFrom-Json
if([IO.Path]::GetFullPath($radarInfo.appRoot) -ne [IO.Path]::GetFullPath($PSScriptRoot)){throw '进程记录不属于本项目，未停止。'}
$radarProcess=Get-CimInstance Win32_Process -Filter ('ProcessId={0}' -f [int]$radarInfo.pid) -ErrorAction SilentlyContinue
if(-not $radarProcess){Remove-Item -LiteralPath $radarRecord;Write-Output '本项目DSH入口已退出，已清理记录。';return}
$radarOwners=@(Get-NetTCPConnection -LocalPort ([int]$radarInfo.port) -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess)
if($radarProcess.CommandLine -notlike '*dsh-desktop-host*' -or -not $radarProcess.CommandLine.Contains([string]$radarInfo.patch) -or $radarProcess.CommandLine -notmatch '--profile\s+web' -or $radarOwners -notcontains [int]$radarInfo.pid){throw 'DSH进程/项目补丁/监听端口不一致，未停止其他进程。'}
$radarInfo | Add-Member -NotePropertyName stopRequested -NotePropertyValue $true -Force
[IO.File]::WriteAllText($radarRecord,($radarInfo | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
& "$env:SystemRoot\System32\taskkill.exe" /PID ([int]$radarInfo.pid) /T /F
if($LASTEXITCODE -ne 0){throw '停止本项目DSH入口失败，保留记录。'}
if(Test-Path -LiteralPath $radarRecord){Remove-Item -LiteralPath $radarRecord}
Write-Output '本项目DSH网页入口已停止；未停止其他DSH窗口或模型服务。'
