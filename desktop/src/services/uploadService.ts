import { invoke } from "@tauri-apps/api/core";

export interface UploadResult {
  path: string;
  relativePath: string;
  filename: string;
  mime: string;
}

export async function saveTempUpload(options: {
  repoPath: string;
  messageId: string;
  filename: string;
  mime?: string;
  dataBase64: string;
}): Promise<UploadResult> {
  const { repoPath, messageId, filename, mime, dataBase64 } = options;
  return invoke<UploadResult>("save_temp_upload", {
    repoPath,
    messageId,
    filename,
    mime,
    dataBase64,
  });
}
