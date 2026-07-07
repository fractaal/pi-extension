// @ts-nocheck
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_BATCH_MS = 1000;
const DEFAULT_MAX_LINES_PER_MESSAGE = 20;
const DEFAULT_MAX_BUFFER_LINES = 500;
const DEFAULT_MAX_LINE_BYTES = 4096;
const DEFAULT_SUMMARY_TAIL_LINES = 50;
const MAX_LINES_PER_DELIVERY_CYCLE = 64;
const MAX_STATUS_TAIL_LINES = 7;
const MAX_STATUS_TAIL_BYTES = 16 * 1024;
const MAX_STATUS_TAIL_ENTRY_BYTES = 512;
const MAX_INJECTED_LINE_BYTES = 1024;
const MAX_SUMMARY_TAIL_ENTRY_BYTES = 512;
const MAX_SUMMARY_TAIL_LINES = 200;
const MAX_METADATA_BYTES = 512;
const MAX_DELIVERY_ERRORS = 5;
const MAX_STATUS_RESPONSE_BYTES = 20 * 1024;
const MAX_DEFERRED_MESSAGE_BYTES = 20 * 1024;
const MAX_MONITOR_LIST_ITEMS = 20;
const MAX_LINES_PER_SECOND = 32;
const RATE_WINDOW_MS = 1000;

type MonitorStatus = "running" | "exited" | "failed" | "error" | "stopped";
type MonitorStream = "stdout" | "stderr" | "monitor";
type StatusUiContext = {
	hasUI: boolean;
	ui: {
		setStatus: (key: string, value?: string) => void;
		theme?: { fg?: (color: string, text: string) => string };
	};
};

interface LineEntry {
	time: string;
	stream: MonitorStream;
	line: string;
}

interface Monitor {
	id: string;
	name: string;
	command: string;
	cwd: string;
	status: MonitorStatus;
	startedAt: string;
	exitedAt?: string;
	exitCode?: number | null;
	signal?: NodeJS.Signals | null;
	lineCount: number;
	rawCapturedByteCount: number;
	spooledByteCount: number;
	injectedOutputLineCount: number;
	injectedOutputByteCount: number;
	displayTruncatedLineCount: number;
	lines: LineEntry[];
	pending: string[];
	pendingLineCount: number;
	pendingByteCount: number;
	pendingSummaryReason?: string;
	summaryEmissionCount: number;
	lastSummaryAt?: string;
	lastSummaryReason?: string;
	logWriteErrorCount: number;
	firstLogWriteErrorAt?: string;
	lastLogWriteError?: string;
	deliveryErrors: LineEntry[];
	recentLineTimes: number[];
	injectionPaused: boolean;
	guardrailTriggeredAt?: string;
	guardrailReason?: string;
	flushTimer?: NodeJS.Timeout;
	flushing: boolean;
	inject: boolean;
	batchMs: number;
	maxLinesPerMessage: number;
	maxBufferLines: number;
	maxLineBytes: number;
	summaryTailLines: number;
	logDir: string;
	combinedLogPath: string;
	stdoutLogPath: string;
	stderrLogPath: string;
	metadataPath: string;
	process: ChildProcessWithoutNullStreams;
	stdoutReader?: ReadlineInterface;
	stderrReader?: ReadlineInterface;
	stopRequested: boolean;
	shutdown: boolean;
}

function objectSchema(properties: Record<string, unknown>, required: string[] = []) {
	return { type: "object", properties, required, additionalProperties: false };
}

function stringSchema(description: string) {
	return { type: "string", description };
}

function numberSchema(description: string) {
	return { type: "number", description };
}

function booleanSchema(description: string) {
	return { type: "boolean", description };
}

function resolveCwd(base: string, cwd?: string): string {
	if (!cwd) return base;
	const normalized = cwd.startsWith("@") ? cwd.slice(1) : cwd;
	return path.isAbsolute(normalized) ? normalized : path.resolve(base, normalized);
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.trunc(value)));
}

function truncateUtf8WithSuffix(line: string, maxBytes: number, suffix: string): string {
	const bytes = Buffer.from(line, "utf8");
	if (bytes.length <= maxBytes) return line;

	const suffixBytes = Buffer.byteLength(suffix, "utf8");
	const contentBytes = Math.max(0, maxBytes - suffixBytes);
	const truncated = bytes
		.subarray(0, contentBytes)
		.toString("utf8")
		.replace(/\uFFFD$/, "");
	return `${truncated}${suffix}`;
}

function truncateUtf8Line(line: string, maxBytes: number): { line: string; truncated: boolean } {
	const bytes = Buffer.from(line, "utf8");
	if (bytes.length <= maxBytes) return { line, truncated: false };

	const suffix = `… [line truncated to ${maxBytes} bytes from ${bytes.length} bytes]`;
	return {
		line: truncateUtf8WithSuffix(line, maxBytes, suffix),
		truncated: true,
	};
}

function displayText(text: string, maxBytes = MAX_METADATA_BYTES) {
	return truncateUtf8Line(text, maxBytes).line;
}

function formatBytes(bytes: number) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function createMonitorLogFiles(id: string) {
	const logDir = mkdtempSync(path.join(tmpdir(), `pi-monitor-${id}-`));
	const combinedLogPath = path.join(logDir, "combined.log");
	const stdoutLogPath = path.join(logDir, "stdout.log");
	const stderrLogPath = path.join(logDir, "stderr.log");
	const metadataPath = path.join(logDir, "meta.json");
	writeFileSync(combinedLogPath, "", { flag: "wx" });
	writeFileSync(stdoutLogPath, "", { flag: "wx" });
	writeFileSync(stderrLogPath, "", { flag: "wx" });
	return {
		logDir,
		combinedLogPath,
		stdoutLogPath,
		stderrLogPath,
		metadataPath,
	};
}

