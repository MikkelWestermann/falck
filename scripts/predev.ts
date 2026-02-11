import { $ } from "bun"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { copyBinaryToSidecarFolder, getCurrentSidecar, windowsify } from "./utils"

function resolveTarget() {
  if (Bun.env.TAURI_ENV_TARGET_TRIPLE) return Bun.env.TAURI_ENV_TARGET_TRIPLE
  if (Bun.env.RUST_TARGET) return Bun.env.RUST_TARGET

  const platform = process.platform
  const arch = process.arch

  if (platform === "darwin") {
    return arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"
  }
  if (platform === "win32") {
    return "x86_64-pc-windows-msvc"
  }
  if (platform === "linux") {
    return arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu"
  }

  throw new Error(`Unsupported platform/arch: ${platform}/${arch}`)
}

const target = resolveTarget()
const sidecarConfig = getCurrentSidecar(target)
const dest = windowsify(`src-tauri/sidecars/opencode-cli-${target}`)
const opencodeSidecarDest = windowsify(`src-tauri/sidecars/opencode-sidecar-${target}`)
let cliReady = false

function parseVersion(value: string) {
  const parts = value.split(".").map((part) => Number(part.replace(/[^0-9]/g, "")))
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0]
}

function compareVersion(a: string, b: string) {
  const [aMaj, aMin, aPatch] = parseVersion(a)
  const [bMaj, bMin, bPatch] = parseVersion(b)
  if (aMaj !== bMaj) return aMaj - bMaj
  if (aMin !== bMin) return aMin - bMin
  return aPatch - bPatch
}

function satisfiesCaret(version: string, base: string) {
  const [vMaj] = parseVersion(version)
  const [bMaj] = parseVersion(base)
  if (vMaj !== bMaj) return false
  return compareVersion(version, base) >= 0
}

if (fs.existsSync(dest)) {
  console.log(`Using existing OpenCode CLI at ${dest}`)
  cliReady = true
}

const envCli = Bun.env.OPENCODE_CLI_PATH
if (envCli && fs.existsSync(envCli)) {
  await copyBinaryToSidecarFolder(envCli, target)
  cliReady = true
}

const repoRoot = path.resolve(process.cwd(), "..", "opencode")
const repoCliRoot = path.join(repoRoot, "packages", "opencode")
const repoBinary = windowsify(
  path.join(repoCliRoot, "dist", sidecarConfig.ocBinary, "bin", "opencode"),
)

async function ensureRepoDeps() {
  const pluginPath = path.join(
    repoCliRoot,
    "node_modules",
    "@opentui",
    "solid",
    "scripts",
    "solid-plugin",
  )
  if (fs.existsSync(pluginPath)) {
    return
  }

  const rootPluginPath = path.join(
    repoRoot,
    "node_modules",
    "@opentui",
    "solid",
    "scripts",
    "solid-plugin",
  )

  if (!fs.existsSync(rootPluginPath)) {
    await $`bun install`.cwd(repoRoot)
  }

  if (fs.existsSync(pluginPath)) {
    return
  }

  const rootNodeModules = path.join(repoRoot, "node_modules")
  const repoNodeModules = path.join(repoCliRoot, "node_modules")

  if (!fs.existsSync(repoNodeModules)) {
    const type = process.platform === "win32" ? "junction" : "dir"
    fs.symlinkSync(rootNodeModules, repoNodeModules, type)
    return
  }

  const rootOpentui = path.join(rootNodeModules, "@opentui")
  const repoOpentui = path.join(repoNodeModules, "@opentui")
  if (fs.existsSync(rootOpentui)) {
    fs.mkdirSync(repoOpentui, { recursive: true })
    const links = ["solid", "core"]
    for (const name of links) {
      const source = path.join(rootOpentui, name)
      const dest = path.join(repoOpentui, name)
      if (!fs.existsSync(dest) && fs.existsSync(source)) {
        const type = process.platform === "win32" ? "junction" : "dir"
        fs.symlinkSync(source, dest, type)
      }
    }
  }

  const rootCore = path.join(rootNodeModules, "@opentui", "core")
  const repoCore = path.join(repoNodeModules, "@opentui", "core")
  if (!fs.existsSync(repoCore) && fs.existsSync(rootCore)) {
    fs.mkdirSync(path.join(repoNodeModules, "@opentui"), { recursive: true })
    const type = process.platform === "win32" ? "junction" : "dir"
    fs.symlinkSync(rootCore, repoCore, type)
  }
}

