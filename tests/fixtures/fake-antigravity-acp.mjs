// A fake agy_acp_server for tests/antigravity.test.ts: speaks just enough
// ACP (newline-delimited JSON-RPC) and MCP to play one tool-calling step the
// way the real server does — ask permission for a BUILT-IN tool (must be
// denied), ask permission for the app's MCP tool (must be allowed), call it
// over the HTTP MCP server it was given, then start a "next response" that
// the engine must cancel. Writes what it saw to MT_FAKE_AGY_REPORT for asserts.
import { createInterface } from "node:readline";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

let nextId = 1000;
const waiting = new Map();
const send = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
const ask = (method, params) =>
	new Promise((resolve) => {
		const id = nextId++;
		waiting.set(id, resolve);
		send({ id, method, params });
	});
const seen = { appendedPrompt: null, model: null, permission: {} };
const sessions = new Map();
let cancelled = null;

createInterface({ input: process.stdin }).on("line", async (line) => {
	const msg = JSON.parse(line);
	if (msg.id !== undefined && waiting.has(msg.id)) {
		waiting.get(msg.id)(msg.result);
		waiting.delete(msg.id);
		return;
	}
	const p = msg.params ?? {};
	switch (msg.method) {
		case "initialize":
			return send({ id: msg.id, result: { protocolVersion: 1, authMethods: [{ id: "oauth-personal" }], agentCapabilities: {} } });
		case "authenticate":
			return send(p.methodId === "oauth-personal" ? { id: msg.id, result: {} } : { id: msg.id, error: { code: -32000, message: "wrong auth" } });
		case "session/new":
			seen.appendedPrompt = p._meta?.antigravity?.systemPrompt?.append ?? null;
			sessions.set("s1", p.mcpServers[0]?.url);
			return send({ id: msg.id, result: { sessionId: "s1" } });
		case "session/set_config_option":
			if (p.configId === "model") seen.model = p.value;
			return send({ id: msg.id, result: {} });
		case "session/close":
			return send({ id: msg.id, result: {} });
		case "session/cancel":
			return cancelled?.();
		case "session/prompt": {
			const update = (u) => send({ method: "session/update", params: { sessionId: "s1", update: u } });
			const text = p.prompt.map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join(" | ");
			// Context of each internal call ("used"); the final usage SUMS the calls.
			update({ sessionUpdate: "usage_update", used: 0, size: 1048576 });
			update({ sessionUpdate: "usage_update", used: 700, size: 1048576 });
			update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Checking prior knowledge." } });
			update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Quick check first." } });
			// A built-in tool asks permission: the engine must deny it.
			const builtin = await ask("session/request_permission", {
				sessionId: "s1",
				toolCall: { toolCallId: "b1", title: "run_command", _meta: {} },
				options: [{ optionId: "allow", kind: "allow_once" }, { optionId: "deny", kind: "reject_once" }],
			});
			seen.permission.builtin = builtin.outcome.optionId;
			// The app's MCP tool asks permission: the engine must allow it.
			const ours = await ask("session/request_permission", {
				sessionId: "s1",
				toolCall: { toolCallId: "t1", title: "mt_quiz", _meta: { mcp: { tool: "quiz", server: "mt" }, is_mcp_tool_call: true } },
				options: [{ optionId: "allow", kind: "allow_once" }, { optionId: "deny", kind: "reject_once" }],
			});
			seen.permission.ours = ours.outcome.optionId;
			update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "mt_quiz", status: "pending" });
			const client = new Client({ name: "fake-agy", version: "0" });
			await client.connect(new StreamableHTTPClientTransport(new URL(sessions.get("s1"))));
			await client.callTool({ name: "quiz", arguments: { question: `Echo: ${text.slice(0, 60)}`, options: ["a", "b"] } });
			await client.close();
			if (process.env.MT_FAKE_AGY_REPORT) fs.writeFileSync(process.env.MT_FAKE_AGY_REPORT, JSON.stringify(seen));
			const done = new Promise((r) => (cancelled = r));
			update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "SHOULD NOT APPEAR" } });
			await done;
			update({ sessionUpdate: "usage_update", used: 820, size: 1048576 });
			return send({ id: msg.id, result: { stopReason: "cancelled", usage: { inputTokens: 1000, outputTokens: 40, thoughtTokens: 60, cachedReadTokens: 400, cachedWriteTokens: 0 } } });
		}
		default:
			if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: "unsupported" } });
	}
});
