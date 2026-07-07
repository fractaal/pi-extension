import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, open, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { AgentToolUpdateCallback, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const FOREGROUND_BUDGET_MS = 60_000;
const MAX_FOREGROUND_WAIT_SECONDS = FOREGROUND_BUDGET_MS / 1000;
const MAX_SET_TIMEOUT_MS = 2_147_483_647;
const MAX_KILL_AFTER_SECONDS = Math.floor(MAX_SET_TIMEOUT_MS / 1000);
const DEFAULT_TAIL_BYTES = 16 * 1024;
const TOOL_OUTPUT_BYTES = 50 * 1024;
const TOOL_OUTPUT_LINES = 2000;
const UPDATE_THROTTLE_MS = 150;
const MAX_COMPLETED_TASKS = 100;
// Background task completion should be pushed back into the session by default.
// Set PI_BASH_BACKGROUND_NOTIFY=0 only when deliberately disabling that behavior.
const COMPLETION_FOLLOW_UP_ENABLED = process.env.PI_BASH_BACKGROUND_NOTIFY !== "0";

const bashParams = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	background_after_seconds: Type.Optional(
		Type.Number({
			description:
				"Seconds to wait in the foreground before returning a background task id. This only controls responsiveness. It does not kill the command. Default: 60. Maximum: 60.",
		}),
	),
	kill_after_seconds: Type.Optional(
		Type.Number({
			description:
				"Optional hard kill deadline for the command after it starts. Blunt instrument; avoid unless the command is known to hang. Must be greater than or equal to background_after_seconds. If omitted, no kill deadline is applied.",
		}),
	),
	description: Type.Optional(Type.String({ description: "Short description of the command" })),
	run_in_background: Type.Optional(Type.Boolean({ description: "Start the command as a background task immediately" })),
});

const bashOutputParams = Type.Object({
	task_id: Type.String({ description: "Background bash task id" }),
	block: Type.Optional(Type.Boolean({ description: "Wait for the task to finish before returning" })),
	wait_seconds: Type.Optional(
		Type.Number({
			description:
				"When block=true, seconds to wait for the background task to finish before returning current status and output. This only controls this polling call. It does not kill the task. Default: 60. Maximum: 60.",
		}),
	),
	tail_bytes: Type.Optional(Type.Number({ description: "Bytes of output tail to read" })),
});

const killBashParams = Type.Object({
	task_id: Type.String({ description: "Background bash task id to stop" }),
	reason: Type.Optional(Type.String({ description: "Reason for stopping the task" })),
});

const bashTasksParams = Type.Object({
	status: Type.Optional(Type.String({ description: "Optional status filter: running, completed, failed, or killed" })),
});

export type BashTaskStatus = "running" | "completed" | "failed" | "killed";

type TaskStatus = BashTaskStatus;

export interface BashTaskSnapshot {
	taskId: string;
	status: TaskStatus;
	exitCode: number | null;
	reason?: string;
	description: string;
	command: string;
	cwd: string;
	outputPath: string;
	startedAt: string;
	startedAtMs: number;
	updatedAt: string;
	updatedAtMs: number;
	killAfterMs?: number;
	hasOutput: boolean;
	hasResult: boolean;
	outputTail: string;
}

export type BashTaskUpdateListener = (snapshot: BashTaskSnapshot) => void;

interface TaskCompletion {
	taskId: string;
	command: string;
	description: string;
	status: Exclude<TaskStatus, "running">;
	exitCode: number | null;
	outputPath: string;
	durationMs: number;
	reason?: string;
}

export interface BashTaskRecord {
	taskId: string;
	command: string;
	description: string;
	cwd: string;
	outputPath: string;
	startedAt: number;
	child: ChildProcess;
	stream: WriteStream;
	status: TaskStatus;
	exitCode: number | null;
	reason?: string;
	notifyOnCompletion: boolean;
	completion: Promise<TaskCompletion>;
	resolveCompletion: (completion: TaskCompletion) => void;
	backgroundAfterMs: number;
	killAfterMs?: number;
	killTimer?: ReturnType<typeof setTimeout>;
	tailChunks: string[];
	tailBytes: number;
	completionSettled: boolean;
}

const tasks = new Map<string, TaskRecord>();
const bashTaskSubscribers = new Set<BashTaskUpdateListener>();
let lastUpdateAt = 0;
let updateTimer: ReturnType<typeof setTimeout> | undefined;

