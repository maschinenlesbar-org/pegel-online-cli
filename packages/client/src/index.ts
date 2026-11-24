// Public entry point for the API client library.

export { MAX_IDS_QUERY_CHARS, NO_VALUE_SENTINEL, PegelOnlineClient, isUnambiguousStationId, stationListNotes } from "./client.js";
export type { StationListNote } from "./client.js";
export {
  RequestEngine,
  cleartextProblem,
  DEFAULT_BASE_URL,
  MAX_RETRIES,
  MAX_RETRY_AFTER_MS,
  isTransientNetworkError,
  parseRetryAfter,
  validateBaseUrl,
} from "./engine.js";
export type { EngineOptions, RawResponse, RetryEvent } from "./engine.js";
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
  PegelAmbiguousStationError,
  describeStationChoice,
  describeStationChoices,
  MAX_LISTED_STATIONS,
  redactUrl,
  credentialsIn,
  echoedCredentialForms,
  redactCredentials,
  redactSecrets,
  cutForMessage,
  cutText,
  quoteValue,
  serverTextForMessage,
  MAX_QUOTED_LENGTH,
  toWellFormed,
} from "./errors.js";
export {
  assertValid,
  baseUrlProblem,
  baseUrlWhitespaceProblem,
  headerValueProblem,
  idListProblem,
  idProblem,
  isBlank,
  knownKeysProblem,
  listProblem,
  nonEmptyProblem,
  normalizeInput,
  normalizeText,
  normalizeToken,
  optionalBooleanProblem,
  splitList,
  stationIdProblem,
  textProblem,
  tokenProblem,
} from "./validate.js";
export type { Problem } from "./validate.js";

export * from "./types.js";
export {
  getLevelTrend,
  getMeasurements,
  getRiverOverview,
  getStationDetail,
  getStationsMap,
  getWaterLevels,
  listStations,
  listWaters,
  readingOf,
  resolveWater,
  summaryOf,
  MAX_STATIONS,
  STALE_AFTER_MINUTES,
  AHEAD_TOLERANCE_MINUTES,
} from "./operations.js";
export type {
  AmbiguousStation,
  ClockInput,
  GaugeFeature,
  GaugeReading,
  LevelTrend,
  LevelTrendInput,
  LevelVerdict,
  ListStationsInput,
  ListWatersInput,
  MeasurementWindow,
  MeasurementsInput,
  Point,
  RiverGauge,
  RiverOverview,
  RiverOverviewInput,
  SeriesDetail,
  StationDetail,
  StationDetailInput,
  StationFilter,
  StationList,
  StationReading,
  StationSearch,
  StationSummary,
  StationsMap,
  StationsMapInput,
  Swings,
  VerdictCounts,
  WaterList,
  WaterLevels,
  WaterLevelsInput,
  WaterLookup,
} from "./operations.js";
