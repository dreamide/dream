// The startup sequence as the window sees it: in production the renderer's
// server answers before the host listens, and holds `/api` until it does.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import getPort from "get-port";
import { afterEach, expect, test } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { createRendererServerManager } from "./renderer-server.js";

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A fake host: the API server listens only when `release()` is called. */
const gatedHost = ({ fail = false } = {}) => {
  let release;
  const released = new Promise((resolve) => {
    release = resolve;
  });
  return {
    release: () => release(),
    startApi: async ({ port }) => {
      await released;
      if (fail) throw new Error("The host could not start.");
      const server = http.createServer((request, response) => {
        let body = "";
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", () => response.end(`${request.url} ${body}`));
      });
      const sockets = new WebSocketServer({ server });
      sockets.on("connection", (socket) =>
        socket.on("message", (data) => socket.send(`echo ${data}`)),
      );
      await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
      cleanups.push(
        () =>
          new Promise((resolve) => {
            sockets.close();
            server.close(resolve);
          }),
      );
      return port;
    },
  };
};

const startManager = async (host) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dream-renderer-server-"));
  mkdirSync(path.join(root, "dist"));
  writeFileSync(path.join(root, "dist", "index.html"), "<p>window</p>");
  cleanups.push(() => rmSync(root, { force: true, recursive: true }));
  const apiServerPort = await getPort({ host: "127.0.0.1" });
  const internalRendererPort = await getPort({
    exclude: [apiServerPort],
    host: "127.0.0.1",
  });
  const manager = createRendererServerManager({
    apiServerPort,
    appDir: path.join(root, "electron"),
    developmentRendererUrl: null,
    internalRendererPort,
    isDevelopment: false,
    startApi: host.startApi,
  });
  cleanups.push(() => manager.stop());
  await manager.start();
  return manager;
};

const settledWithin = (promise, ms) =>
  Promise.race([
    promise.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), ms)),
  ]);

test("the window loads while the host starts, and its API requests wait for the host", async () => {
  const host = gatedHost();
  const manager = await startManager(host);
  const url = manager.getUrl();

  // Started, the host still starting: the window's page is served.
  expect(await (await fetch(url)).text()).toBe("<p>window</p>");

  const request = fetch(`${url}/api/catalog`, {
    body: "{}",
    method: "POST",
  }).then((response) => response.text());
  const socket = new WebSocket(`${url.replace("http", "ws")}/api/host-socket`);
  const opened = new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  expect(await settledWithin(request, 200)).toBe(false);
  expect(await settledWithin(opened, 50)).toBe(false);

  host.release();
  await manager.whenHostListening();
  // Held, then answered with its body intact.
  expect(await request).toBe("/api/catalog {}");
  await opened;
  const reply = new Promise((resolve) => socket.once("message", resolve));
  socket.send("hello");
  expect(String(await reply)).toBe("echo hello");
  socket.close();
});

test("a host that does not start answers held requests and says why", async () => {
  const host = gatedHost({ fail: true });
  const manager = await startManager(host);

  const request = fetch(`${manager.getUrl()}/api/catalog`);
  host.release();
  await expect(manager.whenHostListening()).rejects.toThrow(
    "The host could not start.",
  );
  const response = await request;
  expect(response.status).toBe(502);
  expect(await response.text()).toBe("The local host did not start.");
});
