import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, test } from "bun:test";

import urlPin from "../src/url-pin.ts";

interface FakeEntry {
	id: string;
	type: string;
	message?: unknown;
	customType?: string;
	data?: unknown;
}
interface Option {
	label: string;
	description?: string;
}

class FakeSelectorComponent {
	constructor(
		_title: string,
		offered: Option[],
		private readonly onSelect: (label: string) => void,
		private readonly onCancel: () => void,
		private readonly selectorOptions?: { onRight?: () => void },
	) {
		options = offered;
	}

	handleInput(input: string): void {
		if (input === "right") {
			this.selectorOptions?.onRight?.();
			return;
		}
		const selected = options[pick]?.label;
		if (selected) this.onSelect(selected);
		else this.onCancel();
	}
}

let handlers: Record<string, ((event: unknown, ctx: unknown) => unknown)[]>;
let shortcuts: Record<string, (ctx: unknown) => unknown>;
let commands: Record<string, (args: string, ctx: unknown) => Promise<void>>;
let execCalls: string[][];
let notices: string[];
let statuses: (string | undefined)[];
let appended: { type: string; data: unknown }[];
let branch: FakeEntry[];
let options: Option[];
let pick: number;
let pickerInput: "enter" | "right";
let ids: number;
let ctx: unknown;
let agentDir: string;
let repository: string;
let branchName: string;

let timers: { fn: () => void; delay: number }[];
let symbols: Record<string, string>;

function harness(): void {
	timers = [];
	symbols = { "cmd.globe": "\uf0ac", "icon.pin": "\uf08d" };
	handlers = {};
	shortcuts = {};
	commands = {};
	execCalls = [];
	notices = [];
	statuses = [];
	appended = [];
	branch = [];
	options = [];
	pick = 0;
	pickerInput = "enter";
	ids = 0;

	const pi = {
		setLabel() {},
		pi: { getAgentDir: () => agentDir, ExtensionSelectorComponent: FakeSelectorComponent },
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			(handlers[event] ??= []).push(handler);
		},
		registerShortcut(key: string, opts: { handler: (ctx: unknown) => unknown }) {
			shortcuts[key] = opts.handler;
		},
		registerCommand(name: string, opts: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			commands[name] = opts.handler;
		},
		appendEntry(type: string, data: unknown) {
			appended.push({ type, data });
			branch.push({ id: `pin-${++ids}`, type: "custom", customType: type, data });
		},
		async exec(command: string, args: string[]) {
			if (command === "git") {
				return { code: 0, stdout: `${repository}\n${branchName}\n`, stderr: "", killed: false };
			}
			execCalls.push([command, ...args]);
			return { code: 0, stdout: "", stderr: "", killed: false };
		},
	};

	ctx = {
		cwd: "/worktree",
		hasUI: true,
		sessionManager: { getBranch: () => branch },
		setTimeout(fn: () => void, delay: number) {
			timers.push({ fn, delay });
			return timers.length;
		},
		ui: {
			setStatus(_key: string, text: string | undefined) {
				statuses.push(text);
			},
			notify(message: string) {
				notices.push(message);
			},
			async select(_title: string, offered: Option[]) {
				options = offered;
				return offered[pick]?.label;
			},
			async custom<T>(
				factory: (
					tui: unknown,
					theme: unknown,
					keybindings: unknown,
					done: (result: T) => void,
				) => { handleInput?: (input: string) => void } | Promise<{ handleInput?: (input: string) => void }>,
			): Promise<T | undefined> {
				let result: T | undefined;
				const component = await factory({}, {}, {}, (selected) => {
					result = selected;
				});
				component.handleInput?.(pickerInput === "right" ? "right" : "\r");
				return result;
			},
			theme: { symbol: (key: string) => symbols[key] ?? "" },
		},
	};

	// The harness mimics the host's duck-typed surface: only the fields url-pin reads exist.
	urlPin(pi as unknown as Parameters<typeof urlPin>[0]);
}

