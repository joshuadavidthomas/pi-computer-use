# v0.1.1 — stealth mode

## Patch notes

- Kept a small public tool surface: `screenshot`, `click`, `type_text`, `wait`
- Default mode is now AX-first with fallback for broader compatibility
- Opt-in stealth mode (`PI_COMPUTER_USE_STEALTH=1` / `PI_COMPUTER_USE_STRICT_AX=1`) blocks fallback paths and keeps actions on semantic AX routes
- Enforced background-safe behavior in stealth validation: no foreground activation, no cursor takeover, and no keyboard-focus stealing during validated flows
- Improved AX target discovery with ranked candidates, confidence reporting, and better window-target diagnostics
- Expanded strict QA coverage across Finder, TextEdit, Safari, Reminders, Notes, Calendar, and Chrome