type TaskRecord = BashTaskRecord;

function appendTail(task: TaskRecord, chunk: Buffer | string): void {
	const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
	task.tailChunks.push(text);
	task.tailBytes += Buffer.byteLength(text);
	while (task.tailBytes > TOOL_OUTPUT_BYTES * 2 && task.tailChunks.length > 1) {
		const removed = task.tailChunks.shift() ?? "";
		task.tailBytes -= Buffer.byteLength(removed);
	}
}

function snapshotTail(task: TaskRecord, maxBytes = TOOL_OUTPUT_BYTES): string {
	const joined = task.tailChunks.join("").replace(/\r/g, "");
	const lines = joined.split("\n");
	let text = lines.length > TOOL_OUTPUT_LINES ? lines.slice(-TOOL_OUTPUT_LINES).join("\n") : joined;
	const buf = Buffer.from(text, "utf8");
	if (buf.length > maxBytes) {
		text = buf.subarray(buf.length - maxBytes).toString("utf8");
		text = `[showing last ${maxBytes} bytes]\n${text}`;
	}
	return text;
}

async function readTail(filePath: string, maxBytes: number): Promise<string> {
	const s = await stat(filePath).catch(() => null);
	if (!s) return "";
	const length = Math.min(s.size, maxBytes);
	const start = Math.max(0, s.size - length);
	const handle = await open(filePath, "r");
	try {
		const buffer = Buffer.alloc(length);
		await handle.read(buffer, 0, length, start);
		const tail = buffer.toString("utf8").replace(/\r/g, "");
		return start > 0 ? `[showing last ${length} of ${s.size} bytes]\n${tail}` : tail;
	} finally {
		await handle.close();
	}
}

function scheduleUpdate(onUpdate: AgentToolUpdateCallback<{ outputPath: string }> | undefined, task: TaskRecord): void {
	if (!onUpdate) return;
	const emit = () => {
		lastUpdateAt = Date.now();
		onUpdate({
			content: [{ type: "text", text: snapshotTail(task) || "(running...)" }],
			details: { outputPath: task.outputPath },
		});
	};
	const delay = UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
	if (delay <= 0) {
		if (updateTimer) clearTimeout(updateTimer);
		updateTimer = undefined;
		emit();
		return;
	}
	updateTimer ??= setTimeout(() => {
		updateTimer = undefined;
		emit();
	}, delay);
}

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals = "SIGKILL"): void {
	if (!child.pid) return;
	try {
		process.kill(-child.pid, signal);
	} catch {
		try {
			child.kill(signal);
		} catch {
			// Already exited.
		}
	}
}

function requestKill(pi: ExtensionAPI, task: TaskRecord, reason: string): void {
	if (task.status !== "running") return;
	task.reason = reason;
	killProcessGroup(task.child);
	const timer = setTimeout(() => {
		if (task.completionSettled) return;
		task.child.stdout?.destroy();
		task.child.stderr?.destroy();
		if (!task.stream.destroyed && !task.stream.writableEnded) {
			task.stream.destroy();
		}
		finishTask(pi, task, "killed", task.exitCode ?? 137);
	}, 2_000);
	timer.unref();
}

function finishTask(
	pi: ExtensionAPI,
	task: TaskRecord,
	status: Exclude<TaskStatus, "running">,
	exitCode: number | null,
): void {
	if (task.completionSettled) return;
	if (task.status === "running") {
		task.status = status;
		task.exitCode = exitCode;
	}
	if (task.killTimer) clearTimeout(task.killTimer);
	const settle = () => {
		if (task.completionSettled) return;
		task.completionSettled = true;
		const completion: TaskCompletion = {
			taskId: task.taskId,
			command: task.command,
			description: task.description,
			status: task.status === "running" ? status : task.status,
			exitCode: task.exitCode,
			outputPath: task.outputPath,
			durationMs: Math.max(0, Date.now() - task.startedAt),
			reason: task.reason,
		};
		task.resolveCompletion(completion);
		emitBashTaskUpdate(task);
		if (task.notifyOnCompletion && COMPLETION_FOLLOW_UP_ENABLED) {
			queueCompletionMessage(pi, completion);
		}
		pruneCompletedTasks();
	};
	if (task.stream.destroyed || task.stream.writableEnded) {
		settle();
		return;
	}
	task.stream.end(settle);
}

