// Public entry point for the API client library.

export { NO_VALUE_SENTINEL, PegelOnlineClient, stationListNotes } from "./client.js";
export type { StationListNote } from "./client.js";
export {
  RequestEngine,
  DEFAULT_BASE_URL,
  MAX_RETRIES,
  MAX_RETRY_AFTER_MS,
  isTransientNetworkError,
  parseRetryAfter,
  validateBaseUrl,
} from "./engine.js";
export type { EngineOptions, RawResponse } from "./engine.js";
export { MAX_TIMEOUT_MS, nodeHttpTransport } from "./http.js";
export type { Transport, HttpRequest, HttpResponse } from "./http.js";
export { buildQueryString } from "./query.js";
export type { QueryParams, QueryValue } from "./query.js";
export {
  PegelError,
  PegelApiError,
  PegelNetworkError,
  PegelParseError,
  PegelValidationError,
  redactUrl,
  credentialsIn,
  redactCredentials,
} from "./errors.js";
export {
  assertValid,
  baseUrlProblem,
  baseUrlWhitespaceProblem,
  headerValueProblem,
  idListProblem,
  isBlank,
  knownKeysProblem,
  nonEmptyProblem,
  normalizeInput,
  optionalBooleanProblem,
} from "./validate.js";
export type { Problem } from "./validate.js";

export * from "./types.js";
