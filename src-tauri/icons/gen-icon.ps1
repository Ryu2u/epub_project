# 生成 DIB 格式多尺寸 ICO(Windows RC 编译器要求传统 BMP 数据,不认 PNG 内嵌)
param([string]$OutPath = "C:\project\epub_project\src-tauri\icons\icon.ico")

Add-Type -AssemblyName System.Drawing

function New-IconBitmap([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.Clear([System.Drawing.Color]::Transparent)
    $s = $size / 256.0
    # 背景圆
    $bgPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $bgPath.AddArc([single](16*$s), [single](16*$s), [single](224*$s), [single](224*$s), 0, 360)
    $g.FillPath((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 20, 19, 15))), $bgPath)
    $gold = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 212, 168, 87))
    $goldDark = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 154, 115, 48))
    # 左页
    $ptsL = [System.Drawing.Point[]]@(
        (New-Object System.Drawing.Point([int](60*$s), [int](80*$s))),
        (New-Object System.Drawing.Point([int](122*$s), [int](66*$s))),
        (New-Object System.Drawing.Point([int](122*$s), [int](186*$s))),
        (New-Object System.Drawing.Point([int](60*$s), [int](196*$s))))
    $bookL = New-Object System.Drawing.Drawing2D.GraphicsPath
    $bookL.AddPolygon($ptsL)
    $g.FillPath($goldDark, $bookL)
    # 右页
    $ptsR = [System.Drawing.Point[]]@(
        (New-Object System.Drawing.Point([int](134*$s), [int](66*$s))),
        (New-Object System.Drawing.Point([int](196*$s), [int](80*$s))),
        (New-Object System.Drawing.Point([int](196*$s), [int](196*$s))),
        (New-Object System.Drawing.Point([int](134*$s), [int](186*$s))))
    $bookR = New-Object System.Drawing.Drawing2D.GraphicsPath
    $bookR.AddPolygon($ptsR)
    $g.FillPath($gold, $bookR)
    # 书脊
    $g.FillRectangle((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 13, 11, 8))),
        [int](124*$s), [int](64*$s), [Math]::Max(1, [int](8*$s)), [int](126*$s))
    $g.Dispose()
    return $bmp
}

function Get-DibEntry([System.Drawing.Bitmap]$bmp) {
    $w = $bmp.Width; $h = $bmp.Height
    $rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
    $data = $bmp.LockBits($rect, 'ReadOnly', 'Format32bppArgb')
    $stride = $data.Stride
    $pixelBytes = New-Object byte[] ($stride * $h)
    [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $pixelBytes, 0, $pixelBytes.Length)
    $bmp.UnlockBits($data)

    # AND mask 行宽(4 字节对齐),全 0 = 完全不透明(alpha 已带)
    $andStride = [int]([Math]::Ceiling($w / 8.0))
    $andStride = ($andStride + 3) - (($andStride + 3) % 4)
    $andSize = $andStride * $h

    $imgSize = 40 + ($w * 4 * $h) + $andSize
    $ms = New-Object System.IO.MemoryStream($imgSize)
    $bw = New-Object System.IO.BinaryWriter($ms)
    # BITMAPINFOHEADER
    $bw.Write([uint32]40); $bw.Write([int32]$w); $bw.Write([int32]($h * 2))
    $bw.Write([uint16]1); $bw.Write([uint16]32); $bw.Write([uint32]0)
    $bw.Write([uint32]($w * 4 * $h + $andSize))
    $bw.Write([int32]0); $bw.Write([int32]0)
    $bw.Write([uint32]0); $bw.Write([uint32]0)
    # 像素:自底向上,BGRA
    for ($y = $h - 1; $y -ge 0; $y--) {
        $row = New-Object byte[] ($w * 4)
        [Array]::Copy($pixelBytes, $y * $stride, $row, 0, $w * 4)
        $bw.Write($row)
    }
    # AND mask 全 0
    $bw.Write((New-Object byte[] $andSize))
    $bw.Flush()
    return ,($ms.ToArray())
}

$sizes = @(16, 32, 48, 256)
$entries = @()
foreach ($s in $sizes) {
    $bmp = New-IconBitmap $s
    $dib = Get-DibEntry $bmp
    $entries += ,@($s, $dib)
    $bmp.Dispose()
}

# ICONDIR + 目录项 + 数据
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
[System.IO.File]::WriteAllBytes($OutPath, $out.ToArray())
Write-Host ("DIB ico written: {0} ({1} bytes)" -f $OutPath, (Get-Item $OutPath).Length)