function closeMonitorLogFiles(_monitor: Monitor) {
	// Log files are written synchronously so output is immediately available to read.
}

function pushDeliveryError(monitor: Monitor, entry: LineEntry) {
	monitor.deliveryErrors.push(entry);
	if (monitor.deliveryErrors.length > MAX_DELIVERY_ERRORS) monitor.deliveryErrors.shift();
}

function recordLogWriteError(monitor: Monitor, time: string, target: string, error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	monitor.logWriteErrorCount += 1;
	monitor.firstLogWriteErrorAt = monitor.firstLogWriteErrorAt ?? time;
	monitor.lastLogWriteError = `${target}: ${message}`;
	pushDeliveryError(monitor, {
		time,
		stream: "monitor",
		line: `failed to write ${target}: ${message}`,
	});
}

function monitorMetadata(monitor: Monitor) {
	return {
		id: monitor.id,
		name: displayText(monitor.name),
		command: displayText(monitor.command),
		cwd: displayText(monitor.cwd),
		status: monitor.status,
		pid: monitor.process.pid,
		startedAt: monitor.startedAt,
		exitedAt: monitor.exitedAt,
		exitCode: monitor.exitCode,
		signal: monitor.signal,
		lineCount: monitor.lineCount,
		rawCapturedByteCount: monitor.rawCapturedByteCount,
		spooledByteCount: monitor.spooledByteCount,
		summaryEmissionCount: monitor.summaryEmissionCount,
		lastSummaryAt: monitor.lastSummaryAt,
		lastSummaryReason: monitor.lastSummaryReason,
		logWriteErrorCount: monitor.logWriteErrorCount,
		firstLogWriteErrorAt: monitor.firstLogWriteErrorAt,
		lastLogWriteError: monitor.lastLogWriteError,
		logDir: monitor.logDir,
		combinedLogPath: monitor.combinedLogPath,
		stdoutLogPath: monitor.stdoutLogPath,
		stderrLogPath: monitor.stderrLogPath,
		metadataPath: monitor.metadataPath,
	};
}

function writeMonitorMetadata(monitor: Monitor) {
	try {
		writeFileSync(monitor.metadataPath, `${JSON.stringify(monitorMetadata(monitor), null, 2)}\n`, "utf8");
	} catch (error) {
		pushDeliveryError(monitor, {
			time: new Date().toISOString(),
			stream: "monitor",
			line: `failed to write monitor metadata: ${error instanceof Error ? error.message : String(error)}`,
		});
	}
}

function spoolLine(monitor: Monitor, time: string, stream: MonitorStream, rawLine: string) {
	const rawLineWithNewline = `${rawLine}\n`;
	const combinedLine = `${time} [${stream}] ${rawLine}\n`;
	monitor.rawCapturedByteCount += Buffer.byteLength(rawLineWithNewline, "utf8");

	try {
		appendFileSync(monitor.combinedLogPath, combinedLine, "utf8");
		monitor.spooledByteCount += Buffer.byteLength(combinedLine, "utf8");
	} catch (error) {
		recordLogWriteError(monitor, time, monitor.combinedLogPath, error);
	}

	if (stream === "stdout") {
		try {
			appendFileSync(monitor.stdoutLogPath, rawLineWithNewline, "utf8");
			monitor.spooledByteCount += Buffer.byteLength(rawLineWithNewline, "utf8");
		} catch (error) {
			recordLogWriteError(monitor, time, monitor.stdoutLogPath, error);
		}
	}
	if (stream === "stderr") {
		try {
			appendFileSync(monitor.stderrLogPath, rawLineWithNewline, "utf8");
			monitor.spooledByteCount += Buffer.byteLength(rawLineWithNewline, "utf8");
		} catch (error) {
			recordLogWriteError(monitor, time, monitor.stderrLogPath, error);
		}
	}
}

function pushTail(monitor: Monitor, entry: LineEntry) {
	monitor.lines.push(entry);
	if (monitor.lines.length > monitor.maxBufferLines) {
		monitor.lines.splice(0, monitor.lines.length - monitor.maxBufferLines);
	}
}

function sendDeferredMessage(pi: ExtensionAPI, monitor: Monitor, text: string) {
	if (monitor.shutdown) return;

	monitor.injectedOutputLineCount += text.split("\n").length;
	monitor.injectedOutputByteCount += Buffer.byteLength(text, "utf8");

	try {
		pi.sendMessage(
			{
				customType: "monitor",
				content: text,
				display: true,
				details: {
					source: "pi-monitor",
					monitorID: monitor.id,
					monitorName: displayText(monitor.name),
					command: displayText(monitor.command),
					cwd: displayText(monitor.cwd),
				},
			},
			{ deliverAs: "steer", triggerTurn: true },
		);
	} catch (error) {
		pushDeliveryError(monitor, {
			time: new Date().toISOString(),
			stream: "monitor",
			line: error instanceof Error ? error.message : String(error),
		});
	}
}

function markPendingSummary(monitor: Monitor, reason: string) {
	if (!monitor.pendingSummaryReason) monitor.pendingSummaryReason = reason;
	monitor.guardrailTriggeredAt = monitor.guardrailTriggeredAt ?? new Date().toISOString();
	monitor.guardrailReason = reason;
}