function queueCompletionMessage(pi: ExtensionAPI, completion: TaskCompletion): void {
	const exit = completion.exitCode === null ? "unknown" : String(completion.exitCode);
	const text = [
		"<background-bash-task>",
		`<task-id>${escapeXml(completion.taskId)}</task-id>`,
		`<status>${escapeXml(completion.status)}</status>`,
		`<exit-code>${escapeXml(exit)}</exit-code>`,
		`<output-file>${escapeXml(completion.outputPath)}</output-file>`,
		`<summary>${escapeXml(`Background bash command "${completion.description}" ${completion.status} with exit code ${exit}. Use bash_output with task_id=${completion.taskId} to inspect output if needed.`)}</summary>`,
		"</background-bash-task>",
	].join("\n");
	try {
		pi.sendMessage(
			{
				customType: "background-bash-task",
				content: text,
				display: true,
				details: completion,
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	} catch {
		// Completion notifications are best-effort; bash_output can still inspect state.
	}
}

async function spawnTask(
	pi: ExtensionAPI,
	command: string,
	cwd: string,
	backgroundAfterSeconds: number,
	killAfterSeconds: number | undefined,
	description: string | undefined,
): Promise<TaskRecord> {
	const taskId = `bash-${randomUUID()}`;
	const outputDir = path.join(getAgentDir(), "background-tasks", taskId);
	await mkdir(outputDir, { recursive: true });
	const outputPath = path.join(outputDir, "output.log");
	const stream = createWriteStream(outputPath, { flags: "a" });
	let resolveCompletion!: (completion: TaskCompletion) => void;
	const completion = new Promise<TaskCompletion>((resolve) => {
		resolveCompletion = resolve;
	});
	const wrappedCommand = `__pi_backgrounding_run() {\n${command}\n}\n__pi_backgrounding_run\n__pi_backgrounding_status=$?\nwait\nexit $__pi_backgrounding_status`;
	const child = spawn("/bin/bash", ["-lc", wrappedCommand], {
		cwd,
		detached: true,
		env: process.env,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	const task: TaskRecord = {
		taskId,
		command,
		description: description?.trim() || command,
		cwd,
		outputPath,
		startedAt: Date.now(),
		child,
		stream,
		status: "running",
		exitCode: null,
		notifyOnCompletion: false,
		completion,
		resolveCompletion,
		tailChunks: [],
		tailBytes: 0,
		completionSettled: false,
		backgroundAfterMs: Math.round(backgroundAfterSeconds * 1000),
		killAfterMs: killAfterSeconds === undefined ? undefined : Math.round(killAfterSeconds * 1000),
	};
	tasks.set(taskId, task);
	emitBashTaskUpdate(task);
	stream.on("error", (error) => {
		if (task.status === "running") {
			requestKill(pi, task, `output stream error: ${error.message}`);
		}
		finishTask(pi, task, "failed", 1);
	});
	const writeChunk = (chunk: Buffer | string) => {
		appendTail(task, chunk);
		if (stream.writableEnded || stream.destroyed) return;
		const ok = stream.write(chunk);
		if (!ok) {
			child.stdout?.pause();
			child.stderr?.pause();
			stream.once("drain", () => {
				child.stdout?.resume();
				child.stderr?.resume();
			});
		}
	};
	child.stdout?.on("data", writeChunk);
	child.stderr?.on("data", writeChunk);
	child.once("error", (error) => {
		writeChunk(`\n[spawn error: ${error.message}]\n`);
		finishTask(pi, task, "failed", 1);
	});
	child.once("close", (code, signal) => {
		const exitCode = code ?? signalExitCode(signal);
		if (task.reason) {
			finishTask(pi, task, "killed", exitCode);
		} else {
			finishTask(pi, task, exitCode === 0 ? "completed" : "failed", exitCode);
		}
	});
	if (task.killAfterMs !== undefined) {
		task.killTimer = setTimeout(() => {
			if (task.status !== "running") return;
			const killAfterMs = task.killAfterMs;
			if (killAfterMs === undefined) return;
			const reason = `command killed after ${formatDuration(killAfterMs)}`;
			const msg = `\n[${reason}; task killed]\n`;
			appendTail(task, msg);
			if (!stream.writableEnded && !stream.destroyed) stream.write(msg);
			requestKill(pi, task, reason);
		}, task.killAfterMs);
		task.killTimer.unref();
	}
	return task;
}

function backgroundText(task: TaskRecord, auto: boolean): string {
	return [
		auto
			? `In the interest of keeping Pi responsive, this Bash command has been automatically backgrounded after running for more than ${formatDuration(task.backgroundAfterMs)}.`
			: "Command started in background.",
		`task_id: ${task.taskId}`,
		`output_path: ${task.outputPath}`,
		"Use bash_output with this task_id to inspect progress, or kill_bash to stop it.",
	].join("\n");
}

function taskSummary(task: TaskRecord): string {
	return [
		`task_id: ${task.taskId}`,
		`status: ${task.status}`,
		task.exitCode !== null ? `exit_code: ${task.exitCode}` : undefined,
		task.reason ? `reason: ${task.reason}` : undefined,
		`started_at: ${new Date(task.startedAt).toISOString()}`,
		task.killAfterMs !== undefined ? `kill_after: ${formatDuration(task.killAfterMs)}` : "kill_after: none",
		`description: ${task.description}`,
		`output_path: ${task.outputPath}`,
	]
		.filter(Boolean)
		.join("\n");
}

function formatForeground(task: TaskRecord, completion: TaskCompletion): string {
	const output = snapshotTail(task);
	const line = `Command ${completion.status} after ${formatDuration(completion.durationMs)}${completion.exitCode !== null ? ` with exit code ${completion.exitCode}` : ""}.`;
	return [line, output.trimEnd()].filter(Boolean).join("\n\n") || "Command completed with no output.";
}

function signalExitCode(signal: NodeJS.Signals | null): number {
	if (signal === "SIGKILL") return 137;
	if (signal === "SIGTERM") return 143;
	if (signal === "SIGINT") return 130;
	if (signal === "SIGHUP") return 129;
	return signal ? 128 : 1;
}

function pruneCompletedTasks(): void {
	const completed = [...tasks.values()]
		.filter((task) => task.status !== "running")
		.sort((a, b) => a.startedAt - b.startedAt);
	while (completed.length > MAX_COMPLETED_TASKS) {
		const task = completed.shift();
		if (!task) break;
		tasks.delete(task.taskId);
		void rm(path.dirname(task.outputPath), { recursive: true, force: true });
	}
}

async function pruneOldTaskDirs(): Promise<void> {
	const root = path.join(getAgentDir(), "background-tasks");
	const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
	const cutoff = Date.now() - 24 * 60 * 60 * 1000;
	for (const entry of entries) {
		if (!entry.isDirectory() || !entry.name.startsWith("bash-")) continue;
		const dir = path.join(root, entry.name);
		const s = await stat(dir).catch(() => null);
		if (s && s.mtimeMs < cutoff) {
			void rm(dir, { recursive: true, force: true });
		}
	}
}

function formatDuration(ms: number): string {
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function containsUnsupportedDetach(command: string): boolean {
	return (
		/(^|[;&|\s])(?:\S*\/)?(nohup|disown|setsid|systemd-run)(\s|$)/.test(command) ||
		/(^|[;&|\s])(docker|podman)\s+(compose\s+up|run)\b[^\n;]*(\s-d\b|--detach\b)/.test(command)
	);
}

function parsePositiveSeconds(value: number | undefined, fieldName: string, fallback?: number): number | undefined {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new Error(`${fieldName} must be a positive number of seconds.`);
	}
	return value;
}

function requireResponsiveWaitLimit(value: number, fieldName: string): void {
	if (value <= MAX_FOREGROUND_WAIT_SECONDS) return;
	throw new Error(
		`${fieldName} cannot exceed ${MAX_FOREGROUND_WAIT_SECONDS} seconds. ` +
			"This limit keeps Pi responsive: long Bash work should return a background task id, " +
			`then be checked with bash_output instead of blocking the tool call for more than ${MAX_FOREGROUND_WAIT_SECONDS} seconds.`,
	);
}

function rejectLegacyTimeout(params: Record<string, unknown>, toolName: "bash" | "bash_output"): void {
	if (!("timeout" in params)) return;
	if (toolName === "bash") {
		throw new Error(
			"bash.timeout has been removed because it was ambiguous. Use background_after_seconds to control foreground responsiveness, or kill_after_seconds for an explicit hard kill deadline.",
		);
	}
	throw new Error(
		"bash_output.timeout has been removed because it was ambiguous. Use wait_seconds to control this polling wait; use kill_bash to stop the task.",
	);
}

function resolveBashTiming(params: { background_after_seconds?: number; kill_after_seconds?: number }): {
	backgroundAfterSeconds: number;
	killAfterSeconds: number | undefined;
} {
	const backgroundAfterSeconds =
		parsePositiveSeconds(params.background_after_seconds, "background_after_seconds", MAX_FOREGROUND_WAIT_SECONDS) ??
		MAX_FOREGROUND_WAIT_SECONDS;
	requireResponsiveWaitLimit(backgroundAfterSeconds, "background_after_seconds");

	const killAfterSeconds = parsePositiveSeconds(params.kill_after_seconds, "kill_after_seconds");
	if (killAfterSeconds !== undefined && killAfterSeconds > MAX_KILL_AFTER_SECONDS) {
		throw new Error(
			`kill_after_seconds cannot exceed ${MAX_KILL_AFTER_SECONDS} seconds because Node timers cannot safely represent a longer deadline. Use kill_bash later if the task still needs to be stopped.`,
		);
	}
	if (killAfterSeconds !== undefined && killAfterSeconds < backgroundAfterSeconds) {
		throw new Error("kill_after_seconds must be greater than or equal to background_after_seconds.");
	}
	return { backgroundAfterSeconds, killAfterSeconds };
}

function resolveBashOutputWaitSeconds(value: number | undefined): number {
	const waitSeconds =
		parsePositiveSeconds(value, "wait_seconds", MAX_FOREGROUND_WAIT_SECONDS) ?? MAX_FOREGROUND_WAIT_SECONDS;
	requireResponsiveWaitLimit(waitSeconds, "wait_seconds");
	return waitSeconds;
}

function clampBytes(value: number | undefined, min: number, max: number, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(value)));
}

function taskDetails(task: TaskRecord): BashTaskSnapshot {
	return bashTaskSnapshot(task);
}

function bashTaskSnapshot(task: TaskRecord): BashTaskSnapshot {
	const updatedAt = new Date().toISOString();
	return {
		taskId: task.taskId,
		status: task.status,
		exitCode: task.exitCode,
		reason: task.reason,
		description: task.description,
		command: task.command,
		cwd: task.cwd,
		outputPath: task.outputPath,
		startedAt: new Date(task.startedAt).toISOString(),
		startedAtMs: task.startedAt,
		updatedAt,
		updatedAtMs: Date.parse(updatedAt),
		killAfterMs: task.killAfterMs,
		hasOutput: true,
		hasResult: task.status !== "running",
		outputTail: snapshotTail(task, 12_000),
	};
}

function emitBashTaskUpdate(task: TaskRecord): void {
	const snapshot = bashTaskSnapshot(task);
	for (const listener of bashTaskSubscribers) listener(snapshot);
}

function publishAriaLocalBackgroundTask(pi: ExtensionAPI, snapshot: BashTaskSnapshot): void {
	pi.events?.emit?.("aria-local:background-task-update", {
		task: {
			task_id: snapshot.taskId,
			kind: "shell",
			label: snapshot.description,
			status: snapshot.status,
			started_at: snapshot.startedAt,
			updated_at: snapshot.updatedAt,
			started_at_ms: snapshot.startedAtMs,
			updated_at_ms: snapshot.updatedAtMs,
			expires_at_ms: snapshot.updatedAtMs + (snapshot.status === "running" ? 60 * 60 * 1000 : 60 * 1000),
			has_output: snapshot.hasOutput,
			has_result: snapshot.hasResult,
			exit_code: snapshot.exitCode,
			killed_reason: snapshot.reason,
			output_tail: snapshot.outputTail,
		},
	});
}

function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

function delay(ms: number): Promise<null> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(null), ms);
		timer.unref();
	});
}

