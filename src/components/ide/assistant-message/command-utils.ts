export const ANSI_ESCAPE_SEQUENCE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matches ANSI control sequences in command output
  /[\u001B\u009B][[\]()#;?]*(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]|(?:[^\u001B\u009B]*)(?:\u0007))/g;

export const stripAnsiSequences = (value: string) =>
  value.replaceAll(ANSI_ESCAPE_SEQUENCE, "");

export const unquoteCommandArgument = (value: string) => {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }

  const quote = trimmed[0];
  if (
    (quote !== '"' && quote !== "'") ||
    trimmed[trimmed.length - 1] !== quote
  ) {
    return trimmed;
  }

  const unquoted = trimmed.slice(1, -1);
  return quote === '"' ? unquoted.replace(/\\"/g, '"') : unquoted;
};

export const readShellToken = (value: string, startIndex: number) => {
  let index = startIndex;
  while (index < value.length && /\s/.test(value[index])) {
    index++;
  }

  if (index >= value.length) {
    return null;
  }

  const quote = value[index];
  if (quote === '"' || quote === "'") {
    let token = "";
    index++;
    while (index < value.length) {
      const char = value[index];
      if (char === quote) {
        return { endIndex: index + 1, token };
      }
      token += char;
      index++;
    }
    return { endIndex: index, token };
  }

  const tokenStart = index;
  while (index < value.length && !/\s/.test(value[index])) {
    index++;
  }

  return { endIndex: index, token: value.slice(tokenStart, index) };
};

export const getExecutableName = (value: string) =>
  value.split(/[\\/]/).pop()?.toLowerCase() ?? value.toLowerCase();

export const getCommandWithoutShellPrefix = (command: string) => {
  const executable = readShellToken(command, 0);
  if (!executable) {
    return command;
  }

  const executableName = getExecutableName(executable.token).replace(
    /\.exe$/i,
    "",
  );
  const isPowerShell =
    executableName === "pwsh" || executableName === "powershell";
  const isPosixShell =
    executableName === "sh" ||
    executableName === "bash" ||
    executableName === "zsh";

  if (!(isPowerShell || isPosixShell)) {
    return command;
  }

  let cursor = executable.endIndex;
  while (true) {
    const token = readShellToken(command, cursor);
    if (!token) {
      return command;
    }

    cursor = token.endIndex;
    const normalizedToken = token.token.toLowerCase();
    const isCommandFlag = isPowerShell
      ? normalizedToken === "-command" || normalizedToken === "-c"
      : /^-[a-z]*c[a-z]*$/i.test(token.token);

    if (isCommandFlag) {
      const innerCommand = command.slice(cursor).trim();
      return innerCommand ? unquoteCommandArgument(innerCommand) : command;
    }

    if (!token.token.startsWith("-")) {
      return command;
    }
  }
};

export const formatToolName = (name: string): string =>
  name
    .replace(/[-_]/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