async function buildFromRepo() {
  await ensureRepoDeps()
  await $`bun run --cwd ${repoCliRoot} build --single`

  if (!fs.existsSync(repoBinary)) {
    throw new Error(`OpenCode repo build missing binary at ${repoBinary}`)
  }

  await copyBinaryToSidecarFolder(repoBinary, target)
  cliReady = true
}

if (!cliReady) {
  const repoExists = fs.existsSync(path.join(repoCliRoot, "package.json"))
  let repoOk = repoExists
  if (repoExists) {
    const repoPkgPath = path.join(repoRoot, "package.json")
    if (fs.existsSync(repoPkgPath)) {
      const repoPkg = JSON.parse(fs.readFileSync(repoPkgPath, "utf8")) as {
        packageManager?: string
      }
      const manager = repoPkg.packageManager ?? ""
      const match = manager.match(/bun@([0-9]+\\.[0-9]+\\.[0-9]+)/)
      if (match) {
        const required = match[1]!
        if (!satisfiesCaret(process.versions.bun, required)) {
          console.warn(
            `Skipping opencode repo build: requires bun@^${required}, current bun@${process.versions.bun}`,
          )
          repoOk = false
        }
      }
    }
  }

  if (Bun.env.OPENCODE_SOURCE === "repo") {
    if (!repoExists) {
      throw new Error("OPENCODE_SOURCE=repo set but opencode repo not found")
    }
    if (!repoOk) {
      throw new Error("OPENCODE_SOURCE=repo set but bun version does not satisfy opencode")
    }
    await buildFromRepo()
  }

  if (
    repoExists &&
    repoOk &&
    Bun.env.OPENCODE_SOURCE !== "registry" &&
    Bun.env.OPENCODE_SOURCE !== "release"
  ) {
    try {
      await buildFromRepo()
    } catch (err) {
      console.warn("OpenCode repo build failed, falling back to release download.", err)
    }
  }
}

if (!cliReady) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "falck-opencode-"))
  const version = Bun.env.OPENCODE_VERSION
  const releaseBase = version
    ? `https://github.com/opencode-ai/opencode/releases/download/v${version}`
    : "https://github.com/opencode-ai/opencode/releases/latest/download"
  const archiveName = `${sidecarConfig.ocBinary}.${sidecarConfig.assetExt}`
  const archiveUrl = `${releaseBase}/${archiveName}`
  const archivePath = path.join(tempDir, archiveName)

  await $`curl -L --fail ${archiveUrl} -o ${archivePath}`

  if (sidecarConfig.assetExt === "zip") {
    if (process.platform === "win32") {
      await $`powershell -Command "Expand-Archive -Force -Path '${archivePath}' -DestinationPath '${tempDir}'"`
    } else {
      await $`unzip -q ${archivePath} -d ${tempDir}`
    }
  } else {
    await $`tar -xzf ${archivePath} -C ${tempDir}`
  }

  const binName = process.platform === "win32" ? "opencode.exe" : "opencode"
  const downloadedBinary = path.join(tempDir, binName)

  if (!fs.existsSync(downloadedBinary)) {
    throw new Error(`Downloaded archive missing ${binName} from ${archiveUrl}`)
  }

  await copyBinaryToSidecarFolder(downloadedBinary, target)
  if (process.platform !== "win32") {
    const dest = windowsify(`src-tauri/sidecars/opencode-cli-${target}`)
    await $`chmod +x ${dest}`
  }
  cliReady = true
}

async function ensureOpencodeSidecar() {
  if (fs.existsSync(opencodeSidecarDest)) {
    console.log(`Using existing OpenCode sidecar at ${opencodeSidecarDest}`)
    return
  }

  const sidecarRoot = path.resolve(process.cwd(), "sidecar-opencode")
  const pkgPath = path.join(sidecarRoot, "package.json")
  if (!fs.existsSync(pkgPath)) {
    throw new Error("sidecar-opencode package not found")
  }

  const nodeModules = path.join(sidecarRoot, "node_modules")
  if (!fs.existsSync(nodeModules)) {
    await $`bun install`.cwd(sidecarRoot)
  }

  await $`bun run build`.cwd(sidecarRoot)

  const built = windowsify(path.join(sidecarRoot, "my-sidecar"))
  if (!fs.existsSync(built)) {
    throw new Error(`OpenCode sidecar build missing binary at ${built}`)
  }

  await $`mkdir -p src-tauri/sidecars`
  await $`cp ${built} ${opencodeSidecarDest}`
  if (process.platform !== "win32") {
    await $`chmod +x ${opencodeSidecarDest}`
  }
  console.log(`Copied ${built} to ${opencodeSidecarDest}`)
}

await ensureOpencodeSidecar()
