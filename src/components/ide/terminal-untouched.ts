// Tracks terminal sessions that were started automatically when the terminal
// panel was opened and have not received any user input yet. Those sessions
// are closed when the panel is closed so idle shells don't pile up.

const untouchedSessionIds = new Set<string>();

// xterm.js emits some data through onData without any user action: replies to
// cursor position / device attribute / mode queries, focus in/out reports and
// OSC/DCS query responses. None of those count as user input.
const AUTOMATIC_TERMINAL_RESPONSE_PATTERN =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escape sequences
  /\x1b\[(?:\??\d+;\d+R|[?>=]?[\d;]*c|[IO]|\??[\d;]*\$y|[\d;]*t|\??\d*n)|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\/g;

export const isUserTerminalInput = (data: string) =>
  data.replace(AUTOMATIC_TERMINAL_RESPONSE_PATTERN, "").length > 0;

export const markTerminalSessionUntouched = (sessionId: string) => {
  untouchedSessionIds.add(sessionId);
};

export const markTerminalSessionTouched = (sessionId: string) => {
  untouchedSessionIds.delete(sessionId);
};

export const isTerminalSessionUntouched = (sessionId: string) =>
  untouchedSessionIds.has(sessionId);
