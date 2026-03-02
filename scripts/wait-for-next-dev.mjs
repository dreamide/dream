const portArg = process.argv[2];
const port = Number(portArg ?? process.env.ELECTRON_RENDERER_PORT ?? "3210");
const timeoutMs = Number(process.env.NEXT_READY_TIMEOUT_MS ?? "45000");
const retryDelayMs = 300;
const probeTimeoutMs = 1200;
const wsUrl = `ws://127.0.0.1:${port}/_next/webpack-hmr?id=dream-healthcheck`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const probeHmrSocket = async () =>
  new Promise((resolve) => {
    let settled = false;
    const socket = new WebSocket(wsUrl);

    const finish = (ok, detail) => {
      if (settled) {
        return;
      }

      settled = true;
      try {
        socket.close();
      } catch {
        // no-op
      }

      resolve({ detail, ok });
    };

    const timer = setTimeout(() => {
      finish(false, "probe timeout");
    }, probeTimeoutMs);

    socket.onopen = () => {
      clearTimeout(timer);
      finish(true, "open");
    };

    socket.onerror = (event) => {
      clearTimeout(timer);
      finish(false, event?.message ?? "socket error");
    };

    socket.onclose = () => {
      clearTimeout(timer);
      finish(false, "socket closed before open");
    };
  });

const start = Date.now();
let lastDetail = "not started";

while (Date.now() - start < timeoutMs) {
  const result = await probeHmrSocket();
  if (result.ok) {
    console.log(`Next.js HMR ready on port ${port}.`);
    process.exit(0);
  }

  lastDetail = result.detail;
  await sleep(retryDelayMs);
}

console.error(
  `Timed out waiting for Next.js HMR on port ${port} after ${timeoutMs}ms (last error: ${lastDetail}).`,
);
process.exit(1);
