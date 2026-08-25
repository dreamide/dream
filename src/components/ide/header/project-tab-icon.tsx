import { type ReactNode, useEffect, useState } from "react";
import type { ProjectIconInfo } from "@/types/ide";

const getProjectIconUrl = (projectPath: string, iconPath: string) =>
  `/api/project-file-raw?projectPath=${encodeURIComponent(projectPath)}&filePath=${encodeURIComponent(iconPath)}`;

const getProjectIconCacheKey = (projectPath: string, icon: ProjectIconInfo) =>
  `${projectPath}\x00${icon.path}\x00${icon.mtimeMs}`;

// Object URLs are cached across mounts so a tab icon that is swapped out for
// a status dot and back again renders synchronously instead of flashing while
// it refetches the image.
const projectIconObjectUrls = new Map<string, string>();
const projectIconLoads = new Map<string, Promise<string>>();

const loadProjectIcon = (projectPath: string, icon: ProjectIconInfo) => {
  const cacheKey = getProjectIconCacheKey(projectPath, icon);
  const cachedUrl = projectIconObjectUrls.get(cacheKey);
  if (cachedUrl) {
    return Promise.resolve(cachedUrl);
  }

  const pendingLoad = projectIconLoads.get(cacheKey);
  if (pendingLoad) {
    return pendingLoad;
  }

  const load = fetch(getProjectIconUrl(projectPath, icon.path))
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`Unable to load project icon: ${response.status}`);
      }

      return response.blob();
    })
    .then((blob) => {
      const objectUrl = URL.createObjectURL(blob);
      projectIconObjectUrls.set(cacheKey, objectUrl);
      return objectUrl;
    })
    .finally(() => {
      projectIconLoads.delete(cacheKey);
    });

  projectIconLoads.set(cacheKey, load);
  return load;
};

export function ProjectTabIcon({
  fallback = null,
  icon,
  projectName,
  projectPath,
}: {
  fallback?: ReactNode;
  icon: ProjectIconInfo | null;
  projectName: string;
  projectPath: string;
}) {
  const cacheKey = icon ? getProjectIconCacheKey(projectPath, icon) : null;
  const cachedSrc = cacheKey
    ? (projectIconObjectUrls.get(cacheKey) ?? null)
    : null;
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<{ key: string; src: string } | null>(
    null,
  );

  useEffect(() => {
    if (!icon || cachedSrc) {
      return;
    }

    let cancelled = false;
    const key = getProjectIconCacheKey(projectPath, icon);

    void loadProjectIcon(projectPath, icon)
      .then((src) => {
        if (!cancelled) {
          setLoaded({ key, src });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFailedKey(key);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [cachedSrc, icon, projectPath]);

  const src =
    cachedSrc ?? (loaded && loaded.key === cacheKey ? loaded.src : null);

  if (!icon || !src || failedKey === cacheKey) {
    return fallback;
  }

  return (
    <img
      alt=""
      aria-hidden="true"
      className="size-4 shrink-0 rounded-sm object-contain"
      draggable={false}
      onError={() => setFailedKey(cacheKey)}
      src={src}
      title={projectName}
    />
  );
}
