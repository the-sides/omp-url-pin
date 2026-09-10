import { beforeEach, expect, test } from "bun:test";

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
let ids: number;
let ctx: unknown;

function harness(): void {
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
	ids = 0;

	const pi = {
		setLabel() {},
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
			execCalls.push([command, ...args]);
			return { code: 0, stdout: "", stderr: "", killed: false };
		},
	};

	ctx = {
		hasUI: true,
		sessionManager: { getBranch: () => branch },
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

beforeEach(harness);

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

	expect(status()).toBe("⌘B localhost:5173 ×2");
	pick = 0;
	await commands.urls("", ctx);
	expect(options.some((option) => option.label.includes("docs.example.com"))).toBe(false);
});

test("re-reading the branch does not double count", async () => {
	branch = [message({ role: "assistant", content: [{ type: "text", text: "http://localhost:5173" }] })];
	await fire("session_start");
	await fire("message_end");
	await fire("tool_result");

	expect(status()).toBe("⌘B localhost:5173 ×1");
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
	expect(status()).toBe("⌘B localhost:5173 ×3");
	await shortcuts["ctrl+b"](ctx);
	expect(opened()).toBe("http://localhost:5173/health");
});

test("user-run bash output is counted even though it fires no tool_result", async () => {
	await fire("session_start");
	branch.push(
		message({ role: "bashExecution", command: "npm run dev -- --port 4300", output: "ready on http://localhost:4300/admin" }),
	);
	await fire("user_bash");

	expect(status()).toBe("⌘B localhost:4300 ×1");
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

	expect(status()).toBe("📌 localhost:4300");
	await shortcuts["ctrl+b"](ctx);
	expect(opened()).toBe("http://localhost:4300");
	expect(appended).toHaveLength(1);

	await fire("session_switch"); // resume/switch rebuilds from the branch
	await shortcuts["ctrl+b"](ctx);
	expect(opened()).toBe("http://localhost:4300");

	await commands.urls("unpin", ctx);
	await shortcuts["ctrl+b"](ctx);
	expect(opened()).toBe("http://localhost:5173");
});

test("an empty session warns instead of opening something stale", async () => {
	branch = [message({ role: "assistant", content: [{ type: "text", text: "http://localhost:5173" }] })];
	await fire("session_start");
	branch = [];
	await fire("session_switch");

	const before = execCalls.length;
	await shortcuts["ctrl+b"](ctx);
	expect(execCalls).toHaveLength(before);
	expect(notices.at(-1)).toContain("no URL seen");
	expect(status()).toBeUndefined();
});
