# pi-computer-use

**Demo:** [`pi-computer-use.mp4`](./assets/pi-computer-use.mp4)

![pi-computer-use](./assets/img.jpg)

Add Codex-style computer-use tools to Pi on macOS.

This package bundles:
- a Pi extension that adds semantic computer-use tools
- a skill that teaches the agent how to use those tools reliably
- a native macOS helper used for screenshots and AX dispatch

## What you get

Public tools:
- `screenshot`
- `click`
- `type_text`
- `wait`

Default mode has built-in screenshot/vision grounding and uses AX-first actions with compatibility fallback when semantic AX control is not enough.

Opt-in stealth mode (`PI_COMPUTER_USE_STEALTH=1` or `PI_COMPUTER_USE_STRICT_AX=1`) keeps the same public surface, but blocks non-AX fallback paths and stays AX-only.

## Requirements

- macOS 15+
- Pi / `@mariozechner/pi-coding-agent`
- Node.js 20.6+
- Accessibility and Screen Recording permission for the helper binary

## Install

`pi-computer-use` currently resolves to an unrelated package. Install this package from GitHub or a local checkout instead.

### Global install

```bash
pi install git:github.com/injaneity/pi-computer-use
```

### Project-local install

```bash
pi install -l git:github.com/injaneity/pi-computer-use
```

### Install from a local checkout

```bash
pi install /absolute/path/to/pi-computer-use
# or
pi install -l /absolute/path/to/pi-computer-use
```

This follows the standard Pi package install flow used by other Pi packages.

## What happens after install

- Pi loads the extension from `extensions/`
- Pi loads the skill from `skills/`
- the helper is installed to:

```text
~/.pi/agent/helpers/pi-computer-use/bridge
```

The package tries to copy a bundled prebuilt helper during `postinstall`. If a matching prebuilt is not available, the runtime can build one locally on first use.

## First run / required setup

Start Pi in interactive mode.

On session start, the extension performs a one-time computer-use setup check automatically. If permissions are missing, Pi surfaces that immediately and walks you through setup inline instead of failing later during tool use.

If permissions are missing, the extension will guide you through granting:
- Accessibility
- Screen Recording

Permissions required:
- Screen Recording: lets the agent see the target window and provides screenshot/vision context
- Accessibility: lets the agent click, focus, and type in the target window

Normally you do not need any additional permission beyond those two.

If you cancel setup, pi-computer-use stays unavailable until setup is completed.

Grant both permissions to the helper at:

```text
~/.pi/agent/helpers/pi-computer-use/bridge
```

## Example prompts

- `Use the computer-use tools to inspect the frontmost window.`
- `Take a screenshot of the current window and click the Continue button.`
- `Switch to Safari, open the current tab area, and report what you see.`

## Notes

- Target platform: macOS only
- `screenshot` should be called first to choose a target window
- Successful actions return a fresh screenshot for the next step
- The helper uses a non-intrusive strategy where possible instead of taking over your cursor globally
- Accessibility is mandatory for practical use: actions depend on it
- Screen Recording is mandatory for screenshots and model vision context
- Public tool surface is `screenshot`, `click`, `type_text`, `wait`
- Default mode has built-in screenshot/vision grounding and runs AX-first, with non-AX fallback when a control cannot be completed semantically
- Opt-in stealth mode blocks fallback paths and keeps actions on AX-only semantic paths
- Tool results include execution metadata so we can verify whether an action used AX or a fallback path
- Stealth mode remains on the current desktop/session only: no second screen or virtual display, no foreground activation, and no physical cursor takeover

## Build the helper manually

If you need to build the helper yourself:

```bash
node scripts/build-native.mjs
```

You can also build to a custom output path:

```bash
node scripts/build-native.mjs --output ~/.pi/agent/helpers/pi-computer-use/bridge
```

## Remove

```bash
pi remove git:github.com/injaneity/pi-computer-use
```

## License

MIT
