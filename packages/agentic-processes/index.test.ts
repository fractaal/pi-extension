import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createExtensionApiMock, type ExtensionApiMock } from "../../tests/mock-extension-api.ts";
import { createBashTaskManager } from "./bash-backgrounding.ts";
import agenticProcessesExtension, { bashBackgroundingExtension, monitorExtension } from "./index.ts";
import { createMonitorManager } from "./monitor.ts";

type TextToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details?: unknown;
};

type EventBusMock = {
	emits: Array<{ name: string; data: unknown }>;
};

const tempRoots: string[] = [];

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	vi.restoreAllMocks();
});

async function tempCwd(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-agentic-processes-test-"));
	tempRoots.push(root);
	return root;
}

function installEventBus(apiMock: ExtensionApiMock): EventBusMock {
	const eventBus: EventBusMock = { emits: [] };
	Object.assign(apiMock.api, {
		events: {
			emit(name: string, data: unknown) {
				eventBus.emits.push({ name, data });
			},
			on() {
				return () => undefined;
			},
		},
	});
	return eventBus;
}

function ctx(cwd: string): ExtensionContext {
	return {
		cwd,
		hasUI: false,
	} as unknown as ExtensionContext;
}

function text(result: unknown): string {
	const toolResult = result as TextToolResult;
	return toolResult.content.map((part) => part.text).join("\n");
}

function taskIdFrom(result: unknown): string {
	const match = text(result).match(/task_id: (bash-[a-f0-9-]+)/);
	const taskId = match?.[1];
	if (!taskId) throw new Error(`No task_id in result:\n${text(result)}`);
	return taskId;
}

function monitorIdFrom(result: unknown): string {
	const match = text(result).match(/\(([a-f0-9]{8})\)/);
	const monitorId = match?.[1];
	if (!monitorId) throw new Error(`No monitor id in result:\n${text(result)}`);
	return monitorId;
}

