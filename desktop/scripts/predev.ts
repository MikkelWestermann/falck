import { $ } from "bun"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { copyBinaryToSidecarFolder, getCurrentSidecar, windowsify } from "./utils"

function resolveTarget() {
  const envKeys = [
    "TAURI_ENV_TARGET_TRIPLE",
    "TAURI_ENV_TARGET",
    "TAURI_TARGET",
    "CARGO_BUILD_TARGET",
    "TARGET",
    "RUST_TARGET",
  ]
  for (const key of envKeys) {
    const value = Bun.env[key]
    if (value) return value
  }

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

type ReleaseAsset = { name: string; browser_download_url: string }
type ReleaseInfo = {
  assets: ReleaseAsset[]
  tag_name?: string
  prerelease?: boolean
  draft?: boolean
}

function archiveExt(name: string) {
  const lower = name.toLowerCase()
  if (lower.endsWith(".zip")) return "zip"
  if (lower.endsWith(".tar.gz")) return "tar.gz"
  if (lower.endsWith(".tgz")) return "tar.gz"
  return null
}

function isArchiveAsset(name: string) {
  return archiveExt(name) !== null
}

function targetTerms(target: string) {
  const lower = target.toLowerCase()
  const isMac = lower.includes("apple-darwin")
  const isWindows = lower.includes("windows")
  const isLinux = lower.includes("linux")
  const isArm64 = lower.includes("aarch64") || lower.includes("arm64")
  const isX64 = lower.includes("x86_64") || lower.includes("amd64")

  const platformTerms = isMac
    ? ["darwin", "macos", "osx", "mac"]
    : isWindows
    ? ["windows", "win"]
    : isLinux
    ? ["linux"]
    : []
  const archTerms = isArm64 ? ["arm64", "aarch64"] : isX64 ? ["x64", "x86_64", "amd64"] : []

  return { platformTerms, archTerms, isMac, isWindows }
}

function isDownloadAsset(name: string, target: string) {
  const lower = name.toLowerCase()
  if (
    lower.endsWith(".sig") ||
    lower.endsWith(".sha256") ||
    lower.endsWith(".sha512") ||
    lower.endsWith(".blockmap")
  ) {
    return false
  }

  if (isArchiveAsset(lower)) return true
  if (targetTerms(target).isWindows && lower.endsWith(".exe")) return true
  return false
}

function pickReleaseAsset(
  assets: ReleaseAsset[],
  target: string,
  preferredBase: string,
  preferredExt: string,
) {
  const { platformTerms, archTerms, isMac } = targetTerms(target)
  const lowerPreferred = preferredBase.toLowerCase()

  const baseFilter = (asset: ReleaseAsset) => {
    const lower = asset.name.toLowerCase()
    if (!isDownloadAsset(lower, target)) return false
    if (!lower.includes("opencode")) return false
    if (platformTerms.length && !platformTerms.some((term) => lower.includes(term))) return false
    if (archTerms.length && !archTerms.some((term) => lower.includes(term))) return false
    return true
  }

  let candidates = assets.filter(baseFilter)
  if (!candidates.length && platformTerms.length) {
    candidates = assets.filter((asset) => {
      const lower = asset.name.toLowerCase()
      if (!isDownloadAsset(lower, target)) return false
      if (!lower.includes("opencode")) return false
      return platformTerms.some((term) => lower.includes(term))
    })
  }
  if (!candidates.length && isMac) {
    candidates = assets.filter((asset) => {
      const lower = asset.name.toLowerCase()
      if (!isDownloadAsset(lower, target)) return false
      if (!lower.includes("opencode")) return false
      if (!platformTerms.some((term) => lower.includes(term))) return false
      return lower.includes("universal")
    })
  }

  if (!candidates.length) {
    return null
  }

  const preferredExtScore = (name: string) => {
    const ext = archiveExt(name)
    if (!ext) return 0
    if (ext === preferredExt) return 3
    if (ext === "zip") return 2
    return 1
  }

  const score = (asset: ReleaseAsset) => {
    const lower = asset.name.toLowerCase()
    let value = 0
    if (lower.startsWith(`${lowerPreferred}.`)) value += 6
    if (lower.includes(lowerPreferred)) value += 4
    value += preferredExtScore(lower)
    return value
  }

  candidates.sort((a, b) => score(b) - score(a))
  return candidates[0]!
}

async function fetchRelease(version?: string) {
  const url = version
    ? `https://api.github.com/repos/anomalyco/opencode/releases/tags/v${version}`
    : "https://api.github.com/repos/anomalyco/opencode/releases/latest"
  const headers = githubHeaders()
  try {
    const res = await fetch(url, { headers })
    if (!res.ok) {
      console.warn(`OpenCode release lookup failed (${res.status} ${res.statusText}); using fallback URL.`)
      return null
    }
    const json = (await res.json()) as ReleaseInfo
    if (!Array.isArray(json.assets)) return null
    return json
  } catch (err) {
    console.warn("OpenCode release lookup failed; using fallback URL.", err)
    return null
  }
}

async function fetchReleaseList() {
  const url = "https://api.github.com/repos/anomalyco/opencode/releases?per_page=20"
  const headers = githubHeaders()
  try {
    const res = await fetch(url, { headers })
    if (!res.ok) {
      console.warn(`OpenCode releases lookup failed (${res.status} ${res.statusText}); using fallback URL.`)
      return null
    }
    const json = (await res.json()) as ReleaseInfo[]
    if (!Array.isArray(json)) return null
    return json
  } catch (err) {
    console.warn("OpenCode releases lookup failed; using fallback URL.", err)
    return null
  }
}

function githubHeaders() {
  const token = Bun.env.GITHUB_TOKEN || Bun.env.GH_TOKEN
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "falck-predev",
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }
  return headers
}

