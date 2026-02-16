import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  FileTree,
  FileTreeFile,
  FileTreeFolder,
} from "@/components/ai-elements/file-tree";
import {
  falckService,
  type AssetUploadFile,
  type FalckApplication,
} from "@/services/falckService";
import { FolderIcon, UploadCloudIcon } from "lucide-react";

interface AssetUploadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repoPath: string;
  app?: FalckApplication | null;
  files: File[];
  onUploaded?: (paths: string[]) => void;
}

const ROOT_DESTINATION = "__root__";

const normalizePathLabel = (value: string) => {
  let trimmed = value.trim();
  if (trimmed === "." || trimmed === "./") {
    return "";
  }
  trimmed = trimmed.replace(/^\.?[\\/]+/, "");
  trimmed = trimmed.replace(/[\\/]+$/, "");
  return trimmed;
};

const formatBytes = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  const precision = value >= 10 || idx === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[idx]}`;
};

type FolderNode = {
  name: string;
  path: string;
  children: Map<string, FolderNode>;
};

const buildFolderTree = (rootName: string, paths: string[]) => {
  const root: FolderNode = {
    name: rootName,
    path: ROOT_DESTINATION,
    children: new Map(),
  };

  paths.forEach((path) => {
    const parts = path.split("/").filter(Boolean);
    let current = root;
    let currentPath = "";

    parts.forEach((part) => {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      let child = current.children.get(part);
      if (!child) {
        child = { name: part, path: currentPath, children: new Map() };
        current.children.set(part, child);
      }
      current = child;
    });
  });

  return root;
};

const sortNodes = (nodes: FolderNode[]) =>
  nodes.sort((a, b) =>
    a.name.localeCompare(b.name, "en", { sensitivity: "base" }),
  );

export function AssetUploadDialog({
  open,
  onOpenChange,
  repoPath,
  app,
  files,
  onUploaded,
}: AssetUploadDialogProps) {
  const [targetSubdir, setTargetSubdir] = useState<string>(ROOT_DESTINATION);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const assets = app?.assets;
  const appRootLabel = app?.root === "." ? "repo root" : app?.root || "app root";
  const rootLabel = assets?.root ? normalizePathLabel(assets.root) : "";
  const rootDisplay = rootLabel || "app root";

  const subdirOptions = useMemo(
    () =>
      (assets?.subdirectories ?? [])
        .map((dir) => normalizePathLabel(dir))
        .filter((dir) => dir !== ""),
    [assets?.subdirectories],
  );

  const folderTree = useMemo(
    () => buildFolderTree(rootDisplay, subdirOptions),
    [rootDisplay, subdirOptions],
  );

  const defaultExpanded = useMemo(() => {
    const expanded = new Set<string>();
    expanded.add(ROOT_DESTINATION);
    subdirOptions.forEach((dir) => {
      const parts = dir.split("/").filter(Boolean);
      let current = "";
      parts.slice(0, -1).forEach((part) => {
        current = current ? `${current}/${part}` : part;
        expanded.add(current);
      });
    });
    return expanded;
  }, [subdirOptions]);

  const destinationLabel = useMemo(() => {
    if (!assets?.root) {
      return "";
    }
    const normalizedRoot = rootDisplay;
    if (targetSubdir === ROOT_DESTINATION) {
      return normalizedRoot;
    }
    return `${normalizedRoot}/${targetSubdir}`;
  }, [assets?.root, rootDisplay, targetSubdir]);

  useEffect(() => {
    if (!open) {
      return;
    }
    setError(null);
    setUploading(false);
    setTargetSubdir(ROOT_DESTINATION);
  }, [open, app?.id]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (uploading) {
      return;
    }
    onOpenChange(nextOpen);
  };

  const handleUpload = async () => {
    if (!app || !assets?.root) {
      setError("No asset directory is configured for this application.");
      return;
    }
    if (files.length === 0) {
      setError("No files selected for upload.");
      return;
    }

    setUploading(true);
    setError(null);

    try {
      const payload: AssetUploadFile[] = await Promise.all(
        files.map(async (file) => {
          const buffer = await file.arrayBuffer();
          return {
            name: file.name,
            bytes: Array.from(new Uint8Array(buffer)),
          };
        }),
      );

      const savedPaths = await falckService.uploadAssetFiles(
        repoPath,
        app.id,
        targetSubdir === ROOT_DESTINATION ? null : targetSubdir,
        payload,
      );
      onUploaded?.(savedPaths);
      onOpenChange(false);
    } catch (err) {
      setError(`Failed to upload assets: ${String(err)}`);
    } finally {
      setUploading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UploadCloudIcon className="h-5 w-5" />
            Upload assets to {app?.name ?? "application"}
          </DialogTitle>
          <DialogDescription>
            Choose where these files should live inside the asset directory for
            this app.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {!assets?.root ? (
          <div className="rounded-lg border border-dashed border-border/60 bg-muted/40 p-4 text-sm text-muted-foreground">
            No asset directory is configured for this application.
          </div>
        ) : (
          <div className="space-y-4">
            <div className="text-xs text-muted-foreground">
              Asset root:{" "}
              <span className="font-mono text-foreground">{rootDisplay}</span>{" "}
              (relative to {appRootLabel})
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Destination folder</label>
              <FileTree
                selectedPath={targetSubdir}
                onSelect={(path) => setTargetSubdir(path)}
                defaultExpanded={defaultExpanded}
                className="border-border/60 bg-card/80 shadow-[var(--shadow-sm)]"
              >
                <FileTreeFolder path={folderTree.path} name={folderTree.name}>
                  {folderTree.children.size === 0 ? (
                    <div className="px-2 py-1 text-xs text-muted-foreground">
                      No subfolders configured.
                    </div>
                  ) : (
                    sortNodes(Array.from(folderTree.children.values())).map(
                      (node) => {
                        const children = sortNodes(
                          Array.from(node.children.values()),
                        );
                        if (children.length === 0) {
                          return (
                            <FileTreeFile
                              key={node.path}
                              path={node.path}
                              name={node.name}
                              icon={
                                <FolderIcon className="size-4 text-blue-500" />
                              }
                            />
                          );
                        }
                        const renderBranch = (branch: FolderNode) => {
                          const branchChildren = sortNodes(
                            Array.from(branch.children.values()),
                          );
                          if (branchChildren.length === 0) {
                            return (
                              <FileTreeFile
                                key={branch.path}
                                path={branch.path}
                                name={branch.name}
                                icon={
                                  <FolderIcon className="size-4 text-blue-500" />
                                }
                              />
                            );
                          }
                          return (
                            <FileTreeFolder
                              key={branch.path}
                              path={branch.path}
                              name={branch.name}
                            >
                              {branchChildren.map(renderBranch)}
                            </FileTreeFolder>
                          );
                        };

                        return (
                          <FileTreeFolder
                            key={node.path}
                            path={node.path}
                            name={node.name}
                          >
                            {children.map(renderBranch)}
                          </FileTreeFolder>
                        );
                      },
                    )
                  )}
                </FileTreeFolder>
              </FileTree>
            </div>

            <div className="rounded-lg border border-border/60 bg-muted/40 p-3 text-xs">
              <div className="font-semibold">Files ({files.length})</div>
              <div className="mt-2 max-h-40 space-y-1 overflow-y-auto">
                {files.map((file) => (
                  <div
                    key={`${file.name}-${file.size}-${file.lastModified}`}
                    className="flex items-center justify-between gap-3 text-muted-foreground"
                  >
                    <span className="truncate text-foreground">
                      {file.name}
                    </span>
                    <span>{formatBytes(file.size)}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-lg border border-dashed border-border/60 bg-background px-3 py-2 text-xs text-muted-foreground">
              Upload destination:{" "}
              <span className="font-mono text-foreground">
                {destinationLabel || rootDisplay}
              </span>
            </div>
          </div>
        )}

        <div className="flex gap-3">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={uploading}
          >
            Cancel
          </Button>
          <Button
            onClick={handleUpload}
            disabled={uploading || !assets?.root || files.length === 0}
            className="flex-1"
          >
            {uploading ? "Uploading..." : "Upload assets"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
