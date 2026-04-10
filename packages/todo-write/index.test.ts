import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	applyTodoWrite,
	buildPostCompactionTodoReminder,
	getTodoWidgetVisibility,
	renderTodoWidgetLines,
	renderTodoWriteSummary,
	restoreTodoWriteState,
} from "./index.ts";

describe("todo-write helpers", () => {
	it("normalizes multiple in-progress tasks", () => {
		const applied = applyTodoWrite([
			{ content: "first", status: "in_progress" },
			{ content: "second", status: "in_progress" },
			{ content: "third", status: "pending" },
		]);

		expect(applied.state.tasks.map((task) => task.status)).toEqual(["in_progress", "pending", "pending"]);
	});

	it("renders widget lines and summary", () => {
		const applied = applyTodoWrite([
			{ content: "설계", status: "completed" },
			{ content: "구현", status: "in_progress", activeForm: "구현 중" },
			{ content: "검증", status: "pending" },
		]);

		expect(renderTodoWidgetLines(applied.state)).toEqual(["~~● 설계", "→ 구현 중", "○ 검증"]);
		expect(renderTodoWriteSummary(applied.state)).toContain("Progress: 1/3 tasks complete");
	});

	it("hides fully completed widgets after the grace period", () => {
		const applied = applyTodoWrite([{ content: "완료", status: "completed" }]);
		const now = Date.now();
		expect(getTodoWidgetVisibility(applied.state, { completedAt: now, completedTurn: 1 }, 1, now)).toMatchObject({
			hidden: false,
			completionGraceActive: true,
		});
		expect(
			getTodoWidgetVisibility(applied.state, { completedAt: now - 91_000, completedTurn: 1 }, 3, now),
		).toMatchObject({ hidden: true, completionGraceActive: false });
	});

	it("restores legacy persisted tasks and builds post-compaction reminders", () => {
		const ctx = {
			cwd: "/tmp/project",
			sessionManager: {
				getSessionFile: () => "/tmp/project/session.json",
				getBranch: () => [
					{
						type: "custom",
						customType: "todo-write-state",
						data: {
							tasks: [
								{ id: "task-1", content: "cleanup", status: "abandoned" },
								{ id: "task-2", content: "ship", status: "pending" },
							],
							updatedAt: Date.now(),
						},
					},
				],
			},
		} as unknown as ExtensionContext;

		const restored = restoreTodoWriteState(ctx);
		expect(restored.tasks.map((task) => task.status)).toEqual(["completed", "in_progress"]);
		expect(buildPostCompactionTodoReminder(restored)).toContain("todo_write still has remaining items");
	});
});
