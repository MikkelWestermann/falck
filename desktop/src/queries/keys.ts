export const githubKeys = {
  all: ["github"] as const,
  hasToken: () => [...githubKeys.all, "hasToken"] as const,
  user: () => [...githubKeys.all, "user"] as const,
  repos: () => [...githubKeys.all, "repos"] as const,
  repoCollaborators: (fullName: string) =>
    [...githubKeys.all, "repos", fullName, "collaborators"] as const,
};

export const settingsKeys = {
  defaultRepoDir: () => ["settings", "defaultRepoDir"] as const,
};

export const sshKeys = {
  list: () => ["ssh", "keys"] as const,
  os: () => ["ssh", "os"] as const,
};

export const gitKeys = {
  savedRepos: () => ["git", "savedRepos"] as const,
};
