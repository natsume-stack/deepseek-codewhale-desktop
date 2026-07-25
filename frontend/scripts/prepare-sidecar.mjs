/**
 * 准备 Tauri sidecar 二进制
 *
 * 步骤:
 *   1. 检查 ../target/release/codewhale-server.exe 是否存在
 *      - 不存在则提示先运行 cargo build --release
 *   2. 复制为 src-tauri/binaries/codewhale-server-<target-triple>.exe
 *      - Windows x86_64: codewhale-server-x86_64-pc-windows-msvc.exe
 *
 * 不会主动触发 cargo build（避免每次 tauri dev 都重编译后端）。
 */
import { existsSync, mkdirSync, copyFileSync, statSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const frontendRoot = resolve(__dirname, '..')
const repoRoot = resolve(frontendRoot, '..')

// 探测 Rust target triple
function detectTargetTriple() {
  const raw = execSync('rustc -vV', { stdio: ['ignore', 'pipe', 'ignore'] }).toString()
  const m = raw.match(/host:\s*(\S+)/)
  return m ? m[1] : 'x86_64-pc-windows-msvc'
}

const triple = detectTargetTriple()
const srcExe = resolve(repoRoot, 'target', 'release', 'codewhale-server.exe')
const binDir = resolve(frontendRoot, 'src-tauri', 'binaries')
const dstExe = resolve(binDir, `codewhale-server-${triple}.exe`)

console.log(`[tauri:prep] target triple = ${triple}`)

if (!existsSync(srcExe)) {
  console.error(`[tauri:prep] 后端 release 二进制不存在: ${srcExe}`)
  console.error(`[tauri:prep] 请先在仓库根目录执行: cargo build --release`)
  process.exit(1)
}

const srcMtime = statSync(srcExe).mtimeMs
const dstExists = existsSync(dstExe)
const dstMtime = dstExists ? statSync(dstExe).mtimeMs : 0

if (dstExists && dstMtime === srcMtime) {
  console.log(`[tauri:prep] sidecar 已是最新，跳过复制`)
} else {
  if (!existsSync(binDir)) mkdirSync(binDir, { recursive: true })
  copyFileSync(srcExe, dstExe)
  console.log(`[tauri:prep] 已复制: ${srcExe}`)
  console.log(`         -> ${dstExe}`)
}

console.log(`[tauri:prep] 完成`)
