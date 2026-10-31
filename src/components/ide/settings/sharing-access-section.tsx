/**
 * Settings > Sharing & access, on the desktop: whether other computers may
 * use this computer's host, how they reach it, and which are paired. It is
 * about this computer only; another machine's sharing is managed on that
 * machine (its own Dream, or `dream-host remote` / `dream-host pair`).
 *
 * The one thing said about the host itself is a version that differs from
 * this app's, which only a `dream-host` the user started can have.
 */
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { hostFetch } from "@/lib/connections/host-endpoint";
import { LOCAL_HOST_ID } from "@/lib/host-routing";
import { RemoteAccessSection } from "./remote-access-section";

/** -1, 0 or 1 as version `a` is older, the same as or newer than `b`. */
const compareVersions = (a: string, b: string) => {
  const parts = (value: string) =>
    value
      .split(/[.+-]/)
      .slice(0, 3)
      .map((part) => Number.parseInt(part, 10) || 0);
  const [left, right] = [parts(a), parts(b)];
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index])
      return left[index] < right[index] ? -1 : 1;
  }
  return 0;
};

/** This computer's host's version, from its host-info; null until known. */
const useHostVersion = () => {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void hostFetch(LOCAL_HOST_ID, "/api/host-info")
      .then((response) => (response.ok ? response.json() : null))
      .then((info: { version?: unknown } | null) => {
        if (!cancelled && typeof info?.version === "string")
          setVersion(info.version);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return version;
};

export function SharingAccessSection({ appVersion }: { appVersion: string }) {
  const t = useTranslations("sharing");
  const hostVersion = useHostVersion();
  const relation =
    hostVersion && appVersion ? compareVersions(hostVersion, appVersion) : 0;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h3 className="font-medium text-base">{t("title")}</h3>
        <p className="text-muted-foreground text-sm">{t("description")}</p>
      </div>
      {relation === 0 ? null : (
        <p className="rounded-md border border-warning-border bg-warning-surface px-3 py-2 text-sm text-warning-foreground">
          {t(relation < 0 ? "hostOlder" : "hostNewer", {
            appVersion,
            version: hostVersion ?? "",
          })}
        </p>
      )}
      <RemoteAccessSection />
    </div>
  );
}
