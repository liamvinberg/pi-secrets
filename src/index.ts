import { createLocalBashOperations, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MaskedInput } from "./masked-input.js";
import {
	formatSeedNames,
	parseSeedNames,
	scrubDeep,
	SecretStore,
	SEED_ENV_VAR,
	SHORT_SECRET_LENGTH,
	validateName,
	type SecretRecord,
} from "./secrets.js";

const STATUS_KEY = "pi-secrets";

const requestSecretParams = Type.Object({
	name: Type.String({
		description: "UPPER_SNAKE_CASE environment variable name for the secret, e.g. STRIPE_API_KEY",
	}),
	reason: Type.String({
		description: "One sentence shown to the user: what the secret is and why it is needed",
	}),
});

export default function piSecrets(pi: ExtensionAPI) {
	const store = new SecretStore();

	// Child pi processes (subagents) inherit secret values via the environment;
	// PI_SECRETS_NAMES tells them which env vars to put back under redaction.
	for (const name of parseSeedNames(process.env[SEED_ENV_VAR])) {
		const value = process.env[name];
		if (value) store.add(name, value, "seeded");
	}

	const syncSeedEnv = () => {
		if (store.isEmpty()) {
			delete process.env[SEED_ENV_VAR];
		} else {
			process.env[SEED_ENV_VAR] = formatSeedNames(store.names());
		}
	};
	syncSeedEnv();

	const updateStatus = (ctx: ExtensionContext) => {
		const names = store.names();
		ctx.ui.setStatus(STATUS_KEY, names.length ? `🔒 ${names.join(" ")}` : undefined);
	};

	const clearSecret = (record: SecretRecord) => {
		store.remove(record.name);
		// Captured values were placed into the environment by this extension; inherited
		// and seeded values came from outside, so the variable itself is left untouched.
		if (record.source === "captured") {
			delete process.env[record.name];
		}
		syncSeedEnv();
	};

	const usageText = (name: string, length: number, how: string) =>
		[
			`Secret ${name} ${how} (${length} chars). It is available as $${name} in bash commands.`,
			`- Use it only by reference, e.g. curl -H "Authorization: Bearer $${name}"`,
			`- To place it in a file: echo "${name}=$${name}" >> .env`,
			`- Never print, echo, or log the value; any output containing it is redacted to [REDACTED:${name}] before you see it.`,
		].join("\n");

	const declinedError = (name: string) =>
		new Error(`User declined to provide ${name}. Do not request it again unless the user asks you to.`);

	pi.registerTool({
		name: "request_secret",
		label: "Request Secret",
		description:
			"Ask the user for a secret (API key, token, password) via a local masked prompt. " +
			"The value never enters the conversation: it becomes available as an environment variable in subsequent bash commands, " +
			"and the tool result only reports the name and length.",
		promptSnippet: "Ask the user for a secret via a masked prompt; the value becomes $NAME in bash and never appears in chat",
		promptGuidelines: [
			"Use request_secret when a task needs a credential only the user can provide. Never ask the user to paste secrets into the chat.",
			"After request_secret succeeds, use the secret strictly via its environment variable (e.g. $STRIPE_API_KEY) in bash; never print or echo its value.",
		],
		parameters: requestSecretParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const name = params.name.trim();
			const invalid = validateName(name);
			if (invalid) throw new Error(invalid);

			// Already tracked this process → silent reuse.
			const existing = store.record(name);
			if (existing) {
				return {
					content: [{ type: "text" as const, text: usageText(name, existing.length, "is already available") }],
					details: { name, source: existing.source, reused: true },
				};
			}

			// Present in the inherited environment → confirm interactively; reuse silently
			// headless (the model can already read the environment there — tracking it at
			// least brings the value under redaction).
			const inherited = process.env[name];
			if (inherited) {
				if (ctx.hasUI) {
					const ok = await ctx.ui.confirm(
						`Share $${name} with the agent?`,
						`The agent wants ${name} from your shell environment.\nReason: ${params.reason}\nAllowing also enables redaction of its value in tool output.`,
					);
					if (!ok) throw declinedError(name);
				}
				store.add(name, inherited, "inherited");
				syncSeedEnv();
				updateStatus(ctx);
				return {
					content: [{ type: "text" as const, text: usageText(name, inherited.length, "reused from your environment") }],
					details: { name, source: "inherited", reused: true },
				};
			}

			// Capture via masked prompt.
			if (!ctx.hasUI) {
				throw new Error(
					`No interactive UI available to capture ${name}. Ask the user to export ${name} before launching pi, or run interactively.`,
				);
			}

			const value = await ctx.ui.custom<string | undefined>(
				(tui, theme, _keybindings, done) => new MaskedInput(name, params.reason, tui, theme, done),
			);
			if (value === undefined) throw declinedError(name);

			store.add(name, value, "captured");
			process.env[name] = value;
			syncSeedEnv();
			updateStatus(ctx);

			if (value.length < SHORT_SECRET_LENGTH) {
				ctx.ui.notify(`${name} is only ${value.length} chars — redaction may over-match short strings`, "warning");
			} else {
				ctx.ui.notify(`Secret ${name} captured (${value.length} chars)`, "info");
			}

			return {
				content: [{ type: "text" as const, text: usageText(name, value.length, "captured") }],
				details: { name, source: "captured", length: value.length },
			};
		},
	});

	// Backstop: scrub tracked values from every tool result before it reaches
	// the model context or the session file on disk.
	pi.on("tool_result", (event) => {
		if (store.isEmpty()) return;
		return {
			content: event.content.map((part) => (part.type === "text" ? { ...part, text: store.scrub(part.text) } : part)),
			details: scrubDeep(store, event.details) as typeof event.details,
		};
	});

	// User `!`/`!!` commands also enter context — scrub their streamed output too.
	// Per-chunk scrubbing can miss a value split across chunk boundaries; accepted gap.
	pi.on("user_bash", () => {
		if (store.isEmpty()) return;
		const local = createLocalBashOperations();
		return {
			operations: {
				...local,
				exec: (command, cwd, options) =>
					local.exec(command, cwd, {
						...options,
						onData: (data) => {
							const text = data.toString("utf8");
							const scrubbed = store.scrub(text);
							// Pass the original buffer through untouched unless a secret matched,
							// so multibyte sequences at chunk boundaries are never re-encoded.
							options.onData(scrubbed === text ? data : Buffer.from(scrubbed, "utf8"));
						},
					}),
			},
		};
	});

	pi.on("session_start", (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.registerCommand("secrets", {
		description: "List or clear secrets held by request_secret (usage: /secrets [clear <NAME|all>])",
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);

			if (tokens[0] === "clear") {
				const target = tokens[1];
				if (!target) {
					ctx.ui.notify("Usage: /secrets clear <NAME|all>", "warning");
					return;
				}
				if (target.toLowerCase() === "all") {
					const count = store.list().length;
					for (const record of store.list()) clearSecret(record);
					updateStatus(ctx);
					ctx.ui.notify(count ? `Cleared ${count} secret(s)` : "No secrets held", "info");
					return;
				}
				const record = store.record(target.toUpperCase());
				if (!record) {
					ctx.ui.notify(`No secret named ${target.toUpperCase()}`, "warning");
					return;
				}
				clearSecret(record);
				updateStatus(ctx);
				ctx.ui.notify(`${record.name} cleared`, "info");
				return;
			}

			const records = store.list();
			if (records.length === 0) {
				ctx.ui.notify("No secrets held", "info");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify(`Secrets: ${records.map((r) => r.name).join(", ")}`, "info");
				return;
			}

			const describe = (r: SecretRecord) => `${r.name} · ${r.source} · ${r.length} chars`;
			const choice = await ctx.ui.select(`Secrets (${records.length}) — select one to clear`, [
				...records.map(describe),
				"Clear all",
				"Close",
			]);
			if (!choice || choice === "Close") return;

			if (choice === "Clear all") {
				for (const record of records) clearSecret(record);
				updateStatus(ctx);
				ctx.ui.notify(`Cleared ${records.length} secret(s)`, "info");
				return;
			}

			const record = store.record(choice.split(" ·")[0] ?? "");
			if (!record) return;
			const detail =
				record.source === "captured"
					? `Also removes $${record.name} from the agent environment.`
					: `Removes redaction tracking; the environment variable itself is left untouched.`;
			if (await ctx.ui.confirm(`Clear ${record.name}?`, detail)) {
				clearSecret(record);
				updateStatus(ctx);
				ctx.ui.notify(`${record.name} cleared`, "info");
			}
		},
	});
}
