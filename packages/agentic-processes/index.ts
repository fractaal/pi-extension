import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import bashBackgroundingExtension from "./bash-backgrounding.ts";
import monitorExtension from "./monitor.ts";

export type {
	BashTaskManager,
	BashTaskSnapshot,
	BashTaskStatus,
	BashTaskUpdateListener,
} from "./bash-backgrounding.ts";
export { createBashTaskManager, default as bashBackgroundingExtension } from "./bash-backgrounding.ts";
export type { MonitorManager, MonitorSnapshot, MonitorUpdateListener } from "./monitor.ts";
export { createMonitorManager, default as monitorExtension } from "./monitor.ts";

export default function agenticProcessesExtension(pi: ExtensionAPI): void {
	bashBackgroundingExtension(pi);
	monitorExtension(pi);
}
