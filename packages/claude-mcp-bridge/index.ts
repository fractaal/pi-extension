import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { matchesKey, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Type } from "@sinclair/typebox";

export type RawMcpServer = {
	type?: string;
	enabled?: boolean;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
};

export type NormalizedMcpServer =
	| {
			name: string;
			type: "stdio";
			enabled: boolean;
			command: string;
			args: string[];
			env: Record<string, string>;
			cwd?: string;
	  }
	| {
			name: string;
			type: "sse" | "http";
			enabled: boolean;
			url: string;
			headers: Record<string, string>;
	  };

export type DiscoveredTool = {
	name: string;
	description?: string;
	inputSchema: Record<string, unknown>;
};

export type ServerStatus = "connecting" | "connected" | "disconnected" | "error";
export type McpBridgeConfigShape = "mcpServers" | "mcp.servers" | "servers";
export type McpBridgeLogLevel = "debug" | "info" | "warning" | "error";

export type McpBridgeLogEntry = {
	timestamp: string;
	level: McpBridgeLogLevel;
	message: string;
	serverName?: string;
	toolName?: string;
};

export type McpBridgeRuntimeTool = DiscoveredTool & {
	piToolName: string;
	disabled: boolean;
};

export type McpBridgeRuntimeServer = {
	name: string;
	type: NormalizedMcpServer["type"];
	status: ServerStatus;
	toolCount: number;
	tools: McpBridgeRuntimeTool[];
	error?: string;
};

export type McpBridgeRuntimeSnapshot = {
	loadedSourcePath: string | null;
	servers: McpBridgeRuntimeServer[];
	warnings: string[];
	logs: McpBridgeLogEntry[];
};

export type McpBridgeLogSink = (entry: McpBridgeLogEntry) => void;

export const MCP_BRIDGE_REDACTED_VALUE = "••••••";

class McpConnection {
	private static readonly MAX_RECONNECT_ATTEMPTS = 5;
	private static readonly INITIAL_RECONNECT_DELAY_MS = 2_000;
	private static readonly MAX_RECONNECT_DELAY_MS = 30_000;

	private client: Client | null = null;
	private transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport | null = null;

	/** When true, suppress onclose/onerror side-effects (e.g. during intentional disconnect or cleanup). */
	private intentionalDisconnect = false;
	private reconnectAttempts = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	/** Deduplicates concurrent connect() calls. */
	private connectingPromise: Promise<void> | null = null;
	/** Invalidates stale in-flight connection attempts after disconnect/reconnect. */
	private connectionGeneration = 0;
	/** Identifies the client/transport currently stored on this instance. */
	private activeConnectionGeneration = 0;

	public status: ServerStatus = "disconnected";
	public error?: string;
	public tools: DiscoveredTool[] = [];

	constructor(
		public readonly server: NormalizedMcpServer,
		private readonly log?: McpBridgeLogSink,
	) {}

	private logEvent(level: McpBridgeLogLevel, message: string, toolName?: string): void {
		this.log?.({ timestamp: new Date().toISOString(), level, serverName: this.server.name, toolName, message });
	}

	// ── public API ────────────────────────────────────────────

	async connect(): Promise<void> {
		// Deduplicate concurrent connect() invocations.
		if (this.connectingPromise) return this.connectingPromise;
		const generation = ++this.connectionGeneration;
		const promise = this._doConnect(generation);
		this.connectingPromise = promise;
		try {
			await promise;
		} finally {
			if (this.connectingPromise === promise) {
				this.connectingPromise = null;
			}
		}
	}

	async disconnect(): Promise<void> {
		this.intentionalDisconnect = true;
		this.connectionGeneration++;
		this.connectingPromise = null;
		this.clearReconnectTimer();
		await this.cleanupConnection();

		if (this.status !== "error") {
			this.status = "disconnected";
			this.error = undefined;
		}
		this.tools = [];
	}

	async refreshTools(): Promise<void> {
		if (!this.client) return;
		try {
			const result = await this.client.listTools();
			this.tools = result.tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
			}));
		} catch {
			this.tools = [];
		}
	}

	/**
	 * Ensure the connection is alive before calling a tool.
	 * If disconnected / errored, attempt a fresh reconnect.
	 */
	async ensureConnected(): Promise<void> {
		if (this.status === "connected" && this.client) return;

		// If a connect() is already in flight, piggy-back on it.
		if (this.connectingPromise) {
			await this.connectingPromise;
			if (this.status === "connected" && this.client) return;
		}

		// Cancel any pending scheduled reconnect and try immediately.
		this.clearReconnectTimer();
		this.reconnectAttempts = 0;
		await this.connect();
	}

	async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
		if (!this.client || this.status !== "connected") {
			await this.ensureConnected();
		}
		if (!this.client || this.status !== "connected") {
			throw new Error(`MCP server '${this.server.name}' is not connected (status: ${this.status})`);
		}
		return this.client.callTool({ name: toolName, arguments: args });
	}

	// ── internals ─────────────────────────────────────────────

	private isStaleConnection(generation: number): boolean {
		return generation !== this.connectionGeneration || this.intentionalDisconnect;
	}

	private async _doConnect(generation: number): Promise<void> {
		this.clearReconnectTimer();

		// Guard: prevent the onclose handler of the *old* client from firing
		// a spurious reconnect while we tear it down.
		this.intentionalDisconnect = true;
		await this.cleanupConnection();
		if (generation !== this.connectionGeneration) return;
		this.intentionalDisconnect = false;

		this.status = "connecting";
		this.error = undefined;
		this.tools = [];
		this.logEvent("info", `Connecting MCP server '${this.server.name}'`);

		try {
			const client = new Client({ name: "pi-claude-mcp-bridge", version: "0.1.0" }, { capabilities: {} });
			let transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport;

			if (this.server.type === "stdio") {
				transport = new StdioClientTransport({
					command: this.server.command,
					args: this.server.args,
					env: this.server.env,
					cwd: this.server.cwd,
					// Suppress noisy MCP server bootstrap logs on stderr by default.
					// Set PI_MCP_STDERR=inherit when debugging MCP connection issues.
					stderr: process.env.PI_MCP_STDERR === "inherit" ? "inherit" : "ignore",
				});
			} else if (this.server.type === "sse") {
				const sseHeaders = this.server.headers;
				transport = new SSEClientTransport(new URL(this.server.url), {
					// EventSourceInit does not support a headers property directly.
					// Inject custom headers into the SSE stream via a fetch wrapper.
					eventSourceInit:
						Object.keys(sseHeaders).length > 0
							? {
									fetch: (url, init) =>
										fetch(url, {
											...init,
											headers: { ...init.headers, ...sseHeaders },
										}),
								}
							: undefined,
					requestInit: { headers: sseHeaders },
				});
			} else {
				transport = new StreamableHTTPClientTransport(new URL(this.server.url), {
					requestInit: { headers: this.server.headers },
				});
			}

			this.client = client;
			this.transport = transport;
			this.activeConnectionGeneration = generation;

			await client.connect(transport);
			if (this.isStaleConnection(generation)) {
				await this.cleanupConnection(generation);
				return;
			}

			// ── Detect unexpected disconnection & auto-reconnect ──
			client.onclose = () => {
				if (this.intentionalDisconnect || generation !== this.connectionGeneration) return;
				this.status = "disconnected";
				this.client = null;
				this.transport = null;
				this.activeConnectionGeneration = 0;
				this.logEvent("warning", `MCP server '${this.server.name}' disconnected unexpectedly; scheduling reconnect`);
				this.scheduleReconnect();
			};

			client.onerror = (error: Error) => {
				if (this.intentionalDisconnect || generation !== this.connectionGeneration) return;
				const msg = error instanceof Error ? error.message : String(error);
				if (msg.includes("unknown message ID")) return; // harmless race; ignore
				this.error = msg;
				this.logEvent("warning", `MCP server '${this.server.name}' reported an error: ${msg}`);
			};

			const result = await client.listTools();
			if (this.isStaleConnection(generation)) {
				await this.cleanupConnection(generation);
				return;
			}
			this.tools = result.tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
			}));
			this.status = "connected";
			this.reconnectAttempts = 0;
			this.logEvent("info", `Connected MCP server '${this.server.name}' with ${this.tools.length} tool(s)`);
		} catch (error) {
			if (this.isStaleConnection(generation)) {
				await this.cleanupConnection(generation);
				return;
			}

			const message = error instanceof Error ? error.message : String(error);
			// Clean up the half-initialised connection (guard the onclose handler).
			this.intentionalDisconnect = true;
			await this.cleanupConnection(generation);
			this.intentionalDisconnect = false;
			if (generation !== this.connectionGeneration) return;

			this.status = "error";
			this.error = message;
			this.logEvent("error", `MCP server '${this.server.name}' connection failed: ${message}`);
		}
	}

	private async cleanupConnection(generation?: number): Promise<void> {
		if (generation !== undefined && this.activeConnectionGeneration !== generation) return;

		if (this.client) {
			try {
				await this.client.close();
			} catch {
				/* ignore */
			}
			this.client = null;
		}
		if (this.transport) {
			try {
				await this.transport.close();
			} catch {
				/* ignore */
			}
			this.transport = null;
		}
		this.activeConnectionGeneration = 0;
	}

	private clearReconnectTimer(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}

	/**
	 * Schedule a reconnection attempt with exponential back-off.
	 * Called automatically when an unexpected transport close is detected.
	 */
	private scheduleReconnect(): void {
		this.clearReconnectTimer();

		if (this.reconnectAttempts >= McpConnection.MAX_RECONNECT_ATTEMPTS) {
			this.status = "error";
			this.error = `Reconnection failed after ${McpConnection.MAX_RECONNECT_ATTEMPTS} attempts for '${this.server.name}'`;
			this.logEvent("error", this.error);
			return;
		}

		const delay = Math.min(
			McpConnection.INITIAL_RECONNECT_DELAY_MS * 2 ** this.reconnectAttempts,
			McpConnection.MAX_RECONNECT_DELAY_MS,
		);
		this.reconnectAttempts++;
		this.status = "connecting";

		this.reconnectTimer = setTimeout(async () => {
			await this.connect();
			// If still not connected (connect() swallows its own errors), keep trying.
			if (this.status !== "connected" && !this.intentionalDisconnect) {
				this.scheduleReconnect();
			}
		}, delay);
	}
}

