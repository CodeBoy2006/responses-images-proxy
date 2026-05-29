## [2026-05-29 19:16] Add Docker Compose Development Runner
- **Changes:** Added `compose.yaml` with a Deno image, bind-mounted project directory, watch-mode execution, environment wiring, and a named Deno cache volume. Added `.env.example` and `README.md` with Compose startup instructions.
- **Status:** Completed
- **Next Steps:** Run `cp .env.example .env`, set upstream credentials, then use `docker compose up` for local development.
- **Context:** This directory is not a Git repository, so the normal commit/push workflow cannot run here.

## [2026-05-29 19:17] Clean Docker Compose Init Handling
- **Changes:** Removed `init: true` from `compose.yaml` after runtime verification showed the official Deno image already wraps the command with Tini.
- **Status:** Completed
- **Next Steps:** Re-run Compose verification after the config cleanup.
- **Context:** Avoids duplicate Tini warnings while preserving normal signal handling from the base image.

## [2026-05-29 19:32] Expand Project README
- **Changes:** Replaced the short README with full API, runtime, authentication, environment, endpoint, deployment, and operational documentation. Expanded `compose.yaml` and `.env.example` so documented environment variables are forwarded during Docker Compose development.
- **Status:** Completed
- **Next Steps:** Validate Markdown references and Compose config after the documentation expansion.
- **Context:** README examples use the actual repository entrypoint `server.ts`.
