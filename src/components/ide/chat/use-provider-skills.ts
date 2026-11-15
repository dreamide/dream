import { useEffect, useMemo, useState } from "react";
import type { AiProvider, ProviderSkill } from "@/types/ide";
import {
  fetchProviderSkills,
  getCachedProviderSkills,
  providerSupportsSkills,
  subscribeToProviderSkills,
} from "./provider-skills";

/**
 * Skills the selected provider can invoke for this project on its Host.
 * Loaded lazily (`enabled`) because Codex discovery starts its app-server.
 */
export const useProviderSkills = ({
  enabled,
  hostId,
  projectPath,
  provider,
}: {
  enabled: boolean;
  /** The project's Host (`getProjectHostId`). */
  hostId: string;
  projectPath: string;
  provider: AiProvider;
}) => {
  const scope = useMemo(() => ({ hostId, projectPath }), [hostId, projectPath]);
  const [skills, setSkills] = useState<ProviderSkill[]>(
    () => getCachedProviderSkills(provider, scope)?.skills ?? [],
  );
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    setSkills(getCachedProviderSkills(provider, scope)?.skills ?? []);
    return subscribeToProviderSkills(() => {
      setSkills(getCachedProviderSkills(provider, scope)?.skills ?? []);
    });
  }, [provider, scope]);

  useEffect(() => {
    if (!enabled || !providerSupportsSkills(provider)) {
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    void fetchProviderSkills(provider, scope).finally(() => {
      if (!cancelled) {
        setIsLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, provider, scope]);

  return { isLoading, skills };
};
