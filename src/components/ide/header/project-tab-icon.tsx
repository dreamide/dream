import { type ReactNode, useEffect, useState } from "react";
import { fetchApiBlob, getProjectFileRawUrl } from "@/lib/api-client";
import { LOCAL_HOST_ID } from "@/lib/host-routing";
import type { ProjectIconInfo } from "@/types/ide";

// The same path on two hosts is two folders, with two icons.
const getProjectIconCacheKey = (
  hostId: string,
  projectPath: string,
  icon: ProjectIconInfo,
) => `${hostId}\x00${projectPath}\x00${icon.path}\x00${icon.mtimeMs}`;

// Object URLs are cached across mounts so a tab icon that is swapped out for
// a status dot and back again renders synchronously instead of flashing while
// it refetches the image.
const projectIconObjectUrls = new Map<string, string>();
const projectIconLoads = new Map<string, Promise<string>>();

const loadProjectIcon = (
  hostId: string,
  projectPath: string,
  icon: ProjectIconInfo,
) => {
  const cacheKey = getProjectIconCacheKey(hostId, projectPath, icon);
  const cachedUrl = projectIconObjectUrls.get(cacheKey);
  if (cachedUrl) {
    return Promise.resolve(cachedUrl);
  }

  const pendingLoad = projectIconLoads.get(cacheKey);
  if (pendingLoad) {
    return pendingLoad;
  }

  const load = fetchApiBlob(
    getProjectFileRawUrl(projectPath, icon.path, hostId),
  )
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
  className = "size-4",
  fallback = null,
  hostId = LOCAL_HOST_ID,
  icon,
  projectName,
  projectPath,
}: {
  className?: string;
  fallback?: ReactNode;
  /** The project's host; the local host when absent. */
  hostId?: string;
  icon: ProjectIconInfo | null;
  projectName: string;
  projectPath: string;
}) {
  const cacheKey = icon
    ? getProjectIconCacheKey(hostId, projectPath, icon)
    : null;
  const uploadedSrc =
    icon?.source === "custom" && icon.path.startsWith("data:image/png;base64,")
      ? icon.path
      : null;
  const cachedSrc =
    uploadedSrc ??
    (cacheKey ? (projectIconObjectUrls.get(cacheKey) ?? null) : null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<{ key: string; src: string } | null>(
    null,
  );

  useEffect(() => {
    if (!icon || cachedSrc) {
      return;
    }

    let cancelled = false;
    const key = getProjectIconCacheKey(hostId, projectPath, icon);

    void loadProjectIcon(hostId, projectPath, icon)
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
  }, [cachedSrc, hostId, icon, projectPath]);

  const src =
    cachedSrc ?? (loaded && loaded.key === cacheKey ? loaded.src : null);

  if (!icon || !src || failedKey === cacheKey) {
    return fallback;
  }

  return (
    <img
      alt=""
      aria-hidden="true"
      className={`${className} shrink-0 rounded-sm object-contain`}
      draggable={false}
      onError={() => setFailedKey(cacheKey)}
      src={src}
      title={projectName}
    />
  );
}
