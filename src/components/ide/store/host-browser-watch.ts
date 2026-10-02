/**
 * Lends this window's browser to an SSH host's agents: the host's projects
 * this window has open are announced to it, and their browser tool calls
 * run here (src/lib/host-browser-relay.ts). Runs while the host is loaded.
 */
import { apiClient, getApiErrorMessage } from "@/lib/api-client";
import { createHostBrowserRelay } from "@/lib/host-browser-relay";
import { fromLoadedText, toLoadableUrl } from "@/lib/host-ports";
import { LOCAL_HOST_ID } from "@/lib/host-routing";
import { getHostSocketClient } from "@/lib/host-socket";
import { getProjectHostId } from "../../../../electron/shared/persisted-state-codec.js";
import { useIdeStore } from "../ide-store";

/**
 * A tool result with the forwarded addresses in its text written as the
 * host's own (`localhost:<port>`), so the agent reads URLs it can use.
 */
const asHostSees = (hostId: string, result: unknown): unknown => {
  if (!result || typeof result !== "object") return result;
  const { content } = result as { content?: unknown };
  if (!Array.isArray(content)) return result;
  return {
    ...result,
    content: content.map((part) =>
      part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
        ? {
            ...part,
            text: fromLoadedText(hostId, (part as { text: string }).text),
          }
        : part,
    ),
  };
};

export const watchHostBrowser = (hostId: string) => {
  const relay = createHostBrowserRelay({
    describeError: (error) =>
      getApiErrorMessage(error, "The browser tool failed."),
    getProjectIds: () =>
      useIdeStore
        .getState()
        .projects.filter((project) => getProjectHostId(project) === hostId)
        .map((project) => project.id),
    // The browser lives with this window's own host (the desktop app). The
    // host's localhost is loaded through its port forward, as the browser
    // panel does, and reported back as the host's.
    runTool: async (call) => {
      const args =
        typeof call.args.url === "string"
          ? { ...call.args, url: await toLoadableUrl(hostId, call.args.url) }
          : call.args;
      const result = await apiClient.callBrowserTool(
        { ...call, args },
        { hostId: LOCAL_HOST_ID },
      );
      return asHostSees(hostId, result);
    },
    socket: getHostSocketClient(hostId),
  });

  relay.announce();
  const unsubscribe = useIdeStore.subscribe((state, previous) => {
    if (state.projects !== previous.projects) relay.announce();
  });

  return () => {
    unsubscribe();
    relay.stop();
  };
};