function findAssetInReleases(
  releases: ReleaseInfo[],
  target: string,
  preferredBase: string,
  preferredExt: string,
) {
  for (const release of releases) {
    if (release.draft) continue
    const assets = Array.isArray(release.assets) ? release.assets : []
    const asset = pickReleaseAsset(assets, target, preferredBase, preferredExt)
    if (asset) {
      return { release, asset }
    }
  }
  return null
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

const appRoot = process.cwd()
const monorepoRoot = path.resolve(appRoot, "..")
const repoRoot = path.join(monorepoRoot, "opencode")
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
    ? `https://github.com/anomalyco/opencode/releases/download/v${version}`
    : "https://github.com/anomalyco/opencode/releases/latest/download"

  const fallbackArchiveName = `${sidecarConfig.ocBinary}.${sidecarConfig.assetExt}`
  const fallbackUrl = `${releaseBase}/${fallbackArchiveName}`
  let release = await fetchRelease(version)
  const initialTag = release?.tag_name
  let resolvedAsset = release
    ? pickReleaseAsset(release.assets, target, sidecarConfig.ocBinary, sidecarConfig.assetExt)
    : null
  if (!resolvedAsset && !version) {
    const releases = await fetchReleaseList()
    const fallbackMatch = releases
      ? findAssetInReleases(releases, target, sidecarConfig.ocBinary, sidecarConfig.assetExt)
      : null
    if (fallbackMatch) {
      release = fallbackMatch.release
      resolvedAsset = fallbackMatch.asset
      if (release.tag_name && release.tag_name !== initialTag) {
        console.log(`Using OpenCode asset from ${release.tag_name}: ${resolvedAsset.name}`)
      }
    }
  }
  if (release && !resolvedAsset) {
    console.warn(
      `OpenCode release did not include a matching asset for ${target}; falling back to ${fallbackArchiveName}.`,
    )
  }
  const archiveName = resolvedAsset?.name ?? fallbackArchiveName
  const archiveUrl = resolvedAsset?.browser_download_url ?? fallbackUrl
  const archivePath = path.join(tempDir, archiveName)
  const resolvedExt = archiveExt(archiveName) ?? sidecarConfig.assetExt
  const isDirectBinary = resolvedAsset ? isDownloadAsset(archiveName, target) && !archiveExt(archiveName) : false

  await $`curl -L --fail ${archiveUrl} -o ${archivePath}`

  if (isDirectBinary) {
    // Direct binary download (e.g. Windows .exe) requires no extraction.
  } else if (resolvedExt === "zip") {
    if (process.platform === "win32") {
      await $`powershell -Command "Expand-Archive -Force -Path '${archivePath}' -DestinationPath '${tempDir}'"`
    } else {
      await $`unzip -q ${archivePath} -d ${tempDir}`
    }
  } else if (resolvedExt === "tar.gz") {
    await $`tar -xzf ${archivePath} -C ${tempDir}`
  } else {
    throw new Error(`Unknown archive extension for ${archiveName}`)
  }

  const binName = process.platform === "win32" ? "opencode.exe" : "opencode"
  const downloadedBinary = isDirectBinary ? archivePath : path.join(tempDir, binName)

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

  const sidecarRoot = path.join(appRoot, "sidecar-opencode")
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
