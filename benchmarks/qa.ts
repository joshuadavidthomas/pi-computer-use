import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
	executeClick,
	executeComputerActions,
	executeDoubleClick,
	executeDrag,
	executeKeypress,
	executeMoveMouse,
	executeScreenshot,
	executeScroll,
	executeSetText,
	executeTypeText,
	executeWait,
	reconstructStateFromBranch,
	stopBridge,
} from "../src/bridge.ts";
import { runCdpChecks } from "./cdp-qa.ts";

const ALLOW_FOREGROUND_QA =
	process.argv.includes("--allow-foreground-qa") || process.env.PI_COMPUTER_USE_ALLOW_FOREGROUND_QA === "1";
const ALLOW_SCREEN_TAKEOVER =
	process.argv.includes("--allow-screen-takeover") || process.env.PI_COMPUTER_USE_ALLOW_SCREEN_TAKEOVER === "1";
const STRICT_AX_MODE = process.env.PI_COMPUTER_USE_STEALTH === "1" || process.env.PI_COMPUTER_USE_STRICT_AX === "1";
function argValue(name: string): string | undefined {
	const exact = `${name}=`;
	const inline = process.argv.find((arg) => arg.startsWith(exact));
	if (inline) return inline.slice(exact.length);
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

const OUTPUT_PATH = argValue("--output");
const BASELINE_PATH = argValue("--baseline");
const CONFIG_PATH = path.resolve(process.cwd(), "benchmarks/config.json");
const HELPER_PATH = path.join(os.homedir(), ".pi", "agent", "helpers", "pi-computer-use", "bridge");
const HELPER_SOURCE_PATH = path.resolve(process.cwd(), "native/macos/bridge.swift");

const BROWSER_APPS = ["Safari", "Google Chrome", "Chrome", "Chromium", "Firefox", "Helium", "Arc", "Brave Browser", "Microsoft Edge"];
const HYBRID_APPS = ["Slack", "Discord", "Visual Studio Code", "Cursor", "Figma"];
const MATRIX = [
	{ app: "TextEdit", category: "native" },
	{ app: "Finder", category: "native" },
	{ app: "Reminders", category: "native" },
	...HYBRID_APPS.map((app) => ({ app, category: "hybrid" })),
	...BROWSER_APPS.map((app) => ({ app, category: "browser" })),
];

type CaseRecord = {
	name: string;
	category: string;
	tool:
		| "screenshot"
		| "click"
		| "double_click"
		| "move_mouse"
		| "drag"
		| "scroll"
		| "keypress"
		| "type_text"
		| "set_text"
		| "wait"
		| "computer_actions"
		| "cdp";
	app?: string;
	status: "PASS" | "FAIL" | "SKIP";
	latencyMs?: number;
	hasImage?: boolean;
	axTargets?: number;
	axOnly?: boolean;
	axExecution?: boolean;
	fallbackUsed?: boolean;
	stealthCompatible?: boolean;
	executionVariant?: string;
	details?: string;
	capability?: string;
	imageReason?: string;
	axDiagnosticReason?: string;
	axDiagnosticMessage?: string;
	axRoles?: Record<string, number>;
};

type BenchmarkSummary = {
	date: string;
	strictAxMode: boolean;
	allowScreenTakeover: boolean;
	host: string;
	cwd: string;
	metrics: ReturnType<typeof metrics>;
	analysis: ReturnType<typeof analyzeRecords>;
	goals?: {
		status: "PASS" | "FAIL";
		checks: Array<{ metric: string; current: number; target: number; status: "PASS" | "FAIL"; details: string }>;
	};
	comparison?: {
		baselinePath: string;
		status: "PASS" | "FAIL";
		checks: Array<{ metric: string; current: number; baseline: number; status: "PASS" | "FAIL"; details: string }>;
	};
	cases: CaseRecord[];
};

function readJsonFile(filePath: string): any {
	return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function runningApps(): Set<string> {
	try {
		const output = runCommand("osascript", [
			"-e",
			'tell application "System Events" to get name of (application processes where background only is false)',
		]);
		return new Set(
			output
				.split(",")
				.map((value) => value.trim())
				.filter(Boolean),
		);
	} catch {
		return new Set();
	}
}

function metricHigherIsBetter(metric: string): boolean {
	if (/Fallback|Sparse|Skipped|Failed|Latency|slowest|Count$/i.test(metric)) return false;
	return /Ratio$|avgAxTargets|AxTargets/i.test(metric);
}

function goalStatus(current: ReturnType<typeof metrics>) {
	const goals = readJsonFile(CONFIG_PATH)?.goals ?? {};
	const checks = Object.entries(goals).map(([metric, goal]) => {
		const spec = typeof goal === "object" && goal !== null ? goal as any : { target: goal };
		const currentValue = Number((current as any)[metric] ?? 0);
		const goalValue = Number(spec.target ?? 0);
		const whenMetric = typeof spec.whenMetric === "string" ? spec.whenMetric : undefined;
		const whenAtLeast = Number(spec.whenAtLeast ?? 0);
		if (whenMetric && Number((current as any)[whenMetric] ?? 0) < whenAtLeast) {
			return { metric, current: currentValue, target: goalValue, status: "PASS" as const, details: `skipped: requires ${whenMetric} >= ${whenAtLeast}` };
		}
		const higherIsBetter = metricHigherIsBetter(metric);
		const status = higherIsBetter ? currentValue >= goalValue : currentValue <= goalValue;
		const details = higherIsBetter ? `expected >= ${goalValue}, got ${currentValue}` : `expected <= ${goalValue}, got ${currentValue}`;
		return { metric, current: currentValue, target: goalValue, status: (status ? "PASS" : "FAIL") as "PASS" | "FAIL", details };
	});
	return { status: (checks.every((check) => check.status === "PASS") ? "PASS" : "FAIL") as "PASS" | "FAIL", checks };
}

function compareMetrics(current: ReturnType<typeof metrics>, baseline: ReturnType<typeof metrics>) {
	const config = readJsonFile(CONFIG_PATH)?.regressionTolerance ?? {};
	const checks = Object.entries(config).map(([metric, tolerance]) => {
		const currentValue = Number((current as any)[metric] ?? 0);
		const baselineValue = Number((baseline as any)[metric] ?? 0);
		const allowed = Number(tolerance ?? 0);
		const higherIsBetter = metricHigherIsBetter(metric);
		const status = higherIsBetter
			? currentValue + allowed >= baselineValue
			: currentValue <= baselineValue + allowed;
		const details = higherIsBetter
			? `expected >= ${baselineValue - allowed}, got ${currentValue}`
			: `expected <= ${baselineValue + allowed}, got ${currentValue}`;
		return { metric, current: currentValue, baseline: baselineValue, status: (status ? "PASS" : "FAIL") as "PASS" | "FAIL", details };
	});
	return { status: (checks.every((check) => check.status === "PASS") ? "PASS" : "FAIL") as "PASS" | "FAIL", checks };
}

function isRunningApp(appName: string, apps: Set<string>): boolean {
	return apps.has(appName);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureHelperCurrent(): void {
	try {
		const helperMtime = fs.existsSync(HELPER_PATH) ? fs.statSync(HELPER_PATH).mtimeMs : 0;
		const sourceMtime = fs.statSync(HELPER_SOURCE_PATH).mtimeMs;
		if (helperMtime >= sourceMtime) return;
		runCommand(process.execPath, ["scripts/build-native.mjs", "--output", HELPER_PATH]);
	} catch (error) {
		throw new Error(`Failed to build current helper before benchmarking: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function makeCtx(branchEntries: any[] = []): any {
	return {
		hasUI: false,
		ui: {
			select: async () => undefined,
			confirm: async () => false,
			input: async () => undefined,
			notify: () => undefined,
			onTerminalInput: () => () => undefined,
			setStatus: () => undefined,
			setWorkingMessage: () => undefined,
			setHiddenThinkingLabel: () => undefined,
			setWidget: () => undefined,
			setFooter: () => undefined,
			setHeader: () => undefined,
			setTitle: () => undefined,
			custom: async () => undefined,
			pasteToEditor: () => undefined,
			setEditorText: () => undefined,
			getEditorText: () => "",
			editor: async () => undefined,
			setEditorComponent: () => undefined,
			theme: {} as any,
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({ success: false }),
			getToolsExpanded: () => false,
			setToolsExpanded: () => undefined,
		},
		cwd: process.cwd(),
		sessionManager: { getBranch: () => branchEntries },
		modelRegistry: undefined,
		model: undefined,
		isIdle: () => true,
		signal: undefined,
		abort: () => undefined,
		hasPendingMessages: () => false,
		shutdown: () => undefined,
		getContextUsage: () => undefined,
		compact: () => undefined,
		getSystemPrompt: () => "",
	};
}

function runCommand(command: string, args: string[]): string {
	return execFileSync(command, args, { encoding: "utf8" }).trim();
}

function openApp(appName: string): boolean {
	try {
		runCommand("open", ["-a", appName]);
		return true;
	} catch {
		return false;
	}
}

function runAppleScript(lines: string[]): void {
	runCommand("osascript", lines.flatMap((line) => ["-e", line]));
}

function prepareAppWindow(appName: string): void {
	if (appName === "TextEdit") {
		runAppleScript([`tell application "TextEdit" to activate`, `tell application "TextEdit" to make new document`]);
		return;
	}
	if (appName === "Finder") {
		runAppleScript([`tell application "Finder" to activate`, `tell application "Finder" to make new Finder window to home`]);
		return;
	}
	if (appName === "Reminders") {
		runAppleScript([`tell application "Reminders" to activate`]);
		return;
	}
}

function summarizeResult(result: any): {
	hasImage: boolean;
	axTargets: number;
	fallbackUsed: boolean;
	axExecution: boolean;
	stealthCompatible: boolean;
	executionVariant: string;
	imageReason?: string;
	axDiagnosticReason?: string;
	axDiagnosticMessage?: string;
	axRoles?: Record<string, number>;
} {
	const content = Array.isArray(result?.content) ? result.content : [];
	const details = result?.details ?? {};
	const roleCounts = details?.axDiagnostics?.debug?.roleCounts;
	const axRoles = roleCounts && typeof roleCounts === "object" && !Array.isArray(roleCounts)
		? Object.fromEntries(Object.entries(roleCounts).map(([role, count]) => [role, Number(count) || 0]))
		: undefined;
	return {
		hasImage: content.some((item: any) => item?.type === "image"),
		axTargets: Array.isArray(details?.axTargets) ? details.axTargets.length : 0,
		fallbackUsed: details?.execution?.fallbackUsed === true,
		axExecution: details?.execution?.axSucceeded === true || String(details?.execution?.strategy ?? "").startsWith("ax_"),
		stealthCompatible: details?.execution?.stealthCompatible === true,
		executionVariant: String(details?.execution?.variant ?? "unknown"),
		imageReason: typeof details?.imageReason === "string" ? details.imageReason : undefined,
		axDiagnosticReason: typeof details?.axDiagnostics?.reason === "string" ? details.axDiagnostics.reason : undefined,
		axDiagnosticMessage: typeof details?.axDiagnostics?.message === "string" ? details.axDiagnostics.message : undefined,
		axRoles,
	};
}

function preferredAxTarget(details: any): any | undefined {
	const targets = Array.isArray(details?.axTargets) ? details.axTargets : [];
	const label = (target: any) => String(target?.title || target?.description || target?.value || "").trim();
	for (const role of ["AXTextField", "AXSearchField"]) {
		const match = targets.find((target: any) => String(target?.role ?? "") === role && label(target).length > 0);
		if (match) return match;
	}
	for (const role of ["AXButton", "AXLink", "AXRow", "AXCell"]) {
		const match = targets.find((target: any) => String(target?.role ?? "") === role && label(target).length > 0);
		if (match) return match;
	}
	return targets.find((target: any) => Array.isArray(target?.actions) && target.actions.includes("AXPress")) ?? targets[0];
}

function preferredTextTarget(details: any): any | undefined {
	const targets = Array.isArray(details?.axTargets) ? details.axTargets : [];
	return targets.find((target: any) =>
		["AXTextField", "AXSearchField", "AXTextArea", "AXTextView", "AXEditableText", "AXComboBox"].includes(String(target?.role ?? "")) &&
		target?.canSetValue === true &&
		typeof target?.ref === "string"
	);
}

function preferredScrollTarget(details: any): any | undefined {
	const targets = Array.isArray(details?.axTargets) ? details.axTargets : [];
	return targets.find((target: any) => target?.canScroll === true && typeof target?.ref === "string");
}

function preferredAdjustTarget(details: any): any | undefined {
	const targets = Array.isArray(details?.axTargets) ? details.axTargets : [];
	return targets.find((target: any) => (target?.canIncrement === true || target?.canDecrement === true) && typeof target?.ref === "string");
}

function captureCenter(details: any): { x: number; y: number } {
	const width = Math.max(20, Number(details?.capture?.width ?? 100));
	const height = Math.max(20, Number(details?.capture?.height ?? 100));
	return {
		x: Math.max(8, Math.min(width - 8, Math.round(width * 0.5))),
		y: Math.max(8, Math.min(height - 8, Math.round(height * 0.5))),
	};
}

function metrics(records: CaseRecord[]) {
	// Core excludes capability/hybrid cases and the CDP suite: CDP checks
	// validate the optional CDP backend, not AX coverage, so they carry no
	// axTargets/axOnly signals and would skew the AX-quality goals.
	const coreRecords = records.filter((record) => !record.capability && record.category !== "hybrid" && record.category !== "cdp");
	const executed = records.filter((record) => record.status !== "SKIP");
	const coreExecuted = coreRecords.filter((record) => record.status !== "SKIP");
	const passed = executed.filter((record) => record.status === "PASS");
	const corePassed = coreExecuted.filter((record) => record.status === "PASS");
	const semanticCoverageOk = (record: CaseRecord) => record.status === "PASS" && record.hasImage !== true && (record.axTargets ?? 0) >= 3;
	const sparseSemanticCoverage = (record: CaseRecord) => record.status === "PASS" && (record.hasImage === true || (record.axTargets ?? 0) < 3);
	const navigation = executed.filter((record) => record.tool === "screenshot" || record.tool === "wait");
	const targeting = executed.filter((record) => record.tool === "click" || record.tool === "set_text");
	const primitives = executed.filter((record) =>
		["double_click", "move_mouse", "drag", "scroll", "keypress", "type_text"].includes(record.tool),
	);
	const batches = executed.filter((record) => record.tool === "computer_actions");
	const capabilities = records.filter((record) => Boolean(record.capability));
	const executedCapabilities = capabilities.filter((record) => record.status !== "SKIP");
	const ratio = (subset: CaseRecord[], predicate: (record: CaseRecord) => boolean) =>
		subset.length ? Number((subset.filter(predicate).length / subset.length).toFixed(3)) : 0;
	const avgLatency = (subset: CaseRecord[]) =>
		subset.length
			? Math.round(subset.reduce((sum, record) => sum + (record.latencyMs ?? 0), 0) / subset.length)
			: 0;
	const avgAxTargets = (subset: CaseRecord[]) =>
		subset.length
			? Number((subset.reduce((sum, record) => sum + (record.axTargets ?? 0), 0) / subset.length).toFixed(1))
			: 0;
	const byCategory = Object.fromEntries(
		Array.from(new Set(records.map((record) => record.category))).map((category) => {
			const subset = records.filter((record) => record.category === category);
			const subsetExecuted = subset.filter((record) => record.status !== "SKIP");
			return [
				category,
				{
					total: subset.length,
					executed: subsetExecuted.length,
					passed: subset.filter((record) => record.status === "PASS").length,
					failed: subset.filter((record) => record.status === "FAIL").length,
					skipped: subset.filter((record) => record.status === "SKIP").length,
					axOnlyRatio: ratio(subsetExecuted, (record) => record.axOnly === true),
					visionFallbackRatio: ratio(subsetExecuted, (record) => record.hasImage === true),
					semanticCoverageRatio: ratio(subset.filter((record) => record.status === "PASS"), semanticCoverageOk),
					sparseSemanticCoverageRatio: ratio(subset.filter((record) => record.status === "PASS"), sparseSemanticCoverage),
					stealthCompatibleRatio: ratio(subsetExecuted, (record) => record.stealthCompatible === true),
					avgAxTargets: avgAxTargets(subset.filter((record) => record.status === "PASS")),
					avgLatencyMs: avgLatency(subsetExecuted),
				},
			];
		}),
	);
	const hybridPassed = passed.filter((record) => record.category === "hybrid");
	const hybridExecuted = executed.filter((record) => record.category === "hybrid");
	return {
		total: records.length,
		executed: executed.length,
		passed: passed.length,
		failed: executed.filter((record) => record.status === "FAIL").length,
		skipped: records.filter((record) => record.status === "SKIP").length,
		axOnlyRatio: ratio(executed, (record) => record.axOnly === true),
		coreAxOnlyRatio: ratio(coreExecuted, (record) => record.axOnly === true),
		visionFallbackRatio: ratio(executed, (record) => record.hasImage === true),
		coreVisionFallbackRatio: ratio(coreExecuted, (record) => record.hasImage === true),
		semanticCoverageRatio: ratio(passed, semanticCoverageOk),
		coreSemanticCoverageRatio: ratio(corePassed, semanticCoverageOk),
		sparseSemanticCoverageRatio: ratio(passed, sparseSemanticCoverage),
		coreSparseSemanticCoverageRatio: ratio(corePassed, sparseSemanticCoverage),
		avgAxTargets: avgAxTargets(passed),
		coreAvgAxTargets: avgAxTargets(corePassed),
		hybridExecuted: hybridExecuted.length,
		hybridPassed: hybridPassed.length,
		hybridSemanticCoverageRatio: ratio(hybridPassed, semanticCoverageOk),
		hybridSparseSemanticCoverageRatio: ratio(hybridPassed, sparseSemanticCoverage),
		hybridVisionFallbackRatio: ratio(hybridExecuted, (record) => record.hasImage === true),
		hybridAvgAxTargets: avgAxTargets(hybridPassed),
		zeroAxTargetCaseCount: passed.filter((record) => (record.axTargets ?? 0) === 0).length,
		sparseSemanticCoverageCaseCount: passed.filter(sparseSemanticCoverage).length,
		visionFallbackCaseCount: passed.filter((record) => record.hasImage === true).length,
		nonAxTargetingCaseCount: passed.filter((record) => ["click", "set_text", "scroll", "drag"].includes(record.tool) && record.axExecution !== true).length,
		skippedCapabilityCount: capabilities.filter((record) => record.status === "SKIP").length,
		axExecutionRatio: ratio(targeting, (record) => record.axExecution === true && record.fallbackUsed !== true),
		stealthCompatibleRatio: ratio(executed, (record) => record.stealthCompatible === true),
		navigationAxOnlyRatio: ratio(navigation, (record) => record.axOnly === true),
		targetingAxOnlyRatio: ratio(targeting, (record) => record.axOnly === true && record.axExecution === true),
		primitivePassRatio: ratio(primitives, (record) => record.status === "PASS"),
		batchPassRatio: ratio(batches, (record) => record.status === "PASS"),
		capabilityTotal: capabilities.length,
		capabilityExecuted: executedCapabilities.length,
		capabilityPassRatio: ratio(executedCapabilities, (record) => record.status === "PASS"),
		capabilityStealthRatio: ratio(executedCapabilities, (record) => record.stealthCompatible === true),
		avgLatencyMs: avgLatency(executed),
		avgNavigationLatencyMs: avgLatency(navigation),
		avgTargetingLatencyMs: avgLatency(targeting),
		avgPrimitiveLatencyMs: avgLatency(primitives),
		avgBatchLatencyMs: avgLatency(batches),
		coverage: byCategory,
	};
}

function bucketCounts(values: Array<string | undefined>): Record<string, number> {
	const buckets: Record<string, number> = {};
	for (const value of values) {
		const key = value?.trim() || "(none)";
		buckets[key] = (buckets[key] ?? 0) + 1;
	}
	return Object.fromEntries(Object.entries(buckets).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function compactCase(record: CaseRecord) {
	return {
		name: record.name,
		app: record.app,
		category: record.category,
		tool: record.tool,
		status: record.status,
		latencyMs: record.latencyMs,
		axTargets: record.axTargets,
		hasImage: record.hasImage,
		imageReason: record.imageReason,
		axDiagnosticReason: record.axDiagnosticReason,
		details: record.details,
		capability: record.capability,
	};
}

function analyzeRecords(records: CaseRecord[]) {
	const executed = records.filter((record) => record.status !== "SKIP");
	const passed = executed.filter((record) => record.status === "PASS");
	const semanticCoverageOk = (record: CaseRecord) => record.status === "PASS" && record.hasImage !== true && (record.axTargets ?? 0) >= 3;
	const sparseSemanticCoverage = (record: CaseRecord) => record.status === "PASS" && (record.hasImage === true || (record.axTargets ?? 0) < 3);
	const byApp = Object.fromEntries(
		Array.from(new Set(records.map((record) => record.app).filter((app): app is string => Boolean(app)))).map((app) => {
			const subset = records.filter((record) => record.app === app);
			const subsetExecuted = subset.filter((record) => record.status !== "SKIP");
			const subsetPassed = subset.filter((record) => record.status === "PASS");
			const ratio = (source: CaseRecord[], predicate: (record: CaseRecord) => boolean) =>
				source.length ? Number((source.filter(predicate).length / source.length).toFixed(3)) : 0;
			return [app, {
				executed: subsetExecuted.length,
				passed: subsetPassed.length,
				failed: subset.filter((record) => record.status === "FAIL").length,
				skipped: subset.filter((record) => record.status === "SKIP").length,
				axOnlyRatio: ratio(subsetExecuted, (record) => record.axOnly === true),
				visionFallbackRatio: ratio(subsetExecuted, (record) => record.hasImage === true),
				semanticCoverageRatio: ratio(subsetPassed, semanticCoverageOk),
				sparseSemanticCoverageRatio: ratio(subsetPassed, sparseSemanticCoverage),
				avgAxTargets: subsetPassed.length ? Number((subsetPassed.reduce((sum, record) => sum + (record.axTargets ?? 0), 0) / subsetPassed.length).toFixed(1)) : 0,
				avgLatencyMs: subsetExecuted.length ? Math.round(subsetExecuted.reduce((sum, record) => sum + (record.latencyMs ?? 0), 0) / subsetExecuted.length) : 0,
			}];
		}),
	);
	const sparseSemanticCoverageCases = passed
		.filter(sparseSemanticCoverage)
		.sort((a, b) => (a.axTargets ?? 0) - (b.axTargets ?? 0) || Number(b.hasImage) - Number(a.hasImage))
		.map(compactCase);
	const visionFallbackCases = passed
		.filter((record) => record.hasImage === true)
		.sort((a, b) => String(a.imageReason ?? "").localeCompare(String(b.imageReason ?? "")) || a.name.localeCompare(b.name))
		.map(compactCase);
	const nonAxTargetingCases = passed
		.filter((record) => ["click", "set_text", "scroll", "drag"].includes(record.tool) && record.axExecution !== true)
		.map(compactCase);
	const skippedCapabilities = records
		.filter((record) => record.status === "SKIP" && Boolean(record.capability))
		.map(compactCase);
	const failedCases = records
		.filter((record) => record.status === "FAIL")
		.map(compactCase);
	const slowestCases = executed
		.filter((record) => typeof record.latencyMs === "number")
		.sort((a, b) => (b.latencyMs ?? 0) - (a.latencyMs ?? 0))
		.slice(0, 10)
		.map(compactCase);
	const axDiagnosticReasons = bucketCounts(passed.map((record) => record.axDiagnosticReason));
	const imageReasons = bucketCounts(passed.filter((record) => record.hasImage === true).map((record) => record.imageReason));
	return {
		byApp,
		bottlenecks: {
			sparseSemanticCoverage: sparseSemanticCoverageCases,
			visionFallbackCases,
			nonAxTargetingCases,
			skippedCapabilities,
			failedCases,
			slowestCases,
		},
		buckets: {
			axDiagnosticReasons,
			imageReasons,
			failureReasons: bucketCounts(failedCases.map((record) => record.details?.replace(/\d+/g, "#").slice(0, 160))),
			skipReasons: bucketCounts(records.filter((record) => record.status === "SKIP").map((record) => record.details)),
		},
	};
}

function normalizeRecord(record: CaseRecord): CaseRecord {
	if (
		record.status === "FAIL" &&
		/No controllable window was found|No frontmost controllable window was found|No current controlled window|window is no longer available|is not running/i.test(record.details ?? "")
	) {
		return { ...record, status: "SKIP", details: record.details };
	}
	return record;
}

async function benchmarkCase(
	name: string,
	category: string,
	tool: CaseRecord["tool"],
	app: string | undefined,
	run: () => Promise<any>,
	capability?: string,
): Promise<{ record: CaseRecord; result?: any }> {
	const start = performance.now();
	try {
		const result = await run();
		const summary = summarizeResult(result);
		return {
			record: normalizeRecord({
				name,
				category,
				tool,
				app,
				status: "PASS",
				latencyMs: Math.round(performance.now() - start),
				hasImage: summary.hasImage,
				axTargets: summary.axTargets,
				axOnly: !summary.hasImage,
				axExecution: summary.axExecution,
				fallbackUsed: summary.fallbackUsed,
				stealthCompatible: summary.stealthCompatible,
				executionVariant: summary.executionVariant,
				details: `axTargets=${summary.axTargets} hasImage=${summary.hasImage}${summary.imageReason ? ` imageReason=${summary.imageReason}` : ""} axExecution=${summary.axExecution} fallback=${summary.fallbackUsed} variant=${summary.executionVariant} stealthCompatible=${summary.stealthCompatible}${summary.axDiagnosticReason ? ` axDiagnostic=${summary.axDiagnosticReason}` : ""}`,
				capability,
				imageReason: summary.imageReason,
				axDiagnosticReason: summary.axDiagnosticReason,
				axDiagnosticMessage: summary.axDiagnosticMessage,
				axRoles: summary.axRoles,
			}),
			result,
		};
	} catch (error) {
		return {
			record: normalizeRecord({
				name,
				category,
				tool,
				app,
				status: "FAIL",
				latencyMs: Math.round(performance.now() - start),
				details: error instanceof Error ? error.message : String(error),
				capability,
			}),
		};
	}
}

async function runSotaCapabilityCases(item: { app: string; category: string }, details: any, ctx: any, records: CaseRecord[]): Promise<void> {
	const stateId = details?.capture?.stateId;
	if (!stateId) return;
	const point = captureCenter(details);

	const scrollTarget = preferredScrollTarget(details);
	if (scrollTarget?.ref) {
		const result = await benchmarkCase(
			`${item.app}-sota-scroll-ax`,
			item.category,
			"scroll",
			item.app,
			async () => await executeScroll(`bench-${item.app}-sota-scroll`, { ref: scrollTarget.ref, scrollY: 120, stateId }, undefined, undefined, ctx),
			"ax_scroll_ref",
		);
		records.push(result.record);
	} else {
		records.push({ name: `${item.app}-sota-scroll-ax`, category: item.category, tool: "scroll", app: item.app, status: "SKIP", details: "No AX scroll ref available", capability: "ax_scroll_ref" });
	}

	const adjustTarget = preferredAdjustTarget(details);
	if (adjustTarget?.ref) {
		const result = await benchmarkCase(
			`${item.app}-sota-adjust-ax`,
			item.category,
			"drag",
			item.app,
			async () => await executeDrag(
				`bench-${item.app}-sota-adjust`,
				{
					ref: adjustTarget.ref,
					path: [[point.x, point.y], [Math.min(Number(details.capture.width) - 4, point.x + 24), point.y]],
					stateId,
				},
				undefined,
				undefined,
				ctx,
			),
			"ax_adjust_ref",
		);
		records.push(result.record);
	} else {
		records.push({ name: `${item.app}-sota-adjust-ax`, category: item.category, tool: "drag", app: item.app, status: "SKIP", details: "No AX adjustable ref available", capability: "ax_adjust_ref" });
	}

	if (item.category === "browser") {
		const result = await benchmarkCase(
			`${item.app}-sota-address-ax`,
			item.category,
			"computer_actions",
			item.app,
			async () => await executeComputerActions(
				`bench-${item.app}-sota-address`,
				{
					stateId,
					actions: [
						{ type: "keypress", keys: ["Command+L"] },
						{ type: "type_text", text: "about:blank" },
						{ type: "keypress", keys: ["Enter"] },
					],
				},
				undefined,
				undefined,
				ctx,
			),
			"browser_address_ax",
		);
		records.push(result.record);
	}
}

async function main() {
	if (!ALLOW_FOREGROUND_QA) {
		console.log("Foreground QA benchmark is disabled by default.");
		console.log("Re-run with --allow-foreground-qa (or PI_COMPUTER_USE_ALLOW_FOREGROUND_QA=1).");
		process.exitCode = 1;
		return;
	}

	ensureHelperCurrent();
	const records: CaseRecord[] = [];
	const ctx = makeCtx();
	const apps = runningApps();

	const frontmost = await benchmarkCase("frontmost-screenshot", "baseline", "screenshot", undefined, async () => {
		return await executeScreenshot("bench-frontmost", {}, undefined, undefined, ctx);
	});
	records.push(frontmost.record);

	for (const item of MATRIX) {
		let available = isRunningApp(item.app, apps);
		if (!available && ALLOW_SCREEN_TAKEOVER) {
			available = openApp(item.app);
			if (available) {
				await sleep(400);
			}
		}
		if (available && ALLOW_SCREEN_TAKEOVER) {
			prepareAppWindow(item.app);
			await sleep(250);
		}
		if (!available) {
			records.push({ name: `${item.app}-navigation`, category: item.category, tool: "screenshot", app: item.app, status: "SKIP", details: "App not running" });
			records.push({ name: `${item.app}-targeting`, category: item.category, tool: "click", app: item.app, status: "SKIP", details: "App not running" });
			continue;
		}

		const shot = await benchmarkCase(`${item.app}-navigation`, item.category, "screenshot", item.app, async () => {
			return await executeScreenshot(`bench-${item.app}-shot`, { app: item.app }, undefined, undefined, ctx);
		});
		if (
			STRICT_AX_MODE &&
			item.category === "browser" &&
			shot.record.status === "FAIL" &&
			/String AX mode cannot create an isolated browser window|Strict AX mode cannot create an isolated browser window/.test(String(shot.record.details ?? ""))
		) {
			shot.record = { ...shot.record, status: "SKIP", details: "Strict AX mode requires an already-open dedicated browser window" };
		}
		if (
			shot.record.status === "PASS" &&
			item.app === "Finder" &&
			shot.record.axTargets === 0 &&
			["", "(untitled)"].includes(String(shot.result?.details?.target?.windowTitle ?? ""))
		) {
			shot.record = { ...shot.record, status: "SKIP", details: "Finder is showing the desktop, not a controllable Finder window" };
		}
		records.push(shot.record);
		if (shot.record.status !== "PASS") continue;

		const details = shot.result?.details;
		let capabilityDetails = details;
		const target = preferredAxTarget(details);
		if (shot.record.hasImage || (shot.record.axTargets ?? 0) < 3) {
			records.push({
				name: `${item.app}-targeting`,
				category: item.category,
				tool: "click",
				app: item.app,
				status: "SKIP",
				details: "Semantic AX target coverage was too sparse for AX-first targeting",
			});
		} else if (!target?.ref || !details?.capture?.stateId) {
			records.push({
				name: `${item.app}-targeting`,
				category: item.category,
				tool: "click",
				app: item.app,
				status: "SKIP",
				details: "No AX target available from screenshot details",
			});
		} else {
			const click = await benchmarkCase(`${item.app}-targeting`, item.category, "click", item.app, async () => {
				return await executeClick(`bench-${item.app}-click`, { ref: target.ref, stateId: details.capture.stateId }, undefined, undefined, ctx);
			});
			records.push(click.record);
			if (click.record.status === "PASS" && click.result?.details) capabilityDetails = click.result.details;
		}

		await runSotaCapabilityCases(item, capabilityDetails, ctx, records);

		if (item.app === "TextEdit" && details?.capture?.stateId) {
			let currentDetails = details;
			let point = captureCenter(currentDetails);
			await executeClick(
				"bench-TextEdit-focus",
				{ x: point.x, y: point.y, stateId: currentDetails.capture.stateId },
				undefined,
				undefined,
				ctx,
			).catch(() => undefined);

			const runTextEditCase = async (
				name: string,
				tool: CaseRecord["tool"],
				run: () => Promise<any>,
			): Promise<void> => {
				const record = await benchmarkCase(name, item.category, tool, item.app, run);
				records.push(record.record);
				if (record.record.status === "PASS" && record.result?.details) {
					currentDetails = record.result.details;
					point = captureCenter(currentDetails);
				}
			};

			await runTextEditCase("TextEdit-set-text", "set_text", async () => {
				const textTarget = preferredTextTarget(currentDetails);
				return await executeSetText("bench-TextEdit-set-text", { text: "pi-computer-use benchmark set_text", ref: textTarget?.ref }, undefined, undefined, ctx);
			});

			if (STRICT_AX_MODE) {
				const textTarget = preferredTextTarget(currentDetails);
				if (textTarget?.ref) {
					await runTextEditCase("TextEdit-batch-ax", "computer_actions", async () => {
						return await executeComputerActions(
							"bench-TextEdit-batch-ax",
							{
								stateId: currentDetails.capture.stateId,
								actions: [
									{ type: "set_text", ref: textTarget.ref, text: "pi-computer-use benchmark AX batch" },
								],
							},
							undefined,
							undefined,
							ctx,
						);
					});
				} else {
					records.push({ name: "TextEdit-batch-ax", category: item.category, tool: "computer_actions", app: item.app, status: "SKIP", details: "No AX ref available for strict batch" });
				}


				for (const tool of ["double_click", "move_mouse", "keypress", "type_text"] as const) {
					records.push({ name: `TextEdit-${tool}`, category: item.category, tool, app: item.app, status: "SKIP", details: "Strict AX mode intentionally blocks raw primitive coverage" });
				}
			} else {
				await runTextEditCase("TextEdit-keypress", "keypress", async () => {
					return await executeKeypress("bench-TextEdit-keypress", { keys: ["Enter"] }, undefined, undefined, ctx);
				});
				await runTextEditCase("TextEdit-type-text", "type_text", async () => {
					return await executeTypeText("bench-TextEdit-type-text", { text: "benchmark raw insertion" }, undefined, undefined, ctx);
				});
				await runTextEditCase("TextEdit-move-mouse", "move_mouse", async () => {
					return await executeMoveMouse("bench-TextEdit-move", { x: point.x, y: point.y, stateId: currentDetails.capture.stateId }, undefined, undefined, ctx);
				});
				await runTextEditCase("TextEdit-double-click", "double_click", async () => {
					return await executeDoubleClick("bench-TextEdit-double", { x: point.x, y: point.y, stateId: currentDetails.capture.stateId }, undefined, undefined, ctx);
				});
				await runTextEditCase("TextEdit-drag", "drag", async () => {
					return await executeDrag(
						"bench-TextEdit-drag",
						{
							path: [
								[point.x, point.y],
								[Math.min(Number(currentDetails.capture.width) - 4, point.x + 18), Math.min(Number(currentDetails.capture.height) - 4, point.y + 18)],
							],
							stateId: currentDetails.capture.stateId,
						},
						undefined,
						undefined,
						ctx,
					);
				});
				await runTextEditCase("TextEdit-scroll", "scroll", async () => {
					return await executeScroll("bench-TextEdit-scroll", { x: point.x, y: point.y, scrollY: 120, stateId: currentDetails.capture.stateId }, undefined, undefined, ctx);
				});
				await runTextEditCase("TextEdit-batch", "computer_actions", async () => {
					const textTarget = preferredTextTarget(currentDetails);
					return await executeComputerActions(
						"bench-TextEdit-batch",
						{
							stateId: currentDetails.capture.stateId,
							actions: [
								{ type: "move_mouse", x: point.x, y: point.y },
								{ type: "click", x: point.x, y: point.y },
								{ type: "set_text", ref: textTarget?.ref, text: "pi-computer-use benchmark batch" },
								{ type: "keypress", keys: ["Enter"] },
								{ type: "type_text", text: "batch insertion" },
							],
						},
						undefined,
						undefined,
						ctx,
					);
				});
			}
		}

		if (item.app === "Finder" && details) {
			const waitCtx = makeCtx([{ type: "message", message: { role: "toolResult", toolName: "screenshot", details } }]);
			reconstructStateFromBranch(waitCtx);
			const wait = await benchmarkCase(`${item.app}-wait`, item.category, "wait", item.app, async () => {
				return await executeWait(`bench-${item.app}-wait`, { ms: 20 }, undefined, undefined, waitCtx);
			});
			records.push(wait.record);
		}
	}

	stopBridge();

	// CDP backend checks run against a self-contained headless Chrome; they
	// need no macOS permissions and never touch the foreground.
	const { checks: cdpChecks, skipReason: cdpSkipReason } = await runCdpChecks().catch((error) => ({
		checks: [],
		skipReason: `CDP checks crashed: ${error instanceof Error ? error.message : String(error)}`,
	}));
	if (cdpSkipReason) {
		records.push({ name: "cdp-suite", category: "cdp", tool: "cdp", status: "SKIP", details: cdpSkipReason });
	}
	for (const check of cdpChecks) {
		records.push({
			name: `cdp-${check.name}`,
			category: "cdp",
			tool: "cdp",
			status: check.pass ? "PASS" : "FAIL",
			details: check.detail,
		});
	}

	const benchmarkMetrics = metrics(records);
	const summary: BenchmarkSummary = {
		date: new Date().toISOString(),
		strictAxMode: STRICT_AX_MODE,
		allowScreenTakeover: ALLOW_SCREEN_TAKEOVER,
		host: os.hostname(),
		cwd: process.cwd(),
		metrics: benchmarkMetrics,
		analysis: analyzeRecords(records),
		goals: goalStatus(benchmarkMetrics),
		cases: records,
	};
	if (BASELINE_PATH) {
		const baseline = readJsonFile(path.resolve(BASELINE_PATH));
		summary.comparison = {
			baselinePath: path.resolve(BASELINE_PATH),
			...compareMetrics(summary.metrics, baseline.metrics),
		};
	}

	const text = JSON.stringify(summary, null, 2);
	console.log(text);
	if (OUTPUT_PATH) {
		fs.writeFileSync(path.resolve(OUTPUT_PATH), text);
	}
	if (summary.metrics.failed > 0 || summary.goals?.status === "FAIL" || summary.comparison?.status === "FAIL") {
		process.exitCode = 1;
	}
}

main().catch((error) => {
	stopBridge();
	console.error(error instanceof Error ? error.stack ?? error.message : String(error));
	process.exitCode = 1;
});
