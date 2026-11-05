// Each new TLS socket proves possession of the pinned installation key before
// the Agent gives that socket to a credential-bearing HTTP or WebSocket request.
// Checking on this very socket closes the gap between proof and an endpoint
// being reassigned. TLS certificate validation remains mandatory throughout.
import { createPublicKey, randomBytes, verify } from "node:crypto";
import https from "node:https";
import { Readable } from "node:stream";
import tls from "node:tls";
import { fingerprintOf } from "../host/identity.js";
import { hostProtocolProblem } from "../host/protocol.js";
import { hostProofMessage } from "../shared/host-proof.js";

const fatal = (message) => Object.assign(new Error(message), { fatal: true });

export function httpsOrigin(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw fatal("Use an HTTPS origin with no path, query, or credentials.");
  return url.origin;
}

export function createVerifiedHttps({
  origin,
  expectedIdentity = null,
  knownIdentities = [],
  onLost = () => {},
  ca,
}) {
  origin = httpsOrigin(origin);
  let identity = expectedIdentity;
  let descriptor = null;
  let closed = false;
  const verifying = new Map();
  const agent = new https.Agent({
    keepAlive: true,
    maxSockets: 8,
    maxFreeSockets: 2,
  });
  agent.createConnection = (options, callback) => {
    const socket = tls.connect({ ...options, ca, rejectUnauthorized: true });
    let completed = false;
    const deadline = setTimeout(
      () => finish(new Error("Timed out verifying the HTTPS host.")),
      15_000,
    );
    const finish = (error) => {
      if (completed) return;
      completed = true;
      clearTimeout(deadline);
      verifying.delete(socket);
      socket.setTimeout(0);
      socket.removeListener("error", fail);
      if (error || closed) {
        socket.destroy();
        callback(error ?? new Error("The route was closed."));
      } else callback(null, socket);
    };
    const fail = (error) => finish(error);
    verifying.set(socket, finish);
    socket.once("error", fail);
    socket.setTimeout(15_000, () =>
      finish(new Error("Timed out verifying the HTTPS host.")),
    );
    socket.once("secureConnect", () => {
      if (!socket.authorized)
        return finish(fatal("The HTTPS certificate could not be verified."));
      const nonce = randomBytes(32).toString("base64url");
      // Use a bounded HTTP/1.1 proof exchange before handing this socket to
      // Node's HTTP parser. No second Agent or request owns the socket during
      // the handoff (Electron and Node release HTTP sockets differently).
      const body = JSON.stringify({ nonce, audience: origin });
      let received = Buffer.alloc(0);
      const readProof = (chunk) => {
        try {
          received = Buffer.concat([received, chunk]);
          if (received.length > 65_536)
            throw fatal("The host proof is too large.");
          const boundary = received.indexOf("\r\n\r\n");
          if (boundary < 0) return;
          const lines = received
            .subarray(0, boundary)
            .toString("latin1")
            .split("\r\n");
          if (!/^HTTP\/1\.[01] 200(?: |$)/.test(lines.shift()))
            throw fatal(
              "The HTTPS host cannot prove its identity. Update the host and check its remote access origin.",
            );
          const headers = new Map(
            lines.map((line) => {
              const colon = line.indexOf(":");
              if (colon < 1)
                throw fatal("Invalid host proof response headers.");
              return [
                line.slice(0, colon).toLowerCase(),
                line
                  .slice(colon + 1)
                  .trim()
                  .toLowerCase(),
              ];
            }),
          );
          if (
            headers.get("connection") === "close" ||
            headers.has("content-encoding")
          )
            throw fatal(
              "The HTTPS proxy must allow an uncompressed persistent host proof connection.",
            );
          const content = received.subarray(boundary + 4);
          let payload;
          if (headers.get("transfer-encoding") === "chunked") {
            let offset = 0;
            const chunks = [];
            for (;;) {
              const lineEnd = content.indexOf("\r\n", offset);
              if (lineEnd < 0) return;
              const sizeText = content
                .subarray(offset, lineEnd)
                .toString("ascii");
              if (!/^[0-9a-fA-F]{1,8}$/.test(sizeText))
                throw fatal("Invalid host proof framing.");
              const size = Number.parseInt(sizeText, 16);
              offset = lineEnd + 2;
              if (size > 32_768) throw fatal("The host proof is too large.");
              if (content.length < offset + size + 2) return;
              if (
                content
                  .subarray(offset + size, offset + size + 2)
                  .toString() !== "\r\n"
              )
                throw fatal("Invalid host proof framing.");
              if (size === 0) {
                if (content.length !== offset + 2)
                  throw fatal("Unexpected bytes after the host proof.");
                payload = Buffer.concat(chunks);
                break;
              }
              chunks.push(content.subarray(offset, offset + size));
              offset += size + 2;
            }
          } else {
            const length = headers.get("content-length");
            if (!length || !/^\d+$/.test(length) || Number(length) > 32_768)
              throw fatal(
                "The HTTPS proxy returned invalid host proof framing.",
              );
            if (content.length < Number(length)) return;
            if (content.length !== Number(length))
              throw fatal("Unexpected bytes after the host proof.");
            payload = content;
          }
          const result = JSON.parse(payload.toString());
          const host = result.host;
          identity ??=
            knownIdentities.find((known) => known.hostId === host?.hostId) ??
            null;
          const key = createPublicKey({
            key: Buffer.from(host.publicKey, "base64"),
            type: "spki",
            format: "der",
          });
          if (
            key.asymmetricKeyType !== "ed25519" ||
            typeof host.hostId !== "string" ||
            !host.hostId ||
            fingerprintOf(key.export({ type: "spki", format: "der" })) !==
              host.fingerprint ||
            result.nonce !== nonce ||
            result.audience !== origin ||
            !verify(
              null,
              Buffer.from(hostProofMessage({ nonce, audience: origin, host })),
              key,
              Buffer.from(result.signature, "base64"),
            )
          )
            throw fatal("The HTTPS host's identity proof is invalid.");
          if (
            identity &&
            (identity.hostId !== host.hostId ||
              (identity.fingerprint &&
                identity.fingerprint !== host.fingerprint))
          )
            throw fatal(
              "This HTTPS route reaches a different host than the saved connection. No device credential was sent.",
            );
          const problem = hostProtocolProblem(host.hostProtocolVersion);
          if (problem) throw fatal(problem);
          identity = { hostId: host.hostId, fingerprint: host.fingerprint };
          descriptor = host;
          socket.removeListener("data", readProof);
          finish();
        } catch (error) {
          socket.removeListener("data", readProof);
          finish(
            error.fatal
              ? error
              : fatal("The HTTPS host returned an invalid identity proof."),
          );
        }
      };
      socket.on("data", readProof);
      socket.write(
        `POST /api/remote/proof HTTP/1.1\r\nHost: ${new URL(origin).host}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: keep-alive\r\n\r\n${body}`,
      );
    });
    // Asynchronous Agent creation: the caller must not use the socket yet.
    return undefined;
  };

  const request = (url, init = {}) =>
    new Promise((resolve, reject) => {
      const target = new URL(url);
      if (target.origin !== origin || target.username || target.password)
        return reject(
          fatal("A device credential cannot leave its verified HTTPS origin."),
        );
      if (closed) return reject(new Error("The route was closed."));
      const req = https.request(
        target,
        {
          agent,
          method: init.method ?? "GET",
          headers: Object.fromEntries(new Headers(init.headers)),
          signal: init.signal,
        },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400) {
            res.resume();
            reject(
              fatal(
                "HTTPS host redirects are refused. Edit the route to use its final origin.",
              ),
            );
            return;
          }
          const headers = new Headers();
          for (let i = 0; i < res.rawHeaders.length; i += 2)
            headers.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
          const status = res.statusCode;
          resolve(
            new Response(
              [204, 205, 304].includes(status) || init.method === "HEAD"
                ? null
                : Readable.toWeb(res),
              { status, headers },
            ),
          );
        },
      );
      req.once("error", (error) => {
        if (!closed && !init.signal?.aborted) onLost(error);
        reject(error);
      });
      if (init.body?.getReader)
        Readable.fromWeb(init.body)
          .on("error", (error) => req.destroy(error))
          .pipe(req);
      else req.end(init.body);
    });

  return {
    agent,
    request,
    getDescriptor: () => descriptor,
    close() {
      closed = true;
      for (const finish of verifying.values())
        finish(new Error("The route was closed."));
      agent.destroy();
    },
  };
}