export class McpManager {
	private connections = new Map<string, McpConnection>();
	public sourcePath: string | null = null;

	constructor(private readonly log?: McpBridgeLogSink) {}

	setServers(servers: NormalizedMcpServer[], sourcePath: string | null): void {
		this.connections.clear();
		for (const server of servers) {
			this.connections.set(server.name, new McpConnection(server, this.log));
		}
		this.sourcePath = sourcePath;
		this.log?.({
			timestamp: new Date().toISOString(),
			level: "info",
			message: `Loaded ${servers.length} MCP server config(s)`,
		});
	}

	async replaceServers(servers: NormalizedMcpServer[], sourcePath: string | null): Promise<void> {
		await this.disconnectAll();
		this.setServers(servers, sourcePath);
	}

	async connectAll(onAfterConnection?: () => void): Promise<void> {
		const tasks = Array.from(this.connections.values()).map(async (conn) => {
			if (!conn.server.enabled) return;
			await conn.connect();
			onAfterConnection?.();
		});
		await Promise.all(tasks);
	}

	async disconnectAll(): Promise<void> {
		for (const conn of this.connections.values()) {
			await conn.disconnect();
		}
	}

	getStates(): Array<{
		name: string;
		status: ServerStatus;
		type: NormalizedMcpServer["type"];
		toolCount: number;
		error?: string;
	}> {
		return Array.from(this.connections.values()).map((conn) => ({
			name: conn.server.name,
			status: conn.status,
			type: conn.server.type,
			toolCount: conn.tools.length,
			error: conn.error,
		}));
	}

	getAllTools(): Array<{ serverName: string; tool: DiscoveredTool }> {
		const tools: Array<{ serverName: string; tool: DiscoveredTool }> = [];
		for (const conn of this.connections.values()) {
			if (conn.status !== "connected") continue;
			for (const tool of conn.tools) {
				tools.push({ serverName: conn.server.name, tool });
			}
		}
		return tools;
	}

	getSnapshot(
		disabledToolKeys: Set<string>,
		logs: McpBridgeLogEntry[],
		warnings: string[] = [],
	): McpBridgeRuntimeSnapshot {
		return {
			loadedSourcePath: this.sourcePath,
			warnings,
			logs: [...logs],
			servers: Array.from(this.connections.values()).map((conn) => ({
				name: conn.server.name,
				type: conn.server.type,
				status: conn.status,
				toolCount: conn.tools.length,
				error: conn.error,
				tools: conn.tools.map((tool) => ({
					...tool,
					piToolName: buildPiToolName(conn.server.name, tool.name),
					disabled: disabledToolKeys.has(buildToolVisibilityKey(conn.server.name, tool.name)),
				})),
			})),
		};
	}

	async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
		const conn = this.connections.get(serverName);
		if (!conn) {
			throw new Error(`MCP server '${serverName}' not found`);
		}
		this.log?.({
			timestamp: new Date().toISOString(),
			level: "info",
			serverName,
			toolName,
			message: `Calling MCP tool ${serverName}/${toolName}`,
		});
		try {
			const result = await conn.callTool(toolName, args);
			this.log?.({
				timestamp: new Date().toISOString(),
				level: "info",
				serverName,
				toolName,
				message: `MCP tool ${serverName}/${toolName} completed`,
			});
			return result;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.log?.({
				timestamp: new Date().toISOString(),
				level: "error",
				serverName,
				toolName,
				message: `MCP tool ${serverName}/${toolName} failed: ${message}`,
			});
			throw error;
		}
	}

	async reconnectServer(name: string): Promise<void> {
		const conn = this.connections.get(name);
		if (!conn) return;
		await conn.disconnect();
		await conn.connect();
	}

	getServerTools(name: string): DiscoveredTool[] {
		const conn = this.connections.get(name);
		if (!conn) return [];
		return [...conn.tools];
	}
}

type LoadedConfig = {
	sourcePath: string | null;
	servers: NormalizedMcpServer[];
	warnings: string[];
};

export type McpBridgeConfigSource = {
	path: string;
	exists: boolean;
	writable: boolean;
	shape: McpBridgeConfigShape | null;
	serverNames: string[];
	warnings: string[];
};

export type McpBridgeConfiguredServer = {
	name: string;
	sourcePath: string;
	sourceShape: McpBridgeConfigShape;
	duplicate: boolean;
	valid: boolean;
	redacted: RawMcpServer;
	normalizedType: NormalizedMcpServer["type"] | null;
	warning?: string;
};

export type McpBridgeConfigState = {
	defaultWritePath: string;
	explicitPath: string | null;
	sources: McpBridgeConfigSource[];
	servers: McpBridgeConfiguredServer[];
	warnings: string[];
};

export type McpBridgeConfigOptions = {
	env?: NodeJS.ProcessEnv;
	homeDir?: string;
	explicitConfigPath?: string | null;
	defaultWritePath?: string;
	candidatePaths?: string[];
};

export type UpsertMcpServerConfigInput = {
	cwd: string;
	name: string;
	server: RawMcpServer;
	configPath?: string;
	shape?: McpBridgeConfigShape;
	options?: McpBridgeConfigOptions;
};

export type RemoveMcpServerConfigInput = {
	cwd: string;
	name: string;
	configPath: string;
	options?: McpBridgeConfigOptions;
};

type ToolVisibilitySettingsFile = {
	disabledTools?: Record<string, string[]> | string[];
};

type LoadedToolVisibilitySettings = {
	disabledToolKeys: Set<string>;
	warning?: string;
};

const TOOL_VISIBILITY_SETTINGS_PATH = path.join(os.homedir(), ".pi", "agent", "claude-mcp-bridge-tools.json");
export const TOOL_VISIBILITY_KEY_SEPARATOR = "\u001f";

export function buildToolVisibilityKey(serverName: string, toolName: string): string {
	return `${serverName}${TOOL_VISIBILITY_KEY_SEPARATOR}${toolName}`;
}

export function parseToolVisibilityKey(key: string): { serverName: string; toolName: string } | null {
	const separatorIndex = key.indexOf(TOOL_VISIBILITY_KEY_SEPARATOR);
	if (separatorIndex <= 0 || separatorIndex >= key.length - 1) return null;

	const serverName = key.slice(0, separatorIndex).trim();
	const toolName = key.slice(separatorIndex + TOOL_VISIBILITY_KEY_SEPARATOR.length).trim();
	if (!serverName || !toolName) return null;

	return { serverName, toolName };
}

