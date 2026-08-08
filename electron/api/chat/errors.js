export const formatStreamError = (error) => {
  if (error == null) return "An unknown error occurred.";
  if (typeof error === "string") return error || "An unknown error occurred.";
  if (typeof error !== "object") {
    return String(error) || "An unknown error occurred.";
  }

  const details = [];
  const isGeneric = (s) =>
    !s || s === "Error" || s === "error" || s === "Unknown error";

  const rawErrorData =
    error.data && typeof error.data === "object" ? error.data : null;
  const statusCode =
    error.statusCode ??
    error.status ??
    rawErrorData?.statusCode ??
    rawErrorData?.status;
  if (statusCode) details.push(`[${statusCode}]`);

  const msg = error.message;
  if (!isGeneric(msg)) {
    details.push(msg);
  }

  if (typeof error.stderr === "string" && error.stderr.trim().length > 0) {
    details.push(error.stderr.trim());
  }

  const errData = rawErrorData?.error ?? rawErrorData;
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

  const responseBody = error.responseBody ?? rawErrorData?.responseBody;
  if (typeof responseBody === "string" && responseBody.length > 0) {
    try {
      const body = JSON.parse(responseBody);
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
      const trimmed = responseBody.trim();
      if (trimmed.length > 0 && trimmed.length < 500 && trimmed !== msg) {
        details.push(trimmed);
      }
    }
  }

  let cause = error.cause;
  const seen = new Set();
  while (cause && !seen.has(cause)) {
    seen.add(cause);
    const causeMsg =
      cause instanceof Error
        ? cause.message
        : typeof cause?.message === "string"
          ? cause.message
          : "";
    const causeCode =
      typeof cause?.code === "string" && !causeMsg.includes(cause.code)
        ? cause.code
        : "";
    const causeLocation =
      typeof cause?.address === "string" && !causeMsg.includes(cause.address)
        ? `${cause.address}${cause.port ? `:${cause.port}` : ""}`
        : "";
    const causeDetail = [causeMsg, causeCode, causeLocation]
      .filter(Boolean)
      .join(" ");
    if (!isGeneric(causeDetail) && causeDetail !== msg) {
      details.push(causeDetail);
      break;
    }
    cause = cause?.cause;
  }

  if (details.length > 0) return Array.from(new Set(details)).join(" — ");

  return "An unexpected error occurred. Check the server console for details.";
};
