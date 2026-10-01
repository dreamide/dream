import { expect, test } from "vitest";
import { createDaemonEnvironment } from "./daemon-environment.js";

test("drops the launching SSH session and its forwarded agent", () => {
  const env = createDaemonEnvironment({
    HOME: "/home/me",
    PATH: "/usr/bin",
    SSH_AUTH_SOCK: "/tmp/ssh-XYZ123/agent.4242",
    SSH_CLIENT: "10.0.0.2 5555 22",
    SSH_CONNECTION: "10.0.0.2 5555 10.0.0.1 22",
    SSH_TTY: "/dev/pts/3",
  });

  expect(env).toEqual({ HOME: "/home/me", PATH: "/usr/bin" });
});

test("keeps an agent that outlives the session", () => {
  const env = createDaemonEnvironment({
    SSH_AUTH_SOCK: "/run/user/1000/keyring/ssh",
    SSH_CONNECTION: "10.0.0.2 5555 10.0.0.1 22",
  });

  expect(env.SSH_AUTH_SOCK).toBe("/run/user/1000/keyring/ssh");
});

test("leaves a local (non-SSH) launch alone", () => {
  const env = createDaemonEnvironment({
    SSH_AUTH_SOCK: "/tmp/ssh-XYZ123/agent.4242",
  });

  expect(env.SSH_AUTH_SOCK).toBe("/tmp/ssh-XYZ123/agent.4242");
});
