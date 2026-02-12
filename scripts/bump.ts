import { $ } from "bun"
import fs from "node:fs"

type BumpType = "major" | "minor" | "patch"

const bumpType = (Bun.argv[2] ?? "patch") as BumpType
if (!["major", "minor", "patch"].includes(bumpType)) {
  throw new Error(`Unknown bump type: ${bumpType}`)
}

const rootPackagePath = "package.json"
const desktopPackagePath = "desktop/package.json"
const tauriConfigPath = "desktop/src-tauri/tauri.conf.json"

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T
}

function writeJson(filePath: string, data: unknown) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`)
}

function parseVersion(value: string) {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)$/)
  if (!match) {
    throw new Error(`Invalid version format: ${value}`)
  }
  return match.slice(1).map((part) => Number(part))
}

function bumpVersion(value: string, type: BumpType) {
  const [major, minor, patch] = parseVersion(value)
  if (type === "major") return `${major + 1}.0.0`
  if (type === "minor") return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

const status = await $`git status --porcelain`.text()
if (status.trim()) {
  throw new Error("Working tree not clean. Commit or stash changes before bumping.")
}

const rootPackage = readJson<{ version?: string }>(rootPackagePath)
if (!rootPackage.version) {
  throw new Error(`Missing version field in ${rootPackagePath}`)
}

const nextVersion = bumpVersion(rootPackage.version, bumpType)
rootPackage.version = nextVersion
writeJson(rootPackagePath, rootPackage)

if (fs.existsSync(desktopPackagePath)) {
  const desktopPackage = readJson<{ version?: string }>(desktopPackagePath)
  desktopPackage.version = nextVersion
  writeJson(desktopPackagePath, desktopPackage)
}

const tauriConfig = readJson<{ version?: string }>(tauriConfigPath)
tauriConfig.version = nextVersion
writeJson(tauriConfigPath, tauriConfig)

const filesToAdd = [rootPackagePath, tauriConfigPath]
if (fs.existsSync(desktopPackagePath)) {
  filesToAdd.push(desktopPackagePath)
}

await $`git add ${filesToAdd}`
await $`git commit -m ${`chore(release): bump version to v${nextVersion}`}`
await $`git tag v${nextVersion}`
await $`git push`
await $`git push --tags`

console.log(`Bumped to v${nextVersion}`)
