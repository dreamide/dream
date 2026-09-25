import { useEffect, useState } from "react";
import type { AiProvider, ProviderSkill } from "@/types/ide";
import {
  fetchProviderSkills,
  getCachedProviderSkills,
  providerSupportsSkills,
  subscribeToProviderSkills,
} from "./provider-skills";

/**
 * Skills the selected provider can invoke for this project. Loaded lazily
 * (`enabled`) because Codex discovery starts its app-server.
 */
export const useProviderSkills = ({
  enabled,
  projectPath,
  provider,
}: {
  enabled: boolean;
  projectPath: string;
  provider: AiProvider;
}) => {
  const [skills, setSkills] = useState<ProviderSkill[]>(
    () => getCachedProviderSkills(provider, projectPath)?.skills ?? [],
  );
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    setSkills(getCachedProviderSkills(provider, projectPath)?.skills ?? []);
    return subscribeToProviderSkills(() => {
      setSkills(getCachedProviderSkills(provider, projectPath)?.skills ?? []);
    });
  }, [projectPath, provider]);

  useEffect(() => {
    if (!enabled || !providerSupportsSkills(provider)) {
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    void fetchProviderSkills(provider, projectPath).finally(() => {
      if (!cancelled) {
        setIsLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, projectPath, provider]);

  return { isLoading, skills };
};
