# CodeWhale Server — Windows 启动脚本
# 用法:
#   首次: .\start.ps1 -Build   (release 编译后运行)
#   常用: .\start.ps1           (debug 运行)
param(
    [switch]$Build,
    [switch]$Release,
    [int]$Port = 0
)

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    Write-Error "未检测到 cargo。请先安装 Rust: https://www.rust-lang.org/tools/install"
    exit 1
}

if ($Build) {
    Write-Host "==> 编译 release 二进制..." -ForegroundColor Cyan
    cargo build --release
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$env:RUST_LOG = if ($env:RUST_LOG) { $env:RUST_LOG } else { "info,codewhale_server=debug" }
if ($Port -gt 0) { $env:CODEWHALE_SERVER__PORT = "$Port" }

if ($Release) {
    Write-Host "==> 运行 release 二进制..." -ForegroundColor Green
    .\target\release\codewhale-server.exe
} else {
    Write-Host "==> cargo run (debug)..." -ForegroundColor Green
    cargo run
}
