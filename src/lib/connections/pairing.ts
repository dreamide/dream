/**
 * Pairing a browser client with the host that serves its page
 * (electron/host/auth/host-auth.js has the contract): a short code created
 * on the host is redeemed at once for a session, an HttpOnly cookie this
 * page never sees. Once it is set, the page starts over with it.
 */
import { LOCAL_HOST_ID } from "../host-routing";
import { hostFetch } from "./host-endpoint";

/** A name for this device the host's operator will recognise in its list. */
export const describeThisDevice = (): string => {
  if (typeof navigator === "undefined") return "Browser";
  const agent = navigator.userAgent;
  const device = /iPhone/.test(agent)
    ? "iPhone"
    : /iPad/.test(agent)
      ? "iPad"
      : /Android/.test(agent)
        ? "Android"
        : /Mac OS X/.test(agent)
          ? "Mac"
          : /Windows/.test(agent)
            ? "Windows"
            : /Linux/.test(agent)
              ? "Linux"
              : "Device";
  const browser = /Edg\//.test(agent)
    ? "Edge"
    : /Firefox\//.test(agent)
      ? "Firefox"
      : /Chrome\//.test(agent)
        ? "Chrome"
        : /Safari\//.test(agent)
          ? "Safari"
          : "Browser";
  return `${device} · ${browser}`;
};

/** The host's refusal, as it worded it. */
export class PairingError extends Error {
  override name = "PairingError";
}

const post = async <T>(path: string, body: object): Promise<T> => {
  const response = await hostFetch(LOCAL_HOST_ID, path, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    const reason = (await response.text().catch(() => "")).trim();
    throw new PairingError(reason || `Request failed (${response.status}).`);
  }
  return response.json() as Promise<T>;
};

/** Redeems a pairing code for this browser's session cookie. */
export const pairWithCode = (code: string, deviceName: string) =>
  post<{ session: unknown }>("/api/remote/pair/code", {
    clientKind: "web",
    code: code.trim(),
    deviceName,
  });

/** Starts the page over with the new session (from the app's root). */
export const restartPaired = () => {
  window.location.replace("/");
};
