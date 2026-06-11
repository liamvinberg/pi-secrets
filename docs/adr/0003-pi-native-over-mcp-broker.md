# A pi-native extension, not a shared MCP broker

An MCP "secrets broker" server could in principle serve both pi and Claude Code from one codebase. But as an external process it cannot set pi's `process.env` (no env-var delivery), cannot hook `tool_result` (no redaction), and cannot draw a masked prompt inside pi's TUI. We traded cross-harness portability for those three properties.

## Consequences

- A Claude Code counterpart is a separate build: an MCP server using elicitation (responses stay server-side), delivery via a `CLAUDE_ENV_FILE` hook, and a PostToolUse redaction hook. It shares this design (the CONTEXT.md language and the reuse/redaction rules) but not this code.
