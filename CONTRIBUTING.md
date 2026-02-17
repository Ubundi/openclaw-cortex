# Contributing

## Setup

```bash
npm install
npm run build
npm test
```

## Development Workflow

1. Create a branch from `main`.
2. Make focused changes with tests.
3. Run `npm run build` and `npm test` before opening a PR.
4. If your change affects Cortex API behavior, also run `npm run test:integration` with `CORTEX_API_KEY` set.

## Project Layout

- `src/` plugin source code
- `tests/unit/` unit tests
- `tests/integration/` live API integration tests
- `tests/manual/` manual harness/proof scripts
- `docs/` architecture and testing docs

## Pull Requests

- Keep PRs scoped to one concern.
- Update docs when behavior or configuration changes.
- Add or adjust tests for bug fixes and features.
