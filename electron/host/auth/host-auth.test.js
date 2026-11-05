import { expect, it } from "vitest";
import {
  AuthError,
  createHostAuth,
  LOCAL_PRINCIPAL,
  PAIRING_TTL_MS,
} from "./host-auth.js";

const setup = () => {
  let time = Date.parse("2026-10-30T12:00:00Z");
  const auth = createHostAuth({
    getReader: () => ({ read: async () => [] }),
    getWriter: () => ({ writeDeviceSession: async () => {} }),
    now: () => time,
  });
  return {
    auth,
    advance: (ms) => {
      time += ms;
    },
  };
};

it("a pairing code redeems at once for a session, and only once", async () => {
  const { auth } = setup();
  const { code, scopes } = auth.createPairing(LOCAL_PRINCIPAL, {
    scopes: ["view"],
  });
  expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  expect(scopes).toEqual(["view"]);

  const paired = await auth.redeemPairingCode({
    code: code.toLowerCase().replace("-", " "),
    deviceName: "Studio",
    clientKind: "native",
  });
  expect(paired.session).toMatchObject({
    clientKind: "native",
    deviceName: "Studio",
    scopes: ["view"],
  });
  expect(await auth.authenticate(paired.token)).not.toBeNull();

  await expect(auth.redeemPairingCode({ code })).rejects.toThrow(
    /invalid, used or expired/,
  );
});

it("an expired code is refused", async () => {
  const { auth, advance } = setup();
  const { code } = auth.createPairing(LOCAL_PRINCIPAL);
  advance(PAIRING_TTL_MS);
  await expect(auth.redeemPairingCode({ code })).rejects.toBeInstanceOf(
    AuthError,
  );
});

it("code attempts are rate limited across the host", async () => {
  const { auth, advance } = setup();
  const { code } = auth.createPairing(LOCAL_PRINCIPAL);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await expect(auth.redeemPairingCode({ code: "0000-0000" })).rejects.toThrow(
      /invalid/,
    );
  }
  await expect(auth.redeemPairingCode({ code })).rejects.toMatchObject({
    status: 429,
  });
  advance(60_000);
  await expect(auth.redeemPairingCode({ code })).resolves.toHaveProperty(
    "token",
  );
});
