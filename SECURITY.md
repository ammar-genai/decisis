# Security

## Reporting

Please report anything security-relevant through GitHub's private vulnerability reporting on this repository, rather than opening a public issue.

## API keys

These packages talk to model providers on your behalf, so a key is involved.

- A key is read from the environment (`OPENROUTER_API_KEY`) or from a `.env` file you point at. It is held in one variable, sent as an `Authorization` header, and never logged, echoed in an error, or written to disk by this code.
- Errors from a provider are surfaced with their status and message, which never contain the key.
- `.env` is gitignored here. Keep it that way in your own project, and rotate a key the moment it appears anywhere it should not - a chat window, a screenshot, a log.

## What the packages do at runtime

- `@decisis/core` makes one HTTPS request per decision to the provider you configure, and nothing else. Every adapter takes an injectable `fetch`, so tests never reach the network.
- `@decisis/router` additionally runs the `claude` CLI as a subprocess, with the permission mode and tool allowlist from your config. It never commits or pushes.
- `@decisis/shadow` only reads files from the system it watches; it writes its own log and nothing else.
- `@decisis/mcp` exposes three tools over stdio. A provider failure is returned as a tool error, not raised as a crash.

Nothing in this repository executes model output as code.
