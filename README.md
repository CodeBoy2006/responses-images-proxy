# OpenAI-Compatible Images Proxy for Responses Image Generation

A single-file Deno / edge-runtime server that exposes OpenAI-compatible image endpoints and internally forwards each request to an OpenAI-compatible `/v1/responses` endpoint using the `image_generation` tool.

This build does **not** use local file storage. Generated images are returned directly in the HTTP response as either base64 JSON or data URLs.

The active server file in this repository is:

```text
server.ts
```

## What This Server Does

This server provides a compatibility layer for clients that expect the legacy-style OpenAI Images API:

- `POST /v1/images/generations`
- `POST /v1/images/edits`
- `POST /v1/images/variations`

Internally, each image request is converted into a streaming `/v1/responses` request with:

- a system prompt optimized for image generation,
- an `image_generation` tool definition,
- optional reference images converted to data URLs,
- forced `tool_choice` for image generation,
- SSE parsing to extract final or partial image data.

It also includes:

- `GET /health`
- `GET /v1/models`
- CORS support
- optional proxy-level authentication
- upstream API-key forwarding
- configurable request limits
- retry/candidate collection for image generation robustness
- runtime detection for local Deno, Deno Deploy, Cloudflare Workers, and other edge-like environments

## Architecture

```text
Client
  |
  |  OpenAI-compatible request
  |  /v1/images/generations
  |  /v1/images/edits
  |  /v1/images/variations
  v
This proxy
  |
  |  /v1/responses
  |  stream: true
  |  tool: image_generation
  v
OpenAI-compatible upstream
  |
  |  SSE image_generation events
  v
This proxy extracts image bytes
  |
  |  b64_json or data URL response
  v
Client
```

## Key Design Choices

### No File Storage

This version intentionally avoids writing generated images to disk, object storage, or any public file-serving endpoint.

When the client asks for:

```json
{ "response_format": "url" }
```

the response uses a `data:image/...;base64,...` URL instead of a hosted HTTP URL.

When the client asks for or omits:

```json
{ "response_format": "b64_json" }
```

the response returns base64 image data in `data[].b64_json`.

### OpenAI-Compatible Surface, Responses-Compatible Backend

The public API looks like `/v1/images/*`, but the upstream call is made to:

```text
{UPSTREAM_BASE_URL}/v1/responses
```

The generated upstream payload uses:

```json
{
  "stream": true,
  "tools": [
    {
      "type": "image_generation"
    }
  ],
  "tool_choice": {
    "type": "image_generation"
  }
}
```

### Lenient Candidate Collection

The server can start more upstream attempts than the final requested image count. This is designed to improve success rates when the upstream sometimes fails to emit a final image.

The core controls are:

- `n`: requested number of output images
- `race_concurrency` / `concurrency`: candidate multiplier
- `upstream_concurrency`: maximum parallel upstream calls
- `MAX_TOTAL_UPSTREAM_CALLS`: hard cap on planned attempts

The current implementation uses a lenient batch collector: it accepts successful candidates until `n` images are collected or all planned candidates are exhausted.

### Streaming Image Extraction

The proxy expects the upstream `/v1/responses` endpoint to stream Server-Sent Events. It parses events and looks for final image payloads in common fields such as:

- `result`
- `b64_json`
- `image_base64`
- `base64`
- `data`

It also tracks partial image events and can optionally return the last partial image if `IMAGE_PARTIAL_FALLBACK=true`.

## Runtime Support

The server is written against web-standard APIs and supports multiple runtimes:

| Runtime               | How it runs                                                  |
| --------------------- | ------------------------------------------------------------ |
| Local Deno            | Uses `Deno.serve(...)`                                       |
| Deno Deploy           | Uses the same Deno server path with deployment env detection |
| Cloudflare Workers    | Uses the default `fetch` export                              |
| Unknown edge runtimes | Uses the default `fetch` export when compatible              |

The runtime is detected automatically.

## Requirements

- Deno for local execution
- Docker with Docker Compose v2 for Compose-based development
- An upstream service that exposes:
  - `POST /v1/responses`
  - optionally `GET /v1/models`
- The upstream `/v1/responses` endpoint must support:
  - `stream: true`
  - `image_generation` tool calls
  - image output in base64-compatible event payloads

No third-party TypeScript dependencies are required.

## Quick Start

### Docker Compose Development

Create a local environment file:

```bash
cp .env.example .env
```

Edit `.env`, then start the service:

```bash
docker compose up
```

