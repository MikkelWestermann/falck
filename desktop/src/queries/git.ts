import { useQuery } from "@tanstack/react-query";

import { gitKeys } from "@/queries/keys";
import { gitService } from "@/services/gitService";

export function useSavedRepos(enabled = true) {
  return useQuery({
    queryKey: gitKeys.savedRepos(),
    queryFn: () => gitService.listSavedRepos(),
    enabled,
  });
}
