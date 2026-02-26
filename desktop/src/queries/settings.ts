import { useQuery } from "@tanstack/react-query";

import { settingsKeys } from "@/queries/keys";
import { settingsService } from "@/services/settingsService";

export function useDefaultRepoDir(enabled = true) {
  return useQuery({
    queryKey: settingsKeys.defaultRepoDir(),
    queryFn: () => settingsService.getDefaultRepoDir(),
    enabled,
  });
}
