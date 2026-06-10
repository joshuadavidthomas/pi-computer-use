// CDP browser checks: verify the src/cdp.ts backend against a real headless
// Chrome with a local test server. No macOS permissions or AX helper needed.
//
// Standalone:            npx -y tsx benchmarks/cdp-qa.ts   (npm run benchmark:cdp)
// Inside main benchmark: qa.ts imports runCdpChecks() and merges the results.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { CdpTab, cdpEnabled, cdpTabForWindow } from "../src/cdp.ts";

const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CDP_PORT = 9335;
const SERVER_PORT = 8923;
const SLOW_RESOURCE_DELAY_MS = 800;

export interface CdpCheck {
	name: string;
	pass: boolean;
	detail: string;
}

function page(title: string, body: string): string {
	return `<!DOCTYPE html><html><head><title>${title}</title></head><body>${body}</body></html>`;
}

function startTestServer(): Server {
	const server = createServer((req, res) => {
		const url = req.url ?? "/";
		if (url === "/fast") {
			res.end(page("CDP Fast Page", `<h1>fast</h1><script>
				console.log("hello", 42);
				console.warn("warned");
				setTimeout(() => { throw new Error("intentional-uncaught"); }, 50);
			</script>`));
		} else if (url === "/slow") {
			res.end(page("CDP Slow Page", `<img src="/slow-resource">`));
		} else if (url === "/slow-resource") {
			setTimeout(() => res.end("x"), SLOW_RESOURCE_DELAY_MS);
		} else if (url === "/dup1" || url === "/dup2" || url === "/dup3") {
			res.end(page("Duplicate Title", `<script>window.__marker = "${url.slice(1)}";</script>`));
		} else if (url === "/duplong") {
			res.end(page("Duplicate Title Longer", `<script>window.__marker = "duplong";</script>`));
		} else {
			res.end(page("CDP Blank", ""));
		}
	});
	server.listen(SERVER_PORT, "127.0.0.1");
	return server;
}

async function launchChrome(userDataDir: string): Promise<ChildProcess> {
	const chrome = spawn(CHROME_PATH, [
		"--headless=new",
		`--remote-debugging-port=${CDP_PORT}`,
		`--user-data-dir=${userDataDir}`,
		"--no-first-run",
		"--no-default-browser-check",
		"about:blank",
	], { stdio: "ignore" });

	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		try {
			await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(500) });
			return chrome;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
	}
	throw new Error("Chrome did not expose its CDP endpoint in time.");
}

// Modern Chrome ignores the url param on PUT /json/new, so create a blank
// tab and drive the navigation over CDP, then disconnect so the lookup under
// test (cdpTabForWindow) establishes its own connection.
async function openTab(url: string): Promise<string> {
	const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new`, { method: "PUT" });
	if (!response.ok) throw new Error(`Failed to open tab: ${response.status}`);
	const target = (await response.json()) as { id: string; title: string; webSocketDebuggerUrl: string };
	const tab = await CdpTab.connect(target.webSocketDebuggerUrl, target.id, target.title);
	await tab.navigate(url);
	tab.close();
	return target.id;
}

async function activateTab(targetId: string): Promise<void> {
	await fetch(`http://127.0.0.1:${CDP_PORT}/json/activate/${targetId}`);
	await new Promise((resolve) => setTimeout(resolve, 300));
}

/** One-shot command against the browser-level CDP endpoint (not a page). */
async function browserCommand(method: string, params: Record<string, unknown>): Promise<any> {
	const version = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json()) as { webSocketDebuggerUrl: string };
	const ws = new WebSocket(version.webSocketDebuggerUrl);
	await new Promise<void>((resolve, reject) => {
		ws.onopen = () => resolve();
		ws.onerror = () => reject(new Error("Failed to connect to browser CDP endpoint"));
	});
	try {
		return await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 5_000);
			ws.onmessage = (event) => {
				const message = JSON.parse(String(event.data));
				if (message.id !== 1) return;
				clearTimeout(timer);
				if (message.error) reject(new Error(message.error.message));
				else resolve(message.result);
			};
			ws.send(JSON.stringify({ id: 1, method, params }));
		});
	} finally {
		ws.close();
	}
}

