import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	ensureComputerUseSetup,
	executeClick,
	executeScreenshot,
	executeTypeText,
	executeWait,
	reconstructStateFromBranch,
	stopBridge,
} from "../src/bridge.js";

const screenshotTool = defineTool({
	name: "screenshot",
	label: "Screenshot",
	description: "Capture the current controlled macOS window, returning semantic AX targets and attaching an image only when fallback is needed.",
	promptSnippet: "Capture and select a macOS window. Call this first and to switch windows.",
	promptGuidelines: [
		"Call screenshot first to choose a window and inspect the latest UI state.",
		"If screenshot returns AX targets, prefer those targets over coordinate clicks.",
		"Call screenshot(app, windowTitle) to switch the controlled window.",
		"For browsers, prefer a separate window for agent work instead of opening a new tab in the user's current window.",
		"In strict AX mode, do not bootstrap a new browser window; target an existing dedicated browser window instead.",
	],
	executionMode: "sequential",
	parameters: Type.Object({
		app: Type.Optional(Type.String({ description: "Optional app name, e.g. Safari" })),
		windowTitle: Type.Optional(Type.String({ description: "Optional window title filter" })),
	}),
	async execute(toolCallId, params, signal, onUpdate, ctx) {
		return await executeScreenshot(toolCallId, params, signal, onUpdate, ctx);
	},
});

const clickTool = defineTool({
	name: "click",
	label: "Click",
	description: "Click inside the current controlled window by AX target ref or screenshot-relative coordinates.",
	promptSnippet: "Click in the current window using coordinates from the latest screenshot or an AX target ref like @e1.",
	promptGuidelines: [
		"When screenshot returns AX targets, prefer click(ref=@eN) and use coordinates only when no suitable AX target is available.",
		"Coordinates are window-relative screenshot pixels from the latest screenshot.",
		"This tool returns the latest semantic state and attaches an image only when fallback is needed.",
	],
	executionMode: "sequential",
	parameters: Type.Object({
		x: Type.Optional(Type.Number({ description: "X coordinate in screenshot pixels" })),
		y: Type.Optional(Type.Number({ description: "Y coordinate in screenshot pixels" })),
		ref: Type.Optional(Type.String({ description: "Optional AX target ref from the latest screenshot, e.g. @e1" })),
		captureId: Type.Optional(Type.String({ description: "Optional screenshot validation id" })),
	}),
	async execute(toolCallId, params, signal, onUpdate, ctx) {
		return await executeClick(toolCallId, params, signal, onUpdate, ctx);
	},
});

const typeTextTool = defineTool({
	name: "type_text",
	label: "Type Text",
	description: "Type text into the currently focused control in the current controlled window.",
	promptSnippet: "Type into the focused control in the current window.",
	promptGuidelines: [
		"Click a field first if needed, then call type_text.",
		"Returns the latest semantic state and attaches an image only when fallback is needed.",
	],
	executionMode: "sequential",
	parameters: Type.Object({
		text: Type.String({ description: "Text to type" }),
	}),
	async execute(toolCallId, params, signal, onUpdate, ctx) {
		return await executeTypeText(toolCallId, params, signal, onUpdate, ctx);
	},
});

const waitTool = defineTool({
	name: "wait",
	label: "Wait",
	description: "Pause briefly, then return the latest semantic state of the current controlled window.",
	promptSnippet: "Wait briefly and refresh the current window state.",
	promptGuidelines: [
		"Use this for loading, animations, and polling async UI updates.",
		"Returns the latest semantic state and attaches an image only when fallback is needed.",
	],
	executionMode: "sequential",
	parameters: Type.Object({
		ms: Type.Optional(Type.Number({ description: "Milliseconds to wait (default ~1000ms)" })),
	}),
	async execute(toolCallId, params, signal, onUpdate, ctx) {
		return await executeWait(toolCallId, params, signal, onUpdate, ctx);
	},
});

function isDuplicateToolConflict(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}

	return /Tool ".*" conflicts with /.test(error.message);
}

export default function computerUseExtension(pi: ExtensionAPI): void {
	try {
		pi.registerTool(screenshotTool);
		pi.registerTool(clickTool);
		pi.registerTool(typeTextTool);
		pi.registerTool(waitTool);
	} catch (error) {
		if (isDuplicateToolConflict(error)) {
			return;
		}

		throw error;
	}

	pi.on("session_start", async (_event, ctx) => {
		reconstructStateFromBranch(ctx);

		if (!ctx.hasUI) {
			return;
		}

		try {
			await ensureComputerUseSetup(ctx);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`pi-computer-use is not ready yet. ${message}`, "warning");
		}
	});

	pi.on("session_tree", async (_event, ctx) => {
		reconstructStateFromBranch(ctx);
	});

	pi.on("session_shutdown", async () => {
		stopBridge();
	});
}