The Compose service uses `denoland/deno:2.6.5`, bind-mounts this directory at `/app`, keeps Deno's cache in a named volume, and runs:

```bash
deno run --watch=server.ts --no-clear-screen --allow-net --allow-env server.ts
```

Changes to `server.ts` are picked up by Deno's watcher, so you can edit code and restart the running process without rebuilding a Docker image.

The server listens on:

```text
http://localhost:8000
```

by default.

Stop the Compose service:

```bash
docker compose down
```

### Local Deno

Run the server directly:

```bash
UPSTREAM_BASE_URL="https://your-upstream.example.com" \
UPSTREAM_API_KEY="sk-upstream" \
PROXY_API_KEY="local-secret" \
deno run --allow-net --allow-env server.ts
```

The server listens on:

```text
http://0.0.0.0:8000
```

by default.

## Environment Variables

| Variable                         |         Default | Description                                                  |
| -------------------------------- | --------------: | ------------------------------------------------------------ |
| `HOST`                           |       `0.0.0.0` | Hostname used by local Deno server.                          |
| `PORT`                           |          `8000` | Port used by local Deno server.                              |
| `UPSTREAM_BASE_URL`              |           empty | Required upstream base URL. A trailing `/v1` is automatically stripped. |
| `UPSTREAM_API_KEY`               |           empty | Upstream API key. If empty, the client bearer token is forwarded upstream. |
| `PROXY_API_KEY`                  |           empty | Optional proxy auth key. If set, clients must pass `Authorization: Bearer <PROXY_API_KEY>`. |
| `DEFAULT_MODEL`                  | `gpt-5.3-codex` | Default model used for upstream `/v1/responses` requests.    |
| `UPSTREAM_IMAGE_OUTPUT_FORMAT`   |           `png` | Default image output format: `png`, `jpeg`, or `webp`.       |
| `IMAGE_RACE_CONCURRENCY`         |             `1` | Default candidate multiplier used when the request does not specify concurrency. |
| `MAX_IMAGE_RACE_CONCURRENCY`     |             `4` | Maximum accepted race/candidate multiplier.                  |
| `MAX_TOTAL_UPSTREAM_CALLS`       |             `8` | Maximum planned upstream attempts per image request.         |
| `MAX_IMAGE_UPSTREAM_CONCURRENCY` |             `4` | Maximum parallel upstream image calls.                       |
| `MAX_OUTPUT_IMAGES`              |             `4` | Maximum allowed `n` value.                                   |
| `UPSTREAM_TIMEOUT_MS`            |        `180000` | Timeout for one upstream attempt.                            |
| `MAX_ERROR_BODY_BYTES`           |          `8192` | Maximum number of bytes included from an upstream error response body. |
| `MAX_REQUEST_BYTES`              |      `83886080` | Maximum request body size, checked via `Content-Length` when present. |
| `MAX_INPUT_IMAGE_BYTES`          |      `26214400` | Maximum size for each input image.                           |
| `MAX_INPUT_IMAGES`               |             `8` | Maximum number of input images.                              |
| `ALLOW_REMOTE_IMAGE_URLS`        |         `false` | Whether `http://` and `https://` image inputs may be fetched by the proxy. |
| `CORS_ALLOW_ORIGIN`              |             `*` | Value for `Access-Control-Allow-Origin`.                     |
| `LOG_LEVEL`                      |          `info` | Log level: `debug`, `info`, `warn`, or `error`.              |
| `LOG_SSE_DATA`                   |         `false` | Whether debug logs include SSE data previews. Be careful: this may expose sensitive payload data. |
| `IMAGE_PARTIAL_FALLBACK`         |         `false` | If true, returns the last partial image when no final image is found. |

For Docker Compose, these variables can be placed in `.env`; `compose.yaml` forwards them into the container.

## Authentication Model

The proxy supports two authentication patterns.

### 1. Fixed Upstream Key

Set:

```bash
UPSTREAM_API_KEY="sk-upstream"
```

Then every upstream call uses that key.

Optionally protect the proxy itself:

```bash
PROXY_API_KEY="local-secret"
```

Clients must then call the proxy with:

```http
Authorization: Bearer local-secret
```

### 2. Client Bearer Forwarding

If `UPSTREAM_API_KEY` is empty, the proxy forwards the client's bearer token to the upstream service.

Example:

```http
Authorization: Bearer sk-client-or-upstream-key
```