function addDisabledToolKey(result: Set<string>, serverNameRaw: string, toolNameRaw: string): void {
	const serverName = serverNameRaw.trim();
	const toolName = toolNameRaw.trim();
	if (!serverName || !toolName) return;
	result.add(buildToolVisibilityKey(serverName, toolName));
}

function parseDisabledToolList(value: string[]): Set<string> {
	const result = new Set<string>();
	for (const item of value) {
		if (typeof item !== "string") continue;
		const separatorIndex = item.indexOf("/");
		if (separatorIndex <= 0 || separatorIndex >= item.length - 1) continue;
		addDisabledToolKey(result, item.slice(0, separatorIndex), item.slice(separatorIndex + 1));
	}
	return result;
}

function parseDisabledToolMap(value: Record<string, unknown>): Set<string> {
	const result = new Set<string>();
	for (const [serverNameRaw, tools] of Object.entries(value)) {
		if (!Array.isArray(tools)) continue;
		for (const toolNameRaw of tools) {
			if (typeof toolNameRaw !== "string") continue;
			addDisabledToolKey(result, serverNameRaw, toolNameRaw);
		}
	}
	return result;
}

export function parseDisabledToolKeys(value: unknown): Set<string> {
	if (!value) return new Set<string>();
	if (Array.isArray(value)) return parseDisabledToolList(value);
	if (typeof value !== "object") return new Set<string>();
	return parseDisabledToolMap(value as Record<string, unknown>);
}

function loadToolVisibilitySettings(
	settingsPath: string = TOOL_VISIBILITY_SETTINGS_PATH,
): LoadedToolVisibilitySettings {
	if (!fs.existsSync(settingsPath)) {
		return { disabledToolKeys: new Set<string>() };
	}

	try {
		const raw = fs.readFileSync(settingsPath, "utf-8");
		const parsed = JSON.parse(raw) as ToolVisibilitySettingsFile;
		if (!parsed || typeof parsed !== "object") {
			return {
				disabledToolKeys: new Set<string>(),
				warning: `Invalid tool visibility settings format: ${settingsPath}`,
			};
		}
		return { disabledToolKeys: parseDisabledToolKeys(parsed.disabledTools) };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			disabledToolKeys: new Set<string>(),
			warning: `Failed to load tool visibility settings (${settingsPath}): ${message}`,
		};
	}
}

export function serializeToolVisibilitySettings(disabledToolKeys: Set<string>): ToolVisibilitySettingsFile {
	const grouped = new Map<string, string[]>();

	for (const key of disabledToolKeys) {
		const parsed = parseToolVisibilityKey(key);
		if (!parsed) continue;

		const tools = grouped.get(parsed.serverName) ?? [];
		tools.push(parsed.toolName);
		grouped.set(parsed.serverName, tools);
	}

	const disabledTools: Record<string, string[]> = {};
	const sortedServers = Array.from(grouped.keys()).sort((a, b) => a.localeCompare(b));
	for (const serverName of sortedServers) {
		const tools = grouped.get(serverName) ?? [];
		const dedupedTools = Array.from(new Set(tools)).sort((a, b) => a.localeCompare(b));
		if (dedupedTools.length > 0) {
			disabledTools[serverName] = dedupedTools;
		}
	}

	return { disabledTools };
}

function saveToolVisibilitySettings(
	disabledToolKeys: Set<string>,
	settingsPath: string = TOOL_VISIBILITY_SETTINGS_PATH,
): { ok: true } | { ok: false; error: string } {
	try {
		fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
		const payload = serializeToolVisibilitySettings(disabledToolKeys);
		fs.writeFileSync(settingsPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
		return { ok: true };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, error: message };
	}
}

function hasNewlyDisabledTools(before: Set<string>, after: Set<string>): boolean {
	for (const key of after) {
		if (!before.has(key)) return true;
	}
	return false;
}

export function expandEnvVars(value: string): string {
	return value.replace(/\$\{([^}]+)\}/g, (_, key: string) => process.env[key] ?? "");
}

function expandRecord(input?: Record<string, string>): Record<string, string> {
	const output: Record<string, string> = {};
	if (!input) return output;
	for (const [k, v] of Object.entries(input)) {
		output[k] = expandEnvVars(v);
	}
	return output;
}

