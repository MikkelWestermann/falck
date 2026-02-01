import { z } from "zod";

const isSshUrl = (value: string) =>
  value.startsWith("git@") || value.startsWith("ssh://");

export const cloneRepoSchema = z.object({
  name: z.string().min(1, "Repo name is required"),
  url: z
    .string()
    .min(1, "Repository URL is required")
    .refine(
      (value) => isSshUrl(value),
      "Use an SSH URL (git@github.com:org/repo.git)",
    ),
});

export const openRepoSchema = z.object({
  name: z.string().min(1, "Repo name is required"),
  path: z.string().min(1, "Repository path is required"),
});

export const commitSchema = z.object({
  message: z.string().min(1, "Commit message is required"),
  author: z.string().min(1, "Author name is required"),
  email: z.string().email("Valid email is required"),
});

export const createBranchSchema = z.object({
  branchName: z
    .string()
    .min(1, "Branch name is required")
    .regex(/^[a-zA-Z0-9._/-]+$/, "Invalid branch name"),
});

export const createAISessionSchema = z.object({
  sessionName: z.string().min(1, "Session name is required"),
  description: z.string().optional(),
  model: z.string().min(1, "Model is required"),
});

export const setAPIKeySchema = z.object({
  provider: z.string().min(1, "Provider is required"),
  apiKey: z.string().min(1, "API key is required"),
});

export type CloneRepoInput = z.infer<typeof cloneRepoSchema>;
export type OpenRepoInput = z.infer<typeof openRepoSchema>;
export type CommitInput = z.infer<typeof commitSchema>;
export type CreateBranchInput = z.infer<typeof createBranchSchema>;
export type CreateAISessionInput = z.infer<typeof createAISessionSchema>;
export type SetAPIKeyInput = z.infer<typeof setAPIKeySchema>;