describe("agentic processes extension", () => {
	it("registers the background bash and monitor tool surfaces", () => {
		const apiMock = createExtensionApiMock();
		agenticProcessesExtension(apiMock.api);

		expect([...apiMock.tools.keys()].sort()).toEqual(
			[
				"bash",
				"bash_output",
				"bash_tasks",
				"kill_bash",
				"monitor_list",
				"monitor_start",
				"monitor_status",
				"monitor_stop",
			].sort(),
		);
	});

	it("also exports the individual extension factories", () => {
		const bashMock = createExtensionApiMock();
		bashBackgroundingExtension(bashMock.api);
		expect([...bashMock.tools.keys()].sort()).toEqual(["bash", "bash_output", "bash_tasks", "kill_bash"].sort());

		const monitorMock = createExtensionApiMock();
		monitorExtension(monitorMock.api);
		expect([...monitorMock.tools.keys()].sort()).toEqual(
			["monitor_list", "monitor_start", "monitor_status", "monitor_stop"].sort(),
		);
	});

	it("runs a foreground bash command with the compatible output shape", async () => {
		const cwd = await tempCwd();
		const apiMock = createExtensionApiMock();
		installEventBus(apiMock);
		bashBackgroundingExtension(apiMock.api);
		const execute = apiMock.getTool("bash").execute;
		if (!execute) throw new Error("bash execute missing");

		const result = await execute("call-1", { command: "printf 'hello\\n'" }, undefined, undefined, ctx(cwd));

		expect(text(result)).toContain("Command completed");
		expect(text(result)).toContain("hello");
	});

	it("exposes a UI-independent bash task manager API", async () => {
		const cwd = await tempCwd();
		const apiMock = createExtensionApiMock();
		installEventBus(apiMock);
		const manager = createBashTaskManager(apiMock.api);
		const updates: string[] = [];
		const unsubscribe = manager.subscribe((snapshot) => updates.push(`${snapshot.taskId}:${snapshot.status}`));

		const task = await manager.start({
			command: "printf 'manager-ready\\n'; sleep 0.1; printf 'manager-done\\n'",
			cwd,
			backgroundAfterSeconds: 0.01,
		});
		expect(manager.get(task.taskId)?.taskId).toBe(task.taskId);
		expect(manager.list("running").some((item) => item.taskId === task.taskId)).toBe(true);

		const output = await manager.readOutput({ taskId: task.taskId, block: true, waitSeconds: 2, tailBytes: 4096 });
		expect(output.task.status).toBe("completed");
		expect(output.output).toContain("manager-ready");
		expect(output.output).toContain("manager-done");
		expect(updates.some((update) => update.endsWith(":running"))).toBe(true);
		expect(updates.some((update) => update.endsWith(":completed"))).toBe(true);
		unsubscribe();
	});

	it("keeps bash task state scoped to each manager instance", async () => {
		const cwd = await tempCwd();
		const apiMock = createExtensionApiMock();
		installEventBus(apiMock);
		const firstManager = createBashTaskManager(apiMock.api);
		const secondManager = createBashTaskManager(apiMock.api);

		const task = await firstManager.start({
			command: "printf 'scoped-running\\n'; sleep 30",
			cwd,
			backgroundAfterSeconds: 0.01,
		});
		expect(firstManager.list("running").map((item) => item.taskId)).toContain(task.taskId);
		expect(secondManager.list("running").map((item) => item.taskId)).not.toContain(task.taskId);
		await expect(secondManager.stop(task.taskId, "wrong manager", 0)).rejects.toThrow(
			"Unknown background bash task id",
		);
		await firstManager.stop(task.taskId, "scoped manager cleanup");
	});

	it("supports background bash start, list, output, completion, and kill flows", async () => {
		const cwd = await tempCwd();
		const apiMock = createExtensionApiMock();
		const events = installEventBus(apiMock);
		bashBackgroundingExtension(apiMock.api);
		const bash = apiMock.getTool("bash").execute;
		const bashOutput = apiMock.getTool("bash_output").execute;
		const bashTasks = apiMock.getTool("bash_tasks").execute;
		const killBash = apiMock.getTool("kill_bash").execute;
		if (!bash || !bashOutput || !bashTasks || !killBash) throw new Error("bash tools missing");

		const completedStart = await bash(
			"call-bg-complete",
			{ command: "printf 'start\\n'; sleep 0.1; printf 'done\\n'", background_after_seconds: 0.01 },
			undefined,
			undefined,
			ctx(cwd),
		);
		const completedTaskId = taskIdFrom(completedStart);
		const completedOutput = await bashOutput(
			"call-output-complete",
			{ task_id: completedTaskId, block: true, wait_seconds: 2, tail_bytes: 4096 },
			undefined,
			undefined,
			ctx(cwd),
		);
		expect(text(completedOutput)).toContain("status: completed");
		expect(text(completedOutput)).toContain("start");
		expect(text(completedOutput)).toContain("done");

		const runningStart = await bash(
			"call-bg-running",
			{ command: "printf 'running\\n'; sleep 30", run_in_background: true },
			undefined,
			undefined,
			ctx(cwd),
		);
		const runningTaskId = taskIdFrom(runningStart);
		const tasks = await bashTasks("call-tasks", { status: "running" }, undefined, undefined, ctx(cwd));
		expect(text(tasks)).toContain(runningTaskId);
		const killed = await killBash(
			"call-kill",
			{ task_id: runningTaskId, reason: "test cleanup" },
			undefined,
			undefined,
			ctx(cwd),
		);
		expect(text(killed)).toContain(`Task ${runningTaskId}`);
		expect(events.emits.some((event) => event.name === "aria-local:background-task-update")).toBe(true);
	});

	it("exposes a UI-independent monitor manager API", async () => {
		const cwd = await tempCwd();
		const apiMock = createExtensionApiMock();
		const manager = createMonitorManager(apiMock.api);
		const updates: string[] = [];
		const unsubscribe = manager.subscribe((snapshot) => updates.push(`${snapshot.id}:${snapshot.liveTaskStatus}`));

		const started = await manager.start(
			{ command: "printf 'MANAGER_READY\\n'; sleep 30", inject: false, name: "manager-monitor" },
			cwd,
		);
		const monitorId = monitorIdFrom(started);
		await new Promise((resolve) => setTimeout(resolve, 100));
		const status = await manager.status({ id: monitorId, tail: 20 });
		expect(text(status)).toContain("MANAGER_READY");
		const listed = await manager.list();
		expect(text(listed)).toContain(monitorId);
		const stopped = await manager.stop({ id: monitorId });
		expect(text(stopped)).toContain(`Sent SIGTERM to monitor manager-monitor (${monitorId}).`);
		expect(updates.some((update) => update.endsWith(":running"))).toBe(true);
		expect(updates.length).toBeGreaterThanOrEqual(2);
		unsubscribe();
	});

	it("supports monitor start, status, list, log tail, and stop flows", async () => {
		const cwd = await tempCwd();
		const apiMock = createExtensionApiMock();
		const events = installEventBus(apiMock);
		monitorExtension(apiMock.api);
		const monitorStart = apiMock.getTool("monitor_start").execute;
		const monitorStatus = apiMock.getTool("monitor_status").execute;
		const monitorList = apiMock.getTool("monitor_list").execute;
		const monitorStop = apiMock.getTool("monitor_stop").execute;
		if (!monitorStart || !monitorStatus || !monitorList || !monitorStop) throw new Error("monitor tools missing");

		const started = await monitorStart(
			"call-monitor-start",
			{ command: "printf 'READY\\n'; sleep 30", inject: false, name: "ready-test" },
			undefined,
			undefined,
			ctx(cwd),
		);
		const monitorId = monitorIdFrom(started);
		await new Promise((resolve) => setTimeout(resolve, 100));

		const status = await monitorStatus(
			"call-monitor-status",
			{ id: monitorId, tail: 20 },
			undefined,
			undefined,
			ctx(cwd),
		);
		expect(text(status)).toContain("READY");
		expect(text(status)).toContain("statusTailGuardrail");
		const listed = await monitorList("call-monitor-list", {}, undefined, undefined, ctx(cwd));
		expect(text(listed)).toContain(monitorId);
		const stopped = await monitorStop("call-monitor-stop", { id: monitorId }, undefined, undefined, ctx(cwd));
		expect(text(stopped)).toContain(`Sent SIGTERM to monitor ready-test (${monitorId}).`);
		expect(events.emits.some((event) => event.name === "aria-local:monitor-update")).toBe(true);
	});
});
