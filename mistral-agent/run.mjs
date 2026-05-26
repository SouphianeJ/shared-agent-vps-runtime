import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const apiKey = process.env.MISTRAL_API_KEY?.trim() || "";
const model = process.env.MISTRAL_MODEL?.trim() || "codestral-latest";
const prompt = process.env.MISTRAL_PROMPT ?? "";
const mistralHome = process.env.MISTRAL_HOME?.trim() || ".";
const sessionId = process.env.MISTRAL_SESSION_ID?.trim() || randomUUID();
const mcpConfig = parseMcpConfig(process.env.MISTRAL_MCP_CONFIG);
const sessionDir = join(mistralHome, "sessions");
const sessionFilePath = join(sessionDir, `${sanitizeSessionId(sessionId)}.json`);

if (!apiKey) {
  throw new Error("Missing MISTRAL_API_KEY.");
}

if (!prompt.trim()) {
  throw new Error("Missing MISTRAL_PROMPT.");
}

function parseMcpConfig(raw) {
  if (!raw?.trim()) {
    return { servers: [] };
  }

  const parsed = JSON.parse(raw);
  const servers = Array.isArray(parsed?.servers) ? parsed.servers : [];
  return { servers };
}

function sanitizeSessionId(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "_");
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function normalizeToolName(serverName, toolName) {
  return `${String(serverName)}__${String(toolName)}`.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function extractTextContent(content) {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return "";
      }

      if (entry.type === "text" && typeof entry.text === "string") {
        return entry.text;
      }

      if (typeof entry.content === "string") {
        return entry.content;
      }

      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function stringifyToolResult(result) {
  if (result?.structuredContent !== undefined) {
    return JSON.stringify(result.structuredContent);
  }

  const text = extractTextContent(result?.content);
  if (text) {
    return text;
  }

  return JSON.stringify(result ?? {});
}

function extractToolResultPayload(result) {
  const text = extractTextContent(result?.content);
  if (result?.structuredContent !== undefined) {
    return result.structuredContent;
  }

  if (text) {
    return text;
  }

  return result || null;
}

function normalizeArguments(value) {
  if (!value) {
    return {};
  }

  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }

  if (typeof value === "object") {
    return value;
  }

  return {};
}

async function loadSessionMessages() {
  try {
    const raw = await readFile(sessionFilePath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.messages) ? parsed.messages : [];
  } catch {
    return [];
  }
}

async function saveSessionMessages(messages) {
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    sessionFilePath,
    `${JSON.stringify({ sessionId, updatedAt: new Date().toISOString(), messages }, null, 2)}\n`,
    "utf8",
  );
}

async function createMcpClient(server) {
  const client = new Client({ name: "runtime-mistral-agent", version: "0.1.0" });
  const transport =
    server.transport === "stdio"
      ? new StdioClientTransport({
          command: server.command,
          args: Array.isArray(server.args) ? server.args : [],
          env: {
            ...process.env,
            ...(server.env && typeof server.env === "object" ? server.env : {}),
          },
        })
      : new StreamableHTTPClientTransport(new URL(server.url));

  await client.connect(transport);
  return { client, transport };
}

async function buildToolRegistry() {
  const registry = [];

  for (const server of mcpConfig.servers) {
    const connection = await createMcpClient(server);
    const { tools } = await connection.client.listTools();

    for (const tool of tools) {
      const mistralToolName = normalizeToolName(server.serverName, tool.name);
      registry.push({
        mistralToolName,
        toolName: tool.name,
        serverName: server.serverName,
        description: tool.description || `${server.serverName} :: ${tool.name}`,
        inputSchema:
          tool.inputSchema && typeof tool.inputSchema === "object"
            ? tool.inputSchema
            : { type: "object", properties: {}, additionalProperties: true },
        client: connection.client,
      });
    }
  }

  return registry;
}

async function closeToolRegistry(toolRegistry) {
  const uniqueClients = new Set(toolRegistry.map((entry) => entry.client));

  await Promise.all(
    Array.from(uniqueClients).map(async (client) => {
      try {
        await client.close();
      } catch {
        // Ignore client close errors during teardown.
      }
    }),
  );
}

function buildMistralTools(toolRegistry) {
  return toolRegistry.map((entry) => ({
    type: "function",
    function: {
      name: entry.mistralToolName,
      description: `[${entry.serverName}] ${entry.description}`,
      parameters: entry.inputSchema,
    },
  }));
}

async function callMistral(messages, tools) {
  const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      tools,
      tool_choice: tools.length > 0 ? "auto" : "none",
      parallel_tool_calls: true,
      temperature: 0.1,
    }),
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(
      typeof payload === "object" && payload !== null && "message" in payload
        ? String(payload.message)
        : `Mistral API request failed (${response.status}).`,
    );
  }

  return payload;
}

async function main() {
  const toolRegistry = await buildToolRegistry();
  const tools = buildMistralTools(toolRegistry);
  const toolByMistralName = new Map(toolRegistry.map((entry) => [entry.mistralToolName, entry]));
  const messages = await loadSessionMessages();

  emit({ type: "session.started", sessionId });

  messages.push({ role: "user", content: prompt });

  try {
    while (true) {
      const payload = await callMistral(messages, tools);
      const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
      const message = choice?.message ?? null;

      if (!message) {
        throw new Error("Mistral returned no assistant message.");
      }

      const assistantMessage = {};
      if (typeof message.content === "string" || Array.isArray(message.content)) {
        assistantMessage.role = "assistant";
        assistantMessage.content = message.content;
      } else {
        assistantMessage.role = "assistant";
        assistantMessage.content = "";
      }

      if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        assistantMessage.tool_calls = message.tool_calls;
      }

      messages.push(assistantMessage);

      if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
        const finalContent = extractTextContent(message.content).trim();
        emit({
          type: "assistant.message",
          sessionId,
          content: finalContent,
          done: true,
        });
        await saveSessionMessages(messages);
        break;
      }

      for (const toolCall of message.tool_calls) {
        const toolName = toolCall?.function?.name;
        const toolArgs = normalizeArguments(toolCall?.function?.arguments);
        const entry = toolByMistralName.get(toolName);

        if (!entry) {
          throw new Error(`Unknown Mistral tool mapping: ${toolName || "unknown"}.`);
        }

        emit({
          type: "tool.execution_start",
          sessionId,
          name: entry.toolName,
          toolCallId: toolCall.id,
          data: {
            toolName: entry.toolName,
            toolCallId: toolCall.id,
            arguments: toolArgs,
          },
        });

        const result = await entry.client.callTool({
          name: entry.toolName,
          arguments: toolArgs,
        });

        if (result?.isError) {
          throw new Error(stringifyToolResult(result));
        }

        emit({
          type: "tool.execution_complete",
          sessionId,
          name: entry.toolName,
          toolCallId: toolCall.id,
          data: {
            toolName: entry.toolName,
            toolCallId: toolCall.id,
            result: extractToolResultPayload(result),
          },
        });

        messages.push({
          role: "tool",
          name: toolName,
          tool_call_id: toolCall.id,
          content: stringifyToolResult(result),
        });
      }

      await saveSessionMessages(messages);
    }
  } finally {
    await closeToolRegistry(toolRegistry);
  }
}

await main();