If `PROXY_API_KEY` is set, the same bearer token is first validated against `PROXY_API_KEY`, so fixed upstream auth is usually simpler when proxy auth is enabled.

## Endpoints

### `GET /health`

Returns runtime and configuration health information.

Example:

```bash
curl http://localhost:8000/health
```

Example response:

```json
{
  "ok": true,
  "time": "2026-01-01T00:00:00.000Z",
  "runtime": {
    "kind": "deno-local",
    "label": "Local Deno",
    "is_edge": false,
    "has_deno_serve": true
  },
  "upstream_configured": true
}
```

### `GET /v1/models`

Proxies the upstream models endpoint:

```text
{UPSTREAM_BASE_URL}/v1/models
```

Example:

```bash
curl http://localhost:8000/v1/models \
  -H "Authorization: Bearer local-secret"
```

### `POST /v1/images/generations`

Generates new images from a prompt.

JSON example:

```bash
curl http://localhost:8000/v1/images/generations \
  -H "Authorization: Bearer local-secret" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.3-codex",
    "prompt": "A cinematic photo of a glass greenhouse in a snowy forest at sunrise",
    "n": 1,
    "size": "1024x1024",
    "quality": "high",
    "output_format": "png",
    "response_format": "b64_json"
  }'
```

### `POST /v1/images/edits`

Edits one or more reference images.

Multipart example:

```bash
curl http://localhost:8000/v1/images/edits \
  -H "Authorization: Bearer local-secret" \
  -F 'prompt=Replace the background with a clean white studio backdrop' \
  -F 'image=@input.png' \
  -F 'n=1' \
  -F 'size=1024x1024'
```

JSON with data URL example:

```bash
curl http://localhost:8000/v1/images/edits \
  -H "Authorization: Bearer local-secret" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Make the product look like it is floating above a marble table",
    "image": "data:image/png;base64,iVBORw0KGgo...",
    "response_format": "b64_json"
  }'
```

### `POST /v1/images/variations`

Creates a high-quality variation from a reference image.

The `prompt` field is optional for variations. If omitted, the server uses a default prompt that asks the upstream image tool to preserve the subject and composition while naturally changing details.

Multipart example:

```bash
curl http://localhost:8000/v1/images/variations \
  -H "Authorization: Bearer local-secret" \
  -F 'image=@reference.png' \
  -F 'n=1'
```

With an explicit prompt:

```bash
curl http://localhost:8000/v1/images/variations \
  -H "Authorization: Bearer local-secret" \
  -F 'image=@reference.png' \
  -F 'prompt=Create a warmer, golden-hour variation while preserving the main subject'
```

## Request Parameters

The server accepts both JSON and `multipart/form-data`.

### Common Image Parameters

| Parameter              |    Type |                    Default | Description                                                  |
| ---------------------- | ------: | -------------------------: | ------------------------------------------------------------ |
| `model`                |  string |            `DEFAULT_MODEL` | Upstream Responses model.                                    |
| `prompt`               |  string | required except variations | User image instruction.                                      |
| `n`                    | integer |                        `1` | Number of images requested. Clamped to `1..MAX_OUTPUT_IMAGES`. |
| `response_format`      |  string |                 `b64_json` | Either `b64_json` or `url`. `url` returns a data URL in this no-storage build. |
| `size`                 |  string |                      unset | Forwarded to the `image_generation` tool.                    |
| `quality`              |  string |                      unset | Forwarded to the `image_generation` tool.                    |
| `output_format`        |  string |                env default | `png`, `jpeg`, `jpg`, or `webp`. `jpg` is normalized to `jpeg`. |
| `race_concurrency`     | integer |                env default | Candidate multiplier. Also accepted as `race_count` or `concurrency`. |
| `upstream_concurrency` | integer |                env default | Maximum parallel upstream calls. Also accepted as `max_upstream_concurrency` or `max_concurrency`. |

### Image-Generation Tool Parameters

These values are forwarded into the upstream `image_generation` tool.

| Parameter                                             | Allowed values                             | Description                                             |
| ----------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------- |
| `image_model`, `image_generation_model`, `tool_model` | string                                     | Tool-specific model override.                           |
| `action`, `image_action`                              | `auto`, `generate`, `edit`                 | Tool action.                                            |
| `background`                                          | `auto`, `opaque`, `transparent`            | Background mode.                                        |
| `moderation`                                          | `auto`, `low`                              | Moderation mode. Defaults to `low`.                     |
| `input_fidelity`, `fidelity`                          | `high`, `low`                              | Reference-image fidelity.                               |
| `input_image_mask`, `image_mask`, `mask`              | file, data URL, base64, file ID, or object | Optional mask for image editing.                        |
| `output_compression`                                  | integer `0..100`                           | Tool output compression.                                |
| `partial_images`                                      | integer `0..3`                             | Number of partial image events requested from upstream. |

