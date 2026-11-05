// Every option a host starts with, in one table: its flag, its environment
// variable, its default, and what it is for. `dream-host serve` and `ensure`
// read them here, the desktop starts its own host through them, and
// `dream-host --help` and the options table in docs/host-service.md are
// generated from them (a test keeps the docs in step).
//
// A value comes from the first of these that has one:
//
//   flag       --idle-timeout 0
//   env        DREAM_HOST_IDLE_TIMEOUT=0
//   saved      a setting the host keeps in its data (remote access), applied
//              by the host itself (host/remote-access/)
//   default    the table's
//
// The source of each value is kept: remote access set by a flag or an
// environment variable reports where it came from, and Settings shows it
// read-only.
import os from "node:os";
import path from "node:path";

/** Where a value came from, strongest first. */
export const OPTION_SOURCES = Object.freeze([
  "flag",
  "env",
  "saved",
  "default",
]);

const TRUE_WORDS = new Set(["1", "true", "yes", "on"]);
const FALSE_WORDS = new Set(["0", "false", "no", "off", ""]);

export class HostOptionError extends Error {
  constructor(message) {
    super(message);
    this.name = "HostOptionError";
  }
}

const parsers = {
  path: (value) => path.resolve(String(value)),
  port: (value) => {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
      throw new Error("a port number from 0 to 65535");
    }
    return port;
  },
  seconds: (value) => {
    const seconds = Number(value);
    if (
      String(value).trim() === "" ||
      !Number.isFinite(seconds) ||
      seconds < 0
    ) {
      throw new Error("a number of seconds, 0 or more");
    }
    return seconds;
  },
  boolean: (value) => {
    if (typeof value === "boolean") return value;
    const word = String(value).trim().toLowerCase();
    if (TRUE_WORDS.has(word)) return true;
    if (FALSE_WORDS.has(word)) return false;
    throw new Error("true or false");
  },
  origins: (value) =>
    (Array.isArray(value) ? value : String(value).split(","))
      .map((origin) => String(origin).trim())
      .filter(Boolean)
      .map((origin) => {
        let url;
        try {
          url = new URL(origin);
        } catch {
          throw new Error("http(s) origins such as https://host.example");
        }
        if (!/^https?:$/.test(url.protocol)) {
          throw new Error("http(s) origins such as https://host.example");
        }
        return url.origin;
      }),
  owner: (value) => {
    const owner = String(value);
    if (owner !== "user" && owner !== "desktop") {
      throw new Error("user or desktop");
    }
    return owner;
  },
};

/**
 * The host's options. `default` is a value or a function of the options
 * resolved before it (in table order) and the context.
 * @type {readonly {
 *   name: string,
 *   flag: string,
 *   env: string,
 *   aliases?: string[],
 *   type: keyof typeof parsers,
 *   default: unknown,
 *   defaultText: string,
 *   saved?: string,
 *   description: string,
 * }[]}
 */
export const HOST_OPTIONS = Object.freeze([
  {
    name: "home",
    flag: "home",
    env: "DREAM_HOST_HOME",
    type: "path",
    default: () => path.join(os.homedir(), ".dream", "host"),
    defaultText: "~/.dream/host",
    description:
      "The host's home: its run record (port, token) and log, and by default its data.",
  },
  {
    name: "dataDir",
    flag: "data-dir",
    env: "DREAM_HOST_DATA_DIR",
    type: "path",
    default: (options) => path.join(options.home, "data"),
    defaultText: "<home>/data",
    description:
      "The host's data: its identity, settings and, by default, its database. The desktop's data directory makes it the desktop's host.",
  },
  {
    name: "database",
    flag: "database",
    env: "DREAM_HOST_DATABASE",
    aliases: ["DREAM_DB_PATH"],
    type: "path",
    default: (options) => path.join(options.dataDir, "dream.db"),
    defaultText: "<data dir>/dream.db",
    description:
      "The state database: projects, chats and transcripts. One host runs per database.",
  },
  {
    name: "port",
    flag: "port",
    env: "DREAM_HOST_PORT",
    type: "port",
    default: 0,
    defaultText: "a free port",
    description:
      "The loopback port of the host's local API, for this machine's clients.",
  },
  {
    name: "idleTimeout",
    flag: "idle-timeout",
    env: "DREAM_HOST_IDLE_TIMEOUT",
    type: "seconds",
    default: 3600,
    defaultText: "3600",
    description:
      "Seconds with nothing going on (no client, terminal, turn or remote access) before the host exits; 0 never exits.",
  },
  {
    name: "remotePort",
    flag: "remote-port",
    env: "DREAM_HOST_REMOTE_PORT",
    type: "port",
    default: null,
    defaultText: "remote access as saved",
    saved: "remoteAccess",
    description:
      "Serve paired devices on this loopback port, for a reverse proxy you run. Overrides the saved remote access setting.",
  },
  {
    name: "remoteOrigins",
    flag: "remote-origin",
    env: "DREAM_HOST_REMOTE_ORIGINS",
    type: "origins",
    default: () => [],
    defaultText: "none",
    saved: "remoteAccess",
    description:
      "The public origin(s) the reverse proxy serves the remote port at. Repeat the flag, or separate them with commas.",
  },
  {
    name: "trustForwardedHost",
    flag: "trust-forwarded-host",
    env: "DREAM_HOST_TRUST_FORWARDED_HOST",
    type: "boolean",
    default: false,
    defaultText: "false",
    saved: "remoteAccess",
    description: "Let the reverse proxy name the host in X-Forwarded-Host.",
  },
  {
    name: "clientDir",
    flag: "client-dir",
    env: "DREAM_HOST_CLIENT_DIR",
    type: "path",
    default: (_options, context) => context.clientDirectory,
    defaultText: "the runtime's browser client",
    description: "The browser client the host serves to paired devices.",
  },
  {
    name: "owner",
    flag: "owner",
    env: "DREAM_HOST_OWNER",
    type: "owner",
    default: "user",
    defaultText: "user",
    description:
      "Who started the host: user, or desktop for the host a desktop starts and stops itself.",
  },
  {
    name: "diagnostics",
    flag: "diagnostics",
    env: "DREAM_HOST_DIAGNOSTICS",
    type: "boolean",
    default: false,
    defaultText: "false",
    description: "Serve terminal flow-control diagnostics (development).",
  },
]);