function pruneRecentLineTimes(monitor: Monitor, now = Date.now()) {
	const cutoff = now - RATE_WINDOW_MS;
	while (monitor.recentLineTimes.length > 0) {
		const first = monitor.recentLineTimes[0];
		if (first === undefined || first >= cutoff) break;
		monitor.recentLineTimes.shift();
	}
}

function recordOutputRate(monitor: Monitor, now: number) {
	monitor.recentLineTimes.push(now);
	pruneRecentLineTimes(monitor, now);

	if (monitor.inject && monitor.recentLineTimes.length > MAX_LINES_PER_SECOND) {
		markPendingSummary(
			monitor,
			`output exceeded ${MAX_LINES_PER_SECOND} lines in ${RATE_WINDOW_MS / 1000} second (${monitor.recentLineTimes.length} lines observed)`,
		);
	}
}

function buildMonitorHeading(monitor: Monitor, lineCount: number) {
	return [
		`Monitor ${displayText(monitor.name)} (${monitor.id}) produced ${lineCount} line${lineCount === 1 ? "" : "s"}.`,
		"",
	].join("\n");
}

function rememberPendingLine(monitor: Monitor, injectedLine: string) {
	monitor.pendingLineCount += 1;
	monitor.pendingByteCount += Buffer.byteLength(injectedLine, "utf8") + 1;
	monitor.pending.push(injectedLine);

	if (monitor.pendingLineCount > MAX_LINES_PER_DELIVERY_CYCLE) {
		markPendingSummary(monitor, `emission exceeded the ${MAX_LINES_PER_DELIVERY_CYCLE}-line direct-injection cap`);
	}
	if (monitor.pendingByteCount > MAX_DEFERRED_MESSAGE_BYTES) {
		markPendingSummary(
			monitor,
			`emission exceeded the ${formatBytes(MAX_DEFERRED_MESSAGE_BYTES)} direct-injection byte cap`,
		);
	}

	const retainedLimit = monitor.pendingSummaryReason
		? monitor.summaryTailLines
		: Math.max(MAX_LINES_PER_DELIVERY_CYCLE, monitor.summaryTailLines);
	if (monitor.pending.length > retainedLimit) {
		monitor.pending.splice(0, monitor.pending.length - retainedLimit);
	}
}

function resetPendingEmission(monitor: Monitor) {
	monitor.pending = [];
	monitor.pendingLineCount = 0;
	monitor.pendingByteCount = 0;
	monitor.pendingSummaryReason = undefined;
	monitor.guardrailTriggeredAt = undefined;
	monitor.guardrailReason = undefined;
}

function shouldSummarizePending(monitor: Monitor) {
	return Boolean(monitor.pendingSummaryReason) || monitor.pendingLineCount !== monitor.pending.length;
}

function logPathLines(monitor: Monitor) {
	return [
		`Full output: ${monitor.combinedLogPath}`,
		`stdout: ${monitor.stdoutLogPath}`,
		`stderr: ${monitor.stderrLogPath}`,
		`metadata: ${monitor.metadataPath}`,
	];
}

function buildSummaryMessage(monitor: Monitor) {
	const totalLines = monitor.pendingLineCount;
	const reason = monitor.pendingSummaryReason ?? "emission was summarized to keep session context bounded";
	let tail = monitor.pending
		.slice(-monitor.summaryTailLines)
		.map((line) => truncateUtf8Line(line, MAX_SUMMARY_TAIL_ENTRY_BYTES).line);
	let omittedForMessageBytes = 0;

	const render = () => {
		const tailIntro =
			tail.length > 0
				? `Most recent ${tail.length} of ${totalLines} line${totalLines === 1 ? "" : "s"}:`
				: `No tail lines included; read ${monitor.combinedLogPath} for output.`;
		return [
			`Monitor ${displayText(monitor.name)} (${monitor.id}) emitted ${totalLines} line${totalLines === 1 ? "" : "s"} since last update.`,
			`Summary reason: ${reason}.`,
			...logPathLines(monitor),
			omittedForMessageBytes > 0
				? `Tail reduced by ${omittedForMessageBytes} line${omittedForMessageBytes === 1 ? "" : "s"} to keep this monitor update bounded.`
				: undefined,
			"",
			tailIntro,
			...tail,
		]
			.filter((line): line is string => Boolean(line))
			.join("\n");
	};

	let text = render();
	while (Buffer.byteLength(text, "utf8") > MAX_DEFERRED_MESSAGE_BYTES && tail.length > 0) {
		tail = tail.slice(1);
		omittedForMessageBytes += 1;
		text = render();
	}
	return text;
}

function takePendingLinesForMessage(monitor: Monitor) {
	const lines: string[] = [];
	while (monitor.pending.length > 0 && lines.length < monitor.maxLinesPerMessage) {
		const candidate = monitor.pending[0];
		if (candidate === undefined) break;
		const projectedLines = [...lines, candidate];
		const projectedText = `${buildMonitorHeading(monitor, projectedLines.length)}${projectedLines.join("\n")}`;
		if (lines.length > 0 && Buffer.byteLength(projectedText, "utf8") > MAX_DEFERRED_MESSAGE_BYTES) break;
		const line = monitor.pending.shift();
		if (line === undefined) break;
		lines.push(line);
	}
	return lines;
}