Most tool parameters can also be supplied through headers:

| Header                         | Equivalent parameter   |
| ------------------------------ | ---------------------- |
| `x-image-model`                | `image_model`          |
| `x-image-action`               | `action`               |
| `x-image-background`           | `background`           |
| `x-image-moderation`           | `moderation`           |
| `x-image-input-fidelity`       | `input_fidelity`       |
| `x-image-output-compression`   | `output_compression`   |
| `x-image-partial-images`       | `partial_images`       |
| `x-image-race-concurrency`     | `race_concurrency`     |
| `x-image-upstream-concurrency` | `upstream_concurrency` |

### Image Input Fields

For edits and variations, at least one image is required.

Accepted multipart field names:

- `image`
- `image[]`
- `images`
- `images[]`

Accepted JSON field names:

- `image`
- `images`

Each image can be:

- a multipart `File`
- a `data:image/...;base64,...` URL
- raw base64 image data
- an HTTP(S) URL, only when `ALLOW_REMOTE_IMAGE_URLS=true`

Supported image magic-byte detection includes:

- PNG
- JPEG
- WebP
- GIF

## Response Format

Successful image responses look like this:

```json
{
  "created": 1767225600,
  "data": [
    {
      "b64_json": "iVBORw0KGgo...",
      "mime_type": "image/png",
      "size_bytes": 123456,
      "revised_prompt": "A cinematic photo..."
    }
  ],
  "partial": false,
  "requested": 1,
  "successful": 1,
  "attempts": {
    "planned": 1,
    "started": 1,
    "completed": 1,
    "failed": 0,
    "active_aborted": 0,
    "upstream_concurrency": 1,
    "stopped_reason": "target_success_count_reached",
    "failure_reasons": []
  }
}
```

If `response_format` is `url`, each image item contains:

```json
{
  "url": "data:image/png;base64,iVBORw0KGgo..."
}
```

instead of `b64_json`.

The response may be partial:

```json
{
  "partial": true,
  "requested": 4,
  "successful": 2
}
```

This means the server exhausted all planned upstream candidates before collecting all requested images.

## Error Format

Errors are returned in JSON:

```json
{
  "error": {
    "message": "prompt is required",
    "type": "invalid_request_error",
    "code": "missing_prompt",
    "details": {}
  }
}
```

Common status codes:

| Status | Cause                                                        |
| -----: | ------------------------------------------------------------ |
|  `400` | Invalid JSON, missing prompt, missing image for edit/variation, unsupported parameter, invalid image input. |
|  `401` | Missing or invalid proxy/upstream API key.                   |
|  `404` | Unknown route.                                               |
|  `413` | Request body or input image is too large.                    |
|  `500` | Proxy configuration error or unhandled server error.         |
|  `502` | Upstream failure, missing stream body, no final image found, or all attempts failed. |

## CORS

The server responds to `OPTIONS` with:

```http
Access-Control-Allow-Methods: GET,POST,OPTIONS
Access-Control-Allow-Headers: authorization,content-type,x-image-race-concurrency,x-image-upstream-concurrency,x-request-id
Access-Control-Expose-Headers: x-request-id
```

The allowed origin is controlled by:

```bash
CORS_ALLOW_ORIGIN="*"
```

## Logging

Logs are structured JSON lines.

Example boot log fields include:

- runtime kind and label
- host and port
- upstream base URL
- default model
- concurrency limits
- partial fallback setting

Example request log fields include:

- `request_id`
- method and path
- content type and length
- parsed image parameters
- upstream attempt count
- success/failure counts
- elapsed time

Set:

```bash
LOG_LEVEL=debug
```

for more detailed logs.

Use `LOG_SSE_DATA=true` only in trusted environments because streamed event previews may contain sensitive content or generated image data.

## Deployment Notes

### Local Deno

```bash
deno run --allow-net --allow-env server.ts
```

Required permissions:

- `--allow-net` for the HTTP server and upstream requests
- `--allow-env` for configuration

### Docker Compose

```bash
docker compose up
```

The Compose setup is intended for local development. It does not build a project-specific image; it uses the official Deno image and bind-mounts this directory so source edits are immediately visible inside the container.

