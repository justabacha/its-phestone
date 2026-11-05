# Phase 5C: Router and Ping Command

## Files created/modified

- Created `bot/commands/ping.js` with the `ping` command.
- Created `bot/core/router.js` to route prefixed commands and silently skip non-owner messages.
- Modified `bot/core/connection.js` to pass notification messages to the router.
- Modified `bot/index.js` to load commands at startup.

## How to test

Send `!ping` to the bot. It should reply with `🏓 Pong!`.
