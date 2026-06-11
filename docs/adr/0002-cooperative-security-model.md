# The model is trusted-but-verified, not adversarial

The threat this extension addresses is accidental disclosure — a secret pasted into chat, echoed by a command, or persisted into session files — not a malicious model deliberately exfiltrating values it can already reach through bash. The model is instructed to use secrets only by `$NAME` reference; redaction of tool output (exact value plus base64/URL-encoded variants) is a backstop against accidents, not a security boundary.

## Consequences

- A hostile model could still move a transformed value (hex re-encoding, a JWT signed with the secret, `curl` to an external host). Defending against that requires sandboxing the execution environment and is explicitly out of scope here.
- Redaction gaps (novel encodings, sub-string leaks) are accepted and documented rather than chased — matching the posture of GitHub Actions' `::add-mask::`.
