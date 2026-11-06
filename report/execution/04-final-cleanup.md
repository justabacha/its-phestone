# Final Lifecycle and Security Cleanup

## Changes

- **`bot/core/router.js`**: Owner phone numbers are extracted from the sender JID and compared by exact equality against configured owner numbers. `fromMe` messages remain accepted.
- **`bot/index.js`**: Added raw `console.log` and `console.error` filters for noisy libsignal `SessionEntry`, closed-session, `_chains`, and `registrationId` output. Filtering handles errors and circular objects safely and leaves the custom Pino logger unchanged.
- **`bot/core/connection.js`**: Removed the unused `qrcode-terminal` import; pairing-code flow remains unchanged.

## Verification

- Syntax and diff checks passed.
- Isolated checks verified exact owner-number matching, filtering of matching console output, and preservation of unrelated console output.
