import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Slugifies a filename for URL-safe use. Preserves the file extension.
 * e.g. "My Cool File (1).PNG" → "my-cool-file-1.png"
 */
export function slugifyFilename(filename: string): string {
  const lastDot = filename.lastIndexOf(".");
  let base = lastDot >= 0 ? filename.slice(0, lastDot) : filename;
  let ext = lastDot >= 0 ? filename.slice(lastDot) : "";

  // Handle hidden files like .gitignore
  if (!base && ext.startsWith(".")) {
    base = ext.slice(1);
    ext = "";
  }

  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  const extSlug = ext.toLowerCase().replace(/[^a-z0-9.]/g, "");

  return (slug || "file") + extSlug;
}
