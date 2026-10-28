param([string]$ConfigPath=$env:THEME_RADAR_CONFIG,[ValidateRange(1,30)][int]$RetentionDays=7)
$ErrorActionPreference='Stop'
if ($env:OS -ne 'Windows_NT') { throw '此工具使用Windows当前用户加密。其他系统请设置GITHUB_TOKEN环境变量。' }
if (-not $ConfigPath) { $ConfigPath=Join-Path (Split-Path $PSScriptRoot -Parent) 'config.local.json' }
$radarConfigPath=[IO.Path]::GetFullPath($ConfigPath)
if (-not (Test-Path -LiteralPath $radarConfigPath -PathType Leaf)) { throw '请先运行bootstrap configure创建自己的配置。' }
$radarConfig=Get-Content -LiteralPath $radarConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$radarDataValue=if($radarConfig.dataDir){[string]$radarConfig.dataDir}else{'.data'}
$radarDataPath=if([IO.Path]::IsPathRooted($radarDataValue)){[IO.Path]::GetFullPath($radarDataValue)}else{[IO.Path]::GetFullPath((Join-Path (Split-Path $radarConfigPath -Parent) $radarDataValue))}
$radarCredentialDirectory=Join-Path $radarDataPath 'credentials'
$radarCredentialPath=Join-Path $radarCredentialDirectory 'github.dpapi.json'
Write-Host '只读取公开仓库，请使用GitHub细粒度令牌的Public repositories (read-only)权限。'
Write-Host '本工具不联网；本机保管期限与GitHub服务器实际到期时间分别计算。不要把令牌发到聊天或提交Git。'
$radarSecure=Read-Host '粘贴完整令牌（隐藏输入，直接回车取消）' -AsSecureString
$radarBstr=[IntPtr]::Zero
try {
    $radarBstr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($radarSecure)
    $radarValue=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($radarBstr).Trim().Trim([char]0xFEFF).Trim()
    if (-not $radarValue) { Write-Host '已取消，未改动配置或凭据。'; return }
    if ($radarValue.Length -ge 2 -and (($radarValue[0] -eq [char]34 -and $radarValue[-1] -eq [char]34) -or ($radarValue[0] -eq [char]39 -and $radarValue[-1] -eq [char]39))) { $radarValue=$radarValue.Substring(1,$radarValue.Length-2).Trim() }
    if ($radarValue -cnotmatch '^github_pat_[A-Za-z0-9_]{20,255}$') { throw '需要完整的细粒度令牌值，不包含Bearer或请求头；未保存。' }
    $radarNormalized=ConvertTo-SecureString $radarValue -AsPlainText -Force
    try { $radarEncrypted=ConvertFrom-SecureString -SecureString $radarNormalized } finally { $radarNormalized.Dispose() }
    $radarValue=$null
    $radarCreated=[DateTimeOffset]::UtcNow
    $radarRecord=@{version=1;createdAt=$radarCreated.ToString('o');expiresAt=$radarCreated.AddDays($RetentionDays).ToString('o');encryptedToken=$radarEncrypted}
    New-Item -ItemType Directory -Path $radarCredentialDirectory -Force | Out-Null
    $radarBackup=Join-Path $radarDataPath ('configuration-before-token-'+$radarCreated.ToString('yyyyMMddHHmmssfff')+'.json')
    Copy-Item -LiteralPath $radarConfigPath -Destination $radarBackup
    if (Test-Path -LiteralPath $radarCredentialPath) { Copy-Item -LiteralPath $radarCredentialPath -Destination (Join-Path $radarCredentialDirectory ('github-before-'+$radarCreated.ToString('yyyyMMddHHmmssfff')+'.dpapi.json')) }
    $radarRecord | ConvertTo-Json | Set-Content -LiteralPath $radarCredentialPath -Encoding UTF8
    if (-not $radarConfig.github) { $radarConfig | Add-Member -MemberType NoteProperty -Name github -Value ([pscustomobject]@{}) -Force }
    $radarConfig.github | Add-Member -MemberType NoteProperty -Name credentialFile -Value $radarCredentialPath -Force
    [IO.File]::WriteAllText($radarConfigPath,($radarConfig | ConvertTo-Json -Depth 30),(New-Object Text.UTF8Encoding($false)))
    Write-Host ('已用Windows当前用户加密保存。本机保管期限：'+$radarCreated.AddDays($RetentionDays).ToLocalTime().ToString('yyyy-MM-dd HH:mm:ss'))
    Write-Host '重启主题雷达服务并重连MCP后加载新值；尚未验证服务器权限或实际有效期。'
} finally {
    $radarValue=$null
    if ($radarBstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($radarBstr) }
    $radarSecure.Dispose()
}
