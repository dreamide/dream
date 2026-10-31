import { expect, it } from "vitest";
import { describeHostSettings } from "./settings-report.js";

it("reports who the host is and where it is reached", () => {
  expect(
    describeHostSettings({
      access: { origin: "https://devbox.ts.net" },
      descriptor: { fingerprint: "SHA256:x", hostId: "host_1" },
      localPort: 4100,
      name: "devbox",
      owner: "user",
      pid: 7,
      startedAt: "now",
      version: "1.0.0",
    }),
  ).toEqual({
    host: {
      fingerprint: "SHA256:x",
      hostId: "host_1",
      local: "http://127.0.0.1:4100",
      name: "devbox",
      owner: "user",
      pid: 7,
      remote: "https://devbox.ts.net",
      startedAt: "now",
      version: "1.0.0",
    },
  });
});