### Deno Deploy

Configure the same environment variables in your Deno Deploy project.

The server detects Deno Deploy using deployment-related environment variables and runs through the Deno serving path.

### Cloudflare Workers

The file exports a default object with a `fetch` handler:

```ts
export default {
  async fetch(req, bindings, ctx) {
    return await appFetch(req, bindings);
  },
};
```

For Workers, provide configuration through environment bindings.

## Security Considerations

- Set `PROXY_API_KEY` if the proxy is publicly reachable.
- Prefer setting `UPSTREAM_API_KEY` server-side instead of forwarding arbitrary client bearer tokens.
- Keep `ALLOW_REMOTE_IMAGE_URLS=false` unless you explicitly need remote image fetching.
- Remote image fetching can expose the proxy to SSRF-style risk if enabled without additional URL filtering.
- Keep `LOG_SSE_DATA=false` in production.
- Do not treat `response_format=url` as a persistent asset URL; this build returns data URLs only.
- Tune `MAX_REQUEST_BYTES`, `MAX_INPUT_IMAGE_BYTES`, `MAX_INPUT_IMAGES`, `MAX_TOTAL_UPSTREAM_CALLS`, and concurrency limits to control cost and abuse risk.

## Operational Tuning

### Improve Reliability

Increase candidate attempts:

```bash
IMAGE_RACE_CONCURRENCY=2
MAX_TOTAL_UPSTREAM_CALLS=8
```

Increase parallelism:

```bash
MAX_IMAGE_UPSTREAM_CONCURRENCY=4
```

Or per request:

```json
{
  "race_concurrency": 2,
  "upstream_concurrency": 4
}
```

### Reduce Cost

Lower candidate and output limits:

```bash
MAX_OUTPUT_IMAGES=1
MAX_TOTAL_UPSTREAM_CALLS=2
MAX_IMAGE_UPSTREAM_CONCURRENCY=1
```

### Handle Upstreams That Only Emit Partial Images

Enable partial fallback:

```bash
IMAGE_PARTIAL_FALLBACK=true
```

This returns the last partial image if the stream ends without a final image.

## Implementation Overview

Important internal functions:

| Function                                 | Responsibility                                               |
| ---------------------------------------- | ------------------------------------------------------------ |
| `buildConfig()`                          | Builds runtime configuration from bindings, Deno env, or process env. |
| `detectRuntime()`                        | Detects Cloudflare Workers, Deno Deploy, local Deno, or unknown edge runtime. |
| `parseImageRequest()`                    | Parses JSON or multipart image requests and validates limits. |
| `imageValueToDataUrl()`                  | Normalizes files, data URLs, base64 strings, or optional remote URLs to image data URLs. |
| `buildResponsesPayload()`                | Builds the upstream `/v1/responses` request with `image_generation`. |
| `iterSseEvents()`                        | Parses Server-Sent Events from the upstream response stream. |
| `extractFinalImageFromResponseEvent()`   | Extracts final generated image bytes from streamed response events. |
| `extractPartialImageFromResponseEvent()` | Caches partial images when present.                          |
| `callUpstreamOnce()`                     | Performs one upstream streamed image-generation attempt.     |
| `collectLenientUpstreamImages()`         | Runs multiple attempts until enough images are collected or candidates are exhausted. |
| `handleImageEndpoint()`                  | Shared handler for generation, edit, and variation endpoints. |
| `route()`                                | Routes all public endpoints.                                 |
| `appFetch()`                             | Runtime-neutral fetch entrypoint.                            |

## Known Limitations

- `response_format=url` returns a data URL, not a hosted URL.
- The proxy does not persist generated files.
- The upstream must support streamed `/v1/responses` with `image_generation`.
- The server extracts images heuristically from common event shapes; unusual upstream event schemas may require adjustment.
- The prompt-orchestration system messages are currently written in Chinese.
- The `raceUpstreamImage()` helper exists in the file but the active image path uses `collectLenientUpstreamImages()`.

## Minimal Client Compatibility Example

JavaScript:

```js
const response = await fetch("http://localhost:8000/v1/images/generations", {
  method: "POST",
  headers: {
    "Authorization": "Bearer local-secret",
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    prompt: "A minimalist black-and-white icon of a fox",
    n: 1,
    response_format: "b64_json"
  })
});

const result = await response.json();
const base64 = result.data[0].b64_json;
```

## License

No license is declared in the source file. Add a license before publishing or distributing this project.
