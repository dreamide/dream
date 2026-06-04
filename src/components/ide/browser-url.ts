const BARE_HOST_WITH_PORT_PATTERN =
  /^(?:\[[0-9a-f:.]+\]|[a-z0-9.-]+):\d{1,5}(?:[/?#].*)?$/i;
const LOCAL_HOST_PATTERN =
  /^(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|\[[0-9a-f:.]+\]|[^/?#]+\.local)(?:[/?#].*)?$/i;
const URL_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z\d+.-]*:/;

export const normalizeBrowserUrlInput = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  if (BARE_HOST_WITH_PORT_PATTERN.test(trimmed)) {
    return `http://${trimmed}`;
  }

  if (trimmed === "::1") {
    return "http://[::1]";
  }

  if (trimmed.startsWith("::1/")) {
    return `http://[::1]${trimmed.slice(3)}`;
  }

  if (LOCAL_HOST_PATTERN.test(trimmed)) {
    return `http://${trimmed}`;
  }

  if (URL_SCHEME_PATTERN.test(trimmed)) {
    return trimmed;
  }

  return `https://${trimmed}`;
};
