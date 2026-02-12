import { invoke } from "@tauri-apps/api/core";

export interface CreateAstroProjectInput {
  projectName: string;
  localPath: string;
  repoMode: "new" | "existing";
  repoName?: string | null;
  repoFullName?: string | null;
  repoSshUrl?: string | null;
  repoVisibility?: "private" | "public" | null;
  description?: string | null;
  sshKeyPath: string;
  promptMode: "yes" | "no";
  installDependencies: boolean;
  initializeGit: boolean;
  skipHouston: boolean;
  integrations?: string | null;
  astroRef?: string | null;
  progressId?: string | null;
}

export interface CreateAstroProjectResult {
  path: string;
  repoName: string;
  repoFullName: string;
  repoSshUrl: string;
  branch: string;
}

export const projectService = {
  async createAstroProject(
    input: CreateAstroProjectInput,
  ): Promise<CreateAstroProjectResult> {
    return invoke<CreateAstroProjectResult>("create_astro_project", { input });
  },
};
