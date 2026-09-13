/**
 * url-pin — track every http(s) URL or schemeless host:port that shows up in
 * a session, rank by how often its origin appears, and open the winner in the
 * external browser with Cmd+B.
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
 * Successfully opened and pinned URLs are persisted per repository branch in
 * omp's active agent directory, so a fresh session in the same worktree can
 * recover them while its dev server is still running.
 *
 * Commands: /urls (picker → open), /urls pin [url|/path|port/path], /urls unpin, /urls clear
 */

import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const PIN_ENTRY = "com.oh-my-pi.url-pin.pin";
const STATUS_KEY = "url-pin";
const STATE_VERSION = 1;
const MAX_BRANCHES = 100;
const MAX_URLS_PER_BRANCH = 20;

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

const URL_RE =
	/https?:\/\/[^\s<>"'`\\|]+|(?<![a-z0-9_.-])(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|\[[0-9a-f:]+\]|(?:[a-z0-9-]+\.)+[a-z0-9-]+):\d{1,5}(?:[/?#][^\s<>"'`\\|]*)?/gi;
const SCHEMELESS_URL_RE =
	/^(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|\[[0-9a-f:]+\]|(?:[a-z0-9-]+\.)+[a-z0-9-]+):\d{1,5}(?:[/?#][^\s<>"'`\\|]*)?$/i;
const TRAILING_PUNCT = /[.,;:!?'"`*_~>\]}]+$/;
const PORT_SHORTHAND_RE = /^\d{1,5}(?:[/?#].*)?$/;

/** Re-sync delays after a user-run `!bash`/`$python`, whose output lands with no event. */
const USER_COMMAND_RESYNC_MS = [500, 3000];

interface Hit {
	url: string;
	/** `protocol//host`, the unit the ranking actually competes on. */
	origin: string;
	/** Status-chip text: the port when the URL has one, else the hostname. */
	label: string;
	count: number;
	/** Ingest order, used to break count ties toward the freshest URL. */
	last: number;
}

interface ParsedUrl {
	url: string;
	origin: string;
	label: string;
}

interface BranchIdentity {
	repository: string;
	branch: string;
}

interface StoredUrl {
	url: string;
	lastUsedAt: number;
}

interface StoredBranch extends BranchIdentity {
	urls: StoredUrl[];
	pinned?: string;
	updatedAt: number;
}

interface StoredState {
	version: typeof STATE_VERSION;
	branches: StoredBranch[];
}

function parse(raw: string): ParsedUrl | undefined {
	let candidate = raw.replace(TRAILING_PUNCT, "");
	// A trailing ")" belongs to the URL only when an "(" opened inside it.
	while (candidate.endsWith(")") && candidate.split(")").length > candidate.split("(").length) {
		candidate = candidate.slice(0, -1);
	}
	if (candidate.length === 0) return undefined;
	if (SCHEMELESS_URL_RE.test(candidate)) candidate = `http://${candidate}`;
	try {
		const parsed = new URL(candidate);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
		if (!parsed.hostname) return undefined;
		const origin = `${parsed.protocol}//${parsed.host}`;
		const path = parsed.pathname === "/" ? "" : parsed.pathname;
		return { url: `${origin}${path}${parsed.search}${parsed.hash}`, origin, label: parsed.port || parsed.hostname };
	} catch {
		return undefined;
	}
}

function stringField(value: unknown, field: string): string | undefined {
	if (!value || typeof value !== "object" || !(field in value)) return undefined;
	const found: unknown = (value as Record<string, unknown>)[field];
	return typeof found === "string" ? found : undefined;
}

const emptyState = (): StoredState => ({ version: STATE_VERSION, branches: [] });

function errorCode(error: unknown): string | undefined {
	return error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
}

function decodeState(value: unknown): StoredState | undefined {
	if (!value || typeof value !== "object") return undefined;
	const state = value as Partial<StoredState>;
	if (state.version !== STATE_VERSION || !Array.isArray(state.branches)) return undefined;
	const branches: StoredBranch[] = [];
	for (const candidate of state.branches) {
		if (!candidate || typeof candidate !== "object") continue;
		const branch = candidate as Partial<StoredBranch>;
		if (typeof branch.repository !== "string" || typeof branch.branch !== "string" || !Array.isArray(branch.urls)) continue;
		const urls = branch.urls.filter(
			(item): item is StoredUrl =>
				!!item &&
				typeof item === "object" &&
				typeof item.url === "string" &&
				typeof item.lastUsedAt === "number" &&
				Number.isFinite(item.lastUsedAt),
		);
		branches.push({
			repository: branch.repository,
			branch: branch.branch,
			urls,
			...(typeof branch.pinned === "string" ? { pinned: branch.pinned } : {}),
			updatedAt: typeof branch.updatedAt === "number" && Number.isFinite(branch.updatedAt) ? branch.updatedAt : 0,
		});
	}
	return { version: STATE_VERSION, branches };
}

async function readState(statePath: string): Promise<StoredState> {
	try {
		const decoded = decodeState(JSON.parse(await readFile(statePath, "utf8")));
		if (!decoded) throw new Error("unsupported or malformed state");
		return decoded;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return emptyState();
		throw error;
	}
}

async function withStateLock<T>(statePath: string, operation: () => Promise<T>): Promise<T> {
	const lockPath = `${statePath}.lock`;
	await mkdir(dirname(statePath), { recursive: true });
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			await mkdir(lockPath);
		} catch (error) {
			if (errorCode(error) !== "EEXIST") throw error;
			try {
				const lockStat = await stat(lockPath);
				if (Date.now() - lockStat.mtimeMs > 10_000) await rm(lockPath, { recursive: true, force: true });
			} catch (statError) {
				if (errorCode(statError) !== "ENOENT") throw statError;
			}
			await Bun.sleep(25);
			continue;
		}
		try {
			return await operation();
		} finally {
			await rm(lockPath, { recursive: true, force: true });
		}
	}
	throw new Error("timed out waiting for the state lock");
}

async function updateState(statePath: string, mutate: (state: StoredState) => void): Promise<void> {
	await withStateLock(statePath, async () => {
		let state: StoredState;
		try {
			state = await readState(statePath);
		} catch {
			try {
				await rename(statePath, `${statePath}.corrupt-${Date.now()}`);
			} catch (error) {
				if (errorCode(error) !== "ENOENT") throw error;
			}
			state = emptyState();
		}
		mutate(state);
		const temporaryPath = `${statePath}.tmp-${process.pid}-${Date.now()}`;
		try {
			await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
			await rename(temporaryPath, statePath);
		} finally {
			await rm(temporaryPath, { force: true });
		}
	});
}

export default function urlPin(pi: ExtensionAPI): void {
	const hits = new Map<string, Hit>();
	const statePath = join(pi.pi.getAgentDir(), "url-pin", "state.json");
	const originCounts = new Map<string, number>();
	const seenEntries = new Set<string>();
	let pinned: string | undefined;
	let seq = 0;
	let sessionPinRecorded = false;

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
				hits.set(parsed.url, { url: parsed.url, origin: parsed.origin, label: parsed.label, count: 1, last: seq });
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
				sessionPinRecorded = true;
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
		// One powerline chip's worth of text: the port is the only part that
		// disambiguates sibling worktrees, so that is all the chip carries. The
		// marker comes from the active symbol preset (nerd glyph, emoji, or
		// nothing under ascii — hence the ":" fallback) so the chip matches its
		// neighbours instead of hardcoding a font the terminal may not have.
		const glyph = ctx.ui.theme.symbol(top.url === pinned ? "icon.pin" : "cmd.globe").trim();
		ctx.ui.setStatus(STATUS_KEY, `${glyph.length > 0 ? glyph : ":"} ${top.label}`);
	}

	function refresh(ctx: ExtensionContext): void {
		syncBranch(ctx);
		updateStatus(ctx);
	}

	function resetRanking(): void {
		hits.clear();
		originCounts.clear();
		seenEntries.clear();
		seq = 0;
		sessionPinRecorded = false;
	}

	function forget(ctx: ExtensionContext): void {
		hits.clear();
		originCounts.clear();
		seenEntries.clear();
		for (const entry of ctx.sessionManager.getBranch()) seenEntries.add(entry.id);
		seq = 0;
		updateStatus(ctx);
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
			try {
				await recordOpened(ctx, url);
				ctx.ui.notify(`Opened ${url}`, "info");
			} catch (error) {
				ctx.ui.notify(`Opened ${url}, but url-pin could not save it: ${String(error)}`, "warning");
			}
			return;
		}
		ctx.ui.notify(`url-pin: ${command} exited ${result.code} — ${result.stderr.trim() || url}`, "error");
	}

	async function openTop(ctx: ExtensionContext): Promise<void> {
		refresh(ctx);
		const top = ranked()[0];
		if (!top) {
			ctx.ui.notify("url-pin: no URL seen in this session or saved for this branch", "warning");
			return;
		}
		await openUrl(ctx, top.url);
	}

	async function setPin(ctx: ExtensionContext, url: string | undefined): Promise<void> {
		pinned = url;
		pi.appendEntry(PIN_ENTRY, { url: url ?? null });
		updateStatus(ctx);
		try {
			await persistPin(ctx, url);
			ctx.ui.notify(url ? `url-pin: pinned ${url}` : "url-pin: pin cleared", "info");
		} catch (error) {
			ctx.ui.notify(`url-pin: pin changed for this session but could not be saved: ${String(error)}`, "warning");
		}
	}

	pi.setLabel("url-pin");

	for (const event of ["session_start", "session_switch", "session_branch", "session_tree"] as const) {
		pi.on(event, async (_payload, ctx) => {
			pinned = undefined;
			resetRanking();
			syncBranch(ctx);
			try {
				await restoreStored(ctx);
			} catch (error) {
				ctx.ui.notify(`url-pin: could not restore saved URLs: ${String(error)}`, "warning");
			}
			updateStatus(ctx);
		});
	}
	for (const event of ["input", "message_end", "tool_result"] as const) {
		pi.on(event, (_payload, ctx) => refresh(ctx));
	}
	// `user_bash`/`user_python` fire *before* the command runs, and its output is
	// appended to the session with no completion event of its own. Re-sync on a
	// managed timer so the chip catches a `!npm run dev` banner without waiting
	// for the next prompt; the shortcut re-syncs on press regardless.
	for (const event of ["user_bash", "user_python"] as const) {
		pi.on(event, (_payload, ctx) => {
			refresh(ctx);
			for (const delay of USER_COMMAND_RESYNC_MS) ctx.setTimeout(() => refresh(ctx), delay);
		});
	}

	pi.registerShortcut("super+b", {
		description: "Open the best URL for the current branch",
		handler: (ctx) => openTop(ctx),
	});

	/**
	 * Show the ranked list and return both the chosen URL and requested action.
	 *
	 * The rows carry display ranks and mark the current pin.
	 * In the normal `/urls` picker, right arrow confirms the highlighted row as
	 * a pin; Enter confirms it as an open.
	 */
	async function pickUrl(
		ctx: ExtensionCommandContext,
		title: string,
		allowRightArrowPin = false,
	): Promise<{ hit: Hit; pin: boolean } | undefined> {
		const rows = ranked();
		if (rows.length === 0) {
			ctx.ui.notify("url-pin: no URL seen in this session or saved for this branch", "warning");
			return undefined;
		}
		const pinGlyph = ctx.ui.theme.symbol("icon.pin").trim() || "*";
		const rowByLabel = new Map<string, Hit>();
		const options = rows.map((hit, i) => {
			const label = `${i + 1}. ${hit.url === pinned ? `${pinGlyph} ` : ""}${hit.url}`;
			rowByLabel.set(label, hit);
			const origin = originCounts.get(hit.origin) ?? hit.count;
			return { label, description: origin === hit.count ? `seen ${hit.count}×` : `seen ${hit.count}× · origin ${origin}×` };
		});
		if (allowRightArrowPin) {
			const selected = await ctx.ui.custom<{ label: string; pin: boolean } | undefined>((tui, _theme, _keybindings, done) => {
				let pinRequested = false;
				let selector: InstanceType<typeof pi.pi.ExtensionSelectorComponent>;
				selector = new pi.pi.ExtensionSelectorComponent(
					title,
					options,
					(label) => done({ label, pin: pinRequested }),
					() => done(undefined),
					{
						tui,
						helpText: "Enter open · → pin",
						onRight: () => {
							pinRequested = true;
							selector.handleInput("\r");
						},
					},
				);
				return selector;
			});
			const hit = selected && rowByLabel.get(selected.label);
			return hit && selected ? { hit, pin: selected.pin } : undefined;
		}
		const selected = await ctx.ui.select(title, options);
		const hit = selected && rowByLabel.get(selected);
		return hit ? { hit, pin: false } : undefined;
	}

	function remember(hit: ParsedUrl): void {
		if (hits.has(hit.url)) return;
		seq += 1;
		originCounts.set(hit.origin, (originCounts.get(hit.origin) ?? 0) + 1);
		hits.set(hit.url, { url: hit.url, origin: hit.origin, label: hit.label, count: 1, last: seq });
	}

	async function branchIdentity(ctx: ExtensionContext): Promise<BranchIdentity | undefined> {
		const result = await pi.exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir", "--abbrev-ref", "HEAD"], {
			cwd: ctx.cwd,
		});
		if (result.code !== 0) return undefined;
		const [repository, branch] = result.stdout.trim().split(/\r?\n/);
		return repository && branch ? { repository, branch } : undefined;
	}

	async function editStoredBranch(
		ctx: ExtensionContext,
		create: boolean,
		mutate: (branch: StoredBranch, now: number) => void,
	): Promise<void> {
		const identity = await branchIdentity(ctx);
		if (!identity) return;
		await updateState(statePath, (state) => {
			let stored = state.branches.find(
				(candidate) => candidate.repository === identity.repository && candidate.branch === identity.branch,
			);
			if (!stored) {
				if (!create) return;
				stored = { ...identity, urls: [], updatedAt: 0 };
				state.branches.push(stored);
			}
			const now = Date.now();
			mutate(stored, now);
			stored.updatedAt = now;
			state.branches.sort((a, b) => b.updatedAt - a.updatedAt);
			state.branches.splice(MAX_BRANCHES);
		});
	}

	async function recordOpened(ctx: ExtensionContext, url: string): Promise<void> {
		await editStoredBranch(ctx, true, (stored, now) => {
			stored.urls = [{ url, lastUsedAt: now }, ...stored.urls.filter((candidate) => candidate.url !== url)].slice(
				0,
				MAX_URLS_PER_BRANCH,
			);
		});
	}

	async function persistPin(ctx: ExtensionContext, url: string | undefined): Promise<void> {
		await editStoredBranch(ctx, url !== undefined, (stored, now) => {
			stored.pinned = url;
			if (url) {
				stored.urls = [{ url, lastUsedAt: now }, ...stored.urls.filter((candidate) => candidate.url !== url)].slice(
					0,
					MAX_URLS_PER_BRANCH,
				);
			}
		});
	}

	async function clearStored(ctx: ExtensionContext): Promise<void> {
		const identity = await branchIdentity(ctx);
		if (!identity) return;
		await updateState(statePath, (state) => {
			state.branches = state.branches.filter(
				(candidate) => candidate.repository !== identity.repository || candidate.branch !== identity.branch,
			);
		});
	}

	async function restoreStored(ctx: ExtensionContext): Promise<void> {
		const identity = await branchIdentity(ctx);
		if (!identity) return;
		const state = await readState(statePath);
		const stored = state.branches.find(
			(candidate) => candidate.repository === identity.repository && candidate.branch === identity.branch,
		);
		if (!stored) return;
		for (const candidate of [...stored.urls].sort((a, b) => a.lastUsedAt - b.lastUsedAt)) {
			const parsed = parse(candidate.url);
			if (parsed) remember(parsed);
		}
		if (!sessionPinRecorded && stored.pinned) {
			const parsed = parse(stored.pinned);
			if (parsed) {
				remember(parsed);
				pinned = parsed.url;
			}
		}
	}

	pi.registerCommand("urls", {
		description: "URLs seen this session or saved for this branch — pick one to open (pin | unpin | clear)",
		getArgumentCompletions: (prefix) => {
			const typed = prefix.trim();
			const verbs = ["pin", "unpin", "clear"].filter((verb) => verb.startsWith(typed));
			return verbs.length > 0 ? verbs.map((verb) => ({ value: verb, label: verb })) : null;
		},
		handler: async (args, ctx) => {
			const [verb, operand] = args.trim().split(/\s+/).filter(Boolean);
			if (verb === "clear") {
				forget(ctx);
				pinned = undefined;
				pi.appendEntry(PIN_ENTRY, { url: null });
				try {
					await clearStored(ctx);
					ctx.ui.notify("url-pin: URLs cleared for this branch", "info");
				} catch (error) {
					ctx.ui.notify(`url-pin: live URLs cleared, but saved URLs could not be removed: ${String(error)}`, "warning");
				}
				return;
			}
			if (verb === "unpin") {
				await setPin(ctx, undefined);
				return;
			}

			refresh(ctx);

			if (verb === "pin") {
				// Bare `/urls pin` opens the picker. An absolute URL selects
				// directly; `/path` uses the leading URL's origin. A number starts
				// a localhost port, so `2351/sign-in` becomes that port and route.
				if (operand === undefined) {
					const chosen = await pickUrl(ctx, "Pin URL for ⌘B");
					if (chosen) await setPin(ctx, chosen.hit.url);
					return;
				}
				const rows = ranked();
				let chosen: Hit | ParsedUrl | undefined;
				if (PORT_SHORTHAND_RE.test(operand)) {
					chosen = parse(`localhost:${operand}`);
				} else if (operand.startsWith("/")) {
					const top = rows[0];
					chosen = top ? parse(`${top.origin}${operand}`) : undefined;
				} else {
					chosen = parse(operand);
				}
				if (!chosen) {
					ctx.ui.notify(`url-pin: cannot pin "${operand}"`, "error");
					return;
				}
				remember(chosen);
				await setPin(ctx, chosen.url);
				return;
			}

			const chosen = await pickUrl(ctx, "Open URL (⌘B opens the first)", true);
			if (chosen?.pin) await setPin(ctx, chosen.hit.url);
			else if (chosen) await openUrl(ctx, chosen.hit.url);
		},
	});
}