function flushPending(pi: ExtensionAPI, monitor: Monitor) {
	if (monitor.flushing) return;
	monitor.flushing = true;
	if (monitor.flushTimer) clearTimeout(monitor.flushTimer);
	monitor.flushTimer = undefined;

	try {
		if (monitor.shutdown || monitor.pendingLineCount === 0) return;

		if (shouldSummarizePending(monitor)) {
			const text = buildSummaryMessage(monitor);
			monitor.summaryEmissionCount += 1;
			monitor.lastSummaryAt = new Date().toISOString();
			monitor.lastSummaryReason = monitor.pendingSummaryReason ?? "emission summarized";
			sendDeferredMessage(pi, monitor, text);
			writeMonitorMetadata(monitor);
			resetPendingEmission(monitor);
			return;
		}

		while (!monitor.shutdown && monitor.pending.length > 0) {
			const lines = takePendingLinesForMessage(monitor);
			if (lines.length === 0) break;
			const heading = buildMonitorHeading(monitor, lines.length);

			sendDeferredMessage(pi, monitor, `${heading}${lines.join("\n")}`);
		}
		writeMonitorMetadata(monitor);
		resetPendingEmission(monitor);
	} finally {
		monitor.flushing = false;
	}
}

function scheduleFlush(pi: ExtensionAPI, monitor: Monitor) {
	if (!monitor.inject || monitor.injectionPaused || monitor.shutdown || monitor.flushTimer || monitor.flushing) return;

	if (monitor.batchMs === 0) {
		flushPending(pi, monitor);
		return;
	}

	monitor.flushTimer = setTimeout(() => flushPending(pi, monitor), monitor.batchMs);
}

function enqueueLine(pi: ExtensionAPI, monitor: Monitor, stream: MonitorStream, rawLine: string) {
	const now = Date.now();
	const time = new Date().toISOString();
	spoolLine(monitor, time, stream, rawLine);

	const truncated = truncateUtf8Line(rawLine, monitor.maxLineBytes);
	if (truncated.truncated) monitor.displayTruncatedLineCount += 1;

	const entry: LineEntry = {
		time,
		stream,
		line: truncated.line,
	};

	pushTail(monitor, entry);
	monitor.lineCount += 1;

	const injectedLine = `[${stream}] ${truncateUtf8Line(truncated.line, MAX_INJECTED_LINE_BYTES).line}`;

	if (stream !== "monitor") {
		recordOutputRate(monitor, now);
	}

	if (monitor.inject && !monitor.injectionPaused) {
		rememberPendingLine(monitor, injectedLine);
		scheduleFlush(pi, monitor);
	} else if (monitor.inject && stream === "monitor") {
		sendDeferredMessage(pi, monitor, `[monitor] ${truncated.line}`);
	}

	if (monitor.lineCount % 1000 === 0) writeMonitorMetadata(monitor);
}

function buildStatusTail(monitor: Monitor, maxEntries: number) {
	const tail: LineEntry[] = [];
	let bytes = 0;
	let omittedForByteCap = 0;

	for (const entry of monitor.lines.slice(-maxEntries).reverse()) {
		const rendered = { ...entry, line: truncateUtf8Line(entry.line, MAX_STATUS_TAIL_ENTRY_BYTES).line };
		const entryBytes = Buffer.byteLength(JSON.stringify(rendered), "utf8") + 2;
		if (tail.length > 0 && bytes + entryBytes > MAX_STATUS_TAIL_BYTES) {
			omittedForByteCap += 1;
			continue;
		}
		bytes += entryBytes;
		tail.unshift(rendered);
	}

	return { tail, bytes, omittedForByteCap };
}

function summarizeMonitor(monitor: Monitor, tail = 20) {
	pruneRecentLineTimes(monitor);
	return {
		id: monitor.id,
		name: displayText(monitor.name),
		command: displayText(monitor.command),
		cwd: displayText(monitor.cwd),
		status: monitor.status,
		pid: monitor.process.pid,
		startedAt: monitor.startedAt,
		exitedAt: monitor.exitedAt,
		exitCode: monitor.exitCode,
		signal: monitor.signal,
		lineCount: monitor.lineCount,
		rawCapturedByteCount: monitor.rawCapturedByteCount,
		spooledByteCount: monitor.spooledByteCount,
		injectedOutputLineCount: monitor.injectedOutputLineCount,
		injectedOutputByteCount: monitor.injectedOutputByteCount,
		displayTruncatedLineCount: monitor.displayTruncatedLineCount,
		pendingLines: monitor.pendingLineCount,
		pendingRetainedTailLines: monitor.pending.length,
		pendingByteCount: monitor.pendingByteCount,
		pendingSummaryReason: monitor.pendingSummaryReason,
		summaryEmissionCount: monitor.summaryEmissionCount,
		lastSummaryAt: monitor.lastSummaryAt,
		lastSummaryReason: monitor.lastSummaryReason,
		logWriteErrorCount: monitor.logWriteErrorCount,
		firstLogWriteErrorAt: monitor.firstLogWriteErrorAt,
		lastLogWriteError: monitor.lastLogWriteError,
		injectionPaused: monitor.injectionPaused,
		guardrailTriggeredAt: monitor.guardrailTriggeredAt,
		guardrailReason: monitor.guardrailReason,
		recentLinesPerSecond: monitor.recentLineTimes.length,
		logDir: monitor.logDir,
		combinedLogPath: monitor.combinedLogPath,
		stdoutLogPath: monitor.stdoutLogPath,
		stderrLogPath: monitor.stderrLogPath,
		metadataPath: monitor.metadataPath,
		deliveryErrors: monitor.deliveryErrors.slice(-MAX_DELIVERY_ERRORS).map((entry) => ({
			...entry,
			line: displayText(entry.line),
		})),
		tail: tail > 0 ? monitor.lines.slice(-tail) : [],
	};
}