const byName = new Map(HOST_OPTIONS.map((option) => [option.name, option]));

/** The table's options as `node:util` parseArgs options. */
export const hostParseArgsOptions = () =>
  Object.fromEntries(
    HOST_OPTIONS.map((option) => [
      option.flag,
      option.type === "boolean"
        ? { type: "boolean" }
        : option.type === "origins"
          ? { multiple: true, type: "string" }
          : { type: "string" },
    ]),
  );

const present = (value) =>
  value !== undefined &&
  value !== null &&
  !(Array.isArray(value) && value.length === 0);

/**
 * Resolves every option from parsed flags (`values`, as parseArgs gives
 * them), the environment and the defaults.
 * @param {{
 *   values?: Record<string, unknown>,
 *   env?: NodeJS.ProcessEnv,
 *   context?: { clientDirectory?: string | null },
 * }} [input]
 * @returns {{
 *   options: Record<string, any>,
 *   sources: Record<string, "flag" | "env" | "default">,
 *   from: Record<string, string | null>,
 * }} `from` names the flag (`--port`) or variable that set each value;
 *   null for a default.
 * @throws {HostOptionError} naming the flag or variable whose value is invalid
 */
export function resolveHostOptions({
  values = {},
  env = process.env,
  context = {},
} = {}) {
  const options = {};
  const sources = {};
  const from = {};
  for (const option of HOST_OPTIONS) {
    let raw;
    let source;
    let origin;
    if (present(values[option.flag])) {
      raw = values[option.flag];
      source = "flag";
      origin = `--${option.flag}`;
    } else {
      const variable = [option.env, ...(option.aliases ?? [])].find(
        (name) => typeof env[name] === "string" && env[name].trim() !== "",
      );
      if (variable) {
        raw = env[variable];
        source = "env";
        origin = variable;
      }
    }
    if (source) {
      try {
        options[option.name] = parsers[option.type](raw);
      } catch (error) {
        throw new HostOptionError(
          `Invalid ${origin}: ${JSON.stringify(raw)} (expected ${error.message}).`,
        );
      }
    } else {
      source = "default";
      options[option.name] =
        typeof option.default === "function"
          ? option.default(options, context)
          : option.default;
    }
    sources[option.name] = source;
    from[option.name] = origin ?? null;
  }
  return { from, options, sources };
}

/**
 * The flags that give a `serve` these values: what `ensure` and the desktop
 * pass to the host they start. Only the named options are written; the
 * others come from the started host's own environment and defaults.
 * @param {Record<string, unknown>} options by option name
 */
export function hostOptionFlags(options) {
  const args = [];
  for (const [name, value] of Object.entries(options)) {
    const option = byName.get(name);
    if (!option) throw new Error(`Unknown host option: ${name}`);
    if (!present(value)) continue;
    if (option.type === "boolean") {
      if (value === true) args.push(`--${option.flag}`);
    } else if (option.type === "origins") {
      for (const origin of value) args.push(`--${option.flag}`, String(origin));
    } else {
      args.push(`--${option.flag}`, String(value));
    }
  }
  return args;
}

/** The flags of `values` (as parseArgs gives them) that are host options. */
export const passHostFlags = (values) =>
  hostOptionFlags(
    Object.fromEntries(
      HOST_OPTIONS.filter((option) => present(values[option.flag])).map(
        (option) => [option.name, values[option.flag]],
      ),
    ),
  );

/** One line per option, for `dream-host --help`. */
export function renderHostOptionsHelp() {
  const lines = [];
  for (const option of HOST_OPTIONS) {
    const value =
      option.type === "boolean"
        ? ""
        : option.type === "origins"
          ? " <origin>"
          : option.type === "path"
            ? " <path>"
            : option.type === "owner"
              ? " <user|desktop>"
              : " <n>";
    lines.push(`  --${option.flag}${value}`);
    lines.push(
      `      ${option.env}${option.aliases ? ` (or ${option.aliases.join(", ")})` : ""}; default ${option.defaultText}`,
    );
    lines.push(`      ${option.description}`);
  }
  return lines.join("\n");
}

/** The options as a Markdown table, for docs/host-service.md. */
export function renderHostOptionsMarkdown() {
  const rows = HOST_OPTIONS.map((option) => {
    const env = [option.env, ...(option.aliases ?? [])]
      .map((name) => `\`${name}\``)
      .join(", ");
    // Paths and literal values as code; prose defaults as prose.
    const fallback = /[<~/]|^\d+$|^(true|false|user)$/.test(option.defaultText)
      ? `\`${option.defaultText}\``
      : option.defaultText;
    return `| \`--${option.flag}\` | ${env} | ${fallback} | ${option.description} |`;
  });
  return [
    "| Flag | Environment variable | Default | What it is |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}
