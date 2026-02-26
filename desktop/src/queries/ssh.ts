import { useQuery } from "@tanstack/react-query";

import { sshKeys } from "@/queries/keys";
import { sshService } from "@/services/sshService";

export function useSshKeys(enabled = true) {
  return useQuery({
    queryKey: sshKeys.list(),
    queryFn: () => sshService.listKeys(),
    enabled,
  });
}

export function useSshOs(enabled = true) {
  return useQuery({
    queryKey: sshKeys.os(),
    queryFn: () => sshService.getOS(),
    enabled,
  });
}
