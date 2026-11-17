// @ts-check
// The home host interface: what a desktop holds as its home host, whichever
// way that host runs. Three objects provide it:
//
//   createHost                 the host in this process (host/index.js);
//                              a daemon holds it too, with two members
//                              more (its `Host` type)
//   createHomeHostAttachment   the edge listener to the home host in its
//                              own process (desktop-host.js)
//   withInProcessFallback      that attachment, or a host in this process
//                              when it cannot start (desktop-host.js)
//
// desktop-launch.js holds one of them as `host` from `prepare` to `quit`:
// the fallback over the attachment in the detached host mode, createHost in
// the in-process one. home-host.test.js checks all three against it.

/**
 * The processes a home host runs in the desktop's own process: terminals and
 * runs, which stop before the renderer that owns them unloads.
 * @typedef {object} HomeHostProcesses
 * @property {() => boolean} hasActiveSessions whether any is running.
 * @property {() => Promise<void>} stopAllProcesses stops every one; resolves
 *   when they have stopped.
 */

/**
 * A desktop's home host.
 * @typedef {object} HomeHost
 * @property {"detached" | "in-process"} mode where the host serving the
 *   desktop runs now: `detached`, another process reached through the edge
 *   listener; `in-process`, this process. Read whenever the renderer asks
 *   for the host mode (desktop-launch.js `hostMode`). The fallback's changes
 *   from `detached` to `in-process` when it falls back.
 * @property {HomeHostProcesses} processSessions the processes this desktop's
 *   process runs. Read once, at launch, for the renderer unload guard
 *   (main.js), so the object stays the same for the host's life: the
 *   fallback's forwards to whichever host serves. An attachment's is
 *   `NO_PROCESS_SESSIONS`: its host's processes run in the host's process
 *   and outlive the renderer.
 * @property {(options: { apiToken: string, port: number }) => Promise<number>} listen
 *   starts serving the host's API on loopback, guarded by `apiToken`; `port`
 *   0 picks a free one. Called once, at launch (renderer-server.js
 *   `startApi`, a daemon's `serve`); a second call rejects. Resolves with the
 *   port. An attachment first starts or finds its host and verifies it; the
 *   fallback, when that fails and nothing holds the data, closes the
 *   attachment and listens with a host in this process instead.
 * @property {() => Promise<unknown>} startRemoteAccess applies the host's
 *   remote access as saved, or as its start-up options set it. Called once,
 *   after `listen` resolves (desktop-launch.js `start`, a daemon's `serve`).
 *   A host in this process resolves with its remote access status, which a
 *   daemon logs; an attachment resolves with nothing, since its host applied
 *   its own when it started. The desktop ignores the value.
 * @property {() => Promise<void>} close stops serving, at quit
 *   (desktop-launch.js `quit`, a daemon's shutdown). A host in this process
 *   stops its processes and listeners, flushes its writes and releases its
 *   state lock; an attachment closes the edge listener and stops its host
 *   only if a desktop started it.
 */

/**
 * The processes of a home host in another process, as the desktop sees
 * them: none in its own.
 * @type {Readonly<HomeHostProcesses>}
 */
export const NO_PROCESS_SESSIONS = Object.freeze({
  hasActiveSessions: () => false,
  stopAllProcesses: async () => {},
});
