/**
 * url-pin — track every http(s) URL that shows up in a session, rank by how
 * often its origin appears, and open the winner in the external browser with
 * Cmd+B (or Ctrl+B where the terminal keeps Cmd for itself).
 *
 * Counting reads the live session branch, deduplicated by entry id, so it sees
 * your prompts, assistant text, agent tool output, and your own `!bash` /
 * `$python` output alike. Tool results that carry file content (read, grep,
 * glob, edit, …) are skipped, so a URL sitting in a source file never outranks
 * the dev server you actually started.
 *
 * Ranking is per origin, not per URL: `http://localhost:5173/` and
 * `http://localhost:5173/health` reinforce the same port instead of splitting
 * its score, and the busiest origin's own most-seen URL is what opens.
 *
 * Commands: /urls (picker → open), /urls pin [n|url], /urls unpin, /urls clear
 */

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const PIN_ENTRY = "com.oh-my-pi.url-pin.pin";
const STATUS_KEY = "url-pin";

/** Tool results that carry file/source content rather than chat output. */
const CONTENT_TOOLS: Record<string, true> = {
	read: true,
	grep: true,
	glob: true,
	write: true,
	edit: true,
	apply_patch: true,
	ast_edit: true,
	lsp: true,
	todo: true,
	memory_edit: true,
	learn: true,
};

