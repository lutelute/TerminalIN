# scripts/install-win.ps1 — TiN を Windows へ自動インストール (初回導入用)
#
# GitHub の最新リリースから、実行マシンの arch (x64 / arm64) に合う NSIS インストーラを
# ダウンロードして起動する。以降のバージョンアップはアプリ内蔵の自動アップデートが処理する。
#
# 使い方 (PowerShell):
#   irm https://raw.githubusercontent.com/lutelute/TerminalIN/main/scripts/install-win.ps1 | iex
# もしくはリポジトリ内から:
#   powershell -ExecutionPolicy Bypass -File scripts\install-win.ps1
#
# オプション:
#   -Silent   無人インストール (既定ディレクトリへ /S サイレント実行)
#   -Repo     owner/repo を上書き (既定: lutelute/TerminalIN)

param(
  [switch]$Silent,
  [string]$Repo = 'lutelute/TerminalIN'
)

$ErrorActionPreference = 'Stop'

function Get-TinArch {
  # PROCESSOR_ARCHITECTURE は WOW でも正しく出る環境変数を優先
  $a = $env:PROCESSOR_ARCHITECTURE
  if ($env:PROCESSOR_ARCHITEW6432) { $a = $env:PROCESSOR_ARCHITEW6432 }
  switch -Wildcard ($a) {
    'ARM64' { 'arm64' }
    'AMD64' { 'x64' }
    'x86'   { 'x64' }   # 32bit PowerShell on 64bit OS → x64 を入れる
    default { 'x64' }
  }
}

$arch = Get-TinArch
Write-Host "[TiN] 検出 arch: $arch"
Write-Host "[TiN] 最新リリースを取得中... ($Repo)"

$headers = @{ 'User-Agent' = 'TiN-Installer'; 'Accept' = 'application/vnd.github+json' }
$rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers $headers

# arch 一致の Setup .exe を選ぶ (例: TiN-Setup-1.14.0-arm64.exe)
$asset = $rel.assets | Where-Object { $_.name -match "Setup.*$arch.*\.exe$" } | Select-Object -First 1
if (-not $asset) {
  # arch サフィックス無しの単一インストーラにもフォールバック
  $asset = $rel.assets | Where-Object { $_.name -match 'Setup.*\.exe$' } | Select-Object -First 1
}
if (-not $asset) { throw "リリース $($rel.tag_name) に Windows インストーラ(.exe)が見つかりません。" }

$dest = Join-Path $env:TEMP $asset.name
Write-Host "[TiN] ダウンロード: $($asset.name) ($([math]::Round($asset.size/1MB,1)) MB)"
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $dest -Headers @{ 'User-Agent' = 'TiN-Installer' }

Write-Host "[TiN] インストーラを起動: $dest"
if ($Silent) {
  Start-Process -FilePath $dest -ArgumentList '/S' -Wait
  Write-Host "[TiN] サイレントインストール完了。スタートメニュー/デスクトップの TiN から起動できます。"
} else {
  Start-Process -FilePath $dest
  Write-Host "[TiN] インストーラを開きました。画面の指示に従ってください。"
}