export interface BashTaskStartOptions {
	command: string;
	cwd: string;
	backgroundAfterSeconds: number;
	killAfterSeconds?: number;
	description?: string;
}

export interface BashTaskReadOptions {
	taskId: string;
	block?: boolean;
	waitSeconds?: number;
	tailBytes?: number;
}

export interface BashTaskReadResult {
	task: TaskRecord;
	output: string;
}

export interface BashTaskManager {
	start(options: BashTaskStartOptions): Promise<TaskRecord>;
	get(taskId: string): TaskRecord | undefined;
	list(status?: string): TaskRecord[];
	readOutput(options: BashTaskReadOptions): Promise<BashTaskReadResult>;
	stop(taskId: string, reason?: string, waitMs?: number): Promise<TaskRecord>;
	subscribe(listener: BashTaskUpdateListener): () => void;
	pruneOldTaskDirs(): Promise<void>;
	shutdown(): Promise<void>;
}

export function createBashTaskManager(pi: ExtensionAPI): BashTaskManager {
	return {
		start(options) {
			return spawnTask(
				pi,
				options.command,
				options.cwd,
				options.backgroundAfterSeconds,
				options.killAfterSeconds,
				options.description,
			);
		},
		get(taskId) {
			return tasks.get(taskId);
		},
		list(status) {
			let allTasks = [...tasks.values()];
			if (status) allTasks = allTasks.filter((task) => task.status === status);
			allTasks.sort((a, b) => {
				if (a.status === "running" && b.status !== "running") return -1;
				if (a.status !== "running" && b.status === "running") return 1;
				return b.startedAt - a.startedAt;
			});
			return allTasks;
		},
		async readOutput(options) {
			const task = tasks.get(options.taskId);
			if (!task) {
				throw new Error(
					`Unknown background bash task id: ${options.taskId}. Use bash_tasks to list live tasks in this Pi process.`,
				);
			}
			if (options.block === true) task.notifyOnCompletion = false;
			if (options.block === true && task.status === "running") {
				await Promise.race([task.completion, delay(resolveBashOutputWaitSeconds(options.waitSeconds) * 1000)]);
			}
			const output = await readTail(task.outputPath, clampBytes(options.tailBytes, 1, 262_144, DEFAULT_TAIL_BYTES));
			return { task, output };
		},
		async stop(taskId, reason = "killed by kill_bash", waitMs = 3_000) {
			const task = tasks.get(taskId);
			if (!task) {
				throw new Error(
					`Unknown background bash task id: ${taskId}. Use bash_tasks to list live tasks in this Pi process.`,
				);
			}
			task.notifyOnCompletion = false;
			if (task.status === "running") {
				requestKill(pi, task, reason);
				await Promise.race([task.completion, delay(waitMs)]);
				emitBashTaskUpdate(task);
			}
			return task;
		},
		subscribe(listener) {
			bashTaskSubscribers.add(listener);
			return () => bashTaskSubscribers.delete(listener);
		},
		pruneOldTaskDirs,
		async shutdown() {
			for (const task of tasks.values()) {
				if (task.status === "running") {
					task.notifyOnCompletion = false;
					requestKill(pi, task, "Pi session shutdown");
				}
			}
			await Promise.race([Promise.allSettled([...tasks.values()].map((task) => task.completion)), delay(2_000)]);
			for (const task of tasks.values()) {
				if (task.status !== "running") {
					void rm(path.dirname(task.outputPath), { recursive: true, force: true });
				}
			}
		},
	};
}

