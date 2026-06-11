import { describe, expect, test } from "bun:test";
import {
	formatSeedNames,
	MIN_SECRET_LENGTH,
	parseSeedNames,
	scrubDeep,
	SecretStore,
	validateName,
} from "./secrets.js";

describe("validateName", () => {
	test("accepts UPPER_SNAKE_CASE env var names", () => {
		expect(validateName("STRIPE_API_KEY")).toBeUndefined();
		expect(validateName("A")).toBeUndefined();
		expect(validateName("DB_PASSWORD_2")).toBeUndefined();
	});

	test("rejects invalid shapes", () => {
		expect(validateName("stripe_api_key")).toContain("Invalid");
		expect(validateName("1KEY")).toContain("Invalid");
		expect(validateName("MY-KEY")).toContain("Invalid");
		expect(validateName("")).toContain("Invalid");
	});

	test("rejects reserved names", () => {
		expect(validateName("PATH")).toContain("reserved");
		expect(validateName("HOME")).toContain("reserved");
		expect(validateName("PI_SECRETS_NAMES")).toContain("reserved");
		expect(validateName("PI_ANYTHING")).toContain("reserved");
	});
});

describe("SecretStore.scrub", () => {
	test("redacts exact values", () => {
		const store = new SecretStore();
		store.add("TOKEN", "sk_live_abc123", "captured");
		expect(store.scrub("auth: sk_live_abc123 used")).toBe("auth: [REDACTED:TOKEN] used");
	});

	test("redacts base64 variants", () => {
		const store = new SecretStore();
		store.add("TOKEN", "sk_live_abc123", "captured");
		const encoded = Buffer.from("sk_live_abc123", "utf8").toString("base64");
		expect(store.scrub(`header: ${encoded}`)).toBe("header: [REDACTED:TOKEN]");
	});

	test("redacts URL-encoded variants", () => {
		const store = new SecretStore();
		store.add("PW", "p@ss w0rd+!", "captured");
		expect(store.scrub(`url?pw=${encodeURIComponent("p@ss w0rd+!")}`)).toBe("url?pw=[REDACTED:PW]");
		expect(store.scrub("raw p@ss w0rd+! raw")).toBe("raw [REDACTED:PW] raw");
	});

	test("longest variant wins when one value contains another", () => {
		const store = new SecretStore();
		store.add("SHORT", "abc12345", "captured");
		store.add("LONG", "abc12345extra", "captured");
		expect(store.scrub("x abc12345extra y")).toBe("x [REDACTED:LONG] y");
		expect(store.scrub("x abc12345 y")).toBe("x [REDACTED:SHORT] y");
	});

	test("redacts multiple occurrences and multiple secrets", () => {
		const store = new SecretStore();
		store.add("A", "aaaa1111", "captured");
		store.add("B", "bbbb2222", "captured");
		expect(store.scrub("aaaa1111 bbbb2222 aaaa1111")).toBe("[REDACTED:A] [REDACTED:B] [REDACTED:A]");
	});

	test("ignores values below the minimum length", () => {
		const store = new SecretStore();
		store.add("TINY", "ab", "captured");
		expect(store.scrub("ab is everywhere: absolutely")).toBe("ab is everywhere: absolutely");
		expect(MIN_SECRET_LENGTH).toBeGreaterThan(2);
	});

	test("no-op when empty", () => {
		const store = new SecretStore();
		expect(store.scrub("nothing to do")).toBe("nothing to do");
	});
});

describe("SecretStore lifecycle", () => {
	test("remove drops redaction", () => {
		const store = new SecretStore();
		store.add("TOKEN", "sk_live_abc123", "captured");
		expect(store.remove("TOKEN")).toBe(true);
		expect(store.remove("TOKEN")).toBe(false);
		expect(store.scrub("sk_live_abc123")).toBe("sk_live_abc123");
		expect(store.isEmpty()).toBe(true);
	});

	test("re-adding a name replaces the old value's variants", () => {
		const store = new SecretStore();
		store.add("TOKEN", "old_value_123", "captured");
		store.add("TOKEN", "new_value_456", "captured");
		expect(store.scrub("old_value_123 new_value_456")).toBe("old_value_123 [REDACTED:TOKEN]");
		expect(store.list().length).toBe(1);
	});

	test("two names with the same value: removing one keeps nothing dangling", () => {
		const store = new SecretStore();
		store.add("A", "shared_value_1", "captured");
		store.add("B", "shared_value_1", "captured");
		store.remove("B");
		// A's record survives even though B owned the variant mapping last.
		expect(store.record("A")).toBeDefined();
	});

	test("list is sorted and names() matches", () => {
		const store = new SecretStore();
		store.add("ZED", "zzzz9999", "captured");
		store.add("ALPHA", "aaaa1111", "inherited");
		expect(store.names()).toEqual(["ALPHA", "ZED"]);
	});
});

describe("scrubDeep", () => {
	test("scrubs nested plain objects and arrays", () => {
		const store = new SecretStore();
		store.add("TOKEN", "sk_live_abc123", "captured");
		const result = scrubDeep(store, {
			output: "got sk_live_abc123",
			nested: { list: ["sk_live_abc123", 42, null] },
		}) as Record<string, unknown>;
		expect(result.output).toBe("got [REDACTED:TOKEN]");
		expect((result.nested as Record<string, unknown>).list).toEqual(["[REDACTED:TOKEN]", 42, null]);
	});

	test("leaves class instances and primitives alone", () => {
		const store = new SecretStore();
		store.add("TOKEN", "sk_live_abc123", "captured");
		const date = new Date(0);
		expect(scrubDeep(store, date)).toBe(date);
		expect(scrubDeep(store, 42)).toBe(42);
		expect(scrubDeep(store, undefined)).toBeUndefined();
	});

	test("survives circular references", () => {
		const store = new SecretStore();
		store.add("TOKEN", "sk_live_abc123", "captured");
		const obj: Record<string, unknown> = { text: "sk_live_abc123" };
		obj.self = obj;
		const result = scrubDeep(store, obj) as Record<string, unknown>;
		expect(result.text).toBe("[REDACTED:TOKEN]");
	});
});

describe("seed names", () => {
	test("round-trips", () => {
		expect(parseSeedNames(formatSeedNames(["FOO", "BAR_2"]))).toEqual(["FOO", "BAR_2"]);
	});

	test("filters garbage and handles empty", () => {
		expect(parseSeedNames(undefined)).toEqual([]);
		expect(parseSeedNames("")).toEqual([]);
		expect(parseSeedNames("FOO, not-valid ,BAR")).toEqual(["FOO", "BAR"]);
	});
});