function stopMonitor(pi: ExtensionAPI, monitor: Monitor, signal: NodeJS.Signals | string = "SIGTERM") {
	if (monitor.status !== "running") return;
	monitor.stopRequested = true;
	if (!monitor.process.pid) {
		enqueueLine(pi, monitor, "monitor", `failed to send ${signal}: missing monitor process pid`);
		return;
	}
	try {
		process.kill(-monitor.process.pid, signal as NodeJS.Signals);
		enqueueLine(pi, monitor, "monitor", `sent ${signal}`);
	} catch (error) {
		enqueueLine(
			pi,
			monitor,
			"monitor",
			`failed to send ${signal}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export type MonitorUpdateListener = (snapshot: MonitorSnapshot) => void;

export interface MonitorSnapshot {
	id: string;
	name: string;
	command: string;
	cwd: string;
	status: MonitorStatus;
	liveTaskStatus: string;
	startedAt: string;
	updatedAt: string;
	startedAtMs: number;
	updatedAtMs: number;
	expiresAtMs: number;
	hasOutput: boolean;
	hasResult: boolean;
	exitCode?: number | null;
	outputTail: string;
	details: ReturnType<typeof summarizeMonitor>;
}

export interface MonitorManager {
	start(
		params: Record<string, unknown>,
		baseCwd: string,
		statusCtx?: StatusUiContext,
	): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
	status(
		params: Record<string, unknown>,
		statusCtx?: StatusUiContext,
	): Promise<{ content: Array<{ type: "text"; text: string }>; details?: unknown }>;
	list(statusCtx?: StatusUiContext): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
	stop(
		params: Record<string, unknown>,
		statusCtx?: StatusUiContext,
	): Promise<{ content: Array<{ type: "text"; text: string }>; details?: unknown }>;
	subscribe(listener: MonitorUpdateListener): () => void;
	shutdown(): void;
	clearStatus(ctx?: StatusUiContext): void;
}

function monitorSnapshot(monitor: Monitor): MonitorSnapshot {
	const updatedAt = new Date().toISOString();
	const liveTaskStatus =
		monitor.status === "exited"
			? "completed"
			: monitor.status === "stopped"
				? "killed"
				: monitor.status === "error"
					? "failed"
					: monitor.status;
	const updatedAtMs = Date.parse(updatedAt);
	return {
		id: monitor.id,
		name: monitor.name,
		command: monitor.command,
		cwd: monitor.cwd,
		status: monitor.status,
		liveTaskStatus,
		startedAt: monitor.startedAt,
		updatedAt,
		startedAtMs: Date.parse(monitor.startedAt),
		updatedAtMs,
		expiresAtMs: updatedAtMs + (monitor.status === "running" ? 60 * 60 * 1000 : 60 * 1000),
		hasOutput: monitor.lineCount > 0,
		hasResult: monitor.status !== "running",
		exitCode: monitor.exitCode,
		outputTail: monitor.lines
			.slice(-20)
			.map((entry) => entry.line)
			.join("\n"),
		details: summarizeMonitor(monitor, 0),
	};
}

function publishAriaLocalMonitor(pi: ExtensionAPI, snapshot: MonitorSnapshot): void {
	pi.events?.emit?.("aria-local:monitor-update", {
		task: {
			task_id: snapshot.id,
			kind: "tool",
			label: snapshot.name,
			status: snapshot.liveTaskStatus,
			started_at: snapshot.startedAt,
			updated_at: snapshot.updatedAt,
			started_at_ms: snapshot.startedAtMs,
			updated_at_ms: snapshot.updatedAtMs,
			expires_at_ms: snapshot.expiresAtMs,
			has_output: snapshot.hasOutput,
			has_result: snapshot.hasResult,
			exit_code: snapshot.exitCode,
			output_tail: snapshot.outputTail,
		},
	});
}

export function createMonitorManager(pi: ExtensionAPI): MonitorManager {
	const monitors = new Map<string, Monitor>();
	const subscribers = new Set<MonitorUpdateListener>();
	let latestStatusCtx: StatusUiContext | undefined;

	function emitMonitorUpdate(monitor: Monitor): void {
		const snapshot = monitorSnapshot(monitor);
		for (const listener of subscribers) listener(snapshot);
	}

	function rememberUi(ctx?: StatusUiContext) {
		if (ctx?.hasUI) latestStatusCtx = ctx;
	}

	function shortLabel(label: string, max = 34) {
		return label.length <= max ? label : `${label.slice(0, max - 1)}…`;
	}

	function formatMonitorStatus() {
		const active = [...monitors.values()].filter((monitor) => monitor.status === "running");
		if (active.length === 0) return undefined;

		if (active.length === 1) {
			const monitor = active[0];
			if (!monitor) return undefined;
			return `${monitor.stopRequested ? "monitor stopping" : "monitor"}: ${shortLabel(monitor.name)}`;
		}

		const labels = active
			.slice(0, 2)
			.map((monitor) => shortLabel(monitor.name, 18))
			.join(", ");
		const suffix = active.length > 2 ? ` +${active.length - 2}` : "";
		return `monitors: ${active.length} running (${labels}${suffix})`;
	}

	function colorMonitorStatus(ctx: StatusUiContext | undefined, text: string) {
		return ctx?.ui.theme?.fg?.("accent", text) ?? `\x1b[36m${text}\x1b[0m`;
	}

	function updateMonitorStatus(ctx?: StatusUiContext) {
		if (ctx) rememberUi(ctx);
		const statusCtx = ctx?.hasUI ? ctx : latestStatusCtx?.hasUI ? latestStatusCtx : undefined;
		const ui = statusCtx?.ui;
		if (!ui) return;
		const status = formatMonitorStatus();
		ui.setStatus("monitor", status ? colorMonitorStatus(statusCtx, status) : undefined);
	}

	function cleanupAll() {
		for (const monitor of monitors.values()) {
			monitor.shutdown = true;
			if (monitor.flushTimer) clearTimeout(monitor.flushTimer);
			monitor.stdoutReader?.close();
			monitor.stderrReader?.close();
			writeMonitorMetadata(monitor);
			closeMonitorLogFiles(monitor);
			if (monitor.status === "running") {
				monitor.stopRequested = true;
				try {
					if (monitor.process.pid) process.kill(-monitor.process.pid, "SIGTERM");
				} catch {
					// Process group may already be gone.
				}
			}
		}
		monitors.clear();
	}

	return {
		async start(params, baseCwd, statusCtx) {
			rememberUi(statusCtx);
			const id = randomUUID().slice(0, 8);
			const cwd = resolveCwd(baseCwd, params.cwd);
			const logs = createMonitorLogFiles(id);
			const child = spawn("/bin/bash", ["-lc", String(params.command)], {
				cwd,
				detached: true,
				env: process.env,
				stdio: ["ignore", "pipe", "pipe"],
			}) as ChildProcessWithoutNullStreams;

			const monitor: Monitor = {
				id,
				name: typeof params.name === "string" && params.name ? params.name : id,
				command: String(params.command),
				cwd,
				status: "running",
				startedAt: new Date().toISOString(),
				lineCount: 0,
				rawCapturedByteCount: 0,
				spooledByteCount: 0,
				injectedOutputLineCount: 0,
				injectedOutputByteCount: 0,
				displayTruncatedLineCount: 0,
				lines: [],
				pending: [],
				pendingLineCount: 0,
				pendingByteCount: 0,
				summaryEmissionCount: 0,
				logWriteErrorCount: 0,
				deliveryErrors: [],
				recentLineTimes: [],
				injectionPaused: false,
				flushing: false,
				inject: params.inject !== false,
				batchMs: clampNumber(params.batchMs, DEFAULT_BATCH_MS, 0, 60_000),
				maxLinesPerMessage: clampNumber(
					params.maxLinesPerMessage,
					DEFAULT_MAX_LINES_PER_MESSAGE,
					1,
					MAX_LINES_PER_DELIVERY_CYCLE,
				),
				maxBufferLines: clampNumber(params.maxBufferLines, DEFAULT_MAX_BUFFER_LINES, 1, 10_000),
				maxLineBytes: clampNumber(params.maxLineBytes, DEFAULT_MAX_LINE_BYTES, 128, 64 * 1024),
				summaryTailLines: clampNumber(params.summaryTailLines, DEFAULT_SUMMARY_TAIL_LINES, 1, MAX_SUMMARY_TAIL_LINES),
				...logs,
				process: child,
				stopRequested: false,
				shutdown: false,
			};

			monitors.set(id, monitor);
			emitMonitorUpdate(monitor);
			writeMonitorMetadata(monitor);
			updateMonitorStatus(statusCtx);

			monitor.stdoutReader = createInterface({ input: child.stdout });
			monitor.stderrReader = createInterface({ input: child.stderr });
			monitor.stdoutReader.on("line", (line) => enqueueLine(pi, monitor, "stdout", line));
			monitor.stderrReader.on("line", (line) => enqueueLine(pi, monitor, "stderr", line));

			child.on("error", (error) => {
				monitor.status = "error";
				monitor.exitedAt = new Date().toISOString();
				enqueueLine(pi, monitor, "monitor", `failed to start: ${error.message}`);
				flushPending(pi, monitor);
				writeMonitorMetadata(monitor);
				closeMonitorLogFiles(monitor);
				emitMonitorUpdate(monitor);
				if (!monitor.shutdown) updateMonitorStatus(statusCtx);
			});

			child.on("close", (code, signal) => {
				if (monitor.status !== "error") {
					monitor.status = monitor.stopRequested ? "stopped" : code === 0 ? "exited" : "failed";
				}
				monitor.exitedAt = new Date().toISOString();
				monitor.exitCode = code;
				monitor.signal = signal;
				enqueueLine(pi, monitor, "monitor", `exited with code ${code ?? "null"}${signal ? ` signal ${signal}` : ""}`);
				flushPending(pi, monitor);
				writeMonitorMetadata(monitor);
				closeMonitorLogFiles(monitor);
				emitMonitorUpdate(monitor);
				if (!monitor.shutdown) updateMonitorStatus(statusCtx);
			});

			return {
				content: [
					{
						type: "text" as const,
						text: [
							`Started monitor ${displayText(monitor.name)} (${id}).`,
							`PID: ${child.pid}`,
							`CWD: ${displayText(cwd)}`,
							`Deferred delivery: ${monitor.inject ? `enabled, batchMs=${monitor.batchMs}` : "disabled"}`,
							`Logs: combined=${monitor.combinedLogPath}`,
							`stdout=${monitor.stdoutLogPath}`,
							`stderr=${monitor.stderrLogPath}`,
							`metadata=${monitor.metadataPath}`,
							`Emission caps: direct updates summarize above ${MAX_LINES_PER_DELIVERY_CYCLE} queued lines, ${formatBytes(MAX_DEFERRED_MESSAGE_BYTES)}, or ${MAX_LINES_PER_SECOND} lines/second; summary tail=${monitor.summaryTailLines} lines.`,
							`Display line cap: ${monitor.maxLineBytes} bytes; in-memory status tail buffer: ${monitor.maxBufferLines} lines. Full raw output remains in the log files.`,
							`Use read on the log paths for full output, monitor_status with id=${id} for status, or monitor_stop to terminate it.`,
						].join("\n"),
					},
				],
				details: summarizeMonitor(monitor, 0),
			};
		},
		async status(params, statusCtx) {
			rememberUi(statusCtx);
			const id = String(params.id);
			const monitor = monitors.get(id);
			if (!monitor) {
				return { content: [{ type: "text" as const, text: `No monitor found for id ${id}.` }] };
			}

			flushPending(pi, monitor);
			writeMonitorMetadata(monitor);
			const requestedTail = clampNumber(params.tail, 20, 0, 500);
			const cappedTail = Math.min(requestedTail, MAX_STATUS_TAIL_LINES);
			const statusTail =
				cappedTail > 0 ? buildStatusTail(monitor, cappedTail) : { tail: [], bytes: 0, omittedForByteCap: 0 };
			const guardrailNotes = [
				requestedTail > cappedTail
					? `Requested ${requestedTail} tail lines; returned at most ${cappedTail}. monitor_status returns a capped recent tail, not a full log — read ${monitor.combinedLogPath} for complete combined output, or read stdout/stderr log paths for raw streams.`
					: undefined,
				statusTail.omittedForByteCap > 0
					? `Omitted ${statusTail.omittedForByteCap} older tail entr${statusTail.omittedForByteCap === 1 ? "y" : "ies"} to keep status output under ${MAX_STATUS_TAIL_BYTES} bytes.`
					: undefined,
			].filter((note): note is string => Boolean(note));
			const summary = {
				...summarizeMonitor(monitor, 0),
				tail: statusTail.tail,
				statusTailBytes: statusTail.bytes,
				statusTailGuardrail: guardrailNotes.length > 0 ? guardrailNotes.join(" ") : undefined,
			};
			let text = JSON.stringify(summary, null, 2);
			while (Buffer.byteLength(text, "utf8") > MAX_STATUS_RESPONSE_BYTES && summary.tail.length > 0) {
				summary.tail.shift();
				summary.statusTailGuardrail = [
					summary.statusTailGuardrail,
					`Trimmed oldest tail entries to keep the serialized status response under ${MAX_STATUS_RESPONSE_BYTES} bytes.`,
				]
					.filter(Boolean)
					.join(" ");
				text = JSON.stringify(summary, null, 2);
			}
			return {
				content: [
					{
						type: "text" as const,
						text,
					},
				],
				details: summarizeMonitor(monitor, 0),
			};
		},
		async list(statusCtx) {
			rememberUi(statusCtx);
			const all = [...monitors.values()];
			const running = all.filter((monitor) => monitor.status === "running");
			const notRunning = all.filter((monitor) => monitor.status !== "running");
			const selected =
				running.length >= MAX_MONITOR_LIST_ITEMS
					? running.slice(-MAX_MONITOR_LIST_ITEMS)
					: [...running, ...notRunning.slice(-(MAX_MONITOR_LIST_ITEMS - running.length))];
			const omitted = Math.max(0, all.length - selected.length);
			const omittedRunning = Math.max(
				0,
				running.length - selected.filter((monitor) => monitor.status === "running").length,
			);
			const result = selected.map((monitor) => summarizeMonitor(monitor, 0));
			const summary = {
				monitors: result,
				omittedOlderMonitors: omitted,
				omittedRunningMonitors: omittedRunning,
				listGuardrail:
					omitted > 0
						? `Returned ${result.length} monitors, prioritizing running monitors; omitted ${omitted} older monitor${omitted === 1 ? "" : "s"}${omittedRunning > 0 ? ` (${omittedRunning} still running)` : ""} to keep monitor_list bounded.`
						: undefined,
			};
			return {
				content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
				details: summary,
			};
		},
		async stop(params, statusCtx) {
			rememberUi(statusCtx);
			const id = String(params.id);
			const monitor = monitors.get(id);
			if (!monitor) {
				return { content: [{ type: "text" as const, text: `No monitor found for id ${id}.` }] };
			}
			if (monitor.status !== "running") {
				return { content: [{ type: "text" as const, text: `Monitor ${id} is already ${monitor.status}.` }] };
			}

			const signal = typeof params.signal === "string" && params.signal ? params.signal : "SIGTERM";
			stopMonitor(pi, monitor, signal);
			flushPending(pi, monitor);
			emitMonitorUpdate(monitor);
			updateMonitorStatus(statusCtx);
			return {
				content: [{ type: "text" as const, text: `Sent ${signal} to monitor ${displayText(monitor.name)} (${id}).` }],
				details: summarizeMonitor(monitor, 0),
			};
		},
		subscribe(listener) {
			subscribers.add(listener);
			return () => subscribers.delete(listener);
		},
		shutdown() {
			cleanupAll();
			latestStatusCtx = undefined;
		},
		clearStatus(ctx) {
			if (ctx?.hasUI) ctx.ui.setStatus("monitor", undefined);
		},
	};
}

export default function monitorExtension(pi: ExtensionAPI) {
	const manager = createMonitorManager(pi);
	const unsubscribeAriaLocalUpdates = manager.subscribe((snapshot) => publishAriaLocalMonitor(pi, snapshot));

	pi.on("session_shutdown", async (_event, ctx) => {
		unsubscribeAriaLocalUpdates();
		manager.clearStatus(ctx);
		manager.shutdown();
	});

	pi.registerTool({
		name: "monitor_start",
		label: "Monitor Start",
		description:
			"Start a sparse asynchronous monitor that injects only specific, meaningful events into this Pi session. Do NOT use monitor_start to run noisy servers, dev apps, desktop apps, watch builds, or broad log streams directly; start those with bash as background tasks so their full output stays in the bash task log. If live watching is needed, point monitor_start at a narrow filtered signal source, such as grep/tail over a background task log for one readiness line, one error signature, or a wrapper that emits one compact line per meaningful event. Stream a source unfiltered only when it is already naturally sparse, which is uncommon. Do not use for ordinary one-shot commands; use bash for those. Output injection is batched and bounded per emission; full-fidelity monitor output is retained in log files that can be inspected with read or searched with bash/rg.",
		promptSnippet:
			"Start a sparse async watcher for a specific signal; do not run noisy servers/logs here — background them with bash and monitor only filtered events.",
		promptGuidelines: [
			"Use bash, not monitor_start, for ordinary one-shot commands expected to finish, including ls, rg/grep/find, git status/diff, builds, linters, formatters, migrations, scripts, and non-watch tests; use bash.background_after_seconds for foreground responsiveness and bash.kill_after_seconds only for an explicit hard kill deadline.",
			"Use monitor_start only as a sparse signal watcher. Prefer pointing it at a filtered background-task log (for example tail/grep for one readiness line or one error signature) or at a wrapper script that emits one compact, self-contained line per meaningful event. Aim for one emitted line per meaningful event.",
			"Use bash run_in_background/backgrounding for noisy long-running processes: dev servers, desktop apps, watch builds/tests, persistent services, and broad logs. Their full stdout/stderr belongs in the bash task log, not injected into the conversation.",
			"Do not stream noisy logs raw. A monitor attached to unfiltered Aria Desktop/dev-server logs can flood the session with request JSON just because the user moves around the app.",
			"Do not use monitor_start merely because a command may take a while; if final output or exit status matters, use bash.",
			`monitor_start writes full output to per-monitor log files. Automatic injection is bounded per emission: if an update exceeds ${MAX_LINES_PER_DELIVERY_CYCLE} queued lines, ${formatBytes(MAX_DEFERRED_MESSAGE_BYTES)}, or ${MAX_LINES_PER_SECOND} lines/second, Pi injects a summary with log paths and the most recent retained tail instead of pausing the monitor indefinitely. Use read on the combined/stdout/stderr log paths for full output, or bash/rg to search them.`,
			"Use monitor_status or monitor_list to inspect monitors created by monitor_start, and use monitor_stop when a running monitor is no longer needed.",
		],
		parameters: objectSchema(
			{
				command: stringSchema("Shell command to run via /bin/bash -lc."),
				cwd: stringSchema("Working directory. Relative paths resolve from the current Pi cwd."),
				name: stringSchema("Human-readable monitor name."),
				inject: booleanSchema("Whether output should be queued back into the session. Defaults to true."),
				batchMs: numberSchema(
					"Milliseconds to batch lines before delivery. Use 0 for per-line delivery. Defaults to 1000.",
				),
				maxLinesPerMessage: numberSchema(
					"Maximum direct output lines per monitor message. Defaults to 20; capped at 64 by the sparse-output guardrail.",
				),
				maxBufferLines: numberSchema(
					"Maximum lines retained in memory for monitor_status tail output. Defaults to 500. Full output is still written to log files.",
				),
				maxLineBytes: numberSchema(
					"Maximum bytes retained per in-memory/display output line before truncation. Defaults to 4096. Full raw lines are still written to log files.",
				),
				summaryTailLines: numberSchema(
					"Number of recent lines included when a monitor emission is summarized. Defaults to 50; capped at 200.",
				),
			},
			["command"],
		),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return manager.start(params, ctx.cwd, ctx);
		},
	});

	pi.registerTool({
		name: "monitor_status",
		label: "Monitor Status",
		description: "Show status and recent output for a long-running background monitor created by monitor_start.",
		promptSnippet: "Show status and recent retained output for a monitor_start background process.",
		parameters: objectSchema(
			{
				id: stringSchema("Monitor ID returned by monitor_start."),
				tail: numberSchema(
					`Number of recent retained lines to include. Defaults to 20; capped at ${MAX_STATUS_TAIL_LINES} by the sparse-output guardrail.`,
				),
			},
			["id"],
		),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return manager.status(params, ctx);
		},
	});

	pi.registerTool({
		name: "monitor_list",
		label: "Monitor List",
		description: "List all monitor_start background processes known to this Pi process.",
		promptSnippet: "List all monitor_start background processes known to this Pi process.",
		parameters: objectSchema({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			return manager.list(ctx);
		},
	});

	pi.registerTool({
		name: "monitor_stop",
		label: "Monitor Stop",
		description: "Terminate a running monitor_start background process by signaling its process group.",
		promptSnippet: "Terminate a running monitor_start background process by signaling its process group.",
		parameters: objectSchema(
			{
				id: stringSchema("Monitor ID returned by monitor_start."),
				signal: stringSchema("Signal to send to the process group. Defaults to SIGTERM."),
			},
			["id"],
		),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return manager.stop(params, ctx);
		},
	});
}
