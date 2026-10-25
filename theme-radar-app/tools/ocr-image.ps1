# Run with Windows PowerShell 5.1, not PowerShell 7; WinRT projection is required.
param(
  [Parameter(Mandatory=$true)][string]$ImagePath,
  [string]$Language = 'zh-Hans-CN'
)
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$taskOcrTotal = [Diagnostics.Stopwatch]::StartNew()
$taskOcrStream = $null
$taskOcrBitmap = $null
$taskOcrErrorCode = 'OCR_UNAVAILABLE'

function Complete-OcrJson($Value, [int]$ExitCode) {
  $taskOcrJson = ConvertTo-Json -InputObject $Value -Depth 8 -Compress
  [Console]::Out.WriteLine($taskOcrJson)
  exit $ExitCode
}

try {
  if ($PSVersionTable.PSEdition -ne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5) {
    $taskOcrErrorCode = 'WINDOWS_POWERSHELL_51_REQUIRED'; throw $taskOcrErrorCode
  }
  if ($Language -ne 'zh-Hans-CN') { $taskOcrErrorCode = 'UNSUPPORTED_LANGUAGE'; throw $taskOcrErrorCode }
  $taskOcrErrorCode = 'INVALID_IMAGE_PATH'
  if (-not [IO.Path]::IsPathRooted($ImagePath) -or $ImagePath.StartsWith('\\') -or $ImagePath -notmatch '^[A-Za-z]:\\') { throw $taskOcrErrorCode }
  $taskOcrFileInfo = Get-Item -LiteralPath $ImagePath -Force
  if ($taskOcrFileInfo.PSIsContainer -or $taskOcrFileInfo.Extension -ine '.png' -or $taskOcrFileInfo.Length -lt 8 -or $taskOcrFileInfo.Length -gt 4194304 -or ($taskOcrFileInfo.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw $taskOcrErrorCode }
  $taskOcrErrorCode = 'INVALID_PNG'
  $taskOcrHeaderStream = [IO.File]::OpenRead($taskOcrFileInfo.FullName)
  try {
    $taskOcrHeader = New-Object byte[] 8
    if ($taskOcrHeaderStream.Read($taskOcrHeader, 0, 8) -ne 8 -or [BitConverter]::ToString($taskOcrHeader) -ne '89-50-4E-47-0D-0A-1A-0A') { throw $taskOcrErrorCode }
  } finally { $taskOcrHeaderStream.Dispose() }

  $taskOcrErrorCode = 'OCR_UNAVAILABLE'
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime] | Out-Null
  [Windows.Globalization.Language, Windows.Globalization, ContentType=WindowsRuntime] | Out-Null
  [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime] | Out-Null
  [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime] | Out-Null
  [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime] | Out-Null
  [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType=WindowsRuntime] | Out-Null
  $taskOcrAsTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  } | Select-Object -First 1
  if ($null -eq $taskOcrAsTask) { throw $taskOcrErrorCode }
  function Invoke-OcrAsyncOperation($Operation, [Type]$ResultType) {
    $taskOcrTask = $taskOcrAsTask.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
    if (-not $taskOcrTask.Wait(10000)) { $script:taskOcrErrorCode = 'OCR_TIMEOUT'; throw 'OCR_TIMEOUT' }
    return $taskOcrTask.Result
  }
  $taskOcrLanguage = [Windows.Globalization.Language]::new($Language)
  $taskOcrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($taskOcrLanguage)
  if ($null -eq $taskOcrEngine) { $taskOcrErrorCode = 'LANGUAGE_NOT_INSTALLED'; throw $taskOcrErrorCode }
  $taskOcrInitMilliseconds = $taskOcrTotal.ElapsedMilliseconds

  $taskOcrErrorCode = 'IMAGE_DECODE_FAILED'
  $taskOcrDecodeClock = [Diagnostics.Stopwatch]::StartNew()
  $taskOcrFile = Invoke-OcrAsyncOperation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($taskOcrFileInfo.FullName)) ([Windows.Storage.StorageFile])
  $taskOcrStream = Invoke-OcrAsyncOperation ($taskOcrFile.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $taskOcrDecoder = Invoke-OcrAsyncOperation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($taskOcrStream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $taskOcrWidth = [int]$taskOcrDecoder.PixelWidth
  $taskOcrHeight = [int]$taskOcrDecoder.PixelHeight
  $taskOcrErrorCode = 'IMAGE_DIMENSION_LIMIT'
  if ($taskOcrWidth -lt 1 -or $taskOcrHeight -lt 1 -or $taskOcrWidth -gt 10000 -or $taskOcrHeight -gt 10000 -or ([long]$taskOcrWidth * [long]$taskOcrHeight) -gt 16000000) { throw $taskOcrErrorCode }
  $taskOcrErrorCode = 'IMAGE_DECODE_FAILED'
  $taskOcrBitmap = Invoke-OcrAsyncOperation ($taskOcrDecoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $taskOcrDecodeMilliseconds = $taskOcrDecodeClock.ElapsedMilliseconds
  $taskOcrErrorCode = 'OCR_RECOGNITION_FAILED'
  $taskOcrRecognizeClock = [Diagnostics.Stopwatch]::StartNew()
  $taskOcrResult = Invoke-OcrAsyncOperation ($taskOcrEngine.RecognizeAsync($taskOcrBitmap)) ([Windows.Media.Ocr.OcrResult])
  $taskOcrRecognizeMilliseconds = $taskOcrRecognizeClock.ElapsedMilliseconds
  $taskOcrLines = @($taskOcrResult.Lines | ForEach-Object {
    [PSCustomObject]@{
      text = $_.Text
      words = @($_.Words | ForEach-Object {
        [PSCustomObject]@{
          text = $_.Text
          box = [PSCustomObject]@{
            x=[double]$_.BoundingRect.X; y=[double]$_.BoundingRect.Y;
            width=[double]$_.BoundingRect.Width; height=[double]$_.BoundingRect.Height
          }
        }
      })
    }
  })
  $taskOcrBitmap.Dispose(); $taskOcrBitmap = $null
  $taskOcrStream.Dispose(); $taskOcrStream = $null
  Complete-OcrJson ([PSCustomObject]@{
    ok=$true; engine='Windows.Media.Ocr'; language=$Language;
    width=$taskOcrWidth; height=$taskOcrHeight; text=$taskOcrResult.Text; lines=$taskOcrLines;
    timings=[PSCustomObject]@{
      initializationMilliseconds=$taskOcrInitMilliseconds; decodeMilliseconds=$taskOcrDecodeMilliseconds;
      recognitionMilliseconds=$taskOcrRecognizeMilliseconds; totalMilliseconds=$taskOcrTotal.ElapsedMilliseconds
    }
  }) 0
} catch {
  if ($null -ne $taskOcrBitmap) { $taskOcrBitmap.Dispose() }
  if ($null -ne $taskOcrStream) { $taskOcrStream.Dispose() }
  Complete-OcrJson ([PSCustomObject]@{ok=$false; code=$taskOcrErrorCode}) 1
}
