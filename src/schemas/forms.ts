import { z } from "zod";

import { branchNamePattern } from "@/lib/branching";

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
  message: z.string().min(1, "Please describe what you changed"),
});

export const createBranchSchema = z.object({
  branchName: z
    .string()
    .min(1, "Project name is required")
    .regex(branchNamePattern, "Invalid project name"),
});

export const createAISessionSchema = z.object({
  sessionName: z.string().min(1, "Session name is required"),
  description: z.string().optional(),
  model: z.string().min(1, "Model is required"),
});

export const createAstroProjectSchema = z
  .object({
    projectName: z.string().min(1, "Project name is required"),
    repoMode: z.enum(["new", "existing"]),
    repoName: z.string().optional(),
    existingRepo: z.string().optional(),
    visibility: z.enum(["private", "public"]),
    description: z.string().optional(),
    folderName: z.string().optional(),
    promptMode: z.enum(["yes", "no"]),
    installDependencies: z.boolean(),
    initializeGit: z.boolean(),
    skipHouston: z.boolean(),
    integrations: z.string().optional(),
    astroRef: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.repoMode === "existing") {
      if (!data.existingRepo || !data.existingRepo.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["existingRepo"],
          message: "Select a GitHub repository",
        });
      }
    }
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
export type CreateAstroProjectInput = z.infer<typeof createAstroProjectSchema>;
export type SetAPIKeyInput = z.infer<typeof setAPIKeySchema>;
