import { useQuery } from "@tanstack/react-query";

import { githubKeys } from "@/queries/keys";
import { githubService } from "@/services/githubService";

export function useGithubHasToken(enabled = true) {
  return useQuery({
    queryKey: githubKeys.hasToken(),
    queryFn: () => githubService.hasToken(),
    enabled,
  });
}

export function useGithubUser(enabled = true) {
  return useQuery({
    queryKey: githubKeys.user(),
    queryFn: () => githubService.getUser(),
    enabled,
  });
}

export function useGithubRepos(enabled = true) {
  return useQuery({
    queryKey: githubKeys.repos(),
    queryFn: () => githubService.listRepos(),
    enabled,
  });
}
