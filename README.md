> Latest release: **v0.1.3** — added semantic AX target refs via `click({ ref: "@eN" })`, switched to semantic-first turn updates with image fallback only when needed, added an official benchmark harness in `benchmarks/`, and improved benchmarked performance from `axOnlyRatio 0.5 → 1.0` (**+100%**) and `avgLatencyMs 11194 → 404` (**-10790ms / -96.4%**).

# pi-computer-use

![pi-computer-use](./assets/img.jpg)

Codex-style computer use for Pi on macOS with AX-first semantic targeting, semantic state updates, and image fallback when semantic coverage is weak.

> For setup, development, benchmarks, and contribution workflow, see [CONTRIBUTING.md](./CONTRIBUTING.md).

## Features

- Public tools: `screenshot`, `click`, `type_text`, `wait`
- AX target refs in tool results, e.g. `@e1`, for semantic targeting
- `click({ ref: "@eN" })` support alongside coordinate clicks
- Semantic-first turn updates with image attachment fallback only when needed
- AX-first execution with optional strict AX-only mode via `PI_COMPUTER_USE_STEALTH=1` or `PI_COMPUTER_USE_STRICT_AX=1`
- Browser-aware targeting, including isolated browser window preference when appropriate
- Non-intrusive helper behavior where possible instead of global cursor takeover
- Official benchmark harness in `benchmarks/` with baseline comparison and regression checks

## Setup

### Install

`pi-computer-use` currently resolves to an unrelated package. Install this package from GitHub or a local checkout instead.

```bash
pi install git:github.com/injaneity/pi-computer-use
# or project-local
pi install -l git:github.com/injaneity/pi-computer-use
# or from a local checkout
pi install /absolute/path/to/pi-computer-use
```

### First run

Start Pi in interactive mode. On session start, the extension checks whether computer-use is ready and guides you through setup if permissions are missing.

Grant both permissions to the helper at:

```text
~/.pi/agent/helpers/pi-computer-use/bridge
```

Required permissions:
- Accessibility
- Screen Recording

### Helper build

If you need to build the helper manually:

```bash
node scripts/build-native.mjs
# or build directly to the installed helper path
node scripts/build-native.mjs --output ~/.pi/agent/helpers/pi-computer-use/bridge
```

### Remove

```bash
pi remove git:github.com/injaneity/pi-computer-use
```