function safeReadJson(filePath: string): unknown | null {
	if (!fs.existsSync(filePath)) return null;
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

function readJsonWithError(filePath: string): { ok: true; data: unknown } | { ok: false; error: string } {
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		return { ok: true, data: JSON.parse(raw) };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, error: message };
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function serverContainer(data: unknown): { shape: McpBridgeConfigShape; servers: Record<string, RawMcpServer> } | null {
	if (!isRecord(data)) return null;

	if (data.mcpServers && typeof data.mcpServers === "object" && !Array.isArray(data.mcpServers)) {
		return { shape: "mcpServers", servers: data.mcpServers as Record<string, RawMcpServer> };
	}

	const mcp = data.mcp;
	if (isRecord(mcp) && mcp.servers && typeof mcp.servers === "object" && !Array.isArray(mcp.servers)) {
		return { shape: "mcp.servers", servers: mcp.servers as Record<string, RawMcpServer> };
	}

	if (data.servers && typeof data.servers === "object" && !Array.isArray(data.servers)) {
		return { shape: "servers", servers: data.servers as Record<string, RawMcpServer> };
	}

	return null;
}

export function extractRawServers(data: unknown): Record<string, RawMcpServer> | null {
	return serverContainer(data)?.servers ?? null;
}

function redactRecord(record?: Record<string, string>): Record<string, string> | undefined {
	if (!record) return undefined;
	const output: Record<string, string> = {};
	for (const key of Object.keys(record).sort((a, b) => a.localeCompare(b))) {
		output[key] = MCP_BRIDGE_REDACTED_VALUE;
	}
	return output;
}

export function redactMcpServer(raw: RawMcpServer): RawMcpServer {
	return {
		...raw,
		args: raw.args ? [...raw.args] : undefined,
		env: redactRecord(raw.env),
		headers: redactRecord(raw.headers),
	};
}

function mergeRedactedRecord(
	input?: Record<string, string>,
	existing?: Record<string, string>,
): Record<string, string> | undefined {
	if (!input) return undefined;
	const output: Record<string, string> = {};
	for (const [key, value] of Object.entries(input)) {
		output[key] =
			value === MCP_BRIDGE_REDACTED_VALUE && existing && Object.hasOwn(existing, key) ? existing[key] : value;
	}
	return output;
}

function preserveRedactedServer(input: RawMcpServer, existing?: RawMcpServer): RawMcpServer {
	return {
		...input,
		args: input.args ? [...input.args] : undefined,
		env: mergeRedactedRecord(input.env, existing?.env),
		headers: mergeRedactedRecord(input.headers, existing?.headers),
	};
}

function defaultWritePath(homeDir = os.homedir()): string {
	return path.join(homeDir, ".mcp.json");
}

function isWritablePath(filePath: string): boolean {
	try {
		if (fs.existsSync(filePath)) {
			fs.accessSync(filePath, fs.constants.W_OK);
			return true;
		}
		const parent = path.dirname(filePath);
		fs.accessSync(parent, fs.constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

export function normalizeServer(name: string, raw: RawMcpServer): NormalizedMcpServer | null {
	if (raw.enabled === false) return null;
	const type = raw.type?.toLowerCase();

	if (raw.command || type === "stdio") {
		if (!raw.command) return null;

		const envFromProcess: Record<string, string> = {};
		for (const [k, v] of Object.entries(process.env)) {
			if (typeof v === "string") envFromProcess[k] = v;
		}

		return {
			name,
			type: "stdio",
			enabled: true,
			command: expandEnvVars(raw.command),
			args: (raw.args ?? []).map(expandEnvVars),
			env: { ...envFromProcess, ...expandRecord(raw.env) },
			cwd: raw.cwd ? expandEnvVars(raw.cwd) : undefined,
		};
	}

	if (raw.url) {
		const expandedUrl = expandEnvVars(raw.url);
		const headers = expandRecord(raw.headers);
		const inferred =
			type === "sse" ? "sse" : type === "http" ? "http" : /\/sse(?:\/)?(?:\?|$)/i.test(expandedUrl) ? "sse" : "http";

		return {
			name,
			type: inferred,
			enabled: true,
			url: expandedUrl,
			headers,
		};
	}

	return null;
}

export function collectMcpConfigCandidates(cwd: string, options: McpBridgeConfigOptions = {}): string[] {
	const explicitPath = options.explicitConfigPath ?? options.env?.PI_MCP_CONFIG;
	if (explicitPath) return [path.resolve(expandEnvVars(explicitPath))];
	if (options.candidatePaths) return options.candidatePaths.map((candidate) => path.resolve(candidate));

	const candidates: string[] = [];
	const seen = new Set<string>();

	const push = (candidate: string): void => {
		const resolved = path.resolve(candidate);
		if (seen.has(resolved)) return;
		seen.add(resolved);
		candidates.push(resolved);
	};

	let current = path.resolve(cwd);
	const home = path.resolve(options.homeDir ?? os.homedir());
	const root = path.parse(current).root;

	while (true) {
		push(path.join(current, ".pi", "mcp.json"));
		push(path.join(current, ".mcp.json"));
		push(path.join(current, "backend", ".mcp.json"));
		push(path.join(current, "frontend", ".mcp.json"));

		if (current === home || current === root) break;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}

	push(path.join(home, ".mcp.json"));
	push(path.join(home, ".claude.json"));

	return candidates;
}

export function loadMcpBridgeConfigState(cwd: string, options: McpBridgeConfigOptions = {}): McpBridgeConfigState {
	const homeDir = options.homeDir ?? os.homedir();
	const explicitPath = options.explicitConfigPath ?? options.env?.PI_MCP_CONFIG ?? null;
	const defaultPath = path.resolve(options.defaultWritePath ?? defaultWritePath(homeDir));
	const candidates = collectMcpConfigCandidates(cwd, { ...options, homeDir });
	const warnings: string[] = [];
	const sources: McpBridgeConfigSource[] = [];
	const servers: McpBridgeConfiguredServer[] = [];
	const seenServers = new Set<string>();

	for (const candidate of candidates) {
		const exists = fs.existsSync(candidate);
		if (!exists) continue;

		const sourceWarnings: string[] = [];
		let shape: McpBridgeConfigShape | null = null;
		let serverNames: string[] = [];
		const parsed = readJsonWithError(candidate);
		if (!parsed.ok) {
			const warning = `Failed to parse MCP config ${candidate}: ${parsed.error}`;
			sourceWarnings.push(warning);
			warnings.push(warning);
		} else {
			const container = serverContainer(parsed.data);
			if (container) {
				shape = container.shape;
				serverNames = Object.keys(container.servers);
				for (const [name, raw] of Object.entries(container.servers)) {
					const duplicate = seenServers.has(name);
					if (!duplicate) seenServers.add(name);
					const normalized = normalizeServer(name, raw);
					let warning: string | undefined;
					if (duplicate) warning = `Skipped duplicate MCP server config: ${name} (from ${candidate})`;
					else if (!normalized) warning = `Skipped invalid MCP server config: ${name}`;
					if (warning) warnings.push(warning);
					servers.push({
						name,
						sourcePath: candidate,
						sourceShape: container.shape,
						duplicate,
						valid: Boolean(normalized) && !duplicate,
						redacted: redactMcpServer(raw),
						normalizedType: normalized?.type ?? null,
						warning,
					});
				}
			}
		}

		sources.push({
			path: candidate,
			exists,
			writable: isWritablePath(candidate),
			shape,
			serverNames,
			warnings: sourceWarnings,
		});
	}

	if (!sources.some((source) => source.path === defaultPath)) {
		sources.push({
			path: defaultPath,
			exists: fs.existsSync(defaultPath),
			writable: isWritablePath(defaultPath),
			shape: null,
			serverNames: [],
			warnings: [],
		});
	}

	return {
		defaultWritePath: defaultPath,
		explicitPath: explicitPath ? path.resolve(expandEnvVars(explicitPath)) : null,
		sources,
		servers,
		warnings,
	};
}

function loadConfig(cwd: string): LoadedConfig {
	const warnings: string[] = [];
	const candidates = collectMcpConfigCandidates(cwd, { env: process.env });
	const loadedSources: string[] = [];
	const serversByName = new Map<string, NormalizedMcpServer>();

	for (const candidate of candidates) {
		const parsed = safeReadJson(candidate);
		if (!parsed) continue;

		const rawServers = extractRawServers(parsed);
		if (!rawServers || Object.keys(rawServers).length === 0) continue;
		loadedSources.push(candidate);

		for (const [name, raw] of Object.entries(rawServers)) {
			if (serversByName.has(name)) {
				warnings.push(`Skipped duplicate MCP server config: ${name} (from ${candidate})`);
				continue;
			}

			const normalized = normalizeServer(name, raw);
			if (normalized) serversByName.set(name, normalized);
			else warnings.push(`Skipped invalid MCP server config: ${name}`);
		}
	}

	return {
		sourcePath: loadedSources.length > 0 ? loadedSources.join(", ") : null,
		servers: Array.from(serversByName.values()),
		warnings,
	};
}

function ensureServerContainer(
	record: Record<string, unknown>,
	shape: McpBridgeConfigShape,
): Record<string, RawMcpServer> {
	if (shape === "mcpServers") {
		if (!isRecord(record.mcpServers)) record.mcpServers = {};
		return record.mcpServers as Record<string, RawMcpServer>;
	}
	if (shape === "mcp.servers") {
		if (!isRecord(record.mcp)) record.mcp = {};
		const mcp = record.mcp as Record<string, unknown>;
		if (!isRecord(mcp.servers)) mcp.servers = {};
		return mcp.servers as Record<string, RawMcpServer>;
	}
	if (!isRecord(record.servers)) record.servers = {};
	return record.servers as Record<string, RawMcpServer>;
}

function readMutableConfigRecord(configPath: string): Record<string, unknown> {
	if (!fs.existsSync(configPath)) return {};
	const parsed = readJsonWithError(configPath);
	if (!parsed.ok) throw new Error(`Failed to parse MCP config ${configPath}: ${parsed.error}`);
	if (!isRecord(parsed.data)) throw new Error(`MCP config ${configPath} must be a JSON object.`);
	return parsed.data;
}

function writeJsonAtomic(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
	fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
	fs.renameSync(tmp, filePath);
}

export function upsertMcpServerConfig(input: UpsertMcpServerConfigInput): McpBridgeConfigState {
	const options = input.options ?? {};
	const configPath = path.resolve(
		input.configPath ?? options.defaultWritePath ?? defaultWritePath(options.homeDir ?? os.homedir()),
	);
	const record = readMutableConfigRecord(configPath);
	const existingContainer = serverContainer(record);
	const shape = input.shape ?? existingContainer?.shape ?? "mcpServers";
	const servers = existingContainer?.shape === shape ? existingContainer.servers : ensureServerContainer(record, shape);
	const existing = servers[input.name];
	servers[input.name] = preserveRedactedServer(input.server, existing);
	writeJsonAtomic(configPath, record);
	return loadMcpBridgeConfigState(input.cwd, { ...options, defaultWritePath: options.defaultWritePath ?? configPath });
}

export function removeMcpServerConfig(input: RemoveMcpServerConfigInput): McpBridgeConfigState {
	const record = readMutableConfigRecord(input.configPath);
	const container = serverContainer(record);
	if (!container) throw new Error(`MCP config ${input.configPath} does not contain server settings.`);
	if (!Object.hasOwn(container.servers, input.name))
		throw new Error(`MCP server '${input.name}' was not found in ${input.configPath}.`);
	delete container.servers[input.name];
	writeJsonAtomic(input.configPath, record);
	return loadMcpBridgeConfigState(input.cwd, input.options ?? {});
}

export function sanitizeName(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 80);
}

export function buildPiToolName(serverName: string, toolName: string): string {
	const safeServer = sanitizeName(serverName) || "server";
	const safeTool = sanitizeName(toolName) || "tool";
	return `mcp__${safeServer}__${safeTool}`;
}

export function mimeToExt(mimeType: string): string {
	switch (mimeType) {
		case "image/png":
			return "png";
		case "image/jpeg":
			return "jpg";
		case "image/gif":
			return "gif";
		case "image/webp":
			return "webp";
		case "image/svg+xml":
			return "svg";
		default:
			return "png";
	}
}

type FormattedToolResult = { text: string; imagePaths: string[] };

type PreparedPayload = {
	text: string;
	truncated: boolean;
	fullPayloadPath?: string;
	originalLength: number;
};

const LARGE_PAYLOAD_THRESHOLD_CHARS = 30_000;
const LARGE_PAYLOAD_PREVIEW_CHARS = 1_000;

function preparePayloadForClient(text: string, serverName: string, toolName: string): PreparedPayload {
	const originalLength = text.length;
	if (originalLength <= LARGE_PAYLOAD_THRESHOLD_CHARS) {
		return { text, truncated: false, originalLength };
	}

	const preview = text.slice(0, LARGE_PAYLOAD_PREVIEW_CHARS);
	const fileName = `mcp-payload-${sanitizeName(serverName) || "server"}-${sanitizeName(toolName) || "tool"}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`;
	const filePath = path.join(os.tmpdir(), fileName);

	try {
		fs.writeFileSync(filePath, text, "utf-8");
		return {
			text: [
				preview,
				"",
				`[Truncated output: first ${LARGE_PAYLOAD_PREVIEW_CHARS} chars shown, ${originalLength - LARGE_PAYLOAD_PREVIEW_CHARS} chars omitted]`,
				`[Full payload saved to: ${filePath}]`,
				"Use Read tool (or another file reader) to inspect the full payload.",
			].join("\n"),
			truncated: true,
			fullPayloadPath: filePath,
			originalLength,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			text: [
				preview,
				"",
				`[Truncated output: first ${LARGE_PAYLOAD_PREVIEW_CHARS} chars shown, ${originalLength - LARGE_PAYLOAD_PREVIEW_CHARS} chars omitted]`,
				`[Failed to save full payload: ${message}]`,
			].join("\n"),
			truncated: true,
			originalLength,
		};
	}
}

export function formatToolResult(result: unknown): FormattedToolResult {
	const imagePaths: string[] = [];

	if (typeof result === "string") return { text: result, imagePaths };

	if (result && typeof result === "object") {
		const maybe = result as {
			content?: Array<{ type?: string; text?: string; data?: string; mimeType?: string }>;
			structuredContent?: unknown;
		};

		if (Array.isArray(maybe.content)) {
			const chunks = maybe.content
				.map((item) => {
					if (item?.type === "text") return item.text ?? "";
					if (item?.type === "image" && item.data) {
						const ext = mimeToExt(item.mimeType ?? "image/png");
						const tmpFile = path.join(
							os.tmpdir(),
							`mcp-image-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`,
						);
						try {
							fs.writeFileSync(tmpFile, Buffer.from(item.data, "base64"));
							imagePaths.push(tmpFile);
							return `[Image saved: ${tmpFile}]`;
						} catch {
							return `[Image save failed: ${item.mimeType}, ${item.data.length} chars]`;
						}
					}
					return JSON.stringify(item);
				})
				.filter(Boolean);
			if (chunks.length > 0) return { text: chunks.join("\n"), imagePaths };
		}

		if (maybe.structuredContent !== undefined) {
			return { text: JSON.stringify(maybe.structuredContent, null, 2), imagePaths };
		}
	}

	return { text: JSON.stringify(result, null, 2), imagePaths };
}

type JsonSchemaProp = {
	type?: string;
	description?: string;
	enum?: unknown[];
	items?: { type?: string };
};

/**
 * Map a single JSON Schema property to the appropriate TypeBox type.
 * Preserves type, description, and enum information so the LLM receives
 * accurate type hints and the framework can validate/coerce values.
 */
function mapPropertyType(prop: JsonSchemaProp): ReturnType<typeof Type.Any> {
	const opts: Record<string, unknown> = {};
	if (typeof prop.description === "string") opts.description = prop.description;

	switch (prop.type) {
		case "string":
			if (Array.isArray(prop.enum) && prop.enum.every((v): v is string => typeof v === "string")) {
				return Type.Union(
					prop.enum.map((v) => Type.Literal(v)),
					opts,
				) as unknown as ReturnType<typeof Type.Any>;
			}
			return Type.String(opts) as unknown as ReturnType<typeof Type.Any>;
		case "boolean":
			return Type.Boolean(opts) as unknown as ReturnType<typeof Type.Any>;
		case "number":
			return Type.Number(opts) as unknown as ReturnType<typeof Type.Any>;
		case "integer":
			return Type.Integer(opts) as unknown as ReturnType<typeof Type.Any>;
		case "array":
			return Type.Array(Type.Any(), opts) as unknown as ReturnType<typeof Type.Any>;
		default:
			return Type.Any(opts);
	}
}

export function createParameterSchema(inputSchema: Record<string, unknown>): ReturnType<typeof Type.Object> {
	const schema = inputSchema as {
		type?: string;
		properties?: Record<string, JsonSchemaProp>;
		required?: string[];
	};

	if (schema.type !== "object" || !schema.properties) {
		return Type.Object({});
	}

	const required = new Set(schema.required ?? []);
	const properties: Record<string, ReturnType<typeof Type.Any>> = {};

	for (const [key, prop] of Object.entries(schema.properties)) {
		const base = mapPropertyType(prop);

		if (required.has(key)) {
			properties[key] = base;
		} else {
			properties[key] = Type.Optional(base) as unknown as ReturnType<typeof Type.Any>;
		}
	}

	return Type.Object(properties, { additionalProperties: true });
}

function summarizeToolCallArgs(args: Record<string, unknown>, theme: Theme): string {
	const entries = Object.entries(args).filter(([, value]) => value !== undefined && value !== null);
	if (entries.length === 0) return "";

	const firstEntry = entries[0];
	if (!firstEntry) return "";

	const [, firstVal] = firstEntry;
	const str = typeof firstVal === "string" ? firstVal : JSON.stringify(firstVal);
	const display = str.length > 80 ? `${str.slice(0, 77)}…` : str;
	const extraCount = entries.length > 1 ? theme.fg("muted", ` +${entries.length - 1}`) : "";
	return ` ${theme.fg("accent", display)}${extraCount}`;
}

function renderMcpToolCall(serverName: string, toolName: string, args: unknown, theme: Theme): Text {
	const label = `${serverName}/${toolName}`;
	const params = args as Record<string, unknown>;
	const argText = summarizeToolCallArgs(params, theme);
	return new Text(`${theme.fg("toolTitle", theme.bold(label))}${argText}`, 0, 0);
}

function buildMcpToolResultContent(
	formatted: FormattedToolResult,
	prepared: PreparedPayload,
): Array<{ type: "text"; text: string }> {
	const content: Array<{ type: "text"; text: string }> = [{ type: "text", text: prepared.text }];
	for (const imgPath of formatted.imagePaths) {
		content.push({ type: "text", text: `📎 Use Read tool to view: ${imgPath}` });
	}
	if (prepared.fullPayloadPath) {
		content.push({ type: "text", text: `📄 Full payload file: ${prepared.fullPayloadPath}` });
	}
	return content;
}

type ReloadableContext = ExtensionContext & { reload: () => Promise<void> };

async function executeMcpToolCall(args: {
	manager: McpManager;
	serverName: string;
	tool: DiscoveredTool;
	params: Record<string, unknown>;
	signal?: AbortSignal;
	isToolDisabled: (serverName: string, toolName: string) => boolean;
}) {
	const { manager, serverName, tool, params, signal, isToolDisabled } = args;
	if (signal?.aborted) {
		return {
			content: [{ type: "text" as const, text: "Cancelled" }],
			details: { server: serverName, tool: tool.name, cancelled: true },
		};
	}
	if (isToolDisabled(serverName, tool.name)) {
		throw new Error("This MCP tool is disabled. Open /mcp-status → Tools to enable it.");
	}

	try {
		const result = await manager.callTool(serverName, tool.name, params);
		const formatted = formatToolResult(result);
		if ((result as { isError?: boolean })?.isError) {
			throw new Error(formatted.text || `MCP tool ${serverName}/${tool.name} returned an error`);
		}
		const prepared = preparePayloadForClient(formatted.text, serverName, tool.name);
		return {
			content: buildMcpToolResultContent(formatted, prepared),
			details: {
				server: serverName,
				tool: tool.name,
				raw: prepared.truncated ? undefined : result,
				payloadTruncated: prepared.truncated,
				payloadOriginalLength: prepared.originalLength,
				payloadFilePath: prepared.fullPayloadPath,
			},
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`MCP error (${serverName}/${tool.name}): ${message}`);
	}
}

// ── Overlay shared helpers ────────────────────────────────────

type McpServerState = {
	name: string;
	status: ServerStatus;
	type: string;
	toolCount: number;
	error?: string;
};

type ServerAction = "tools" | "reconnect";

function sColor(status: ServerStatus): "success" | "error" | "warning" | "muted" {
	switch (status) {
		case "connected":
			return "success";
		case "error":
			return "error";
		case "disconnected":
			return "warning";
		default:
			return "muted";
	}
}

function sIcon(status: ServerStatus): string {
	switch (status) {
		case "connected":
			return "●";
		case "error":
			return "✗";
		case "disconnected":
			return "○";
		default:
			return "◐";
	}
}

function boxTop(th: Theme, title: string, innerW: number): string {
	const t = ` ${title} `;
	const tW = visibleWidth(t);
	const p1 = Math.floor((innerW - tW) / 2);
	const p2 = Math.max(0, innerW - tW - p1);
	return th.fg("border", `╭${"─".repeat(p1)}`) + th.fg("accent", th.bold(t)) + th.fg("border", `${"─".repeat(p2)}╮`);
}

function boxSep(th: Theme, innerW: number): string {
	return th.fg("border", `├${"─".repeat(innerW)}┤`);
}

function boxBot(th: Theme, innerW: number): string {
	return th.fg("border", `╰${"─".repeat(innerW)}╯`);
}

function boxRow(th: Theme, content: string, innerW: number): string {
	return th.fg("border", "│") + truncateToWidth(` ${content}`, innerW, "…", true) + th.fg("border", "│");
}

// ── Overlay 1: Server list (navigable) ───────────────────────

class McpStatusOverlay {
	private tui: TUI;
	private theme: Theme;
	private done: (value: string | null) => void;
	private states: McpServerState[];
	private sourcePath: string | null;
	private warnings: string[];
	private sel = 0;

	constructor(
		tui: TUI,
		theme: Theme,
		done: (value: string | null) => void,
		states: McpServerState[],
		sourcePath: string | null,
		warnings: string[],
	) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.states = states;
		this.sourcePath = sourcePath;
		this.warnings = warnings;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q") {
			this.done(null);
		} else if (matchesKey(data, "up") || data === "k") {
			this.sel = Math.max(0, this.sel - 1);
			this.tui.requestRender();
		} else if (matchesKey(data, "down") || data === "j") {
			this.sel = Math.min(this.states.length - 1, this.sel + 1);
			this.tui.requestRender();
		} else if (matchesKey(data, "return")) {
			if (this.states.length > 0) this.done(this.states[this.sel]?.name);
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		const th = this.theme;
		const iW = Math.max(1, width - 2);
		const lines: string[] = [];

		lines.push(boxTop(th, "MCP Server Status", iW));
		if (this.sourcePath) {
			lines.push(boxRow(th, th.fg("muted", `Source: ${this.sourcePath}`), iW));
		}
		lines.push(boxSep(th, iW));

		for (let i = 0; i < this.states.length; i++) {
			const st = this.states[i];
			if (!st) continue;
			const c = sColor(st.status);
			const ico = sIcon(st.status);
			const sel = i === this.sel;
			const cursor = sel ? th.fg("accent", "▸") : " ";
			const name = sel ? th.fg("accent", th.bold(st.name)) : st.name;
			const tools = st.toolCount > 0 ? th.fg("muted", ` ${st.toolCount} tools`) : "";
			const err = st.error ? `  ${th.fg("error", "⚠")}` : "";
			lines.push(boxRow(th, `${cursor} ${th.fg(c, ico)} ${name}  ${th.fg("muted", st.type)}${tools}${err}`, iW));
		}

		if (this.warnings.length > 0) {
			lines.push(boxSep(th, iW));
			lines.push(boxRow(th, th.fg("warning", `⚠ ${this.warnings.length} warning(s)`), iW));
		}

		lines.push(boxSep(th, iW));
		lines.push(boxRow(th, th.fg("muted", "↑↓ navigate · enter select · ESC close"), iW));
		lines.push(boxBot(th, iW));
		return lines;
	}
}

// ── Overlay 2: Server action menu ────────────────────────────

class McpActionOverlay {
	private tui: TUI;
	private theme: Theme;
	private done: (value: ServerAction | null) => void;
	private state: McpServerState;
	private actions: Array<{ id: ServerAction; label: string; hint: string }> = [
		{ id: "tools", label: "Tools", hint: "Enable/disable tools" },
		{ id: "reconnect", label: "Reconnect", hint: "Disconnect & reconnect" },
	];
	private sel = 0;

	constructor(tui: TUI, theme: Theme, done: (value: ServerAction | null) => void, state: McpServerState) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.state = state;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.done(null);
		} else if (matchesKey(data, "up") || data === "k") {
			this.sel = Math.max(0, this.sel - 1);
			this.tui.requestRender();
		} else if (matchesKey(data, "down") || data === "j") {
			this.sel = Math.min(this.actions.length - 1, this.sel + 1);
			this.tui.requestRender();
		} else if (matchesKey(data, "return")) {
			this.done(this.actions[this.sel]?.id);
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		const th = this.theme;
		const iW = Math.max(1, width - 2);
		const st = this.state;
		const c = sColor(st.status);
		const ico = sIcon(st.status);
		const lines: string[] = [];

		lines.push(boxTop(th, st.name, iW));
		lines.push(boxRow(th, `${th.fg(c, `${ico} ${st.status}`)}  ${th.fg("muted", st.type)}`, iW));
		if (st.toolCount > 0) {
			lines.push(boxRow(th, th.fg("muted", `${st.toolCount} tools registered`), iW));
		}
		if (st.error) {
			lines.push(boxRow(th, th.fg("error", `⚠ ${st.error}`), iW));
		}
		lines.push(boxSep(th, iW));

		for (let i = 0; i < this.actions.length; i++) {
			const a = this.actions[i];
			if (!a) continue;
			const sel = i === this.sel;
			const cursor = sel ? th.fg("accent", "▸") : " ";
			const label = sel ? th.fg("accent", th.bold(a.label)) : a.label;
			lines.push(boxRow(th, `${cursor} ${label}  ${th.fg("muted", a.hint)}`, iW));
		}

		lines.push(boxSep(th, iW));
		lines.push(boxRow(th, th.fg("muted", "↑↓ navigate · enter select · ESC back"), iW));
		lines.push(boxBot(th, iW));
		return lines;
	}
}

// ── Overlay 3: Tool list ─────────────────────────────────────

class McpToolListOverlay {
	private tui: TUI;
	private theme: Theme;
	private onClose: () => void;
	private serverName: string;
	private tools: DiscoveredTool[];
	private isToolDisabled: (toolName: string) => boolean;
	private onToggleTool: (toolName: string) => void;
	private sel = 0;
	private scroll = 0;
	private maxVisible = 15;

	constructor(
		tui: TUI,
		theme: Theme,
		onClose: () => void,
		serverName: string,
		tools: DiscoveredTool[],
		isToolDisabled: (toolName: string) => boolean,
		onToggleTool: (toolName: string) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.onClose = onClose;
		this.serverName = serverName;
		this.tools = tools;
		this.isToolDisabled = isToolDisabled;
		this.onToggleTool = onToggleTool;
	}

	private ensureSelectionVisible(): void {
		if (this.sel < this.scroll) {
			this.scroll = this.sel;
			return;
		}
		if (this.sel >= this.scroll + this.maxVisible) {
			this.scroll = this.sel - this.maxVisible + 1;
		}
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.onClose();
			return;
		}

		if (this.tools.length === 0) return;

		if (matchesKey(data, "up") || data === "k") {
			this.sel = Math.max(0, this.sel - 1);
			this.ensureSelectionVisible();
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "down") || data === "j") {
			this.sel = Math.min(this.tools.length - 1, this.sel + 1);
			this.ensureSelectionVisible();
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "return") || data === " ") {
			const tool = this.tools[this.sel];
			if (!tool) return;
			this.onToggleTool(tool.name);
			this.tui.requestRender();
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		const th = this.theme;
		const iW = Math.max(1, width - 2);
		const lines: string[] = [];
		const enabledCount = this.tools.filter((tool) => !this.isToolDisabled(tool.name)).length;

		lines.push(boxTop(th, `${this.serverName} · Tools`, iW));
		lines.push(boxRow(th, th.fg("muted", `Enabled ${enabledCount}/${this.tools.length}`), iW));
		lines.push(boxSep(th, iW));

		if (this.tools.length === 0) {
			lines.push(boxRow(th, th.fg("muted", "No tools available"), iW));
		} else {
			const from = this.scroll;
			const to = Math.min(this.tools.length, this.scroll + this.maxVisible);
			for (let i = from; i < to; i++) {
				const tool = this.tools[i];
				if (!tool) continue;
				const selected = i === this.sel;
				const cursor = selected ? th.fg("accent", "▸") : " ";
				const piName = buildPiToolName(this.serverName, tool.name);
				const name = selected ? th.fg("accent", th.bold(piName)) : piName;
				const enabled = !this.isToolDisabled(tool.name);
				const state = enabled ? th.fg("success", "● on") : th.fg("muted", "○ off");
				const desc = tool.description ? ` ${th.fg("muted", `— ${tool.description}`)}` : "";
				lines.push(boxRow(th, `${cursor} ${state} ${name}${desc}`, iW));
			}
			if (this.tools.length > this.maxVisible) {
				lines.push(boxSep(th, iW));
				const info = `${from + 1}–${to} of ${this.tools.length}`;
				lines.push(boxRow(th, th.fg("muted", info), iW));
			}
		}

		lines.push(boxSep(th, iW));
		lines.push(boxRow(th, th.fg("muted", "↑↓ navigate · Enter/Space toggle · ESC back"), iW));
		lines.push(boxBot(th, iW));
		return lines;
	}
}

