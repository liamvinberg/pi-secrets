# Secrets travel to commands via process.env, not files

pi's bash tool builds its child environment from the agent's own `process.env` (`getShellEnv()` spreads it), so setting `process.env[NAME]` at capture time makes `$NAME` available in every subsequent bash command. We chose this over the obvious alternative (writing the value to a `mktemp` file the model sources or `$(cat)`s) because it leaves zero bytes on disk, needs no cleanup or permission management, dies with the process, and is inherited by child processes (subagents) for free.

## Consequences

- Processes already running before a capture (notably MCP servers spawned at pi startup) never see the secret. A tool that needs one must receive it through a bash command (`echo "NAME=$NAME" >> .env`, `--env` flags, stdin pipes).
- Nothing survives a pi restart; the model must re-request. This is the intended UX, not a limitation to fix.
