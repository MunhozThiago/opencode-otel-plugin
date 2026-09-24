# Contributing to opencode-otel-plugin

Thanks for your interest in contributing!

## Development Setup

```bash
npm install
npm run build
npm test
```

Requirements:

- Node.js ≥ 20
- npm ≥ 9

## Workflow

1. Fork and create a feature branch from `main`.
2. Make changes in `src/` (TypeScript, ESM, `NodeNext` module resolution).
3. **Rebuild before testing** — unit tests import compiled output from `dist/`:

   ```bash
   npm run build && npm test
   ```

4. Add or update tests under `tests/unit/` or `tests/integration/`.
5. Run `npm audit` and ensure 0 high/critical vulnerabilities.
6. Open a pull request with a clear description of the change and motivation.

## Code Style

- ESM only (`import`/`export`); `require()` is not allowed in `src/`.
- Prefer top-level imports over dynamic `import()` except for lazy OTLP exporters.
- Keep hooks non-throwing: observability must never break the host (use `safeHook` patterns).
- Ambient OTel types live in `src/opentelemetry.d.ts` — update it when changing OTel API usage.

## Testing

```bash
npm test           # vitest run (all suites)
npx vitest tests/unit/config.test.ts   # single file
```

Integration tests (`tests/integration/e2e.test.ts`) exercise the event hook against a test provider.

## Pull Request Checklist

- [ ] `npm run build` exits 0
- [ ] `npm test` all green
- [ ] `npm audit` no high/critical issues
- [ ] New behavior covered by tests
- [ ] README/config docs updated if options changed

## Reporting Issues

Open a GitHub issue with:

- Plugin version
- opencode / Node versions
- Minimal reproduction or relevant logs (redact secrets)

Security issues: see [SECURITY.md](./SECURITY.md).

## Release

Maintainers run `npm version` + `npm publish` (or the release workflow). `prepublishOnly` runs build + tests automatically.
