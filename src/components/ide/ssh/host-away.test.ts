import { expect, test } from "vitest";
import { DEFAULT_SETTINGS } from "@/lib/ide-defaults";
import { isHostAway } from "./host-away";

const settings = {
  ...DEFAULT_SETTINGS,
  sshHosts: [
    { hostCommand: "", id: "devbox", label: "Devbox", target: "me@devbox" },
  ],
};

test("a local project's host is never away", () => {
  expect(isHostAway({ hosts: {}, settings }, {})).toBeNull();
});

test("an SSH host is away until it is connected with its catalog loaded", () => {
  const project = { hostId: "devbox" };
  const at = (runtime: Parameters<typeof isHostAway>[0]["hosts"][string]) =>
    isHostAway({ hosts: { devbox: runtime }, settings }, project);

  expect(isHostAway({ hosts: {}, settings }, project)).toMatchObject({
    label: "Devbox",
    state: "idle",
  });
  expect(at({ error: null, loaded: false, state: "connected" })).toMatchObject({
    state: "connected",
  });
  expect(
    at({ error: null, loaded: true, state: "reconnecting" }),
  ).toMatchObject({ state: "reconnecting" });
  expect(
    at({ error: "Permission denied", loaded: false, state: "failed" }),
  ).toMatchObject({ error: "Permission denied", state: "failed" });
  expect(at({ error: null, loaded: true, state: "connected" })).toBeNull();
});
