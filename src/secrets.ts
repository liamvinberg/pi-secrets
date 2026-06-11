/**
 * Pure secret bookkeeping: validation, storage, and redaction.
 * No pi imports so this module is unit-testable in isolation.
 */

export const NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Environment variables that must never be overwritten by a capture. */
const RESERVED_NAMES = new Set([
	"PATH",
	"HOME",
	"SHELL",
	"USER",
	"LOGNAME",
	"TMPDIR",
	"TERM",
	"LANG",
	"PWD",
	"OLDPWD",
	"EDITOR",
	"VISUAL",
	"IFS",
	"LD_PRELOAD",
	"DYLD_INSERT_LIBRARIES",
	"NODE_OPTIONS",
]);

/** Comma-separated list of tracked secret names, exported so child pi processes (subagents) can rebuild their redaction map. */
export const SEED_ENV_VAR = "PI_SECRETS_NAMES";

/** Values shorter than this are rejected at capture and never registered for redaction (false-positive risk). */
export const MIN_SECRET_LENGTH = 4;

/** Values shorter than this are accepted with a warning. */
export const SHORT_SECRET_LENGTH = 8;

export type SecretSource = "captured" | "inherited" | "seeded";

export interface SecretRecord {
	name: string;
	source: SecretSource;
	length: number;
	addedAt: number;
}

export function validateName(name: string): string | undefined {
	if (!NAME_PATTERN.test(name)) {
		return `Invalid secret name "${name}". Use an UPPER_SNAKE_CASE environment variable name such as STRIPE_API_KEY.`;
	}
	if (RESERVED_NAMES.has(name) || name.startsWith("PI_")) {
		return `Secret name "${name}" is reserved and cannot be used for a secret. Pick a different name.`;
	}
	return undefined;
}

/** The value plus the encoded forms it commonly leaks through (mirrors GitHub Actions masking). */
function variantsOf(value: string): string[] {
	const variants = new Set<string>([value]);
	variants.add(Buffer.from(value, "utf8").toString("base64"));
	const uriEncoded = encodeURIComponent(value);
	if (uriEncoded !== value) variants.add(uriEncoded);
	return [...variants];
}

export class SecretStore {
	private records = new Map<string, SecretRecord>();
	private values = new Map<string, string>();
	private variants = new Map<string, string>();

	add(name: string, value: string, source: SecretSource): SecretRecord {
		this.remove(name);
		const record: SecretRecord = { name, source, length: value.length, addedAt: Date.now() };
		this.records.set(name, record);
		this.values.set(name, value);
		for (const variant of variantsOf(value)) {
			if (variant.length >= MIN_SECRET_LENGTH) {
				this.variants.set(variant, name);
			}
		}
		return record;
	}

	remove(name: string): boolean {
		const value = this.values.get(name);
		if (value === undefined) return false;
		this.records.delete(name);
		this.values.delete(name);
		for (const variant of variantsOf(value)) {
			if (this.variants.get(variant) === name) {
				this.variants.delete(variant);
			}
		}
		return true;
	}

	record(name: string): SecretRecord | undefined {
		return this.records.get(name);
	}

	list(): SecretRecord[] {
		return [...this.records.values()].sort((a, b) => a.name.localeCompare(b.name));
	}

	names(): string[] {
		return this.list().map((r) => r.name);
	}

	isEmpty(): boolean {
		return this.records.size === 0;
	}

	/** Replace every tracked value (and encoded variant) with [REDACTED:NAME]. Longest variants first so containing strings win. */
	scrub(text: string): string {
		if (!text || this.variants.size === 0) return text;
		let result = text;
		const ordered = [...this.variants.entries()].sort((a, b) => b[0].length - a[0].length);
		for (const [variant, name] of ordered) {
			if (result.includes(variant)) {
				result = result.split(variant).join(`[REDACTED:${name}]`);
			}
		}
		return result;
	}
}

/** Deep-scrub strings inside plain objects/arrays (tool result details get persisted to session files). */
export function scrubDeep(store: SecretStore, input: unknown, seen = new WeakSet<object>()): unknown {
	if (typeof input === "string") return store.scrub(input);
	if (Array.isArray(input)) {
		if (seen.has(input)) return input;
		seen.add(input);
		return input.map((item) => scrubDeep(store, item, seen));
	}
	if (input !== null && typeof input === "object") {
		const proto = Object.getPrototypeOf(input);
		if (proto !== Object.prototype && proto !== null) return input;
		if (seen.has(input)) return input;
		seen.add(input);
		const out: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(input)) {
			out[key] = scrubDeep(store, value, seen);
		}
		return out;
	}
	return input;
}

export function parseSeedNames(raw: string | undefined): string[] {
	if (!raw) return [];
	return raw
		.split(",")
		.map((name) => name.trim())
		.filter((name) => NAME_PATTERN.test(name));
}

export function formatSeedNames(names: string[]): string {
	return names.join(",");
}
