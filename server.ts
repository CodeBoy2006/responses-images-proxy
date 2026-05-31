// v1_images_server_no_file_storage.ts
//
// Deno server that exposes OpenAI-compatible /v1/images/* endpoints,
// internally calls an OpenAI-compatible /v1/responses endpoint with
// image_generation tool, and returns generated images directly.
//
// Run:
//   UPSTREAM_BASE_URL="https://your-upstream.example.com" \
//   UPSTREAM_API_KEY="sk-upstream" \
//   PROXY_API_KEY="local-secret" \
//   deno run --allow-net --allow-env v1_images_server_no_file_storage.ts
//

type LogLevel = "debug" | "info" | "warn" | "error";

interface GeneratedImage {
  bytes: Uint8Array;
  mime: string;
  ext: string;
  source: "upstream";
  upstreamEventCount: number;
  upstreamElapsedMs: number;
  winningAttempt: number;
  raceGroup: number;
}

const IMAGE_TOOL_ACTIONS = ["auto", "generate", "edit"] as const;
const IMAGE_TOOL_BACKGROUNDS = ["auto", "opaque", "transparent"] as const;
const IMAGE_TOOL_MODERATIONS = ["auto", "low"] as const;
const IMAGE_TOOL_INPUT_FIDELITIES = ["high", "low"] as const;

type ImageToolAction = typeof IMAGE_TOOL_ACTIONS[number];
type ImageToolBackground = typeof IMAGE_TOOL_BACKGROUNDS[number];
type ImageToolModeration = typeof IMAGE_TOOL_MODERATIONS[number];
type ImageToolInputFidelity = typeof IMAGE_TOOL_INPUT_FIDELITIES[number];

interface ImageToolInputMask {
  file_id?: string;
  image_url?: string;
}

interface ParsedImageRequest {
  model: string;
  prompt: string;
  imageDataUrls: string[];
  mode: "generation" | "edit" | "variation";
  n: number;
  responseFormat: "b64_json" | "url";
  raceConcurrency: number;
  candidateCount: number;
  upstreamConcurrency: number;
  outputFormat: "png" | "jpeg" | "webp";
  imageModel?: string;
  imageAction?: ImageToolAction;
  background?: ImageToolBackground;
  moderation: ImageToolModeration;
  inputFidelity?: ImageToolInputFidelity;
  inputImageMask?: ImageToolInputMask;
  outputCompression?: number;
  partialImages: number;
  size?: string;
  quality?: string;
  rawBodyForLog: Record<string, unknown>;
}

class HttpError extends Error {
  status: number;
  type: string;
  code: string;
  details?: unknown;

  constructor(status: number, message: string, type = "invalid_request_error", code = "bad_request", details?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.type = type;
    this.code = code;
    this.details = details;
  }
}

class UpstreamRaceError extends Error {
  reasons: string[];
  raceGroup: number;
  raceConcurrency: number;

  constructor(raceGroup: number, raceConcurrency: number, reasons: string[]) {
    super("All upstream image generation attempts failed");
    this.name = "UpstreamRaceError";
    this.reasons = reasons;
    this.raceGroup = raceGroup;
    this.raceConcurrency = raceConcurrency;
  }
}

interface LenientImageBatchResult {
  images: GeneratedImage[];
  targetCount: number;
  totalAttempts: number;
  attemptsStarted: number;
  attemptsCompleted: number;
  activeAborted: number;
  failures: string[];
  stoppedReason: "target_success_count_reached" | "all_candidates_exhausted";
  upstreamConcurrency: number;
}

type RuntimeKind = "cloudflare-worker" | "deno-deploy" | "deno-local" | "unknown-edge";
type RuntimeEnvBindings = Record<string, unknown>;

interface RuntimeInfo {
  kind: RuntimeKind;
  label: string;
  hasDeno: boolean;
  hasDenoServe: boolean;
  isEdge: boolean;
}

interface AppConfig {
  runtime: RuntimeInfo;
  host: string;
  port: number;
  upstreamBaseUrl: string;
  upstreamApiKey: string;
  proxyApiKey: string;
  defaultModel: string;
  upstreamOutputFormat: "png" | "jpeg" | "webp";
  defaultRaceConcurrency: number;
  maxRaceConcurrency: number;
  maxTotalUpstreamCalls: number;
  maxUpstreamConcurrency: number;
  maxOutputImages: number;
  upstreamTimeoutMs: number;
  maxErrorBodyBytes: number;
  maxRequestBytes: number;
  maxInputImageBytes: number;
  maxInputImages: number;
  allowRemoteImageUrls: boolean;
  corsAllowOrigin: string;
  logLevel: LogLevel;
  // If true, use human-friendly, colored terminal output instead of JSON.
  prettyLogs: boolean;
  logSseData: boolean;
  imagePartialFallback: boolean;
}

let ACTIVE_ENV_BINDINGS: RuntimeEnvBindings | undefined;
let runtimeBootLogged = false;

