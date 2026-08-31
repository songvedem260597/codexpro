param(
  [string]$OutputDirectory = (Join-Path $PSScriptRoot "..\chrome-extension\icons")
)

Add-Type -AssemblyName System.Drawing

$resolvedOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
[System.IO.Directory]::CreateDirectory($resolvedOutput) | Out-Null

function New-RoundedRectanglePath {
  param(
    [System.Drawing.RectangleF]$Bounds,
    [float]$Radius
  )

  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $diameter = $Radius * 2
  $arc = [System.Drawing.RectangleF]::new($Bounds.X, $Bounds.Y, $diameter, $diameter)
  $path.AddArc($arc, 180, 90)
  $arc.X = $Bounds.Right - $diameter
  $path.AddArc($arc, 270, 90)
  $arc.Y = $Bounds.Bottom - $diameter
  $path.AddArc($arc, 0, 90)
  $arc.X = $Bounds.X
  $path.AddArc($arc, 90, 90)
  $path.CloseFigure()
  return $path
}

foreach ($size in 16, 32, 48, 128) {
  $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.Clear([System.Drawing.Color]::Transparent)

  $inset = [Math]::Max(0.5, $size * 0.035)
  $bounds = [System.Drawing.RectangleF]::new($inset, $inset, $size - (2 * $inset), $size - (2 * $inset))
  $radius = $size * 0.26
  $backgroundPath = New-RoundedRectanglePath -Bounds $bounds -Radius $radius
  $backgroundBrush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
    $bounds,
    [System.Drawing.Color]::FromArgb(255, 106, 142, 255),
    [System.Drawing.Color]::FromArgb(255, 112, 74, 244),
    45
  )
  $graphics.FillPath($backgroundBrush, $backgroundPath)

  $scale = $size / 24.0
  $stroke = [Math]::Max(1.35, 1.9 * $scale)
  $pen = [System.Drawing.Pen]::new([System.Drawing.Color]::White, $stroke)
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

  $graphics.DrawLine($pen, 8 * $scale, 7 * $scale, 8 * $scale, 4 * $scale)
  $graphics.DrawLine($pen, 16 * $scale, 7 * $scale, 16 * $scale, 4 * $scale)
  $graphics.DrawLine($pen, 6 * $scale, 9 * $scale, 18 * $scale, 9 * $scale)
  $graphics.DrawLine($pen, 6 * $scale, 9 * $scale, 6 * $scale, 12 * $scale)
  $graphics.DrawArc($pen, 6 * $scale, 7 * $scale, 12 * $scale, 11 * $scale, 0, 180)
  $graphics.DrawLine($pen, 12 * $scale, 18 * $scale, 12 * $scale, 21 * $scale)
  $graphics.DrawLine($pen, 9 * $scale, 21 * $scale, 15 * $scale, 21 * $scale)

  $target = Join-Path $resolvedOutput "icon$size.png"
  $bitmap.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)

  $pen.Dispose()
  $backgroundBrush.Dispose()
  $backgroundPath.Dispose()
  $graphics.Dispose()
  $bitmap.Dispose()
}

Write-Host "Rendered CodexPro extension icons to $resolvedOutput"
