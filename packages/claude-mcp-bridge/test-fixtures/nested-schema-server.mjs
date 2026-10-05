// Minimal stdio MCP server with one tool, `apply_change`, whose input schema is
// the JSON passed as the first argument.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const inputSchema = JSON.parse(process.argv[2]);
const server = new Server({ name: "nested-schema", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, () => ({
	tools: [{ name: "apply_change", description: "Apply one change.", inputSchema }],
}));
server.setRequestHandler(CallToolRequestSchema, () => ({ content: [{ type: "text", text: "ok" }] }));
await server.connect(new StdioServerTransport());
