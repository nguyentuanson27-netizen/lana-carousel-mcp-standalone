import "./candidate-invariant.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./mcp-tools.js";

const server = createMcpServer();
await server.connect(new StdioServerTransport());