export type McpBridgeRuntimeController = {
	getSnapshot(): McpBridgeRuntimeSnapshot;
	reload(cwd?: string): Promise<McpBridgeRuntimeSnapshot>;
	reconnectServer(serverName: string): Promise<McpBridgeRuntimeSnapshot>;
	setToolDisabled(
		serverName: string,
		toolName: string,
		disabled: boolean,
	): { ok: true; snapshot: McpBridgeRuntimeSnapshot } | { ok: false; error: string };
};

let activeMcpBridgeRuntime: McpBridgeRuntimeController | null = null;

export function getActiveMcpBridgeRuntime(): McpBridgeRuntimeController | null {
	return activeMcpBridgeRuntime;
}

export default function claudeMcpBridge(pi: ExtensionAPI) {
	const recentLogs: McpBridgeLogEntry[] = [];
	const maxLogs = 200;
	const manager = new McpManager((entry) => recordLog(entry));
	const registeredTools = new Set<string>();
	let loadedAt: LoadedConfig = { sourcePath: null, servers: [], warnings: [] };
	const loadedToolVisibility = loadToolVisibilitySettings();
	const disabledToolKeys = loadedToolVisibility.disabledToolKeys;
	let toolVisibilityWarning = loadedToolVisibility.warning;
	let activeContext: ExtensionContext | undefined;
	let loadedCwd = process.cwd();
	let loadGeneration = 0;
	let startupPromise: Promise<void> | undefined;
	let shuttingDown = false;

	function runtimeSnapshot(): McpBridgeRuntimeSnapshot {
		return manager.getSnapshot(disabledToolKeys, recentLogs, getOverlayWarnings());
	}

	function emitRuntimeSnapshot(): void {
		pi.events?.emit("claude-mcp-bridge:state", runtimeSnapshot());
	}

	function recordLog(entry: McpBridgeLogEntry): void {
		recentLogs.push(entry);
		if (recentLogs.length > maxLogs) recentLogs.splice(0, recentLogs.length - maxLogs);
		pi.events?.emit("claude-mcp-bridge:log", entry);
	}

	function getOverlayWarnings(): string[] {
		const warnings = [...loadedAt.warnings];
		if (toolVisibilityWarning) warnings.push(toolVisibilityWarning);
		return warnings;
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const states = manager.getStates();
		const total = states.length;
		if (total === 0) {
			ctx.ui.setStatus("mcp", undefined);
			return;
		}
		const connected = states.filter((s) => s.status === "connected").length;
		ctx.ui.setStatus("mcp", `MCP ${connected}/${total}`);
	}

	function isToolDisabled(serverName: string, toolName: string): boolean {
		return disabledToolKeys.has(buildToolVisibilityKey(serverName, toolName));
	}

	function removeDisabledToolsFromActiveSet(): void {
		let activeTools: Set<string>;
		try {
			activeTools = new Set(pi.getActiveTools());
		} catch {
			return;
		}

		let changed = false;

		for (const { serverName, tool } of manager.getAllTools()) {
			if (!isToolDisabled(serverName, tool.name)) continue;
			const piToolName = buildPiToolName(serverName, tool.name);
			if (activeTools.delete(piToolName)) changed = true;
		}

		if (changed) {
			pi.setActiveTools(Array.from(activeTools));
		}
	}

	function setToolActive(piToolName: string, enabled: boolean): void {
		let activeTools: Set<string>;
		try {
			activeTools = new Set(pi.getActiveTools());
		} catch {
			return;
		}

		let changed = false;
		if (enabled) {
			if (!activeTools.has(piToolName)) {
				activeTools.add(piToolName);
				changed = true;
			}
		} else if (activeTools.delete(piToolName)) {
			changed = true;
		}

		if (changed) {
			pi.setActiveTools(Array.from(activeTools));
		}
	}

	function setToolDisabledState(
		serverName: string,
		toolName: string,
		disabled: boolean,
	): { ok: true; disabled: boolean } | { ok: false; error: string } {
		const key = buildToolVisibilityKey(serverName, toolName);
		const wasDisabled = disabledToolKeys.has(key);

		if (disabled) {
			disabledToolKeys.add(key);
		} else {
			disabledToolKeys.delete(key);
		}

		const saved = saveToolVisibilitySettings(disabledToolKeys);
		if (!saved.ok) {
			if (wasDisabled) {
				disabledToolKeys.add(key);
			} else {
				disabledToolKeys.delete(key);
			}
			return { ok: false, error: saved.error };
		}

		toolVisibilityWarning = undefined;
		return { ok: true, disabled };
	}

	function toggleToolDisabled(
		serverName: string,
		toolName: string,
	): { ok: true; disabled: boolean } | { ok: false; error: string } {
		return setToolDisabledState(
			serverName,
			toolName,
			!disabledToolKeys.has(buildToolVisibilityKey(serverName, toolName)),
		);
	}

	function notifyStatusSummary(ctx: ExtensionContext): void {
		const states = manager.getStates();
		const summary = states.map((s) => `${s.name}=${s.status}${s.toolCount > 0 ? `(${s.toolCount})` : ""}`).join(", ");
		const sourceText = manager.sourcePath ? ` | source: ${manager.sourcePath}` : "";
		const disabledCount = manager
			.getAllTools()
			.filter(({ serverName, tool }) => isToolDisabled(serverName, tool.name)).length;
		const disabledText = disabledCount > 0 ? ` | disabled tools: ${disabledCount}` : "";
		ctx.ui.notify(`MCP: ${summary}${sourceText}${disabledText}`, "info");
	}

	function handleToolToggle(
		ctx: ExtensionContext,
		serverName: string,
		toolName: string,
		setReloadNeeded: (value: boolean) => void,
	): void {
		const toggled = toggleToolDisabled(serverName, toolName);
		if (!toggled.ok) {
			ctx.ui.notify(`Failed to save MCP tool settings: ${toggled.error}`, "warning");
			return;
		}

		registerDiscoveredTools();
		removeDisabledToolsFromActiveSet();

		const piToolName = buildPiToolName(serverName, toolName);
		if (toggled.disabled) {
			if (registeredTools.has(piToolName)) {
				setReloadNeeded(true);
			}
			setToolActive(piToolName, false);
			ctx.ui.notify(`${piToolName}: disabled`, "info");
			emitRuntimeSnapshot();
			return;
		}

		if (registeredTools.has(piToolName)) {
			setToolActive(piToolName, true);
			ctx.ui.notify(`${piToolName}: enabled`, "info");
			emitRuntimeSnapshot();
			return;
		}
		ctx.ui.notify(`${piToolName}: enabled (connect or reload to register)`, "warning");
		emitRuntimeSnapshot();
	}

	async function showToolOverlay(
		ctx: ExtensionContext,
		serverName: string,
		setReloadNeeded: (value: boolean) => void,
	): Promise<void> {
		const tools = manager.getServerTools(serverName);
		await ctx.ui.custom<null>(
			(tui, theme, _kb, done) =>
				new McpToolListOverlay(
					tui,
					theme,
					() => done(null),
					serverName,
					tools,
					(toolName) => isToolDisabled(serverName, toolName),
					(toolName) => handleToolToggle(ctx, serverName, toolName, setReloadNeeded),
				),
			{ overlay: true, overlayOptions: { anchor: "center", width: "80%", minWidth: 50, maxHeight: "80%" } },
		);
	}

	async function reconnectSelectedServer(ctx: ExtensionContext, serverName: string): Promise<void> {
		await manager.reconnectServer(serverName);
		registerDiscoveredTools();
		removeDisabledToolsFromActiveSet();
		updateStatus(ctx);
		const updated = manager.getStates().find((s) => s.name === serverName);
		if (updated?.status === "connected") {
			ctx.ui.notify(`${serverName}: reconnected (${updated.toolCount} tools)`, "info");
			return;
		}
		ctx.ui.notify(
			`${serverName}: ${updated?.status ?? "unknown"}${updated?.error ? ` – ${updated.error}` : ""}`,
			"warning",
		);
	}

	async function openMcpStatusOverlay(ctx: ReloadableContext, disabledAtCommandStart: Set<string>): Promise<void> {
		let shouldReloadForVisibility = false;
		const setReloadNeeded = (value: boolean) => {
			if (value) shouldReloadForVisibility = true;
		};

		serverList: while (true) {
			const freshStates = manager.getStates();
			const serverName = await ctx.ui.custom<string | null>(
				(tui, theme, _kb, done) =>
					new McpStatusOverlay(tui, theme, done, freshStates, manager.sourcePath, getOverlayWarnings()),
				{ overlay: true, overlayOptions: { anchor: "center", width: "80%", minWidth: 50, maxHeight: "80%" } },
			);
			if (!serverName) break;

			while (true) {
				const serverState = manager.getStates().find((s) => s.name === serverName);
				if (!serverState) break;

				const action = await ctx.ui.custom<ServerAction | null>(
					(tui, theme, _kb, done) => new McpActionOverlay(tui, theme, done, serverState),
					{ overlay: true, overlayOptions: { anchor: "center", width: "80%", minWidth: 50, maxHeight: "80%" } },
				);
				if (action === "tools") {
					await showToolOverlay(ctx, serverName, setReloadNeeded);
					continue;
				}
				if (action === "reconnect") {
					await reconnectSelectedServer(ctx, serverName);
					continue serverList;
				}
				continue serverList;
			}
		}

		if (shouldReloadForVisibility || hasNewlyDisabledTools(disabledAtCommandStart, disabledToolKeys)) {
			ctx.ui.notify("Reloading runtime to hide disabled MCP tools...", "info");
			await ctx.reload();
		}
	}

	function registerDiscoveredTools(): void {
		for (const { serverName, tool } of manager.getAllTools()) {
			if (isToolDisabled(serverName, tool.name)) continue;

			const piToolName = buildPiToolName(serverName, tool.name);
			if (registeredTools.has(piToolName)) continue;

			pi.registerTool({
				name: piToolName,
				label: `MCP ${serverName}/${tool.name}`,
				description: tool.description ?? `MCP tool ${serverName}/${tool.name}`,
				parameters: createParameterSchema(tool.inputSchema),

				renderCall(args, theme) {
					return renderMcpToolCall(serverName, tool.name, args, theme);
				},

				renderResult(result, { expanded }, theme) {
					const tc = result.content.find((c) => c.type === "text");
					if (!expanded) {
						if (tc?.type === "text") {
							const count = tc.text.trim().split("\n").filter(Boolean).length;
							if (count > 0) return new Text(theme.fg("muted", ` → ${count} lines`), 0, 0);
						}
						return new Text("", 0, 0);
					}
					if (tc?.type !== "text") return new Text("", 0, 0);
					const output = tc.text
						.trim()
						.split("\n")
						.map((line) => theme.fg("toolOutput", line))
						.join("\n");
					return output ? new Text(`\n${output}`, 0, 0) : new Text("", 0, 0);
				},

				async execute(_toolCallId, params, signal, onUpdate, _ctx) {
					onUpdate?.({
						content: [{ type: "text" as const, text: `Calling MCP ${serverName}/${tool.name}...` }],
						details: { server: serverName, tool: tool.name, status: "running" },
					});
					return executeMcpToolCall({
						manager,
						serverName,
						tool,
						params: params as Record<string, unknown>,
						signal,
						isToolDisabled,
					});
				},
			});

			registeredTools.add(piToolName);
		}
	}

	function refreshRuntimeState(generation: number): void {
		if (shuttingDown || generation !== loadGeneration) return;
		registerDiscoveredTools();
		removeDisabledToolsFromActiveSet();
		if (activeContext) updateStatus(activeContext);
		emitRuntimeSnapshot();
	}

	function loadConfiguredServers(cwd: string): number {
		loadedCwd = cwd;
		const loaded = loadConfig(cwd);
		loadedAt = loaded;
		manager.setServers(loaded.servers, loaded.sourcePath);
		const generation = ++loadGeneration;
		refreshRuntimeState(generation);
		return generation;
	}

	async function connectConfiguredServersInBackground(generation: number): Promise<void> {
		try {
			await manager.connectAll(() => refreshRuntimeState(generation));
			refreshRuntimeState(generation);
		} catch (error) {
			if (shuttingDown || generation !== loadGeneration) return;
			const message = error instanceof Error ? error.message : String(error);
			toolVisibilityWarning = `MCP background startup failed: ${message}`;
			recordLog({ timestamp: new Date().toISOString(), level: "error", message: toolVisibilityWarning });
			if (activeContext?.hasUI) {
				activeContext.ui.notify(`[claude-mcp-bridge] ${toolVisibilityWarning}`, "warning");
			}
			emitRuntimeSnapshot();
		}
	}

	async function reloadConfiguredServers(cwd: string): Promise<McpBridgeRuntimeSnapshot> {
		const loaded = loadConfig(cwd);
		loadedAt = loaded;
		await manager.replaceServers(loaded.servers, loaded.sourcePath);
		const generation = ++loadGeneration;
		refreshRuntimeState(generation);
		await connectConfiguredServersInBackground(generation);
		return runtimeSnapshot();
	}

	const runtimeController: McpBridgeRuntimeController = {
		getSnapshot: runtimeSnapshot,
		reload: async (cwd = process.cwd()) => reloadConfiguredServers(cwd),
		reconnectServer: async (serverName: string) => {
			await manager.reconnectServer(serverName);
			refreshRuntimeState(loadGeneration);
			return runtimeSnapshot();
		},
		setToolDisabled: (serverName: string, toolName: string, disabled: boolean) => {
			const result = setToolDisabledState(serverName, toolName, disabled);
			if (!result.ok) return result;
			registerDiscoveredTools();
			removeDisabledToolsFromActiveSet();
			const piToolName = buildPiToolName(serverName, toolName);
			setToolActive(piToolName, !disabled);
			emitRuntimeSnapshot();
			return { ok: true, snapshot: runtimeSnapshot() };
		},
	};
	activeMcpBridgeRuntime = runtimeController;

	// Load config synchronously so /mcp-status and the footer know which servers exist,
	// but do not await server connection/tool discovery during pi startup. Tools are
	// registered dynamically as MCP servers finish connecting in the background.
	const startupGeneration = loadConfiguredServers(process.cwd());
	startupPromise = connectConfiguredServersInBackground(startupGeneration);

	pi.on("session_start", async (_event, ctx) => {
		activeContext = ctx;
		if (path.resolve(ctx.cwd) !== path.resolve(loadedCwd)) {
			const generation = loadConfiguredServers(ctx.cwd);
			startupPromise = connectConfiguredServersInBackground(generation);
		}
		updateStatus(ctx);
		removeDisabledToolsFromActiveSet();
		emitRuntimeSnapshot();
		if (toolVisibilityWarning && ctx.hasUI) {
			ctx.ui.notify(`[claude-mcp-bridge] ${toolVisibilityWarning}`, "warning");
		}
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		loadGeneration++;
		activeContext = undefined;
		if (activeMcpBridgeRuntime === runtimeController) activeMcpBridgeRuntime = null;
		await manager.disconnectAll();
		await startupPromise;
	});

	pi.registerCommand("mcp-status", {
		description: "Show MCP server connection status",
		handler: async (_args, ctx) => {
			if (manager.getStates().length === 0) {
				ctx.ui.notify("MCP: no configured servers", "warning");
				return;
			}

			const disabledAtCommandStart = new Set(disabledToolKeys);
			if (!ctx.hasUI) {
				notifyStatusSummary(ctx);
				return;
			}
			await openMcpStatusOverlay(ctx as ReloadableContext, disabledAtCommandStart);
		},
	});
}
