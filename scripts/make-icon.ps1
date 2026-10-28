<#
  Draws the CityTwin app icon (a cyan skyline on the app's dark background) and writes
  scripts\citytwin.ico (PNG-compressed ICO, 256 and 48 px). Run once; the shortcut uses it.
#>
Add-Type -AssemblyName System.Drawing
$out = Join-Path $PSScriptRoot 'citytwin.ico'

function New-Png([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)
  $s = $size / 256.0
  # Rounded dark tile
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $r = 56 * $s; $w = $size - 1
  $path.AddArc(0, 0, $r, $r, 180, 90); $path.AddArc($w - $r, 0, $r, $r, 270, 90)
  $path.AddArc($w - $r, $w - $r, $r, $r, 0, 90); $path.AddArc(0, $w - $r, $r, $r, 90, 90); $path.CloseFigure()
  $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 10, 17, 32))), $path)
  # Skyline (x, top, width) on a common ground line
  $cyan = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 34, 211, 238))
  $dim = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 14, 116, 144))
  $ground = 196
  foreach ($b in @(@(40, 120, 30, $dim), @(76, 80, 34, $cyan), @(116, 52, 30, $cyan), @(152, 100, 32, $dim), @(190, 132, 26, $cyan))) {
    $g.FillRectangle($b[3], [float]($b[0] * $s), [float]($b[1] * $s), [float]($b[2] * $s), [float](($ground - $b[1]) * $s))
  }
  $g.FillRectangle($cyan, [float](32 * $s), [float]($ground * $s), [float](192 * $s), [float](8 * $s))
  # Sensor dot
  $g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 34, 197, 94))), [float](176 * $s), [float](40 * $s), [float](36 * $s), [float](36 * $s))
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  return , $ms.ToArray()
}

$images = @((New-Png 256), (New-Png 48))
$fs = [System.IO.File]::Create($out)
$bw = New-Object System.IO.BinaryWriter $fs
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$images.Count)
$offset = 6 + 16 * $images.Count
foreach ($i in 0..($images.Count - 1)) {
  $dim = @(256, 48)[$i]
  $bw.Write([byte]($dim % 256)); $bw.Write([byte]($dim % 256))  # 0 means 256
  $bw.Write([byte]0); $bw.Write([byte]0); $bw.Write([uint16]1); $bw.Write([uint16]32)
  $bw.Write([uint32]$images[$i].Length); $bw.Write([uint32]$offset)
  $offset += $images[$i].Length
}
foreach ($img in $images) { $bw.Write($img) }
$bw.Close()
Write-Host "wrote $out"
