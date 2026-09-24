# Security Policy

## Reporting a Vulnerability

Please report security vulnerabilities privately via GitHub Security Advisories on this repository, or email the maintainers. Do **not** open a public issue for security reports.

We aim to acknowledge reports within 72 hours and provide a fix or mitigation plan within 14 days for high-severity issues.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.x     | ✅        |

## Security Defaults

- **PII redaction is enabled by default** (`piiRedaction.enabled: true`). Prompt content is redacted from logs unless `capturePromptInLogs: true`.
- OTLP headers reject CR/LF injection.
- Config validation rejects invalid endpoints, protocols, and batch bounds before export.
- Local span persistence writes only to a configured directory (default under the project worktree).
- Dynamic header helpers are executed as separate processes with a timeout; failures keep previous headers and never crash the host.

## Secrets Guidance

- Prefer environment variables or the headers helper for API keys — do not commit secrets in `opencode.json`.
- Use `OPENCODE_OTEL_HEADERS` or `OPENCODE_OTEL_HEADERS_HELPER` for collector credentials.
- Resource attributes and span attributes may be exported to your collector; treat them as potentially sensitive.

## Scope

This plugin exports telemetry to an OTLP endpoint you configure. You are responsible for:

- Securing the collector endpoint (TLS, auth)
- Compliance of exported data with your privacy policy
- Protecting `OPENCODE_*` environment variables in CI
