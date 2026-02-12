import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import os from "os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const platform = os.platform();
const arch = os.arch();

let target;
let filename;

if (platform === "win32") {
  target = "x86_64-pc-windows-msvc";
  filename = "my-sidecar.exe";
} else if (platform === "darwin") {
  target = arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  filename = "my-sidecar";
} else {
  target = "x86_64-unknown-linux-gnu";
  filename = "my-sidecar";
}

const src = path.join(__dirname, filename);
const dest = path.join(
  __dirname,
  "..",
  "src-tauri",
  "binaries",
  `opencode-sidecar-${target}`,
);

fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.copyFileSync(src, dest);
fs.chmodSync(dest, 0o755);

console.log(`✓ Copied ${src} to ${dest}`);
