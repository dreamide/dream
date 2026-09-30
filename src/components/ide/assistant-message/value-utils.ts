export {
  getNumberFromPaths,
  getStringFromPaths,
  isRecord,
} from "../../../../electron/shared/tool-call.js";

export const isString = (value: unknown): value is string =>
  typeof value === "string";
