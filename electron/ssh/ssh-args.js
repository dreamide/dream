// The argument lists Dream hands to the system's OpenSSH client. Pure, so
// what Dream asks ssh to do is visible (and tested) in one place.
//
// Two shapes, by whether the client can multiplex (ControlMaster: OpenSSH on
// macOS and Linux, not Windows):
//
//   multiplexed   a master connection holds the one authentication; the
//                 daemon command and the port forward go through it, so a
//                 password or 2FA prompt appears once, and the forward dies
//                 with the master.
//   direct        the daemon command, then a separate ssh that holds the
//                 forward.
//
// Every session that should end with Dream runs `cat >/dev/null` on the host
// with stdin piped from Dream: when Dream exits (even by crashing) the pipe
// closes, the remote `cat` sees end-of-file, and ssh exits instead of
// leaving a stale forward behind.

/** Quotes one word for a POSIX shell (and fish). */
export const quoteShellWord = (value) =>
  `'${String(value).replaceAll("'", `'\\''`)}'`;

const KEEPALIVE_OPTIONS = [
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=3",
];

const HOLD_OPEN_COMMAND = "cat >/dev/null";

// Run by `sh` on the host: re-exec the user's login shell on the command
// passed as $1. `${SHELL:-sh}` is for that shell to expand, not JavaScript.
// biome-ignore lint/suspicious/noTemplateCurlyInString: a shell expansion.
const LOGIN_SHELL_SCRIPT = 'exec "${SHELL:-sh}" -lc "$1"';

/**
 * The command run on the host to reuse or start the daemon. It goes through
 * the user's login shell so the PATH (and version managers) match an
 * interactive login, whatever that shell is.
 * @param {string} hostCommand how to run dream-host there, e.g. `dream-host`
 */
export const buildEnsureCommand = (hostCommand) =>
  `sh -c ${quoteShellWord(LOGIN_SHELL_SCRIPT)} sh ${quoteShellWord(`${hostCommand} ensure`)}`;

/** Options every invocation carries. */
const baseOptions = ({ connectTimeoutSeconds = 15 } = {}) => [
  "-o",
  `ConnectTimeout=${connectTimeoutSeconds}`,
  // Prompts (passwords, 2FA, unknown host keys) go through askpass, never a
  // terminal Dream does not have.
  "-o",
  "BatchMode=no",
];

const controlOptions = (controlPath) => ["-S", controlPath];

/** The multiplexed master: authenticates once and holds the connection. */
export const buildMasterArgs = ({ target, controlPath, ...options }) => [
  ...baseOptions(options),
  ...KEEPALIVE_OPTIONS,
  "-M",
  ...controlOptions(controlPath),
  "-o",
  "ControlPersist=no",
  "-T",
  target,
  HOLD_OPEN_COMMAND,
];

/** Asks whether the master is up. */
export const buildMasterCheckArgs = ({ target, controlPath }) => [
  ...controlOptions(controlPath),
  "-O",
  "check",
  target,
];

/** Runs the daemon command (through the master when there is one). */
export const buildEnsureArgs = ({
  target,
  controlPath,
  hostCommand,
  ...options
}) => [
  ...baseOptions(options),
  ...(controlPath ? controlOptions(controlPath) : []),
  "-T",
  target,
  buildEnsureCommand(hostCommand),
];

const forwardSpec = ({ localPort, remotePort }) =>
  `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`;

/** Adds the forward to the master; it lives as long as the master. */
export const buildMasterForwardArgs = ({ target, controlPath, ...ports }) => [
  ...controlOptions(controlPath),
  "-O",
  "forward",
  "-L",
  forwardSpec(ports),
  target,
];

/** Without a master: one ssh that holds the forward open. */
export const buildDirectForwardArgs = ({ target, ...options }) => [
  ...baseOptions(options),
  ...KEEPALIVE_OPTIONS,
  "-o",
  "ExitOnForwardFailure=yes",
  "-L",
  forwardSpec(options),
  "-T",
  target,
  HOLD_OPEN_COMMAND,
];
