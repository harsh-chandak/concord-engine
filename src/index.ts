export { detect, escalate, nextOwner, LADDER, MAX_ATTEMPTS } from "./detect.js";
export type { Finding, Override, DetectResult } from "./detect.js";
export { KINDS, KIND_IDS, kindSpec, normalizeSubject, normalizePath } from "./compare.js";
export { readDecisions, appendDecision, activeDecisions, subjectKey, nextId, decisionsPath, DEFAULT_DIR } from "./log.js";
export type { Decision, Conflict, ConflictState, Kind, KindSpec, Layer } from "./types.js";
