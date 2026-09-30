$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $dir "node_modules\electron\dist\electron.exe"
if (-not (Test-Path $exe)) { Write-Host "Electron not installed yet. Run start.bat first."; exit 1 }
$sh = New-Object -ComObject WScript.Shell
$targets = @(
  (Join-Path ([Environment]::GetFolderPath("Desktop")) "ДваРяда.lnk"),
  (Join-Path ([Environment]::GetFolderPath("Programs")) "ДваРяда.lnk")
)
foreach ($p in $targets) {
  $s = $sh.CreateShortcut($p)
  $s.TargetPath = $exe
  $s.Arguments = '"' + $dir + '"'
  $s.WorkingDirectory = $dir
  $s.IconLocation = (Join-Path $dir "icon.ico") + ",0"
  $s.Description = "DvaRyada - dual subtitle player"
  $s.Save()
}
Write-Host "Shortcut created on the Desktop and in the Start menu."