const message = (msg: unknown): FakeEntry => ({ id: `e-${++ids}`, type: "message", message: msg });
const status = () => statuses.at(-1);
const opened = () => execCalls.at(-1)?.[1];

async function fire(event: string): Promise<void> {
	for (const handler of handlers[event] ?? []) await handler({}, ctx);
}

/** Run every callback url-pin scheduled through the host's managed timers. */
function flushTimers(): void {
	const scheduled = timers.splice(0, timers.length);
	for (const timer of scheduled) timer.fn();
}

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "url-pin-test-"));
	repository = "/repos/example/.git";
	branchName = "feature/persist-urls";
	harness();
});

afterEach(() => rmSync(agentDir, { recursive: true, force: true }));

test("registers Cmd+B without claiming Ctrl+B", () => {
	expect(typeof shortcuts["super+b"]).toBe("function");
	expect(shortcuts["ctrl+b"]).toBeUndefined();
});

test("counts chat and tool output, ignores file content", async () => {
	branch = [
		message({
			role: "toolResult",
			toolName: "bash",
			content: [{ type: "text", text: "Local: http://localhost:5173/\nAPI: http://127.0.0.1:4000/health" }],
		}),
		message({ role: "toolResult", toolName: "read", content: [{ type: "text", text: "const DOCS = 'https://docs.example.com/a';" }] }),
		message({ role: "assistant", content: [{ type: "text", text: "open http://localhost:5173/ now" }] }),
	];
	await fire("session_start");

	expect(status()).toBe("\uf0ac 5173");
	pick = 0;
	await commands.urls("", ctx);
	expect(options.some((option) => option.label.includes("docs.example.com"))).toBe(false);
});

test("detects a schemeless host and port as HTTP", async () => {
	branch = [
		message({
			role: "assistant",
			content: [{ type: "text", text: "Dev server: localhost:3400/fleet/pm." }],
		}),
	];
	await fire("session_start");

	expect(status()).toBe("\uf0ac 3400");
	await shortcuts["super+b"](ctx);
	expect(opened()).toBe("http://localhost:3400/fleet/pm");
});

test("re-reading the branch does not double count", async () => {
	branch = [message({ role: "assistant", content: [{ type: "text", text: "http://localhost:5173" }] })];
	await fire("session_start");
	await fire("message_end");
	await fire("tool_result");

	pick = 0;
	await commands.urls("", ctx);
	expect(options).toHaveLength(1);
	expect(options[0].description).toBe("seen 1×");
});

test("paths of one origin reinforce that origin instead of splitting it", async () => {
	branch = [
		message({
			role: "assistant",
			content: [{ type: "text", text: "http://localhost:5173/ then http://localhost:5173/health twice: http://localhost:5173/health" }],
		}),
		message({ role: "assistant", content: [{ type: "text", text: "http://localhost:9999/a and http://localhost:9999/a again" }] }),
	];
	await fire("session_start");

	// :9999/a ties :5173/health on per-URL count, but :5173 is the busier origin.
	expect(status()).toBe("\uf0ac 5173");
	await shortcuts["super+b"](ctx);
	expect(opened()).toBe("http://localhost:5173/health");

	pick = 0;
	await commands.urls("", ctx);
	expect(options[0].description).toBe("seen 2× · origin 3×");
	expect(options.at(-1)?.description).toBe("seen 2×");
});

test("user-run bash output is counted once it lands, with no tool_result to announce it", async () => {
	await fire("session_start");
	// `user_bash` fires before the command runs, so nothing is countable yet.
	await fire("user_bash");
	expect(status()).toBeUndefined();

	branch.push(
		message({ role: "bashExecution", command: "npm run dev -- --port 4300", output: "ready on http://localhost:4300/admin" }),
	);
	flushTimers();

	expect(status()).toBe("\uf0ac 4300");
	await shortcuts["super+b"](ctx);
	expect(opened()).toBe("http://localhost:4300/admin");
});