/** The host's reason for refusing, as it worded it (plain text), or null. */
const refusal = async (response) => {
  const text = (await response.text().catch(() => "")).trim();
  return text ? text.slice(0, 300) : null;
};

export function createHttpsRoutes({
  credentials,
  ca,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  /** Stores the session a verified host issued as this device's credential. */
  const keepSession = (transport, origin, result) => {
    if (typeof result?.token !== "string" || !result.session)
      throw fatal("The host did not issue a device session.");
    const host = transport.getDescriptor();
    const credentialId = credentials.put({
      origin,
      token: result.token,
      hostId: host.hostId,
      fingerprint: host.fingerprint,
    });
    return { credentialId, origin, host };
  };

  return {
    /**
     * Pairs with a short code created on the host (Settings > Sharing &
     * access, or `dream-host pair`): the host proves who it is on this
     * connection, then redeems the code for this desktop's session at once.
     * `signal` stops an attempt in flight.
     */
    async pairWithCode({
      address,
      code,
      deviceName,
      expectedIdentity,
      knownIdentities,
      signal,
    }) {
      credentials.check?.();
      let origin;
      try {
        origin = httpsOrigin(new URL(address).origin);
      } catch {
        throw fatal("Enter the host's HTTPS address.");
      }
      const transport = createVerifiedHttps({
        origin,
        expectedIdentity,
        knownIdentities,
        ca,
      });
      try {
        const response = await transport.request(
          `${origin}/api/remote/pair/code`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ code, deviceName, clientKind: "native" }),
            signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
          },
        );
        if (!response.ok)
          throw fatal(
            (await refusal(response)) ??
              `Pairing was refused (${response.status}).`,
          );
        return keepSession(transport, origin, await response.json());
      } finally {
        transport.close();
      }
    },
    async open(route, { signal, expectedIdentity, onLost }) {
      let grant;
      try {
        grant = credentials.get(route.credentialId);
      } catch (error) {
        error.fatal = true;
        throw error;
      }
      const origin = httpsOrigin(route.origin);
      if (
        grant.origin !== origin ||
        (expectedIdentity &&
          (grant.hostId !== expectedIdentity.hostId ||
            (expectedIdentity.fingerprint &&
              grant.fingerprint !== expectedIdentity.fingerprint)))
      )
        throw fatal(
          "This route's device credential belongs to another origin or host. Pair it again.",
        );
      const transport = createVerifiedHttps({
        origin,
        expectedIdentity: grant,
        onLost,
        ca,
      });
      let timer;
      const close = () => {
        clearTimer(timer);
        signal.removeEventListener("abort", close);
        transport.close();
      };
      signal.addEventListener("abort", close, { once: true });
      const request = async (url, init = {}) => {
        const headers = new Headers(init.headers);
        headers.delete("x-dream-api-token");
        headers.delete("cookie");
        headers.set("authorization", `Bearer ${grant.token}`);
        const response = await transport.request(url, { ...init, headers });
        if (response.status === 401 || response.status === 403)
          onLost(
            fatal(
              "This device's grant was revoked, expired, or lacks access. Pair again on the host.",
            ),
          );
        return response;
      };
      const check = async () => {
        const response = await request(`${origin}/api/remote/session/renew`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
          signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        });
        if (!response.ok)
          throw Object.assign(
            new Error(`The HTTPS route refused access (${response.status}).`),
            { fatal: response.status === 401 || response.status === 403 },
          );
        await response.body?.cancel();
      };
      try {
        signal.throwIfAborted();
        await check();
        const response = await request(`${origin}/api/catalog`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
          signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        });
        if (!response.ok)
          throw new Error(
            `The HTTPS route's catalog is unavailable (${response.status}).`,
          );
        const catalog = await response.json();
        if (
          catalog.host?.hostId !== grant.hostId ||
          catalog.host?.fingerprint !== grant.fingerprint
        )
          throw fatal("The HTTPS catalog does not match its verified host.");
        const poll = () => {
          timer = setTimer(() => {
            void check().then(poll, onLost);
          }, 15_000);
          timer.unref?.();
        };
        poll();
        const host = transport.getDescriptor();
        return {
          endpoint: {
            ...host,
            baseUrl: origin,
            routeId: route.id,
            fetch: request,
            socketOptions: { agent: transport.agent },
          },
          close,
        };
      } catch (error) {
        close();
        throw error;
      }
    },
    forget: (credentialId) => credentials.remove(credentialId),
  };
}
