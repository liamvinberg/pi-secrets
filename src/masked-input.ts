import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { MIN_SECRET_LENGTH } from "./secrets.js";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/**
 * Single-line masked input for ctx.ui.custom(). Renders bullets instead of the
 * value, buffers bracketed paste itself (pi-tui's Input silently strips
 * newlines on paste; here interior newlines must reject the capture instead),
 * and resolves with the value on Enter or undefined on Esc.
 */
export class MaskedInput implements Component, Focusable {
	focused = false;

	private value = "";
	private pasteBuffer = "";
	private inPaste = false;
	private error: string | undefined;

	constructor(
		private readonly name: string,
		private readonly reason: string,
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly done: (value: string | undefined) => void,
	) {}

	handleInput(data: string): void {
		this.error = undefined;

		if (!this.inPaste && data.includes(PASTE_START)) {
			this.inPaste = true;
			this.pasteBuffer = "";
			data = data.slice(data.indexOf(PASTE_START) + PASTE_START.length);
		}
		if (this.inPaste) {
			this.pasteBuffer += data;
			const end = this.pasteBuffer.indexOf(PASTE_END);
			if (end !== -1) {
				const content = this.pasteBuffer.slice(0, end);
				const remaining = this.pasteBuffer.slice(end + PASTE_END.length);
				this.inPaste = false;
				this.pasteBuffer = "";
				this.acceptPaste(content);
				if (remaining) {
					this.handleInput(remaining);
					return;
				}
			}
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, Key.enter)) {
			this.submit();
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.done(undefined);
			return;
		}
		if (matchesKey(data, Key.backspace)) {
			this.value = this.value.slice(0, -1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.ctrl("u"))) {
			this.value = "";
			this.tui.requestRender();
			return;
		}
		if (data.startsWith("\x1b")) {
			// Unhandled escape sequence (arrow keys etc.); a masked field has no cursor movement.
			return;
		}

		const printable = [...data].filter((ch) => ch >= " " && ch !== "\x7f").join("");
		if (printable) {
			this.value += printable;
			this.tui.requestRender();
		}
	}

	private acceptPaste(raw: string): void {
		// A single trailing newline is a copy artifact (pbcopy < file, terminal selection); strip it.
		const content = raw.replace(/[\r\n]+$/, "");
		if (/[\r\n]/.test(content)) {
			this.error = "Multi-line value detected. Give the agent a file path instead, or press Esc to decline.";
			return;
		}
		this.value += content;
	}

	private submit(): void {
		const value = this.value.trim();
		if (!value) {
			this.error = "Empty input. Paste or type the value, or press Esc to decline.";
			this.tui.requestRender();
			return;
		}
		if (value.length < MIN_SECRET_LENGTH) {
			this.error = `Only ${value.length} characters, which looks like a paste error. Fix the value or press Esc to decline.`;
			this.tui.requestRender();
			return;
		}
		this.done(value);
	}

	render(width: number): string[] {
		const t = this.theme;
		const maxBullets = Math.max(8, width - 16);
		const bullets = "•".repeat(Math.min(this.value.length, maxBullets));
		const cursor = this.focused ? t.fg("accent", "▎") : " ";
		const lines = [
			t.fg("accent", `Secret requested: ${this.name}`),
			t.fg("muted", `Reason: ${this.reason}`),
			"",
			`  ${bullets}${cursor}${t.fg("dim", ` (${this.value.length} chars)`)}`,
			"",
		];
		if (this.error) {
			lines.push(t.fg("error", `  ${this.error}`), "");
		}
		lines.push(t.fg("muted", "  Paste or type · Enter submit · Esc decline · Ctrl+U clear"));
		return lines;
	}

	invalidate(): void {}
}