/** Opens `url` in a separate browser window placed at the given bounds. */
async function openWindow(url: string, bounds: { left: number; top: number; width: number; height: number }): Promise<string> {
	const created = await browserCommand("Target.createTarget", { url: "about:blank", newWindow: true });
	const targetId = created.targetId as string;
	const { windowId } = await browserCommand("Browser.getWindowForTarget", { targetId });
	await browserCommand("Browser.setWindowBounds", { windowId, bounds });
	const list = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()) as Array<{ id: string; webSocketDebuggerUrl: string }>;
	const entry = list.find((target) => target.id === targetId);
	if (!entry) throw new Error("New window target not found in /json/list");
	const tab = await CdpTab.connect(entry.webSocketDebuggerUrl, targetId, "");
	await tab.navigate(url);
	tab.close();
	return targetId;
}

export async function runCdpChecks(): Promise<{ checks: CdpCheck[]; skipReason?: string }> {
	if (!existsSync(CHROME_PATH)) {
		return { checks: [], skipReason: `Chrome not found at ${CHROME_PATH}` };
	}

	const checks: CdpCheck[] = [];
	const record = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });
	const previousEnv = process.env.PI_COMPUTER_USE_CDP_PORT;
	const userDataDir = mkdtempSync(path.join(os.tmpdir(), "pi-cdp-qa-"));
	const server = startTestServer();
	const base = `http://127.0.0.1:${SERVER_PORT}`;
	let chrome: ChildProcess | undefined;

	try {
		// 1. Gating: disabled without the env var.
		delete process.env.PI_COMPUTER_USE_CDP_PORT;
		record("gating: disabled without env", !cdpEnabled() && (await cdpTabForWindow("anything")) === undefined, "cdpEnabled false, lookup undefined");

		chrome = await launchChrome(userDataDir);
		process.env.PI_COMPUTER_USE_CDP_PORT = String(CDP_PORT);

		// 2. Discovery + exact title match.
		await openTab(`${base}/fast`);
		const fastTab = await cdpTabForWindow("CDP Fast Page");
		record("discovery: exact title match", fastTab !== undefined, fastTab ? `connected to '${fastTab.title}'` : "no tab found");

		// 3. Suffixed window title (AX titles often carry ' - Google Chrome').
		const suffixedTab = await cdpTabForWindow("CDP Fast Page - Google Chrome");
		record("matching: suffixed window title", suffixedTab !== undefined && suffixedTab === fastTab, suffixedTab === fastTab ? "reused same connection" : "no/new match");

		// 4. Console capture: levels, exception, drain clears.
		await new Promise((resolve) => setTimeout(resolve, 300));
		const entries = fastTab?.drainConsole() ?? [];
		const hasLog = entries.some((entry) => entry.level === "log" && entry.text.includes("hello 42"));
		const hasWarn = entries.some((entry) => entry.level === "warning" || entry.level === "warn");
		const hasException = entries.some((entry) => entry.level === "exception" && entry.text.includes("intentional-uncaught"));
		record("console: log/warn/exception captured", hasLog && hasWarn && hasException, JSON.stringify(entries.map((entry) => entry.level)));
		record("console: drain clears buffer", (fastTab?.drainConsole() ?? [{ level: "x", text: "x" }]).length === 0, "second drain empty");

		// 5. Navigation waits for the real load event (slow subresource delays it).
		const navStart = performance.now();
		await fastTab!.navigate(`${base}/slow`);
		const navMs = performance.now() - navStart;
		record(
			"navigate: waits for load event",
			navMs >= SLOW_RESOURCE_DELAY_MS && navMs < 9_000,
			`took ${Math.round(navMs)}ms (expected >=${SLOW_RESOURCE_DELAY_MS}ms event-driven, <9000ms cap)`,
		);

		// 6. Reconnect-by-target after title changed under the same connection.
		const slowTab = await cdpTabForWindow("CDP Slow Page");
		record("matching: follows title change on same target", slowTab !== undefined && slowTab.targetId === fastTab!.targetId, slowTab ? "same target reused" : "lost the tab");

		// 7. Duplicate titles in one window: the active (visible) tab should
		// win, not whichever happens to be listed first by /json/list.
		const dup1Id = await openTab(`${base}/dup1`);
		await openTab(`${base}/dup2`); // newest, so listed first
		await activateTab(dup1Id); // but dup1 is the active tab
		const dupTab = await cdpTabForWindow("Duplicate Title");
		const marker = dupTab ? await dupTab.evaluate("window.__marker") : undefined;
		record("matching: duplicate titles pick active tab", marker === "dup1", `selected marker=${String(marker)} (want dup1, the activated tab)`);

		// 8. Exact title beats prefix match, even when the prefix-matching tab
		// is the active one.
		const dupLongId = await openTab(`${base}/duplong`);
		await activateTab(dupLongId);
		await cdpTabForWindow("CDP Slow Page"); // point the connection cache elsewhere
		const exactTab = await cdpTabForWindow("Duplicate Title");
		const exactMarker = exactTab ? await exactTab.evaluate("window.__marker") : undefined;
		record("matching: exact title beats prefix", exactMarker === "dup1" || exactMarker === "dup2", `selected marker=${String(exactMarker)} (want dup1/dup2, not duplong)`);

		// 9. Same title in two windows: the AX window frame must decide,
		// since both windows' active tabs report visible.
		const windowBounds = { left: 900, top: 300, width: 500, height: 400 };
		await openWindow(`${base}/dup3`, windowBounds);
		await cdpTabForWindow("CDP Slow Page"); // reset the connection cache
		const framedTab = await cdpTabForWindow("Duplicate Title", { x: windowBounds.left, y: windowBounds.top, w: windowBounds.width, h: windowBounds.height });
		const framedMarker = framedTab ? await framedTab.evaluate("window.__marker") : undefined;
		record("matching: window frame separates same-titled windows", framedMarker === "dup3", `selected marker=${String(framedMarker)} (want dup3, the second window)`);

		// 10. Unknown title with multiple open tabs: must not guess.
		const bogus = await cdpTabForWindow("No Such Window Title 123");
		record("matching: unknown title returns undefined", bogus === undefined, bogus ? `wrongly matched '${bogus.title}'` : "no match, as expected");

		// 11. Dead endpoint: fails once, then negative cache answers instantly.
		chrome.kill("SIGKILL");
		await new Promise((resolve) => setTimeout(resolve, 500));
		await cdpTabForWindow("CDP Slow Page"); // primes the failure cache
		const cachedStart = performance.now();
		const cached = await cdpTabForWindow("CDP Slow Page");
		const cachedMs = performance.now() - cachedStart;
		record("resilience: dead endpoint negative-cached", cached === undefined && cachedMs < 50, `second lookup ${cachedMs.toFixed(1)}ms`);
	} finally {
		chrome?.kill("SIGKILL");
		server.close();
		rmSync(userDataDir, { recursive: true, force: true });
		if (previousEnv === undefined) delete process.env.PI_COMPUTER_USE_CDP_PORT;
		else process.env.PI_COMPUTER_USE_CDP_PORT = previousEnv;
	}

	return { checks };
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
	runCdpChecks()
		.then(({ checks, skipReason }) => {
			if (skipReason) {
				console.log(`SKIP  ${skipReason}`);
				return;
			}
			for (const check of checks) {
				console.log(`${check.pass ? "PASS" : "FAIL"}  ${check.name} — ${check.detail}`);
			}
			const failed = checks.filter((check) => !check.pass).length;
			console.log(`\n${checks.length - failed}/${checks.length} checks passed.`);
			process.exit(failed ? 1 : 0);
		})
		.catch((error) => {
			console.error(error);
			process.exit(1);
		});
}