const URL_RE = /https?:\/\/[^\s<>"'`\\|]+/gi;
const TRAILING_PUNCT = /[.,;:!?'"`*_~>\]}]+$/;

interface Hit {
	url: string;
	/** `protocol//host`, the unit the ranking actually competes on. */
	origin: string;
	count: number;
	/** Ingest order, used to break count ties toward the freshest URL. */
	last: number;
}

interface ParsedUrl {
	url: string;
	origin: string;
}

function parse(raw: string): ParsedUrl | undefined {
	let candidate = raw.replace(TRAILING_PUNCT, "");
	// A trailing ")" belongs to the URL only when an "(" opened inside it.
	while (candidate.endsWith(")") && candidate.split(")").length > candidate.split("(").length) {
		candidate = candidate.slice(0, -1);
	}
	if (candidate.length === 0) return undefined;
	try {
		const parsed = new URL(candidate);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
		if (!parsed.hostname) return undefined;
		const origin = `${parsed.protocol}//${parsed.host}`;
		const path = parsed.pathname === "/" ? "" : parsed.pathname;
		return { url: `${origin}${path}${parsed.search}${parsed.hash}`, origin };
	} catch {
		return undefined;
	}
}

function stringField(value: unknown, field: string): string | undefined {
	if (!value || typeof value !== "object" || !(field in value)) return undefined;
	const found: unknown = (value as Record<string, unknown>)[field];
	return typeof found === "string" ? found : undefined;
}

export default function urlPin(pi: ExtensionAPI): void {
	const hits = new Map<string, Hit>();
	const originCounts = new Map<string, number>();
	const seenEntries = new Set<string>();
	let pinned: string | undefined;
	let seq = 0;

	function ingest(text: string | undefined): void {
		if (!text) return;
		for (const match of text.matchAll(URL_RE)) {
			const parsed = parse(match[0]);
			if (!parsed) continue;
			seq += 1;
			originCounts.set(parsed.origin, (originCounts.get(parsed.origin) ?? 0) + 1);
			const existing = hits.get(parsed.url);
			if (existing) {
				existing.count += 1;
				existing.last = seq;
			} else {
				hits.set(parsed.url, { url: parsed.url, origin: parsed.origin, count: 1, last: seq });
			}
		}
	}

	function ingestContent(content: unknown): void {
		if (typeof content === "string") {
			ingest(content);
			return;
		}
		if (!Array.isArray(content)) return;
		for (const part of content) {
			if (!part || typeof part !== "object") continue;
			if (!("type" in part) || part.type !== "text") continue;
			if ("text" in part && typeof part.text === "string") ingest(part.text);
		}
	}

	function ingestMessage(message: unknown): void {
		if (!message || typeof message !== "object") return;
		switch (stringField(message, "role")) {
			case "user":
			case "assistant":
			case "developer":
			case "hookMessage":
				if ("content" in message) ingestContent(message.content);
				return;
			case "toolResult": {
				const toolName = stringField(message, "toolName");
				if (toolName && CONTENT_TOOLS[toolName]) return;
				if ("content" in message) ingestContent(message.content);
				return;
			}
			case "bashExecution":
				ingest(stringField(message, "command"));
				ingest(stringField(message, "output"));
				return;
			case "pythonExecution":
				ingest(stringField(message, "code"));
				ingest(stringField(message, "output"));
				return;
			default:
				return;
		}
	}

	/**
	 * Fold every branch entry not already counted into the ranking.
	 *
	 * The session branch — not the live event stream — is the source of truth:
	 * user-run `!bash` output is appended to the session but fires no
	 * `tool_result`, and entry ids make re-reads idempotent.
	 */
	function syncBranch(ctx: ExtensionContext): void {
		for (const entry of ctx.sessionManager.getBranch()) {
			if (seenEntries.has(entry.id)) continue;
			seenEntries.add(entry.id);
			if (entry.type === "message") {
				ingestMessage(entry.message);
			} else if (entry.type === "custom" && entry.customType === PIN_ENTRY) {
				pinned = stringField(entry.data, "url");
			}
		}
	}

	function ranked(): Hit[] {
		return [...hits.values()].sort((a, b) => {
			const pinDelta = (b.url === pinned ? 1 : 0) - (a.url === pinned ? 1 : 0);
			if (pinDelta !== 0) return pinDelta;
			const originDelta = (originCounts.get(b.origin) ?? 0) - (originCounts.get(a.origin) ?? 0);
			if (originDelta !== 0) return originDelta;
			if (a.count !== b.count) return b.count - a.count;
			return b.last - a.last;
		});
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const top = ranked()[0];
		if (!top) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const host = top.origin.replace(/^https?:\/\//, "");
		ctx.ui.setStatus(STATUS_KEY, top.url === pinned ? `📌 ${host}` : `⌘B ${host} ×${originCounts.get(top.origin) ?? top.count}`);
	}

	function refresh(ctx: ExtensionContext): void {
		syncBranch(ctx);
		updateStatus(ctx);
	}

	function forget(ctx: ExtensionContext): void {
		hits.clear();
		originCounts.clear();
		seenEntries.clear();
		seq = 0;
		refresh(ctx);
	}

	async function openUrl(ctx: ExtensionContext, url: string): Promise<void> {
		let command = "xdg-open";
		let args = [url];
		if (process.platform === "darwin") {
			command = "open";
		} else if (process.platform === "win32") {
			command = "cmd";
			args = ["/c", "start", "", url];
		}
		const result = await pi.exec(command, args);
		if (result.code === 0) {
			ctx.ui.notify(`Opened ${url}`, "info");
			return;
		}
		ctx.ui.notify(`url-pin: ${command} exited ${result.code} — ${result.stderr.trim() || url}`, "error");
	}

	async function openTop(ctx: ExtensionContext): Promise<void> {
		refresh(ctx);
		const top = ranked()[0];
		if (!top) {
			ctx.ui.notify("url-pin: no URL seen in this session yet", "warning");
			return;
		}
		await openUrl(ctx, top.url);
	}

	function setPin(ctx: ExtensionContext, url: string | undefined): void {
		pinned = url;
		pi.appendEntry(PIN_ENTRY, { url: url ?? null });
		updateStatus(ctx);
		ctx.ui.notify(url ? `url-pin: pinned ${url}` : "url-pin: pin cleared", "info");
	}

	pi.setLabel("url-pin");

	for (const event of ["session_start", "session_switch", "session_branch", "session_tree"] as const) {
		pi.on(event, (_payload, ctx) => {
			pinned = undefined;
			forget(ctx);
		});
	}
	for (const event of ["input", "message_end", "tool_result", "user_bash", "user_python"] as const) {
		pi.on(event, (_payload, ctx) => refresh(ctx));
	}

	for (const shortcut of ["super+b", "ctrl+b"] as const) {
		pi.registerShortcut(shortcut, {
			description: "Open the most-seen URL of this session",
			handler: (ctx) => openTop(ctx),
		});
	}

	pi.registerCommand("urls", {
		description: "URLs seen this session — pick one to open (pin | unpin | clear)",
		getArgumentCompletions: (prefix) => {
			const typed = prefix.trim();
			const verbs = ["pin", "unpin", "clear"].filter((verb) => verb.startsWith(typed));
			return verbs.length > 0 ? verbs.map((verb) => ({ value: verb, label: verb })) : null;
		},
		handler: async (args, ctx) => {
			const [verb, operand] = args.trim().split(/\s+/).filter(Boolean);
			if (verb === "clear") {
				forget(ctx);
				setPin(ctx, undefined);
				return;
			}
			if (verb === "unpin") {
				setPin(ctx, undefined);
				return;
			}

			refresh(ctx);
			const rows = ranked();

			if (verb === "pin") {
				const index = operand === undefined ? 1 : Number.parseInt(operand, 10);
				const chosen = Number.isFinite(index) ? rows[index - 1] : parse(operand ?? "");
				if (!chosen) {
					ctx.ui.notify(operand ? `url-pin: cannot pin "${operand}"` : "url-pin: nothing to pin yet", "error");
					return;
				}
				if (!hits.has(chosen.url)) {
					seq += 1;
					originCounts.set(chosen.origin, (originCounts.get(chosen.origin) ?? 0) + 1);
					hits.set(chosen.url, { url: chosen.url, origin: chosen.origin, count: 1, last: seq });
				}
				setPin(ctx, chosen.url);
				return;
			}

			if (rows.length === 0) {
				ctx.ui.notify("url-pin: no URL seen in this session yet", "warning");
				return;
			}
			const urlByLabel = new Map<string, string>();
			const options = rows.map((hit, i) => {
				const label = `${i + 1}. ${hit.url === pinned ? "📌 " : ""}${hit.url}`;
				urlByLabel.set(label, hit.url);
				const origin = originCounts.get(hit.origin) ?? hit.count;
				return { label, description: origin === hit.count ? `seen ${hit.count}×` : `seen ${hit.count}× · origin ${origin}×` };
			});
			const picked = await ctx.ui.select("Open URL (⌘B opens the first)", options);
			if (!picked) return;
			const url = urlByLabel.get(picked);
			if (url) await openUrl(ctx, url);
		},
	});
}
