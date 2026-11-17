import { expect, test } from "vitest";
import { DEFAULT_SETTINGS } from "@/lib/ide-defaults";
import { isHostAway } from "./host-away";

const settings = {
  ...DEFAULT_SETTINGS,
  sshHosts: [{ id: "devbox", label: "Devbox", target: "me@devbox" }],
};
const ready = { error: null, status: "ready" as const };

test("a home project's host is away only while the home host is not ready", () => {
  const state = { hosts: {}, settings, stateHydrated: true };
  expect(isHostAway(state, {}, ready)).toBeNull();
  expect(
    isHostAway(state, {}, { error: null, status: "reconnecting" }),
  ).toMatchObject({ hostId: "local", state: "reconnecting" });
  expect(
    isHostAway(state, {}, { error: "Another host.", status: "incompatible" }),
  ).toMatchObject({ error: "Another host.", state: "failed" });
  // Its catalog comes in with hydration.
  expect(
    isHostAway({ ...state, stateHydrated: false }, {}, ready),
  ).toMatchObject({ state: "connected" });
});

test("an SSH host is away until it is connected with its catalog loaded", () => {
  const project = { hostId: "devbox" };
  const at = (runtime: Parameters<typeof isHostAway>[0]["hosts"][string]) =>
    isHostAway(
      { hosts: { devbox: runtime }, settings, stateHydrated: true },
      project,
      ready,
    );

  expect(
    isHostAway({ hosts: {}, settings, stateHydrated: true }, project, ready),
  ).toMatchObject({
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