test("trailing punctuation and markdown wrapping collapse to one URL", async () => {
	branch = [
		message({
			role: "user",
			content: [{ type: "text", text: "see http://localhost:3000/app. and (http://localhost:3000/app) plus <http://localhost:3000/app>" }],
		}),
	];
	await fire("session_start");

	pick = 0;
	await commands.urls("", ctx);
	expect(options).toHaveLength(1);
	expect(options[0].label).toContain("http://localhost:3000/app");
	expect(options[0].description).toContain("3×");
});

test("a pin outranks frequency and survives a branch replay", async () => {
	branch = [
		message({ role: "assistant", content: [{ type: "text", text: "http://localhost:5173 http://localhost:5173 http://localhost:4300" }] }),
	];
	await fire("session_start");
	await commands.urls("pin http://localhost:4300", ctx);

	expect(status()).toBe("\uf08d 4300");
	await shortcuts["super+b"](ctx);
	expect(opened()).toBe("http://localhost:4300");
	expect(appended).toHaveLength(1);

	await fire("session_switch"); // resume/switch rebuilds from the branch
	await shortcuts["super+b"](ctx);
	expect(opened()).toBe("http://localhost:4300");

	await commands.urls("unpin", ctx);
	await shortcuts["super+b"](ctx);
	expect(opened()).toBe("http://localhost:5173");
});

test("a schemeless pin is normalized and persisted", async () => {
	await fire("session_start");
	await commands.urls("pin localhost:3400", ctx);
	expect(status()).toBe("\uf08d 3400");

	harness();
	await fire("session_start");
	await shortcuts["super+b"](ctx);
	expect(opened()).toBe("http://localhost:3400");
});

test("port shorthand pins localhost with an optional route and persists", async () => {
	await fire("session_start");

	await commands.urls("pin 5142", ctx);
	await shortcuts["super+b"](ctx);
	expect(opened()).toBe("http://localhost:5142");

	await commands.urls("pin 2351/sign-in", ctx);
	await shortcuts["super+b"](ctx);
	expect(opened()).toBe("http://localhost:2351/sign-in");

	harness();
	await fire("session_start");
	await shortcuts["super+b"](ctx);
	expect(opened()).toBe("http://localhost:2351/sign-in");
});

test("a numeric operand is a port even when the same URL rank exists", async () => {
	branch = [
		message({
			role: "assistant",
			content: [{ type: "text", text: "http://localhost:5173 http://localhost:5173 http://localhost:4300" }],
		}),
	];
	await fire("session_start");

	await commands.urls("pin 2", ctx);
	await shortcuts["super+b"](ctx);
	expect(opened()).toBe("http://localhost:2");
});

test("a path pin uses the leading URL origin and survives a new session", async () => {
	branch = [
		message({
			role: "assistant",
			content: [{ type: "text", text: "http://localhost:5173/app http://localhost:5173/app http://localhost:4300/admin" }],
		}),
	];
	await fire("session_start");
	await commands.urls("pin /fleet/pm", ctx);
	await shortcuts["super+b"](ctx);
	expect(opened()).toBe("http://localhost:5173/fleet/pm");

	harness();
	await fire("session_start");
	await shortcuts["super+b"](ctx);
	expect(status()).toBe("\uf08d 5173");
	expect(opened()).toBe("http://localhost:5173/fleet/pm");
});

test("opened and pinned URLs survive a new session on the same branch", async () => {
	branch = [
		message({
			role: "assistant",
			content: [{ type: "text", text: "http://localhost:5173/app http://localhost:5173/app http://localhost:4300/admin" }],
		}),
	];
	await fire("session_start");
	await shortcuts["super+b"](ctx);
	expect(opened()).toBe("http://localhost:5173/app");
	await commands.urls("pin http://localhost:4300/admin", ctx);

	harness();
	await fire("session_start");

	expect(status()).toBe("\uf08d 4300");
	await commands.urls("", ctx);
	expect(options.map((option) => option.label).join("\n")).toContain("http://localhost:5173/app");
	expect(options.map((option) => option.label).join("\n")).toContain("http://localhost:4300/admin");
	expect(opened()).toBe("http://localhost:4300/admin");
});