export default function bashBackgrounding(pi: ExtensionAPI) {
	const manager = createBashTaskManager(pi);
	const unsubscribeAriaLocalUpdates = manager.subscribe((snapshot) => publishAriaLocalBackgroundTask(pi, snapshot));

	pi.registerTool({
		name: "bash",
		label: "bash",
		description:
			"Execute a bash command. Long-running commands auto-background after at most 1 minute and return a task id. Commands have no default kill deadline; use kill_after_seconds only when you intentionally want a hard deadline. Use bash_output to inspect progress, bash_tasks to discover live tasks, and kill_bash to stop a task.",
		promptSnippet: "Execute bash commands; long-running commands auto-background after at most 1 minute",
		promptGuidelines: [
			"Use bash for ordinary shell commands. If bash returns a task_id, Pi will send a follow-up session message when the task completes; use bash_output to inspect progress before then or kill_bash to stop it.",
			"Use background_after_seconds only to control foreground responsiveness; it does not kill the command and cannot exceed 60 seconds.",
			"Use kill_after_seconds only as an explicit hard kill deadline for commands known to hang. If omitted, no kill deadline is applied. Prefer kill_bash for intentional stops after a task id exists.",
			"Use bash_tasks to discover live background bash tasks if the original task_id is no longer in context. Bash task tracking is in-memory and scoped to the current Pi process/session.",
			"Use bash_output.wait_seconds only to control one polling call; it does not kill the task and cannot exceed 60 seconds.",
			"Avoid manually appending '&' for long-running commands; prefer letting bash auto-background so Pi can track output and status.",
			"Do not use nohup, disown, setsid, systemd-run, docker -d/--detach, or daemonizing shell patterns with bash; local Pi only has best-effort process-group tracking, not a sandbox/cgroup containment boundary.",
		],
		parameters: bashParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			rejectLegacyTimeout(params as Record<string, unknown>, "bash");
			if (containsUnsupportedDetach(params.command)) {
				throw new Error(
					"Unsupported shell detach pattern. Do not use nohup, disown, setsid, systemd-run, docker -d/--detach, or daemonizing commands with Pi bash; run the command normally and let bash return a tracked task_id.",
				);
			}
			const { backgroundAfterSeconds, killAfterSeconds } = resolveBashTiming(params);
			const task = await manager.start({
				command: params.command,
				cwd: ctx.cwd,
				backgroundAfterSeconds,
				killAfterSeconds,
				description: params.description,
			});
			const abort = () => {
				void manager.stop(task.taskId, "aborted by user", 0);
			};
			if (params.run_in_background === true) {
				task.notifyOnCompletion = true;
				return {
					content: [{ type: "text", text: backgroundText(task, false) }],
					details: { outputPath: task.outputPath },
				};
			}
			if (signal?.aborted) abort();
			signal?.addEventListener("abort", abort, { once: true });
			const updateInterval = setInterval(() => scheduleUpdate(onUpdate, task), 1_000);
			updateInterval.unref();
			try {
				const completion = await Promise.race([task.completion, delay(task.backgroundAfterMs)]);
				if (completion === null) {
					task.notifyOnCompletion = true;
					return {
						content: [{ type: "text", text: backgroundText(task, true) }],
						details: { outputPath: task.outputPath },
					};
				}
				const text = formatForeground(task, completion);
				if (completion.status === "failed" || completion.status === "killed") throw new Error(text);
				return { content: [{ type: "text", text }], details: { outputPath: task.outputPath } };
			} finally {
				clearInterval(updateInterval);
				signal?.removeEventListener("abort", abort);
			}
		},
	});

	pi.registerTool({
		name: "bash_output",
		label: "bash_output",
		description:
			"Read output and status for a background bash task. Set block=true to wait briefly for completion; wait_seconds controls only this polling wait and does not kill the task.",
		promptSnippet: "Read output/status for a background bash task",
		parameters: bashOutputParams,
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			rejectLegacyTimeout(params as Record<string, unknown>, "bash_output");
			const { task, output } = await manager.readOutput({
				taskId: params.task_id,
				block: params.block,
				waitSeconds: params.wait_seconds,
				tailBytes: params.tail_bytes,
			});
			return {
				content: [{ type: "text", text: [taskSummary(task), output.trimEnd()].filter(Boolean).join("\n\n") }],
				details: { ...taskDetails(task), outputPath: task.outputPath },
			};
		},
	});

	pi.registerTool({
		name: "bash_tasks",
		label: "bash_tasks",
		description:
			"List live background bash tasks tracked by this Pi process. Task tracking is in-memory; if Pi restarts, old task ids are no longer managed.",
		promptSnippet: "List live background bash tasks",
		parameters: bashTasksParams,
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			const allTasks = manager.list(params.status);
			const text =
				allTasks.length === 0
					? "No live background bash tasks tracked by this Pi process."
					: allTasks.map((task) => taskSummary(task)).join("\n\n---\n\n");
			return { content: [{ type: "text", text }], details: { tasks: allTasks.map(taskDetails) } };
		},
	});

	pi.registerTool({
		name: "kill_bash",
		label: "kill_bash",
		description: "Stop a running background bash task by task id.",
		promptSnippet: "Stop a running background bash task",
		parameters: killBashParams,
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			const reason = params.reason?.trim() || "killed by kill_bash";
			const task = await manager.stop(params.task_id, reason);
			return {
				content: [{ type: "text", text: `Task ${task.taskId} ${task.status}.\nreason: ${reason}` }],
				details: { ...taskDetails(task), outputPath: task.outputPath },
			};
		},
	});

	pi.on("session_start", () => {
		void manager.pruneOldTaskDirs();
		const active = new Set(pi.getActiveTools());
		if (active.has("bash")) {
			active.add("bash_output");
			active.add("bash_tasks");
			active.add("kill_bash");
			pi.setActiveTools([...active]);
		}
	});

	pi.on("session_shutdown", async () => {
		unsubscribeAriaLocalUpdates();
		await manager.shutdown();
	});
}
