export const formatStreamError = (error) => {
  if (error == null) return "An unknown error occurred.";
  if (typeof error === "string") return error || "An unknown error occurred.";
  if (typeof error !== "object") {
    return String(error) || "An unknown error occurred.";
  }

  const details = [];
  const isGeneric = (s) =>
    !s || s === "Error" || s === "error" || s === "Unknown error";

  const statusCode = error.statusCode ?? error.status;
  if (statusCode) details.push(`[${statusCode}]`);

  const msg = error.message;
  if (!isGeneric(msg)) {
    details.push(msg);
  }

  if (typeof error.stderr === "string" && error.stderr.trim().length > 0) {
    details.push(error.stderr.trim());
  }

  const errData = error.data?.error ?? error.data;
  if (errData && typeof errData === "object") {
    const errType = errData.type ?? errData.code;
    if (typeof errType === "string" && errType.length > 0) {
      details.push(errType.replaceAll("_", " "));
    }
    const errMsg = errData.message;
    if (typeof errMsg === "string" && !isGeneric(errMsg) && errMsg !== msg) {
      details.push(errMsg);
    }
  }

  if (
    details.length <= 1 &&
    typeof error.responseBody === "string" &&
    error.responseBody.length > 0
  ) {
    try {
      const body = JSON.parse(error.responseBody);
      const bodyErrType = body?.error?.type ?? body?.error?.code;
      const bodyMsg =
        body?.error?.message ?? body?.message ?? body?.error_description;
      if (typeof bodyErrType === "string" && bodyErrType.length > 0) {
        details.push(bodyErrType.replaceAll("_", " "));
      }
      if (
        typeof bodyMsg === "string" &&
        !isGeneric(bodyMsg) &&
        bodyMsg !== msg
      ) {
        details.push(bodyMsg);
      }
    } catch {
      const trimmed = error.responseBody.trim();
      if (trimmed.length > 0 && trimmed.length < 500 && trimmed !== msg) {
        details.push(trimmed);
      }
    }
  }

  let cause = error.cause;
  const seen = new Set();
  while (cause && !seen.has(cause)) {
    seen.add(cause);
    const causeMsg = cause instanceof Error ? cause.message : String(cause);
    if (!isGeneric(causeMsg) && causeMsg !== msg) {
      details.push(causeMsg);
      break;
    }
    cause = cause?.cause;
  }

  if (details.length > 0) return details.join(" — ");

  return "An unexpected error occurred. Check the server console for details.";
};
