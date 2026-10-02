import { afterEach, expect, test, vi } from "vitest";

const forwardHostPort = vi.fn(async (_hostId: string, port: number) =>
  port === 3000 ? 49152 : 49153,
);

vi.stubGlobal("window", { dream: { forwardHostPort, isElectron: true } });

const { fromLoadedText, fromLoadedUrl, isLoopbackUrl, toLoadableUrl } =
  await import("./host-ports");

afterEach(() => forwardHostPort.mockClear());

test("only a loopback URL of an SSH-host project goes through a forward", async () => {
  expect(isLoopbackUrl("http://localhost:3000/")).toBe(true);
  expect(isLoopbackUrl("https://example.com/")).toBe(false);
  expect(await toLoadableUrl(undefined, "http://localhost:3000/")).toBe(
    "http://localhost:3000/",
  );
  expect(await toLoadableUrl("devbox", "https://example.com/a")).toBe(
    "https://example.com/a",
  );
  expect(forwardHostPort).not.toHaveBeenCalled();
});

test("the host's localhost loads through its forward and reads back as itself", async () => {
  const loaded = await toLoadableUrl("devbox", "http://localhost:3000/a?b=1");

  expect(loaded).toBe("http://127.0.0.1:49152/a?b=1");
  expect(fromLoadedUrl("http://127.0.0.1:49152/next")).toBe(
    "http://localhost:3000/next",
  );
  // An address that is not a forward is left alone.
  expect(fromLoadedUrl("http://127.0.0.1:5173/")).toBe(
    "http://127.0.0.1:5173/",
  );

  // A port forwarded once is reused.
  await toLoadableUrl("devbox", "http://localhost:3000/other");
  expect(forwardHostPort).toHaveBeenCalledTimes(1);
});

test("a browser tool's report names the host's addresses, not the forwards", async () => {
  await toLoadableUrl("devbox", "http://localhost:3000/");

  expect(
    fromLoadedText(
      "devbox",
      "tab t1 · http://127.0.0.1:49152/login → 200, see http://127.0.0.1:5173/",
    ),
  ).toBe(
    "tab t1 · http://localhost:3000/login → 200, see http://127.0.0.1:5173/",
  );
  // Another host's forward is not this host's address.
  expect(fromLoadedText("other", "http://127.0.0.1:49152/")).toBe(
    "http://127.0.0.1:49152/",
  );
});