test("saved URLs are isolated by repository branch", async () => {
	branch = [message({ role: "assistant", content: [{ type: "text", text: "http://localhost:5173/app" }] })];
	await fire("session_start");
	await shortcuts["super+b"](ctx);

	branchName = "feature/another-worktree";
	harness();
	await fire("session_start");
	expect(status()).toBeUndefined();

	branchName = "feature/persist-urls";
	harness();
	await fire("session_start");
	expect(status()).toBe("\uf0ac 5173");
});

test("clear removes both the live ranking and saved branch record", async () => {
	branch = [message({ role: "assistant", content: [{ type: "text", text: "http://localhost:5173/app" }] })];
	await fire("session_start");
	await shortcuts["super+b"](ctx);

	await commands.urls("clear", ctx);
	expect(status()).toBeUndefined();

	harness();
	await fire("session_start");
	expect(status()).toBeUndefined();
});

test("right arrow pins the highlighted URL from the normal menu", async () => {
	branch = [
		message({
			role: "assistant",
			content: [{ type: "text", text: "http://localhost:5173 http://localhost:5173 http://localhost:4300" }],
		}),
	];
	await fire("session_start");

	pick = 1;
	pickerInput = "right";
	await commands.urls("", ctx);

	expect(options[1]?.label).toContain("http://localhost:4300");
	expect(execCalls).toHaveLength(0);
	expect(status()).toBe("\uf08d 4300");

	harness();
	await fire("session_start");
	expect(status()).toBe("\uf08d 4300");
	await shortcuts["super+b"](ctx);
	expect(opened()).toBe("http://localhost:4300");
});

test("`/urls pin` pins whatever is selected in the list", async () => {
	branch = [
		message({
			role: "assistant",
			content: [{ type: "text", text: "http://localhost:5173 http://localhost:5173 http://localhost:4300" }],
		}),
	];
	await fire("session_start");

	pick = 1; // second row of the ranked list, not the ⌘B default
	await commands.urls("pin", ctx);

	expect(options[0].label).toContain("http://localhost:5173");
	expect(status()).toBe("\uf08d 4300");
	await shortcuts["super+b"](ctx);
	expect(opened()).toBe("http://localhost:4300");

	// Selecting from the pin list must not also open a browser tab.
	expect(execCalls).toHaveLength(1);

	// The pin now leads the list and is marked; the plain picker opens rather than pins.
	pick = 1;
	await commands.urls("", ctx);
	expect(options[0].label).toContain("\uf08d");
	expect(opened()).toBe("http://localhost:5173");
	expect(status()).toBe("\uf08d 4300");
});

test("cancelling the pin list leaves the pin untouched", async () => {
	branch = [message({ role: "assistant", content: [{ type: "text", text: "http://localhost:5173" }] })];
	await fire("session_start");

	pick = 99; // nothing selected — Esc
	await commands.urls("pin", ctx);

	expect(appended).toHaveLength(0);
	expect(status()).toBe("\uf0ac 5173");
});

test("a symbol preset with no globe falls back to a colon", async () => {
	symbols = {}; // the `ascii` preset ships no `cmd.globe`
	branch = [message({ role: "assistant", content: [{ type: "text", text: "http://localhost:5173" }] })];
	await fire("session_start");

	expect(status()).toBe(": 5173");
});

test("an empty session warns instead of opening something stale", async () => {
	branch = [message({ role: "assistant", content: [{ type: "text", text: "http://localhost:5173" }] })];
	await fire("session_start");
	branch = [];
	await fire("session_switch");

	const before = execCalls.length;
	await shortcuts["super+b"](ctx);
	expect(execCalls).toHaveLength(before);
	expect(notices.at(-1)).toContain("no URL seen");
	expect(status()).toBeUndefined();
});
