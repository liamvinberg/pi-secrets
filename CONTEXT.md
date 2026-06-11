# pi-secrets

Secure hand-off of secrets from a human to a pi coding-agent session: the agent asks, the human enters the value in a masked prompt, and the value reaches commands without ever entering the model's context.

## Language

**Secret**:
A sensitive value (API key, token, password) owned by the human. Exists only in process memory and the process environment, never in model context, chat, or session files.
_Avoid_: credential, key

**Secret Name**:
The UPPER_SNAKE_CASE environment-variable identifier (e.g. `STRIPE_API_KEY`) the model uses to refer to a Secret. The only secret-related token that may appear in context.
_Avoid_: key, variable

**Capture**:
The human entering a Secret into the masked prompt in response to a `request_secret` call.
_Avoid_: input, entry

**Inherited Secret**:
A value already present in the shell environment when pi started. Becomes tracked (and redacted) only after the human confirms reuse.

**Seeded Secret**:
A Secret a child pi process (e.g. a subagent) rebuilt from `PI_SECRETS_NAMES` plus its inherited environment, so Redaction follows Secrets across process boundaries.

**Reuse**:
Answering a `request_secret` call from an already-tracked Secret instead of prompting. Silent for Captured and Seeded Secrets; requires confirmation for Inherited Secrets.

**Decline**:
The human refusing a request (Esc or answering no). Surfaces to the model as a tool error instructing it not to re-ask.

**Redaction**:
Replacing a Secret's value (and its base64/URL-encoded variants) with `[REDACTED:NAME]` in anything that would enter model context or session files. A backstop against accidents, not a security boundary.
_Avoid_: masking (reserved for the visual bullets in the Capture prompt)
