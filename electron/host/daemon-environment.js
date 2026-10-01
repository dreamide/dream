// The environment a detached daemon starts with. It outlives the SSH
// session that launched it, so variables that only make sense for that
// session are dropped: the session's own SSH variables, and an agent socket
// forwarded into it (`/tmp/ssh-XXXX/agent.N`), which dies with the session
// and would leave every later `git push` from an agent failing (t3code
// #11872). An agent socket that is not a forwarded one (a keyring or
// launchd agent) is kept.

const SESSION_VARIABLES = ["SSH_CLIENT", "SSH_CONNECTION", "SSH_TTY"];
const FORWARDED_AGENT_SOCKET = /(^|\/)ssh-[^/]+\/agent\.\d+$/;

export function createDaemonEnvironment(env = process.env) {
  const next = { ...env };
  const inSshSession = Boolean(env.SSH_CONNECTION || env.SSH_CLIENT);

  for (const name of SESSION_VARIABLES) delete next[name];

  if (
    inSshSession &&
    typeof env.SSH_AUTH_SOCK === "string" &&
    FORWARDED_AGENT_SOCKET.test(env.SSH_AUTH_SOCK)
  ) {
    delete next.SSH_AUTH_SOCK;
  }

  return next;
}
