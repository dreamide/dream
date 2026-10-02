import { afterEach, expect, test } from "vitest";
import {
  hostApiPath,
  LOCAL_HOST_ID,
  resolveRequestHost,
  setHostResolver,
} from "./host-routing";

afterEach(() => setHostResolver(() => LOCAL_HOST_ID));

test("a local request keeps its route; an SSH host's goes through the proxy", () => {
  expect(hostApiPath(LOCAL_HOST_ID, "/api/project-files")).toBe(
    "/api/project-files",
  );
  expect(hostApiPath("dev box", "/api/project-files")).toBe(
    "/api/hosts/dev%20box/project-files",
  );
});

test("the host comes from what the body names, or is local", () => {
  setHostResolver((hint) =>
    hint.projectPath === "/srv/app" ? "devbox" : LOCAL_HOST_ID,
  );

  expect(resolveRequestHost({ projectPath: "/srv/app" })).toBe("devbox");
  expect(resolveRequestHost({ projectPath: "/home/me" })).toBe(LOCAL_HOST_ID);
  expect(resolveRequestHost(null)).toBe(LOCAL_HOST_ID);
  setHostResolver(() => {
    throw new Error("broken");
  });
  expect(resolveRequestHost({})).toBe(LOCAL_HOST_ID);
});
