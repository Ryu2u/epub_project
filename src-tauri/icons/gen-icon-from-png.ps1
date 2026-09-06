# 从用户提供的 PNG 生成应用图标:
#   icon.png  — 256x256(高质量缩放,保留 alpha)
#   icon.ico  — 16/32/48/256 传统 DIB 格式(RC 编译器要求,不认 PNG 内嵌)
param(
    [string]$Source = "C:\Users\MI\Downloads\ChatGPT Image 2026年9月6日 18_25_50.png",
    [string]$OutDir = "C:\project\epub_project\src-tauri\icons"
)

Add-Type -AssemblyName System.Drawing

$src = [System.Drawing.Image]::FromFile($Source)
Write-Host ("source: {0}x{1}" -f $src.Width, $src.Height)

function New-Scaled([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = 'HighQualityBicubic'
    $g.SmoothingMode = 'AntiAlias'
    $g.PixelOffsetMode = 'HighQuality'
    $g.DrawImage($src, 0, 0, $size, $size)
    $g.Dispose()
    return $bmp
}

# icon.png:256x256
$png256 = New-Scaled 256
$png256.Save((Join-Path $OutDir "icon.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$png256.Dispose()

# DIB ICO(多尺寸)
function Get-DibEntry([System.Drawing.Bitmap]$bmp) {
    $w = $bmp.Width; $h = $bmp.Height
    $rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
    $data = $bmp.LockBits($rect, 'ReadOnly', 'Format32bppArgb')
    $stride = $data.Stride
    $pixelBytes = New-Object byte[] ($stride * $h)
    [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $pixelBytes, 0, $pixelBytes.Length)
    $bmp.UnlockBits($data)

    $andStride = [int]([Math]::Ceiling($w / 8.0))
    $andStride = ($andStride + 3) - (($andStride + 3) % 4)
    $andSize = $andStride * $h

    $imgSize = 40 + ($w * 4 * $h) + $andSize
    $ms = New-Object System.IO.MemoryStream($imgSize)
    $bw = New-Object System.IO.BinaryWriter($ms)
    $bw.Write([uint32]40); $bw.Write([int32]$w); $bw.Write([int32]($h * 2))
    $bw.Write([uint16]1); $bw.Write([uint16]32); $bw.Write([uint32]0)
    $bw.Write([uint32]($w * 4 * $h + $andSize))
    $bw.Write([int32]0); $bw.Write([int32]0)
    $bw.Write([uint32]0); $bw.Write([uint32]0)
    for ($y = $h - 1; $y -ge 0; $y--) {
        $row = New-Object byte[] ($w * 4)
        [Array]::Copy($pixelBytes, $y * $stride, $row, 0, $w * 4)
        $bw.Write($row)
    }
    $bw.Write((New-Object byte[] $andSize))
    $bw.Flush()
    return ,($ms.ToArray())
}

$sizes = @(16, 32, 48, 256)
$entries = @()
foreach ($s in $sizes) {
    $bmp = New-Scaled $s
    $dib = Get-DibEntry $bmp
    $entries += , @($s, $dib)
    $bmp.Dispose()
}
$src.Dispose()

$out = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($out)
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$entries.Count)
$offset = 6 + 16 * $entries.Count
foreach ($e in $entries) {
    $s = $e[0]; $dib = $e[1]
    $dim = if ($s -ge 256) { 0 } else { $s }
    $bw.Write([byte]$dim); $bw.Write([byte]$dim); $bw.Write([byte]0); $bw.Write([byte]0)
    $bw.Write([uint16]1); $bw.Write([uint16]32)
    $bw.Write([uint32]$dib.Length); $bw.Write([uint32]$offset)
    $offset += $dib.Length
}
foreach ($e in $entries) { $bw.Write([byte[]]$e[1]) }
$bw.Flush()
[System.IO.File]::WriteAllBytes((Join-Path $OutDir "icon.ico"), $out.ToArray())
Write-Host ("icon.png(256) + icon.ico({0} bytes, 16/32/48/256) written to {1}" -f (Get-Item (Join-Path $OutDir "icon.ico")).Length, $OutDir)