function bindingEnv(name: string, bindings = ACTIVE_ENV_BINDINGS): string | undefined {
  const value = bindings?.[name];
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function denoEnv(name: string): string | undefined {
  const deno = (globalThis as any).Deno;
  try {
    const value = deno?.env?.get?.(name);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function processEnv(name: string): string | undefined {
  const process = (globalThis as any).process;
  const value = process?.env?.[name];
  return typeof value === "string" ? value : undefined;
}

function env(name: string, fallback = ""): string {
  return bindingEnv(name) ?? denoEnv(name) ?? processEnv(name) ?? fallback;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const value = env(name, "");
  if (value == null || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function intEnv(name: string, fallback: number): number {
  const value = env(name, "");
  if (value == null || value.trim() === "") return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}


function normalizeBaseUrl(input: string): string {
  let base = String(input || "").trim();
  if (!base) return "";
  base = base.replace(/\/+$/, "");
  if (base.endsWith("/v1")) base = base.slice(0, -3);
  return base;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}


function detectRuntime(bindings = ACTIVE_ENV_BINDINGS): RuntimeInfo {
  const g = globalThis as any;
  const deno = g.Deno;
  const hasDeno = typeof deno !== "undefined";
  const hasDenoServe = typeof deno?.serve === "function";
  const denoDeployId = bindingEnv("DENO_DEPLOYMENT_ID", bindings) ?? denoEnv("DENO_DEPLOYMENT_ID");
  const denoRegion = bindingEnv("DENO_REGION", bindings) ?? denoEnv("DENO_REGION");
  const denoDeployBuildId = bindingEnv("DENO_DEPLOY_BUILD_ID", bindings) ?? denoEnv("DENO_DEPLOY_BUILD_ID");
  const denoDeployFlag = bindingEnv("DENO_DEPLOY", bindings) ?? denoEnv("DENO_DEPLOY");
  const userAgent = String(g.navigator?.userAgent ?? "");
  const looksLikeCloudflare = !hasDeno && (
    typeof g.WebSocketPair !== "undefined" ||
    /Cloudflare-Workers/i.test(userAgent) ||
    Boolean(bindings && ("CF_PAGES" in bindings || "__STATIC_CONTENT_MANIFEST" in bindings))
  );

  if (looksLikeCloudflare) {
    return {
      kind: "cloudflare-worker",
      label: "Cloudflare Workers",
      hasDeno,
      hasDenoServe,
      isEdge: true,
    };
  }

  if (hasDeno && (denoDeployFlag === "true" || denoDeployId || denoRegion || denoDeployBuildId)) {
    return {
      kind: "deno-deploy",
      label: "Deno Deploy",
      hasDeno,
      hasDenoServe,
      isEdge: true,
    };
  }

  if (hasDeno) {
    return {
      kind: "deno-local",
      label: "Local Deno",
      hasDeno,
      hasDenoServe,
      isEdge: false,
    };
  }

  return {
    kind: "unknown-edge",
    label: "Unknown Web Runtime",
    hasDeno,
    hasDenoServe,
    isEdge: true,
  };
}


function buildConfig(): AppConfig {
  const runtime = detectRuntime();

  return {
    runtime,
    host: env("HOST", "0.0.0.0"),
    port: intEnv("PORT", 8000),

    upstreamBaseUrl: normalizeBaseUrl(env("UPSTREAM_BASE_URL", "")),
    upstreamApiKey: env("UPSTREAM_API_KEY", ""),
    proxyApiKey: env("PROXY_API_KEY", ""),
    defaultModel: env("DEFAULT_MODEL", "gpt-5.3-codex"),
    upstreamOutputFormat: normalizeImageFormat(env("UPSTREAM_IMAGE_OUTPUT_FORMAT", "png")),

    defaultRaceConcurrency: intEnv("IMAGE_RACE_CONCURRENCY", 1),
    maxRaceConcurrency: intEnv("MAX_IMAGE_RACE_CONCURRENCY", 4),
    maxTotalUpstreamCalls: intEnv("MAX_TOTAL_UPSTREAM_CALLS", 8),
    maxUpstreamConcurrency: intEnv("MAX_IMAGE_UPSTREAM_CONCURRENCY", 4),
    maxOutputImages: intEnv("MAX_OUTPUT_IMAGES", 4),
    upstreamTimeoutMs: intEnv("UPSTREAM_TIMEOUT_MS", 180_000),
    maxErrorBodyBytes: intEnv("MAX_ERROR_BODY_BYTES", 8 * 1024),

    maxRequestBytes: intEnv("MAX_REQUEST_BYTES", 80 * 1024 * 1024),
    maxInputImageBytes: intEnv("MAX_INPUT_IMAGE_BYTES", 25 * 1024 * 1024),
    maxInputImages: intEnv("MAX_INPUT_IMAGES", 8),
    allowRemoteImageUrls: boolEnv("ALLOW_REMOTE_IMAGE_URLS", false),

    corsAllowOrigin: env("CORS_ALLOW_ORIGIN", "*"),
    logLevel: (env("LOG_LEVEL", "info").toLowerCase() as LogLevel),
    logSseData: boolEnv("LOG_SSE_DATA", false),
    // When true, logs are printed in a human-friendly, colored format
    // instead of compact JSON lines. Enable with LOG_PRETTY=true.
    prettyLogs: boolEnv("LOG_PRETTY", false),
    imagePartialFallback: boolEnv("IMAGE_PARTIAL_FALLBACK", false),
  };
}

let CONFIG: AppConfig = buildConfig();

function configureRuntime(bindings?: RuntimeEnvBindings): AppConfig {
  if (bindings) ACTIVE_ENV_BINDINGS = bindings;
  CONFIG = buildConfig();
  return CONFIG;
}


const LOG_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
function printPrettyDivider(label: string): void {
  console.log(`<${label}>`);
}

function log(level: LogLevel, message: string, fields: Record<string, unknown> = {}): void {
  if (LOG_ORDER[level] < LOG_ORDER[CONFIG.logLevel]) return;
  // Pretty terminal output when enabled in config
  if (CONFIG.prettyLogs) {
    const ts = new Date().toISOString();
    const colorMap: Record<LogLevel, string> = {
      debug: "\x1b[36m", // cyan
      info: "\x1b[32m", // green
      warn: "\x1b[33m", // yellow
      error: "\x1b[31m", // red
    };
    const reset = "\x1b[0m";

    const fmtValue = (v: unknown): string => {
      if (v === null) return "null";
      if (v === undefined) return "undefined";
      if (typeof v === "string") return v;
      if (typeof v === "number" || typeof v === "boolean") return String(v);
      try {
        return JSON.stringify(v);
      } catch {
        return String(v as any);
      }
    };

    const levelLabel = level.toUpperCase();
    const coloredLevel = (colorMap[level] || "") + levelLabel + reset;
    const fieldsStr = Object.keys(fields).length
      ? " | " + Object.entries(fields).map(([k, v]) => `${k}=${fmtValue(v)}`).join(" | ")
      : "";
    const line = `[${ts}] ${coloredLevel} ${message}${fieldsStr}`;

    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
    return;
  }

  // Default: compact JSON log lines for structured logging
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...fields,
  };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

function makeRequestId(): string {
  return "req_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
}

function corsHeaders(): HeadersInit {
  return {
    "access-control-allow-origin": CONFIG.corsAllowOrigin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type,x-image-race-concurrency,x-image-upstream-concurrency,x-request-id",
    "access-control-expose-headers": "x-request-id",
  };
}

function jsonResponse(data: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(),
      ...extraHeaders,
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function errorResponse(err: unknown, requestId: string): Response {
  if (err instanceof HttpError) {
    log(err.status >= 500 ? "error" : "warn", "request failed", {
      request_id: requestId,
      status: err.status,
      type: err.type,
      code: err.code,
      error: err.message,
      details: err.details,
    });
    return jsonResponse({
      error: {
        message: err.message,
        type: err.type,
        code: err.code,
        details: err.details,
      },
    }, err.status, { "x-request-id": requestId });
  }

  if (err instanceof UpstreamRaceError) {
    log("error", "all upstream race attempts failed", {
      request_id: requestId,
      race_group: err.raceGroup,
      race_concurrency: err.raceConcurrency,
      reasons: err.reasons,
    });
    return jsonResponse({
      error: {
        message: err.message,
        type: "upstream_error",
        code: "all_attempts_failed",
        details: {
          race_group: err.raceGroup,
          race_concurrency: err.raceConcurrency,
          reasons: err.reasons,
        },
      },
    }, 502, { "x-request-id": requestId });
  }

  const message = err instanceof Error ? err.message : String(err);
  log("error", "unhandled request error", {
    request_id: requestId,
    error: message,
    name: err instanceof Error ? err.name : typeof err,
    stack: err instanceof Error ? err.stack : undefined,
  });
  return jsonResponse({
    error: {
      message,
      type: "server_error",
      code: "internal_error",
    },
  }, 500, { "x-request-id": requestId });
}

function getBearerToken(req: Request): string {
  const auth = req.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return m ? m[1].trim() : "";
}

function requireProxyAuth(req: Request): void {
  if (!CONFIG.proxyApiKey) return;
  const token = getBearerToken(req);
  if (!token || token !== CONFIG.proxyApiKey) {
    throw new HttpError(401, "Invalid or missing proxy API key", "authentication_error", "invalid_api_key");
  }
}

function resolveUpstreamApiKey(req: Request): string {
  requireProxyAuth(req);
  const clientBearer = getBearerToken(req);
  const key = CONFIG.upstreamApiKey || clientBearer;
  if (!key) {
    throw new HttpError(401, "Missing upstream API key. Set UPSTREAM_API_KEY or pass Authorization: Bearer <upstream-key>.", "authentication_error", "missing_api_key");
  }
  return key;
}

function assertUpstreamConfigured(): void {
  if (!CONFIG.upstreamBaseUrl) {
    throw new HttpError(500, "UPSTREAM_BASE_URL is not configured", "configuration_error", "missing_upstream_base_url");
  }
}

function checkContentLength(req: Request): void {
  const lenHeader = req.headers.get("content-length");
  if (!lenHeader) return;
  const len = Number.parseInt(lenHeader, 10);
  if (Number.isFinite(len) && len > CONFIG.maxRequestBytes) {
    throw new HttpError(413, `Request body is too large: ${len} bytes`, "invalid_request_error", "request_too_large", {
      max_request_bytes: CONFIG.maxRequestBytes,
    });
  }
}


function intFromUnknown(value: unknown, fallback: number): number {
  if (value == null || value === "") return fallback;
  const n = Number.parseInt(String(value), 10);
  return Number.isFinite(n) ? n : fallback;
}

function stringFromUnknown(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

function enumParamFromUnknown<T extends string>(value: unknown, name: string, allowed: readonly T[], fallback?: T): T | undefined {
  if (value == null || value === "") return fallback;
  const s = stringFromUnknown(value, "").trim().toLowerCase();
  if (!s) return fallback;
  if ((allowed as readonly string[]).includes(s)) return s as T;
  throw new HttpError(400, `${name} must be one of: ${allowed.join(", ")}`, "invalid_request_error", "invalid_image_tool_parameter", {
    parameter: name,
    value: stringFromUnknown(value, ""),
    allowed,
  });
}

function intParamFromUnknown(value: unknown, name: string, min: number, max: number): number | undefined {
  if (value == null || value === "") return undefined;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) {
    throw new HttpError(400, `${name} must be an integer`, "invalid_request_error", "invalid_image_tool_parameter", {
      parameter: name,
      value: stringFromUnknown(value, ""),
      min,
      max,
    });
  }
  return clampInt(n, min, max);
}

function redactedInputImageMask(mask?: ImageToolInputMask): Record<string, boolean> | undefined {
  if (!mask) return undefined;
  return {
    file_id: Boolean(mask.file_id),
    image_url: Boolean(mask.image_url),
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToBytes(input: string): Uint8Array {
  const clean = input.replace(/\s+/g, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function detectImage(bytes: Uint8Array): { mime: string; ext: string } | null {
  if (bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return { mime: "image/png", ext: "png" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: "image/jpeg", ext: "jpg" };
  }
  if (bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return { mime: "image/webp", ext: "webp" };
  }
  if (bytes.length >= 6) {
    const sig = String.fromCharCode(...bytes.subarray(0, 6));
    if (sig === "GIF87a" || sig === "GIF89a") {
      return { mime: "image/gif", ext: "gif" };
    }
  }
  return null;
}

function mimeToExt(mime: string): string {
  const m = mime.toLowerCase();
  if (m === "image/jpeg" || m === "image/jpg") return "jpg";
  if (m === "image/png") return "png";
  if (m === "image/webp") return "webp";
  if (m === "image/gif") return "gif";
  return "bin";
}

function normalizeImageFormat(format: string): "png" | "jpeg" | "webp" {
  const f = String(format || "").toLowerCase();
  if (f === "jpg" || f === "jpeg") return "jpeg";
  if (f === "webp") return "webp";
  return "png";
}

function dataUrlFromBytes(bytes: Uint8Array, mime: string): string {
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

function parseDataUrl(input: string): { mime: string; bytes: Uint8Array } | null {
  const m = /^data:([^;,]+)?(?:;[^,]*)?;base64,(.+)$/is.exec(input.trim());
  if (!m) return null;
  const mime = (m[1] || "application/octet-stream").toLowerCase();
  const bytes = base64ToBytes(m[2]);
  return { mime, bytes };
}

async function scalarFromForm(form: FormData, name: string): Promise<string> {
  const v = form.get(name);
  return typeof v === "string" ? v : "";
}

function scalarFromObject(obj: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (obj[name] != null) return obj[name];
  }
  return undefined;
}

async function imageValueToDataUrl(value: unknown, fieldName: string, requestId: string): Promise<string> {
  if (value instanceof File) {
    const bytes = new Uint8Array(await value.arrayBuffer());
    if (bytes.byteLength > CONFIG.maxInputImageBytes) {
      throw new HttpError(413, `${fieldName} is too large`, "invalid_request_error", "input_image_too_large", {
        field: fieldName,
        bytes: bytes.byteLength,
        max_input_image_bytes: CONFIG.maxInputImageBytes,
      });
    }
    const detected = detectImage(bytes);
    const mime = detected?.mime || value.type || "application/octet-stream";
    if (!mime.startsWith("image/")) {
      throw new HttpError(400, `${fieldName} is not a supported image`, "invalid_request_error", "invalid_image");
    }
    return dataUrlFromBytes(bytes, mime);
  }

  if (typeof value !== "string") {
    throw new HttpError(400, `${fieldName} must be a File, data URL, or base64 string`, "invalid_request_error", "invalid_image_input");
  }

  const s = value.trim();
  if (!s) {
    throw new HttpError(400, `${fieldName} is empty`, "invalid_request_error", "invalid_image_input");
  }

  if (/^https?:\/\//i.test(s)) {
    if (!CONFIG.allowRemoteImageUrls) {
      throw new HttpError(400, "Remote image URLs are disabled. Use multipart/form-data or a data URL, or set ALLOW_REMOTE_IMAGE_URLS=true.", "invalid_request_error", "remote_image_urls_disabled");
    }
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort("remote image fetch timeout"), 30_000);
    try {
      const resp = await fetch(s, { signal: controller.signal });
      if (!resp.ok) {
        throw new HttpError(400, `Failed to fetch remote image: HTTP ${resp.status}`, "invalid_request_error", "remote_image_fetch_failed");
      }
      const bytes = new Uint8Array(await resp.arrayBuffer());
      if (bytes.byteLength > CONFIG.maxInputImageBytes) {
        throw new HttpError(413, "Remote image is too large", "invalid_request_error", "input_image_too_large", {
          bytes: bytes.byteLength,
          max_input_image_bytes: CONFIG.maxInputImageBytes,
        });
      }
      const detected = detectImage(bytes);
      const mime = detected?.mime || resp.headers.get("content-type") || "application/octet-stream";
      if (!mime.startsWith("image/")) {
        throw new HttpError(400, "Remote URL did not return a supported image", "invalid_request_error", "invalid_image");
      }
      log("info", "remote image fetched for image edit", {
        request_id: requestId,
        bytes: bytes.byteLength,
        mime,
      });
      return dataUrlFromBytes(bytes, mime);
    } finally {
      clearTimeout(t);
    }
  }

  const dataUrl = parseDataUrl(s);
  if (dataUrl) {
    if (dataUrl.bytes.byteLength > CONFIG.maxInputImageBytes) {
      throw new HttpError(413, `${fieldName} is too large`, "invalid_request_error", "input_image_too_large", {
        bytes: dataUrl.bytes.byteLength,
        max_input_image_bytes: CONFIG.maxInputImageBytes,
      });
    }
    const detected = detectImage(dataUrl.bytes);
    const mime = detected?.mime || dataUrl.mime;
    if (!mime.startsWith("image/")) {
      throw new HttpError(400, `${fieldName} is not an image data URL`, "invalid_request_error", "invalid_image");
    }
    return dataUrlFromBytes(dataUrl.bytes, mime);
  }

  try {
    const bytes = base64ToBytes(s);
    if (bytes.byteLength > CONFIG.maxInputImageBytes) {
      throw new HttpError(413, `${fieldName} is too large`, "invalid_request_error", "input_image_too_large", {
        bytes: bytes.byteLength,
        max_input_image_bytes: CONFIG.maxInputImageBytes,
      });
    }
    const detected = detectImage(bytes);
    if (!detected) {
      throw new Error("image magic bytes not recognized");
    }
    return dataUrlFromBytes(bytes, detected.mime);
  } catch (err) {
    throw new HttpError(400, `${fieldName} is not a valid image data URL or base64 image`, "invalid_request_error", "invalid_image", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function normalizeInputImageMask(value: unknown, requestId: string): Promise<ImageToolInputMask | undefined> {
  if (value == null || value === "") return undefined;

  if (value instanceof File) {
    return { image_url: await imageValueToDataUrl(value, "input_image_mask", requestId) };
  }

  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return undefined;

    if (s.startsWith("{")) {
      try {
        return await normalizeInputImageMask(JSON.parse(s), requestId);
      } catch (err) {
        throw new HttpError(400, "input_image_mask is not valid JSON", "invalid_request_error", "invalid_image_tool_parameter", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (/^file[-_]/i.test(s)) {
      return { file_id: s };
    }

    return { image_url: await imageValueToDataUrl(s, "input_image_mask", requestId) };
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const fileId = stringFromUnknown(record.file_id ?? record.fileId, "").trim();
    const imageValue = record.image_url ?? record.imageUrl ?? record.url;
    const mask: ImageToolInputMask = {};

    if (fileId) mask.file_id = fileId;
    if (imageValue != null && imageValue !== "") {
      mask.image_url = await imageValueToDataUrl(imageValue, "input_image_mask.image_url", requestId);
    }

    if (mask.file_id || mask.image_url) return mask;
  }

  throw new HttpError(400, "input_image_mask must be a File, data URL, base64 image, file ID, or object with file_id/image_url", "invalid_request_error", "invalid_image_tool_parameter");
}

async function parseImageRequest(req: Request, mode: "generation" | "edit" | "variation", requestId: string): Promise<ParsedImageRequest> {
  checkContentLength(req);

  const contentType = req.headers.get("content-type") || "";
  let raw: Record<string, unknown> = {};
  let inputImageMaskCandidate: unknown;
  const imageDataUrls: string[] = [];

  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();

    raw = {
      model: await scalarFromForm(form, "model"),
      prompt: await scalarFromForm(form, "prompt"),
      n: await scalarFromForm(form, "n"),
      response_format: await scalarFromForm(form, "response_format"),
      concurrency: await scalarFromForm(form, "concurrency"),
      race_concurrency: await scalarFromForm(form, "race_concurrency"),
      size: await scalarFromForm(form, "size"),
      quality: await scalarFromForm(form, "quality"),
      output_format: await scalarFromForm(form, "output_format"),
      image_model: await scalarFromForm(form, "image_model"),
      image_generation_model: await scalarFromForm(form, "image_generation_model"),
      tool_model: await scalarFromForm(form, "tool_model"),
      action: await scalarFromForm(form, "action"),
      image_action: await scalarFromForm(form, "image_action"),
      background: await scalarFromForm(form, "background"),
      moderation: await scalarFromForm(form, "moderation"),
      input_fidelity: await scalarFromForm(form, "input_fidelity"),
      output_compression: await scalarFromForm(form, "output_compression"),
      partial_images: await scalarFromForm(form, "partial_images"),
    };

    inputImageMaskCandidate = form.get("input_image_mask") ?? form.get("image_mask") ?? form.get("mask") ?? undefined;

    const imageFields = [
      ...form.getAll("image"),
      ...form.getAll("image[]"),
      ...form.getAll("images"),
      ...form.getAll("images[]"),
    ];

    for (let i = 0; i < imageFields.length; i++) {
      imageDataUrls.push(await imageValueToDataUrl(imageFields[i], `image[${i}]`, requestId));
    }
  } else {
    try {
      raw = await req.json();
    } catch {
      throw new HttpError(400, "Request body must be JSON or multipart/form-data", "invalid_request_error", "invalid_json");
    }

    inputImageMaskCandidate = scalarFromObject(raw, "input_image_mask", "image_mask", "mask");

    const imageCandidate = scalarFromObject(raw, "image", "images");
    const imageArray = Array.isArray(imageCandidate) ? imageCandidate : imageCandidate != null ? [imageCandidate] : [];
    for (let i = 0; i < imageArray.length; i++) {
      imageDataUrls.push(await imageValueToDataUrl(imageArray[i], `image[${i}]`, requestId));
    }
  }

  if (imageDataUrls.length > CONFIG.maxInputImages) {
    throw new HttpError(400, `Too many input images: ${imageDataUrls.length}`, "invalid_request_error", "too_many_input_images", {
      max_input_images: CONFIG.maxInputImages,
    });
  }

  if ((mode === "edit" || mode === "variation") && imageDataUrls.length === 0) {
    throw new HttpError(400, "image is required for edits/variations", "invalid_request_error", "missing_image");
  }

  const promptDefault = mode === "variation"
    ? "请基于参考图片生成一个高质量变体，保留主体构图并自然改变细节。"
    : "";

  const prompt = stringFromUnknown(raw.prompt, promptDefault).trim();
  if (!prompt && mode !== "variation") {
    throw new HttpError(400, "prompt is required", "invalid_request_error", "missing_prompt");
  }

  const model = stringFromUnknown(raw.model, CONFIG.defaultModel).trim() || CONFIG.defaultModel;

  const n = clampInt(intFromUnknown(raw.n, 1), 1, CONFIG.maxOutputImages);

  const headerRace = req.headers.get("x-image-race-concurrency");
  const requestedRace = intFromUnknown(
    raw.race_concurrency ?? raw.race_count ?? raw.concurrency ?? headerRace,
    CONFIG.defaultRaceConcurrency,
  );
  const raceConcurrency = clampInt(requestedRace, 1, CONFIG.maxRaceConcurrency);

  const requestedCandidateCount = n * raceConcurrency;
  const totalCandidateLimit = CONFIG.maxTotalUpstreamCalls > 0 ? CONFIG.maxTotalUpstreamCalls : requestedCandidateCount;
  const candidateCount = Math.max(1, Math.min(requestedCandidateCount, totalCandidateLimit));

  const headerUpstreamConcurrency = req.headers.get("x-image-upstream-concurrency");
  const requestedUpstreamConcurrency = intFromUnknown(
    raw.upstream_concurrency ?? raw.max_upstream_concurrency ?? raw.max_concurrency ?? headerUpstreamConcurrency,
    CONFIG.maxUpstreamConcurrency,
  );
  const maxAllowedUpstreamConcurrency = Math.max(1, Math.min(Math.max(1, CONFIG.maxUpstreamConcurrency), candidateCount));
  const upstreamConcurrency = clampInt(requestedUpstreamConcurrency, 1, maxAllowedUpstreamConcurrency);

  const responseFormatRaw = stringFromUnknown(raw.response_format, "b64_json").trim().toLowerCase();
  const responseFormat = responseFormatRaw === "url" ? "url" : "b64_json";

  const outputFormat = normalizeImageFormat(stringFromUnknown(raw.output_format, CONFIG.upstreamOutputFormat));
  const size = stringFromUnknown(raw.size, "").trim() || undefined;
  const quality = stringFromUnknown(raw.quality, "").trim() || undefined;

  const imageModel = stringFromUnknown(
    raw.image_model ?? raw.image_generation_model ?? raw.tool_model ?? req.headers.get("x-image-model"),
    "",
  ).trim() || undefined;
  const imageAction = enumParamFromUnknown(
    raw.action ?? raw.image_action ?? req.headers.get("x-image-action"),
    "action",
    IMAGE_TOOL_ACTIONS,
  );
  const background = enumParamFromUnknown(
    raw.background ?? req.headers.get("x-image-background"),
    "background",
    IMAGE_TOOL_BACKGROUNDS,
  );
  const moderation = enumParamFromUnknown(
    raw.moderation ?? req.headers.get("x-image-moderation"),
    "moderation",
    IMAGE_TOOL_MODERATIONS,
    "low",
  ) ?? "low";
  const inputFidelity = enumParamFromUnknown(
    raw.input_fidelity ?? raw.fidelity ?? req.headers.get("x-image-input-fidelity"),
    "input_fidelity",
    IMAGE_TOOL_INPUT_FIDELITIES,
  );
  const outputCompression = intParamFromUnknown(
    raw.output_compression ?? raw.image_output_compression ?? raw.compression ?? req.headers.get("x-image-output-compression"),
    "output_compression",
    0,
    100,
  );
  const partialImages = intParamFromUnknown(
    raw.partial_images ?? raw.partialImages ?? req.headers.get("x-image-partial-images"),
    "partial_images",
    0,
    3,
  ) ?? 0;
  const inputImageMask = await normalizeInputImageMask(inputImageMaskCandidate, requestId);

  return {
    model,
    prompt,
    imageDataUrls,
    mode,
    n,
    responseFormat,
    raceConcurrency,
    candidateCount,
    upstreamConcurrency,
    outputFormat,
    imageModel,
    imageAction,
    background,
    moderation,
    inputFidelity,
    inputImageMask,
    outputCompression,
    partialImages,
    size,
    quality,
    rawBodyForLog: {
      model,
      prompt_length: prompt.length,
      input_images: imageDataUrls.length,
      n,
      response_format: responseFormat,
      race_concurrency: raceConcurrency,
      candidate_count: candidateCount,
      upstream_concurrency: upstreamConcurrency,
      output_format: outputFormat,
      image_model: imageModel,
      image_action: imageAction,
      background,
      moderation,
      input_fidelity: inputFidelity,
      input_image_mask: redactedInputImageMask(inputImageMask),
      output_compression: outputCompression,
      partial_images: partialImages,
      size,
      quality,
    },
  };
}

const UPSTREAM_IMAGE_RETRY_INSTRUCTION =
  "重要指示：如果 image_generation 未产出图片，请在不改变核心意图的前提下改写提示词并再次调用，直到成功生成图片，否则继续重试，不得中途停止。";

const UPSTREAM_IMAGE_SYSTEM_PROMPT = [
  "你是专业图片生成代理。目标是调用 image_generation 工具直接产出图片，不用文字描述代替图片。",
  "调用工具前，将需求整理为简洁、可执行的视觉提示词；保留硬约束，适度补足构图、主体、动作、场景、光线、色彩、材质、镜头、背景、风格和细节。如果需求中有明确的风格要求，需要遵循。",
  "不要擅自增加水印、Logo、签名、边框、乱码或无关文字。",
  UPSTREAM_IMAGE_RETRY_INSTRUCTION,
  "最终只产出图片，不解释改写过程，不输出 Markdown 或无关文本。",
].join("\n");

function buildUpstreamImagePrompt(parsed: ParsedImageRequest): string {
  const hasReferenceImages = parsed.imageDataUrls.length > 0;
  const modeName = parsed.mode === "variation"
    ? "图片变体"
    : parsed.mode === "edit"
      ? "图片编辑"
      : hasReferenceImages
        ? "参考图片辅助生成"
        : "文本生成";

  const taskLines: string[] = [
    "请直接调用 image_generation 工具完成图片任务。",
    "先整理为一条清晰、可执行的视觉提示词，再调用工具。",
    "保留用户要求的主体、动作、场景、风格、文字、比例、禁止事项等硬约束。",
    "可适度补充构图、镜头、光线、色彩、材质、空间关系和清晰度；不要引入与主题冲突的元素。",
    "如用户要求包含文字，保持文字内容一致、简洁、清晰可读。",
    UPSTREAM_IMAGE_RETRY_INSTRUCTION,
    "只输出 image_generation 工具生成的图片结果；不要输出解释、分析、Markdown 或纯文本替代答案。",
  ];

  const referenceLines: string[] = [];
  if (hasReferenceImages) {
    if (parsed.mode === "variation") {
      referenceLines.push("保留参考图片的主体、构图和整体视觉关系；在风格、细节、背景、色彩、光影或氛围上做自然变化。");
    } else if (parsed.mode === "edit") {
      referenceLines.push("只修改用户明确要求修改的内容；未提及的主体身份、数量、构图、比例、姿态、背景关系和关键细节尽量保持不变。");
    } else {
      referenceLines.push("参考图片仅作为视觉依据；以用户原始需求为准，只沿用用户要求保留的主体、风格、构图或关键元素。");
    }

    if (parsed.inputImageMask) referenceLines.push("已提供编辑遮罩；优先将修改限制在遮罩和用户明确要求的范围内。");
  }

  // Keep the user prompt as the final line so the stable instruction prefix is
  // more cache-friendly for upstream prompt-prefix caching.
  return [
    ...taskLines,
    ...(referenceLines.length > 0 ? ["", "参考图片处理：", ...referenceLines.map((line) => `- ${line}`)] : []),
    "",
    "用户原始需求如下：",
    parsed.prompt,
  ].join("\n");
}

function buildResponsesPayload(parsed: ParsedImageRequest): Record<string, unknown> {
  const tool: Record<string, unknown> = {
    type: "image_generation",
    output_format: parsed.outputFormat,
    moderation: parsed.moderation,
    partial_images: parsed.partialImages,
  };

  if (parsed.imageModel) tool.model = parsed.imageModel;
  if (parsed.imageAction) tool.action = parsed.imageAction;
  if (parsed.background) tool.background = parsed.background;
  if (parsed.size) tool.size = parsed.size;
  if (parsed.quality) tool.quality = parsed.quality;
  if (parsed.inputFidelity) tool.input_fidelity = parsed.inputFidelity;
  if (parsed.inputImageMask) tool.input_image_mask = parsed.inputImageMask;
  if (parsed.outputCompression != null) tool.output_compression = parsed.outputCompression;

  const taskText = buildUpstreamImagePrompt(parsed);

  if (parsed.imageDataUrls.length > 0) {
    const content: Array<Record<string, string>> = parsed.imageDataUrls.map((dataUrl) => ({
      type: "input_image",
      image_url: dataUrl,
    }));

    content.push({
      type: "input_text",
      text: taskText,
    });

    return {
      model: parsed.model,
      input: [
        { role: "system", content: UPSTREAM_IMAGE_SYSTEM_PROMPT },
        { role: "user", content },
      ],
      tools: [tool],
      tool_choice: { type: "image_generation" },
      stream: true,
    };
  }

  return {
    model: parsed.model,
    input: [
      {
        role: "system",
        content: UPSTREAM_IMAGE_SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: taskText,
      },
    ],
    tools: [tool],
    tool_choice: { type: "image_generation" },
    stream: true,
  };
}

function isLikelyBase64ImageString(s: string): boolean {
  const clean = s.trim().replace(/\s+/g, "");
  if (clean.length < 64) return false;
  if (/^data:image\/[^;]+;base64,/i.test(clean)) return true;
  if (/^(iVBOR|\/9j\/|UklGR|R0lGOD)/.test(clean)) return true;
  if (!/^[A-Za-z0-9+/=_-]+$/.test(clean)) return false;
  return clean.length > 1000;
}

function tryDecodeImageString(s: string): { bytes: Uint8Array; mime: string; ext: string } | null {
  try {
    const dataUrl = parseDataUrl(s);
    if (dataUrl) {
      const detected = detectImage(dataUrl.bytes);
      if (detected) return { bytes: dataUrl.bytes, mime: detected.mime, ext: detected.ext };
      if (dataUrl.mime.startsWith("image/")) {
        return { bytes: dataUrl.bytes, mime: dataUrl.mime, ext: mimeToExt(dataUrl.mime) };
      }
      return null;
    }

    const bytes = base64ToBytes(s);
    const detected = detectImage(bytes);
    if (!detected) return null;
    return { bytes, mime: detected.mime, ext: detected.ext };
  } catch {
    return null;
  }
}

interface ExtractedImage {
  bytes: Uint8Array;
  mime: string;
  ext: string;
  path: string;
}

const FINAL_IMAGE_KEYS = ["result", "b64_json", "image_base64", "base64", "data"] as const;
const PARTIAL_IMAGE_KEYS = ["partial_image_b64", "b64_json"] as const;
const PARTIAL_IMAGE_FIELD_NAMES = new Set<string>(["partial_image_b64", "partial_image", "partial_images"]);

function extractImageFromString(value: unknown, path: string): ExtractedImage | null {
  if (typeof value !== "string") return null;
  if (!isLikelyBase64ImageString(value)) return null;
  const decoded = tryDecodeImageString(value);
  return decoded ? { ...decoded, path } : null;
}

function extractImageFromAllowedKeys(record: unknown, keys: readonly string[], basePath = ""): ExtractedImage | null {
  if (record == null || typeof record !== "object" || Array.isArray(record)) return null;
  const obj = record as Record<string, unknown>;

  for (const key of keys) {
    if (!(key in obj)) continue;
    const path = basePath ? `${basePath}.${key}` : key;
    const extracted = extractImageFromString(obj[key], path);
    if (extracted) return extracted;
  }

  return null;
}

function extractImageFromObject(obj: unknown, options: { ignoredKeys?: Set<string>; basePath?: string } = {}): ExtractedImage | null {
  const seen = new Set<unknown>();
  const priorityKeys = new Set<string>(FINAL_IMAGE_KEYS);
  const ignoredKeys = options.ignoredKeys ?? new Set<string>();
  const basePath = options.basePath ?? "";

  function walk(value: unknown, path: string, keyName = ""): ExtractedImage | null {
    if (value == null) return null;
    if (keyName && ignoredKeys.has(keyName)) return null;

    if (typeof value === "string") {
      return extractImageFromString(value, path);
    }

    if (typeof value !== "object") return null;
    if (seen.has(value)) return null;
    seen.add(value);

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const found = walk(value[i], `${path}[${i}]`);
        if (found) return found;
      }
      return null;
    }

    const record = value as Record<string, unknown>;

    for (const key of Object.keys(record)) {
      if (!priorityKeys.has(key) || ignoredKeys.has(key)) continue;
      const found = walk(record[key], path ? `${path}.${key}` : key, key);
      if (found) return found;
    }

    for (const key of Object.keys(record)) {
      if (priorityKeys.has(key) || ignoredKeys.has(key)) continue;
      const found = walk(record[key], path ? `${path}.${key}` : key, key);
      if (found) return found;
    }

    return null;
  }

  return walk(obj, basePath);
}

function responseEventType(eventName: string, data: unknown): string {
  const record = data as Record<string, unknown>;
  const type = typeof record?.type === "string" ? record.type : "";
  return type || eventName || "message";
}

function extractFinalImageFromResponseEvent(eventName: string, data: unknown): ExtractedImage | null {
  if (data == null || typeof data !== "object") return null;

  const eventType = responseEventType(eventName, data);
  const record = data as Record<string, unknown>;

  if (eventType === "response.completed" || eventName === "response.completed") {
    const response = record.response as Record<string, unknown> | undefined;
    const output = response?.output;

    if (Array.isArray(output)) {
      for (let i = 0; i < output.length; i++) {
        const item = output[i] as Record<string, unknown>;
        if (item?.type !== "image_generation_call") continue;

        const basePath = `response.output[${i}]`;
        const direct = extractImageFromAllowedKeys(item, FINAL_IMAGE_KEYS, basePath);
        if (direct) return direct;

        const nested = extractImageFromObject(item, { ignoredKeys: PARTIAL_IMAGE_FIELD_NAMES, basePath });
        if (nested) return nested;
      }
    }

    return extractImageFromObject(record, { ignoredKeys: PARTIAL_IMAGE_FIELD_NAMES });
  }

  if (eventType === "response.output_item.done" || eventName === "response.output_item.done") {
    const item = record.item as Record<string, unknown> | undefined;
    if (item?.type === "image_generation_call") {
      const direct = extractImageFromAllowedKeys(item, FINAL_IMAGE_KEYS, "item");
      if (direct) return direct;
      return extractImageFromObject(item, { ignoredKeys: PARTIAL_IMAGE_FIELD_NAMES, basePath: "item" });
    }
    return null;
  }

  if (eventType.includes("image_generation_call") && (eventType.includes("completed") || eventType.endsWith(".done"))) {
    const direct = extractImageFromAllowedKeys(record, FINAL_IMAGE_KEYS);
    if (direct) return direct;
    return extractImageFromObject(record, { ignoredKeys: PARTIAL_IMAGE_FIELD_NAMES });
  }

  return null;
}

function extractPartialImageFromResponseEvent(eventName: string, data: unknown): ExtractedImage | null {
  if (data == null || typeof data !== "object") return null;

  const eventType = responseEventType(eventName, data);
  if (!eventType.includes("partial_image") && !eventName.includes("partial_image")) return null;

  return extractImageFromAllowedKeys(data, PARTIAL_IMAGE_KEYS)
    ?? extractImageFromObject(data, { ignoredKeys: new Set<string>(["result"]) });
}

interface SseEvent {
  event: string;
  data: string;
}

async function* iterSseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "";
  let dataLines: string[] = [];

  const dispatch = function* (): Generator<SseEvent> {
    if (dataLines.length === 0 && !eventName) return;
    const evt: SseEvent = {
      event: eventName || "message",
      data: dataLines.join("\n"),
    };
    eventName = "";
    dataLines = [];
    yield evt;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const rawLine of lines) {
        const line = rawLine;
        if (line === "") {
          yield* dispatch();
          continue;
        }
        if (line.startsWith(":")) continue;

        const colon = line.indexOf(":");
        const field = colon >= 0 ? line.slice(0, colon) : line;
        let fieldValue = colon >= 0 ? line.slice(colon + 1) : "";
        if (fieldValue.startsWith(" ")) fieldValue = fieldValue.slice(1);

        if (field === "event") eventName = fieldValue;
        else if (field === "data") dataLines.push(fieldValue);
      }
    }

    if (buffer.length > 0) {
      const line = buffer;
      const colon = line.indexOf(":");
      const field = colon >= 0 ? line.slice(0, colon) : line;
      let fieldValue = colon >= 0 ? line.slice(colon + 1) : "";
      if (fieldValue.startsWith(" ")) fieldValue = fieldValue.slice(1);
      if (field === "event") eventName = fieldValue;
      else if (field === "data") dataLines.push(fieldValue);
    }

    yield* dispatch();
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Ignore cancellation errors.
    }
  }
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();

  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
  }

  for (const signal of signals) {
    signal.addEventListener("abort", () => {
      if (!controller.signal.aborted) controller.abort(signal.reason);
    }, { once: true });
  }

  return controller.signal;
}

function briefError(err: unknown): string {
  if (err instanceof HttpError) return `${err.name} ${err.status}: ${err.message}`;
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

async function callUpstreamOnce(params: {
  payload: Record<string, unknown>;
  upstreamApiKey: string;
  requestId: string;
  raceGroup: number;
  attempt: number;
  signal: AbortSignal;
}): Promise<GeneratedImage> {
  assertUpstreamConfigured();

  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort("upstream timeout"), CONFIG.upstreamTimeoutMs);
  const signal = anySignal([params.signal, timeoutController.signal]);

  const started = Date.now();
  let eventCount = 0;
  let textDeltaChars = 0;
  let lastPartialImage: ExtractedImage | null = null;
  let partialImageCount = 0;

  const url = CONFIG.upstreamBaseUrl + "/v1/responses";
  const headers = {
    "authorization": "Bearer " + params.upstreamApiKey,
    "accept": "text/event-stream",
    "content-type": "application/json",
    "chatgpt-account-id": "",
    "version": "0.122.0",
    "originator": "deno_v1_images_proxy",
    "session_id": `${params.requestId}-g${params.raceGroup}-a${params.attempt}`,
  };

  log("info", "upstream attempt started", {
    request_id: params.requestId,
    race_group: params.raceGroup,
    attempt: params.attempt,
    url,
    timeout_ms: CONFIG.upstreamTimeoutMs,
  });

  const makeGeneratedImage = (extracted: ExtractedImage, extractionType: "final" | "partial_fallback"): GeneratedImage => {
    const elapsed = Date.now() - started;
    log(extractionType === "final" ? "info" : "warn", "upstream image extracted", {
      request_id: params.requestId,
      race_group: params.raceGroup,
      attempt: params.attempt,
      elapsed_ms: elapsed,
      events: eventCount,
      extraction_type: extractionType,
      mime: extracted.mime,
      bytes: extracted.bytes.byteLength,
      json_path: extracted.path,
      partial_images_seen: partialImageCount,
    });

    return {
      bytes: extracted.bytes,
      mime: extracted.mime,
      ext: extracted.ext,
      source: "upstream",
      upstreamEventCount: eventCount,
      upstreamElapsedMs: elapsed,
      winningAttempt: params.attempt,
      raceGroup: params.raceGroup,
    };
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(params.payload),
      signal,
    });

    if (!response.ok) {
      let errorBody = "";
      try {
        errorBody = (await response.text()).slice(0, CONFIG.maxErrorBodyBytes);
      } catch {
        // Ignore.
      }
      throw new HttpError(response.status, `Upstream /v1/responses failed with HTTP ${response.status}`, "upstream_error", "upstream_http_error", {
        body: errorBody,
      });
    }

    if (!response.body) {
      throw new HttpError(502, "Upstream response has no body", "upstream_error", "missing_stream_body");
    }

    for await (const evt of iterSseEvents(response.body)) {
      eventCount++;
      if (evt.data === "[DONE]") {
        log("debug", "upstream SSE done", {
          request_id: params.requestId,
          race_group: params.raceGroup,
          attempt: params.attempt,
          events: eventCount,
        });
        continue;
      }

      if (evt.event !== "response.output_text.delta") {
        log("debug", "upstream SSE event", {
          request_id: params.requestId,
          race_group: params.raceGroup,
          attempt: params.attempt,
          event: evt.event,
          data_preview: CONFIG.logSseData ? evt.data.slice(0, 500) : undefined,
        });
      }

      let data: unknown;
      try {
        data = JSON.parse(evt.data);
      } catch (err) {
        log("debug", "upstream SSE data is not JSON", {
          request_id: params.requestId,
          race_group: params.raceGroup,
          attempt: params.attempt,
          event: evt.event,
          data_preview: evt.data.slice(0, 120),
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      const finalImage = extractFinalImageFromResponseEvent(evt.event, data);
      if (finalImage) {
        return makeGeneratedImage(finalImage, "final");
      }

      const partialImage = extractPartialImageFromResponseEvent(evt.event, data);
      if (partialImage) {
        partialImageCount++;
        lastPartialImage = partialImage;
        log("debug", "upstream partial image cached", {
          request_id: params.requestId,
          race_group: params.raceGroup,
          attempt: params.attempt,
          events: eventCount,
          partial_images_seen: partialImageCount,
          mime: partialImage.mime,
          bytes: partialImage.bytes.byteLength,
          json_path: partialImage.path,
        });
        continue;
      }

      const maybe = data as Record<string, unknown>;
      if (typeof maybe?.delta === "string") {
        textDeltaChars += maybe.delta.length;
      }
    }

    if (lastPartialImage && CONFIG.imagePartialFallback) {
      return makeGeneratedImage(lastPartialImage, "partial_fallback");
    }

    throw new HttpError(502, "Upstream stream ended without final image data", "upstream_error", "no_final_image_in_stream", {
      events: eventCount,
      text_delta_chars: textDeltaChars,
      partial_images_seen: partialImageCount,
      partial_fallback_enabled: CONFIG.imagePartialFallback,
    });
  } catch (err) {
    if (signal.aborted) {
      throw new Error(`Upstream attempt aborted: ${String(signal.reason || "aborted")}`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
    log("debug", "upstream attempt finished", {
      request_id: params.requestId,
      race_group: params.raceGroup,
      attempt: params.attempt,
      elapsed_ms: Date.now() - started,
      events: eventCount,
    });
  }
}

async function raceUpstreamImage(params: {
  payload: Record<string, unknown>;
  upstreamApiKey: string;
  requestId: string;
  raceGroup: number;
  raceConcurrency: number;
}): Promise<GeneratedImage> {
  const controllers: AbortController[] = [];
  const reasons: string[] = [];

  return await new Promise<GeneratedImage>((resolve, reject) => {
    let settled = false;
    let pending = params.raceConcurrency;

    for (let attempt = 1; attempt <= params.raceConcurrency; attempt++) {
      const controller = new AbortController();
      controllers.push(controller);

      callUpstreamOnce({
        payload: params.payload,
        upstreamApiKey: params.upstreamApiKey,
        requestId: params.requestId,
        raceGroup: params.raceGroup,
        attempt,
        signal: controller.signal,
      }).then((image) => {
        if (settled) return;
        settled = true;

        for (const c of controllers) {
          if (c !== controller && !c.signal.aborted) c.abort("race winner selected");
        }

        log("info", "upstream race winner selected", {
          request_id: params.requestId,
          race_group: params.raceGroup,
          winner_attempt: attempt,
          race_concurrency: params.raceConcurrency,
          image_mime: image.mime,
          image_bytes: image.bytes.byteLength,
          upstream_elapsed_ms: image.upstreamElapsedMs,
          upstream_events: image.upstreamEventCount,
        });

        resolve(image);
      }).catch((err) => {
        if (settled) return;

        const reason = briefError(err);
        reasons.push(reason);
        pending--;

        log("warn", "upstream race attempt failed", {
          request_id: params.requestId,
          race_group: params.raceGroup,
          attempt,
          pending,
          error: reason,
        });

        if (pending === 0) {
          settled = true;
          reject(new UpstreamRaceError(params.raceGroup, params.raceConcurrency, reasons));
        }
      });
    }
  });
}

async function collectLenientUpstreamImages(params: {
  payload: Record<string, unknown>;
  upstreamApiKey: string;
  requestId: string;
  targetCount: number;
  totalAttempts: number;
  upstreamConcurrency: number;
}): Promise<LenientImageBatchResult> {
  const images: GeneratedImage[] = [];
  const failures: string[] = [];
  const controllers = new Set<AbortController>();

  let nextAttempt = 1;
  let attemptsStarted = 0;
  let attemptsCompleted = 0;
  let running = 0;
  let settled = false;

  return await new Promise<LenientImageBatchResult>((resolve) => {
    const finish = (stoppedReason: LenientImageBatchResult["stoppedReason"]) => {
      if (settled) return;
      settled = true;

      const activeAborted = controllers.size;
      for (const controller of controllers) {
        if (!controller.signal.aborted) controller.abort(stoppedReason);
      }

      log("info", "lenient image batch finished", {
        request_id: params.requestId,
        stopped_reason: stoppedReason,
        target_count: params.targetCount,
        success_count: images.length,
        total_attempts: params.totalAttempts,
        attempts_started: attemptsStarted,
        attempts_completed: attemptsCompleted,
        active_aborted: activeAborted,
        failure_count: failures.length,
        upstream_concurrency: params.upstreamConcurrency,
      });

      resolve({
        images: images.slice(0, params.targetCount),
        targetCount: params.targetCount,
        totalAttempts: params.totalAttempts,
        attemptsStarted,
        attemptsCompleted,
        activeAborted,
        failures,
        stoppedReason,
        upstreamConcurrency: params.upstreamConcurrency,
      });
    };

    const launchMore = () => {
      if (settled) return;

      while (
        running < params.upstreamConcurrency &&
        nextAttempt <= params.totalAttempts &&
        images.length < params.targetCount
      ) {
        const candidateAttempt = nextAttempt++;
        const controller = new AbortController();
        controllers.add(controller);
        running++;
        attemptsStarted++;

        (async () => {
          try {
            const image = await callUpstreamOnce({
              payload: params.payload,
              upstreamApiKey: params.upstreamApiKey,
              requestId: params.requestId,
              raceGroup: candidateAttempt,
              attempt: 1,
              signal: controller.signal,
            });

            if (settled) {
              log("debug", "late upstream image discarded after lenient batch settled", {
                request_id: params.requestId,
                candidate_attempt: candidateAttempt,
                image_mime: image.mime,
                image_bytes: image.bytes.byteLength,
              });
              return;
            }

            if (images.length < params.targetCount) {
              images.push(image);
              log("info", "lenient image candidate accepted", {
                request_id: params.requestId,
                candidate_attempt: candidateAttempt,
                success_count: images.length,
                target_count: params.targetCount,
                image_mime: image.mime,
                image_bytes: image.bytes.byteLength,
                upstream_elapsed_ms: image.upstreamElapsedMs,
                upstream_events: image.upstreamEventCount,
              });
            }
          } catch (err) {
            if (!settled) {
              const reason = briefError(err);
              failures.push(reason);
              log("warn", "lenient image candidate failed", {
                request_id: params.requestId,
                candidate_attempt: candidateAttempt,
                error: reason,
                running,
                failure_count: failures.length,
              });
            }
          } finally {
            controllers.delete(controller);
            running--;
            attemptsCompleted++;

            if (settled) return;
            if (images.length >= params.targetCount) {
              finish("target_success_count_reached");
              return;
            }
            if (nextAttempt > params.totalAttempts && running === 0) {
              finish("all_candidates_exhausted");
              return;
            }
            launchMore();
          }
        })();
      }

      if (!settled && nextAttempt > params.totalAttempts && running === 0) {
        finish("all_candidates_exhausted");
      }
    };

    launchMore();
  });
}

async function handleImageEndpoint(req: Request, mode: "generation" | "edit" | "variation", requestId: string): Promise<Response> {
  const upstreamApiKey = resolveUpstreamApiKey(req);
  const parsed = await parseImageRequest(req, mode, requestId);

  log("info", "image request parsed", {
    request_id: requestId,
    method: req.method,
    path: new URL(req.url).pathname,
    ...parsed.rawBodyForLog,
  });

  const payload = buildResponsesPayload(parsed);

  const batch = await collectLenientUpstreamImages({
    payload,
    upstreamApiKey,
    requestId,
    targetCount: parsed.n,
    totalAttempts: parsed.candidateCount,
    upstreamConcurrency: parsed.upstreamConcurrency,
  });

  const images = batch.images;
  const data: Record<string, unknown>[] = [];

  for (const image of images) {
    const item: Record<string, unknown> = {};

    if (parsed.responseFormat === "url") {
      // No local file storage in this build. The OpenAI-compatible "url" response
      // is represented as a data URL so callers can still consume it without an
      // additional file-serving endpoint.
      item.url = dataUrlFromBytes(image.bytes, image.mime);
    } else {
      item.b64_json = bytesToBase64(image.bytes);
    }

    item.mime_type = image.mime;
    item.size_bytes = image.bytes.byteLength;
    item.revised_prompt = parsed.prompt;

    data.push(item);
  }

  const partial = data.length < parsed.n;

  log("info", "image request completed", {
    request_id: requestId,
    requested_count: parsed.n,
    image_count: images.length,
    partial,
    response_format: parsed.responseFormat,
    candidate_count: parsed.candidateCount,
    upstream_concurrency: parsed.upstreamConcurrency,
    stopped_reason: batch.stoppedReason,
    attempts_started: batch.attemptsStarted,
    attempts_completed: batch.attemptsCompleted,
    active_aborted: batch.activeAborted,
    failure_count: batch.failures.length,
    total_generated_bytes: images.reduce((sum, img) => sum + img.bytes.byteLength, 0),
  });

  return jsonResponse({
    created: Math.floor(Date.now() / 1000),
    data,
    partial,
    requested: parsed.n,
    successful: data.length,
    attempts: {
      planned: parsed.candidateCount,
      started: batch.attemptsStarted,
      completed: batch.attemptsCompleted,
      failed: batch.failures.length,
      active_aborted: batch.activeAborted,
      upstream_concurrency: parsed.upstreamConcurrency,
      stopped_reason: batch.stoppedReason,
      failure_reasons: batch.failures.slice(0, 20),
    },
  }, 200, { "x-request-id": requestId });
}

async function handleModels(req: Request, requestId: string): Promise<Response> {
  const upstreamApiKey = resolveUpstreamApiKey(req);
  assertUpstreamConfigured();

  const resp = await fetch(CONFIG.upstreamBaseUrl + "/v1/models", {
    headers: {
      "authorization": "Bearer " + upstreamApiKey,
      "content-type": "application/json",
    },
  });

  const body = await resp.text();
  log("info", "models proxied", {
    request_id: requestId,
    upstream_status: resp.status,
    bytes: body.length,
  });

  return new Response(body, {
    status: resp.status,
    headers: {
      ...corsHeaders(),
      "content-type": resp.headers.get("content-type") || "application/json; charset=utf-8",
      "x-request-id": requestId,
    },
  });
}

async function handleHealth(): Promise<Response> {
  return jsonResponse({
    ok: true,
    time: new Date().toISOString(),
    runtime: {
      kind: CONFIG.runtime.kind,
      label: CONFIG.runtime.label,
      is_edge: CONFIG.runtime.isEdge,
      has_deno_serve: CONFIG.runtime.hasDenoServe,
    },
    upstream_configured: Boolean(CONFIG.upstreamBaseUrl),
  });
}


async function route(req: Request): Promise<Response> {
  const requestId = req.headers.get("x-request-id") || makeRequestId();
  const url = new URL(req.url);
  const path = url.pathname;

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const started = Date.now();
  if (CONFIG.prettyLogs) printPrettyDivider(`request start ${requestId}`);
  log("info", "request received", {
    request_id: requestId,
    method: req.method,
    path,
    content_type: req.headers.get("content-type") || "",
    content_length: req.headers.get("content-length") || "",
    client: req.headers.get("x-forwarded-for") || req.headers.get("cf-connecting-ip") || "",
  });

  try {
    if (req.method === "GET" && path === "/health") {
      return await handleHealth();
    }

    if (req.method === "GET" && path === "/v1/models") {
      return await handleModels(req, requestId);
    }

    if (req.method === "POST" && path === "/v1/images/generations") {
      return await handleImageEndpoint(req, "generation", requestId);
    }

    if (req.method === "POST" && path === "/v1/images/edits") {
      return await handleImageEndpoint(req, "edit", requestId);
    }

    if (req.method === "POST" && path === "/v1/images/variations") {
      return await handleImageEndpoint(req, "variation", requestId);
    }

    throw new HttpError(404, "Not found", "invalid_request_error", "not_found");
  } finally {
    log("info", "request finished", {
      request_id: requestId,
      method: req.method,
      path,
      elapsed_ms: Date.now() - started,
    });
    if (CONFIG.prettyLogs) printPrettyDivider(`request end ${requestId}`);
  }
}

function logRuntimeBoot(kind: "server" | "worker"): void {
  if (runtimeBootLogged) return;
  runtimeBootLogged = true;
  log("info", kind === "server" ? "server starting" : "worker initialized", {
    runtime: CONFIG.runtime.kind,
    runtime_label: CONFIG.runtime.label,
    is_edge: CONFIG.runtime.isEdge,
    hostname: CONFIG.host,
    port: CONFIG.port,
    upstream_base_url: CONFIG.upstreamBaseUrl || "(not configured)",
    default_model: CONFIG.defaultModel,
    default_race_concurrency: CONFIG.defaultRaceConcurrency,
    max_race_concurrency: CONFIG.maxRaceConcurrency,
    max_upstream_concurrency: CONFIG.maxUpstreamConcurrency,
    max_total_upstream_calls: CONFIG.maxTotalUpstreamCalls,
    image_partial_fallback: CONFIG.imagePartialFallback,
  });
}


async function appFetch(req: Request, bindings?: RuntimeEnvBindings): Promise<Response> {
  configureRuntime(bindings);
  logRuntimeBoot(CONFIG.runtime.kind === "cloudflare-worker" ? "worker" : "server");
  const requestId = req.headers.get("x-request-id") || makeRequestId();
  try {
    return await route(req);
  } catch (err) {
    return errorResponse(err, requestId);
  }
}

export default {
  async fetch(req: Request, bindings?: RuntimeEnvBindings, _ctx?: { waitUntil?: (promise: Promise<unknown>) => void }): Promise<Response> {
    return await appFetch(req, bindings);
  },
};

const DENO_RUNTIME = (globalThis as any).Deno;
if (CONFIG.runtime.hasDenoServe && typeof DENO_RUNTIME?.serve === "function") {
  logRuntimeBoot("server");
  DENO_RUNTIME.serve({ hostname: CONFIG.host, port: CONFIG.port }, async (req: Request) => {
    return await appFetch(req);
  });
}