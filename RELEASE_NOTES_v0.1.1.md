# v0.1.1 — stealth mode + inline setup

## Patch notes

- Kept a small public tool surface: `screenshot`, `click`, `type_text`, `wait`
- Default mode is now built-in screenshot/vision grounding with AX-first actions and compatibility fallback
- Opt-in stealth mode (`PI_COMPUTER_USE_STEALTH=1` / `PI_COMPUTER_USE_STRICT_AX=1`) blocks fallback paths and keeps actions on semantic AX routes
- Added required inline first-run setup in interactive Pi sessions so permission problems are surfaced immediately instead of failing later during tool use
- Polished onboarding copy to explain the two required macOS permissions in plain language:
  - Screen Recording lets the agent see the window
  - Accessibility lets the agent click, focus, and type
- Improved setup-cancel and unavailable-state messaging so pi-computer-use reads as “not ready yet” instead of failing invisibly
- Enforced background-safe behavior in stealth validation: no foreground activation, no cursor takeover, and no keyboard-focus stealing during validated flows
- Improved AX target discovery with ranked candidates, confidence reporting, and better window-target diagnostics
- Expanded strict QA coverage across Finder, TextEdit, Safari, Reminders, Notes, Calendar, and Chrome
- Fixed the helper screenshot timeout issue by adding a more reliable window-capture fallback path in the native macOS helper
