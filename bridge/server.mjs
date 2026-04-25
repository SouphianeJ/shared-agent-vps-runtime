import { createWriteStream } from "node:fs";
import { chmod, cp, mkdir, readdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

const port = Number.parseInt(process.env.PORT ?? "11437", 10);
const host = process.env.HOST ?? "127.0.0.1";
const maxSkewSeconds = Number.parseInt(process.env.PROXY_MAX_SKEW_SECONDS ?? "90", 10);
const nonceTtlSeconds = Number.parseInt(process.env.PROXY_NONCE_TTL_SECONDS ?? "120", 10);
const runtimeRoot = process.env.RUNTIME_ROOT ?? "/runtime";
const runtimeAppsConfigPath = process.env.RUNTIME_APPS_CONFIG ?? "/app/config/apps.json";
const defaultModel = process.env.CODEX_MODEL ?? "";
const chatUploadMaxBytes = Number.parseInt(process.env.CHAT_UPLOAD_MAX_BYTES ?? "0", 10);
const allowDangerousDefault = /^(1|true|yes|on)$/i.test(process.env.CODEX_ALLOW_DANGEROUS ?? "true");
const r2Bucket = process.env.R2_BUCKET ?? "";
const r2Endpoint = process.env.R2_ENDPOINT ?? "";
const r2AccessKeyId = process.env.R2_ACCESS_KEY_ID ?? process.env.AWS_ACCESS_KEY_ID ?? "";
const r2SecretAccessKey = process.env.R2_SECRET_ACCESS_KEY ?? process.env.AWS_SECRET_ACCESS_KEY ?? "";
const r2AuthPrefix = process.env.R2_CODEX_AUTH_PREFIX ?? "codex-auth";

const keyRegistry = new Map();
const nonceCache = new Map();
const runQueueByKey = new Map();
const activeRunsByKey = new Map();
const activeCopilotAuthSessionsByApp = new Map();
const appRegistryPromise = loadAppRegistry();

registerKey(process.env.PROXY_KEY_ID_ACTIVE, process.env.PROXY_SIGNING_KEY_ACTIVE);
registerKey(process.env.PROXY_KEY_ID_PREVIOUS, process.env.PROXY_SIGNING_KEY_PREVIOUS);

if (keyRegistry.size === 0) {
  throw new Error("No proxy signing keys configured.");
}

setInterval(cleanExpiredNonces, 30_000).unref();

const server = createServer(async (request, response) => {
  try {
    if (!request.url || !request.method) {
      response.writeHead(400).end("Invalid request");
      return;
    }

    const requestUrl = new URL(request.url, `http://${request.headers.host ?? "127.0.0.1"}`);

    if (requestUrl.pathname === "/codex/files/upload" && request.method === "OPTIONS") {
      writeCorsHeaders(response, request.headers.origin);
      response.writeHead(204);
      response.end();
      return;
    }

    if (requestUrl.pathname === "/codex/health" && request.method === "GET") {
      const rawBody = Buffer.alloc(0);
      const headers = normalizeHeaders(request.headers);
      const validationError = validateSignedRequest({
        method: request.method,
        path: requestUrl.pathname,
        headers,
        rawBody,
      });

      if (validationError) {
        response.writeHead(validationError.status, { "Content-Type": "text/plain; charset=utf-8" });
        response.end(validationError.message);
        return;
      }

      const registry = await appRegistryPromise;
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: true, apps: Array.from(registry.keys()) }));
      return;
    }

    if (requestUrl.pathname === "/codex/files/upload" && request.method === "PUT") {
      writeCorsHeaders(response, request.headers.origin);
      const upload = validateUploadRequest(request, requestUrl);
      const appConfig = await resolveAppConfig(upload.appId);
      const fileDirectory = getFileDirectory(appConfig, upload.chatId, upload.fileId);
      const writtenFile = await streamUploadToDisk(request, fileDirectory, upload);

      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(writtenFile));
      return;
    }

    if (requestUrl.pathname === "/codex/files" && request.method === "DELETE") {
      const rawBody = await readRequestBody(request);
      const headers = normalizeHeaders(request.headers);
      const validationError = validateSignedRequest({
        method: request.method,
        path: requestUrl.pathname,
        headers,
        rawBody,
      });

      if (validationError) {
        response.writeHead(validationError.status, { "Content-Type": "text/plain; charset=utf-8" });
        response.end(validationError.message);
        return;
      }

      const payload = parseFileDeletePayload(rawBody);
      const appConfig = await resolveAppConfig(payload.appId);
      await rm(getFileDirectory(appConfig, payload.chatId, payload.fileId), { recursive: true, force: true });

      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: true, fileId: payload.fileId }));
      return;
    }

    if (requestUrl.pathname === "/codex/runs/stop" && request.method === "POST") {
      const rawBody = await readRequestBody(request);
      const headers = normalizeHeaders(request.headers);
      const validationError = validateSignedRequest({
        method: request.method,
        path: requestUrl.pathname,
        headers,
        rawBody,
      });

      if (validationError) {
        response.writeHead(validationError.status, { "Content-Type": "text/plain; charset=utf-8" });
        response.end(validationError.message);
        return;
      }

      const payload = parseStopPayload(rawBody);
      await resolveAppConfig(payload.appId);
      await handleStopRequest(payload, response);
      return;
    }

    if (requestUrl.pathname === "/codex/chats/cleanup" && request.method === "POST") {
      const rawBody = await readRequestBody(request);
      const headers = normalizeHeaders(request.headers);
      const validationError = validateSignedRequest({
        method: request.method,
        path: requestUrl.pathname,
        headers,
        rawBody,
      });

      if (validationError) {
        response.writeHead(validationError.status, { "Content-Type": "text/plain; charset=utf-8" });
        response.end(validationError.message);
        return;
      }

      const payload = parseCleanupPayload(rawBody);
      const appConfig = await resolveAppConfig(payload.appId);
      await handleCleanupRequest(payload, appConfig, response);
      return;
    }

    if (requestUrl.pathname === "/codex/copilot-auth/start" && request.method === "POST") {
      const rawBody = await readRequestBody(request);
      const headers = normalizeHeaders(request.headers);
      const validationError = validateSignedRequest({
        method: request.method,
        path: requestUrl.pathname,
        headers,
        rawBody,
      });

      if (validationError) {
        response.writeHead(validationError.status, { "Content-Type": "text/plain; charset=utf-8" });
        response.end(validationError.message);
        return;
      }

      const payload = parseCopilotAuthPayload(rawBody);
      const appConfig = await resolveAppConfig(payload.appId);
      const session = await startCopilotAuthSession(appConfig);
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(serializeCopilotAuthSession(session)));
      return;
    }

    if (requestUrl.pathname === "/codex/copilot-auth/status" && request.method === "POST") {
      const rawBody = await readRequestBody(request);
      const headers = normalizeHeaders(request.headers);
      const validationError = validateSignedRequest({
        method: request.method,
        path: requestUrl.pathname,
        headers,
        rawBody,
      });

      if (validationError) {
        response.writeHead(validationError.status, { "Content-Type": "text/plain; charset=utf-8" });
        response.end(validationError.message);
        return;
      }

      const payload = parseCopilotAuthStatusPayload(rawBody);
      const session = activeCopilotAuthSessionsByApp.get(payload.appId);

      if (!session || session.id !== payload.authSessionId) {
        response.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: "Copilot auth session not found." }));
        return;
      }

      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(serializeCopilotAuthSession(session)));
      return;
    }

    if (requestUrl.pathname !== "/codex/run" || request.method !== "POST") {
      response.writeHead(404).end("Not found");
      return;
    }

    const rawBody = await readRequestBody(request);
    const headers = normalizeHeaders(request.headers);
    const validationError = validateSignedRequest({
      method: request.method,
      path: requestUrl.pathname,
      headers,
      rawBody,
    });

    if (validationError) {
      response.writeHead(validationError.status, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(validationError.message);
      return;
    }

    const payload = parsePayload(rawBody);
    const appConfig = await resolveAppConfig(payload.appId);
    const workspacePath = buildWorkspacePath(appConfig, payload.chatId);
    const runHandler = () => handleRunRequest(payload, appConfig, workspacePath, response);

    if (shouldSerializeCodexRuns(payload)) {
      await enqueueSerializedRun(`codex:${payload.appId}`, runHandler);
    } else {
      await runHandler();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected bridge error";
    response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(message);
  }
});

server.listen(port, host, () => {
  console.log(`shared-agent-runtime bridge listening on ${host}:${port}`);
});

function registerKey(keyId, key) {
  if (!keyId || !key) {
    return;
  }

  keyRegistry.set(keyId, key);
}

async function loadAppRegistry() {
  const raw = await readFile(runtimeAppsConfigPath, "utf8");
  const parsed = JSON.parse(raw);
  const apps = Array.isArray(parsed?.apps) ? parsed.apps : [];

  return new Map(
    apps.map((app) => {
      const appId = String(app.id ?? "").trim();

      if (!appId) {
        throw new Error("Invalid app id in runtime apps config.");
      }

      const appHome = buildRuntimePath(String(app.paths?.appHome ?? ""));

      return [
        appId,
        {
          id: appId,
          displayName: String(app.displayName ?? appId),
          copilotMcpEnvPrefix: String(app.copilotMcpEnvPrefix ?? "").trim(),
          appHome,
          codexHome: buildRuntimePath(String(app.paths?.codexHome ?? "")),
          copilotHome: buildRuntimePath(String(app.paths?.copilotHome ?? "")),
          workspaceRoot: buildRuntimePath(String(app.paths?.workspaceRoot ?? "")),
          fileLibraryRoot: `${appHome}/file-library`,
        },
      ];
    }),
  );
}

function buildRuntimePath(relativePath) {
  const normalized = relativePath.replace(/^\/+/, "").replace(/\\/g, "/");

  if (!normalized) {
    throw new Error("Invalid runtime path.");
  }

  return `${runtimeRoot.replace(/\/+$/, "")}/${normalized}`;
}

const DEFAULT_MCP_SERVER_URLS = {
  GithubPerso: "https://mcp-github-client-proxy.vercel.app/mcp",
  DBanalyzer: "https://mcp-dbanalyzer-client-proxy.vercel.app/mcp",
  DBworker: "https://mcp-dbworker-client-proxy.vercel.app/mcp",
  MCPcompetencies: "https://mcp-personal-competencies-client-pr.vercel.app/mcp",
  Moodle: "https://mcp-moodle-client-proxy.vercel.app/mcp",
};

async function resolveAppConfig(appId) {
  const registry = await appRegistryPromise;
  const app = registry.get(appId);

  if (!app) {
    throw new Error(`Unknown app id: ${appId}`);
  }

  return app;
}

function parsePayload(rawBody) {
  let payload;

  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new Error("Invalid JSON payload.");
  }

  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid payload.");
  }

  const appId = typeof payload.appId === "string" ? payload.appId.trim() : "";
  const chatId = typeof payload.chatId === "string" ? payload.chatId.trim() : "";
  const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
  const sessionId = typeof payload.sessionId === "string" && payload.sessionId.trim() ? payload.sessionId.trim() : null;
  const engine = payload.engine === "copilot" ? "copilot" : "codex";
  const model = typeof payload.model === "string" && payload.model.trim() ? payload.model.trim() : defaultModel;
  const reasoningEffort =
    payload.reasoningEffort === "low" || payload.reasoningEffort === "medium" || payload.reasoningEffort === "high"
      ? payload.reasoningEffort
      : null;
  const allowBypassSandbox =
    typeof payload.allowBypassSandbox === "boolean" ? payload.allowBypassSandbox : allowDangerousDefault;
  const enabledMcpServers = Array.isArray(payload.enabledMcpServers)
    ? payload.enabledMcpServers.map((value) => String(value ?? "").trim()).filter(Boolean)
    : null;
  const attachmentIds = Array.isArray(payload.attachmentIds)
    ? payload.attachmentIds.map((value) => String(value ?? "").trim()).filter(Boolean)
    : [];

  if (!/^[a-zA-Z0-9_-]+$/.test(appId)) {
    throw new Error("Invalid app id.");
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(chatId)) {
    throw new Error("Invalid chat id.");
  }

  if (!prompt.trim()) {
    throw new Error("Missing prompt.");
  }

  return {
    appId,
    chatId,
    prompt,
    sessionId,
    engine,
    model,
    reasoningEffort,
    allowBypassSandbox,
    enabledMcpServers,
    attachmentIds,
  };
}

function parseFileDeletePayload(rawBody) {
  let payload;

  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new Error("Invalid JSON payload.");
  }

  const appId = typeof payload?.appId === "string" ? payload.appId.trim() : "";
  const chatId = typeof payload?.chatId === "string" ? payload.chatId.trim() : "";
  const fileId = typeof payload?.fileId === "string" ? payload.fileId.trim() : "";

  if (!/^[a-zA-Z0-9_-]+$/.test(appId)) {
    throw new Error("Invalid app id.");
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(chatId)) {
    throw new Error("Invalid chat id.");
  }

  if (!/^[a-f0-9-]{36}$/i.test(fileId)) {
    throw new Error("Invalid file id.");
  }

  return { appId, chatId, fileId };
}

function buildWorkspacePath(appConfig, chatId) {
  return `${appConfig.workspaceRoot.replace(/\/+$/, "")}/${chatId}`;
}

function buildRunKey(appId, chatId) {
  return `${appId}:${chatId}`;
}

function getFileDirectory(appConfig, chatId, fileId) {
  return join(appConfig.fileLibraryRoot, "chats", chatId, fileId);
}

async function handleRunRequest(payload, appConfig, workspacePath, response) {
  await ensureAppPaths(appConfig, workspacePath, payload.enabledMcpServers);

  if (shouldSyncCodexAuth(payload)) {
    await restoreCodexAuthFromR2(appConfig);
  }

  await materializeAttachedFiles(appConfig, workspacePath, payload.chatId, payload.attachmentIds);
  await resetGeneratedFilesDirectory(workspacePath);

  if (payload.engine === "copilot") {
    await ensureCopilotWorkspaceSettings(appConfig, workspacePath, payload.reasoningEffort, payload.enabledMcpServers);
  }

  response.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });

  await new Promise((resolve) => {
    const child = spawnAgent(payload, appConfig, workspacePath);
    const runKey = buildRunKey(payload.appId, payload.chatId);
    const runHandle = createActiveRunHandle({
      key: runKey,
      appId: payload.appId,
      chatId: payload.chatId,
      workspacePath,
      child,
      response,
    });
    let stderrBuffer = "";
    let sawStdout = false;
    let finalized = false;

    const finalize = async (code = 0, processError = null) => {
      if (finalized) {
        return;
      }

      finalized = true;
      unregisterActiveRun(runHandle);
      stopWorkspaceSnapshotWatcher(runHandle);
      const errorMessage = processError?.message?.trim() || stderrBuffer.trim();

      try {
        if (shouldSyncCodexAuth(payload)) {
          await uploadCodexAuthToR2(appConfig);
        }
      } catch (authError) {
        console.error(authError instanceof Error ? authError.message : String(authError));
      }

      if (processError && !response.headersSent) {
        response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        response.end(processError.message);
        resolve();
        return;
      }

      if (runHandle.stopRequested && !response.writableEnded) {
        emitNdjson(response, {
          type: "run_stopped",
          message: runHandle.stopMessage || "Run stopped by user.",
        });
      } else if (code && !response.writableEnded) {
        response.write(
          `${JSON.stringify({
            type: "error",
            message: errorMessage || `Agent process exited with status ${code}.`,
          })}\n`,
        );
      } else if (!sawStdout && errorMessage && !response.writableEnded) {
        response.write(
          `${JSON.stringify({
            type: "error",
            message: errorMessage,
          })}\n`,
        );
      } else if (!response.writableEnded) {
        const generatedFiles = await collectGeneratedFiles(appConfig, workspacePath, payload.chatId);
        for (const file of generatedFiles) {
          response.write(`${JSON.stringify({ type: "generated_file", file })}\n`);
        }
      }

      if (!response.writableEnded) {
        response.end();
      }

      resolve();
    };

    registerActiveRun(runHandle);
    void emitWorkspaceSnapshot(runHandle, { force: false });

    child.stdout.on("data", (chunk) => {
      sawStdout = true;
      response.write(chunk);
    });

    child.stderr.on("data", (chunk) => {
      const message = chunk.toString();
      stderrBuffer += message;
      console.error(message);
    });

    child.on("error", (error) => {
      void finalize(1, error);
    });

    child.on("close", (code) => {
      void finalize(code ?? 0, null);
    });

    if (payload.engine === "codex") {
      child.stdin.write(payload.prompt);
      child.stdin.end();
    }
  });
}

function createActiveRunHandle({ key, appId, chatId, workspacePath, child, response }) {
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  return {
    key,
    appId,
    chatId,
    workspacePath,
    child,
    response,
    stopRequested: false,
    stopMessage: "",
    workspaceEntries: [],
    snapshotTimer: null,
    done,
    resolveDone,
  };
}

function registerActiveRun(runHandle) {
  activeRunsByKey.set(runHandle.key, runHandle);
  runHandle.snapshotTimer = setInterval(() => {
    void emitWorkspaceSnapshot(runHandle, { force: false });
  }, 2_000);
  runHandle.snapshotTimer.unref();
}

function unregisterActiveRun(runHandle) {
  if (activeRunsByKey.get(runHandle.key) === runHandle) {
    activeRunsByKey.delete(runHandle.key);
  }

  runHandle.resolveDone?.();
}

function stopWorkspaceSnapshotWatcher(runHandle) {
  if (runHandle.snapshotTimer) {
    clearInterval(runHandle.snapshotTimer);
    runHandle.snapshotTimer = null;
  }
}

function emitNdjson(response, payload) {
  if (!response.writableEnded) {
    response.write(`${JSON.stringify(payload)}\n`);
  }
}

async function emitWorkspaceSnapshot(runHandle, { force }) {
  const nextEntries = await collectWorkspaceEntries(runHandle.workspacePath);

  if (!force && arraysEqual(nextEntries, runHandle.workspaceEntries)) {
    return;
  }

  const previousEntries = new Set(runHandle.workspaceEntries);
  const nextEntriesSet = new Set(nextEntries);
  const added = nextEntries.filter((entry) => !previousEntries.has(entry));
  const removed = runHandle.workspaceEntries.filter((entry) => !nextEntriesSet.has(entry));
  runHandle.workspaceEntries = nextEntries;

  if (!force && added.length === 0 && removed.length === 0) {
    return;
  }

  emitNdjson(runHandle.response, {
    type: "workspace_snapshot",
    title: "Workspace activity",
    summary: summarizeWorkspaceChange(added, removed, nextEntries),
    added,
    removed,
  });
}

function summarizeWorkspaceChange(added, removed, entries) {
  const parts = [];

  if (added.length > 0) {
    parts.push(`Added: ${added.slice(0, 8).join(", ")}`);
  }

  if (removed.length > 0) {
    parts.push(`Removed: ${removed.slice(0, 8).join(", ")}`);
  }

  if (entries.length > 0) {
    parts.push(`Visible now: ${entries.slice(0, 10).join(", ")}`);
  } else {
    parts.push("Workspace is currently empty.");
  }

  return parts.join(" | ");
}

async function collectWorkspaceEntries(workspacePath) {
  const entries = [];
  await collectWorkspaceEntriesRecursive(workspacePath, "", 0, 2, entries);
  return entries.sort((left, right) => left.localeCompare(right));
}

async function collectWorkspaceEntriesRecursive(rootPath, relativePath, depth, maxDepth, output) {
  let directoryEntries;

  try {
    directoryEntries = await readdir(relativePath ? join(rootPath, relativePath) : rootPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of directoryEntries) {
    const normalizedRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      output.push(`${normalizedRelativePath}/`);

      if (depth >= maxDepth || shouldSkipWorkspaceSnapshotDirectory(entry.name)) {
        continue;
      }

      await collectWorkspaceEntriesRecursive(rootPath, normalizedRelativePath, depth + 1, maxDepth, output);
      continue;
    }

    output.push(normalizedRelativePath);
  }
}

function shouldSkipWorkspaceSnapshotDirectory(name) {
  return [".git", "node_modules", ".next"].includes(name);
}

function arraysEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}

async function ensureAppPaths(appConfig, workspacePath, payloadEnabledServers = null) {
  await mkdir(appConfig.appHome, { recursive: true });
  await mkdir(appConfig.codexHome, { recursive: true });
  await mkdir(appConfig.copilotHome, { recursive: true });
  await mkdir(appConfig.workspaceRoot, { recursive: true });
  await mkdir(workspacePath, { recursive: true });
  await mkdir(join(appConfig.fileLibraryRoot, "chats"), { recursive: true });
  await ensureCodexHomeConfig(appConfig, payloadEnabledServers);
}

function getSelectedMcpServerEntries(appConfig, payloadEnabledServers = null) {
  const prefix = appConfig.copilotMcpEnvPrefix;
  const enabledServersRaw = process.env[`${prefix}_COPILOT_ENABLED_SERVERS`]?.trim() ?? "";
  const envEnabledServers = enabledServersRaw
    ? new Set(
        enabledServersRaw
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      )
    : null;
  const requestEnabledServers = Array.isArray(payloadEnabledServers) && payloadEnabledServers.length > 0
    ? new Set(payloadEnabledServers)
    : null;
  const enabledServers = requestEnabledServers ?? envEnabledServers;
  return Object.entries(DEFAULT_MCP_SERVER_URLS)
    .filter(([name]) => !enabledServers || enabledServers.has(name))
    .map(([name, fallback]) => {
      const envName =
        name === "GithubPerso"
          ? `${prefix}_COPILOT_MCP_GITHUB_URL`
          : name === "DBanalyzer"
            ? `${prefix}_COPILOT_MCP_DBANALYZER_URL`
            : name === "DBworker"
              ? `${prefix}_COPILOT_MCP_DBWORKER_URL`
              : name === "MCPcompetencies"
                ? `${prefix}_COPILOT_MCP_COMPETENCIES_URL`
                : `${prefix}_COPILOT_MCP_MOODLE_URL`;

      return [name, process.env[envName]?.trim() || fallback];
    });
}

function buildCopilotMcpPayload(appConfig, payloadEnabledServers = null) {
  const selectedEntries = getSelectedMcpServerEntries(appConfig, payloadEnabledServers);

  return {
    mcpServers: Object.fromEntries(
      selectedEntries.map(([name, url]) => {
        return [
          name,
          {
            type: "http",
            url,
            tools: ["*"],
          },
        ];
      }),
    ),
  };
}

function buildCodexConfigToml(appConfig, payloadEnabledServers = null) {
  const escapeToml = (value) => String(value).replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
  const lines = [
    `[projects."${escapeToml(runtimeRoot)}"]`,
    'trust_level = "trusted"',
    "",
  ];
  const selectedEntries = getSelectedMcpServerEntries(appConfig, payloadEnabledServers);

  for (const [name, url] of selectedEntries) {
    lines.push(`[mcp_servers.${name}]`);
    lines.push(`url = "${escapeToml(url)}"`);
    lines.push("");
  }

  return `${lines.join("\n").trim()}\n`;
}

async function ensureCodexHomeConfig(appConfig, payloadEnabledServers = null) {
  const configPath = `${appConfig.codexHome}/config.toml`;
  const payload = buildCodexConfigToml(appConfig, payloadEnabledServers);
  await writeFile(configPath, payload, "utf8");
}

async function ensureCopilotWorkspaceSettings(appConfig, workspacePath, reasoningEffort, payloadEnabledServers = null) {
  const settingsDir = `${workspacePath}/.github/copilot`;
  const settingsPath = `${settingsDir}/settings.local.json`;
  const workspaceMcpConfigPath = `${workspacePath}/.mcp.json`;
  const settingsPayload = reasoningEffort ? { effortLevel: reasoningEffort } : {};
  const mcpPayload = buildCopilotMcpPayload(appConfig, payloadEnabledServers);

  await mkdir(settingsDir, { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(settingsPayload, null, 2)}\n`, "utf8");
  await writeFile(workspaceMcpConfigPath, `${JSON.stringify(mcpPayload, null, 2)}\n`, "utf8");
}

async function materializeAttachedFiles(appConfig, workspacePath, chatId, attachmentIds) {
  const attachmentDir = join(workspacePath, "__attached_files__");
  await rm(attachmentDir, { recursive: true, force: true });
  await mkdir(attachmentDir, { recursive: true });

  const manifest = [];
  const usedNames = new Set();

  for (const fileId of attachmentIds) {
    const fileDirectory = getFileDirectory(appConfig, chatId, fileId);
    const metaPath = join(fileDirectory, "meta.json");
    const blobPath = join(fileDirectory, "blob");
    let meta;

    try {
      meta = JSON.parse(await readFile(metaPath, "utf8"));
    } catch {
      continue;
    }

    const targetName = getUniqueAttachmentName(meta.originalName || fileId, usedNames);
    const targetPath = join(attachmentDir, targetName);

    try {
      await symlink(blobPath, targetPath);
    } catch {
      await cp(blobPath, targetPath, { force: true });
    }

    manifest.push({
      ...meta,
      mountedName: targetName,
    });
  }

  await writeFile(join(attachmentDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function resetGeneratedFilesDirectory(workspacePath) {
  const generatedDir = join(workspacePath, "__generated_files__");
  await rm(generatedDir, { recursive: true, force: true });
  await mkdir(generatedDir, { recursive: true });
}

async function collectGeneratedFiles(appConfig, workspacePath, chatId) {
  const generatedDir = join(workspacePath, "__generated_files__");
  let entries = [];

  try {
    entries = await readdir(generatedDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const generatedFiles = [];

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const sourcePath = join(generatedDir, entry.name);
    const sourceStat = await stat(sourcePath);
    const content = await readFile(sourcePath);
    const fileId = randomUUID();
    const fileDirectory = getFileDirectory(appConfig, chatId, fileId);
    const blobPath = join(fileDirectory, "blob");
    const metaPath = join(fileDirectory, "meta.json");
    const originalName = sanitizeDisplayName(entry.name);
    const contentType = detectGeneratedFileContentType(originalName);
    const sha256 = createHash("sha256").update(content).digest("hex");
    const metadata = {
      id: fileId,
      fileId,
      chatId,
      originalName,
      storedName: "blob",
      contentType,
      size: Number(sourceStat.size ?? content.byteLength),
      sha256,
      createdAt: new Date().toISOString(),
    };

    await mkdir(fileDirectory, { recursive: true });
    await cp(sourcePath, blobPath, { force: true });
    await writeFile(metaPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    generatedFiles.push(metadata);
  }

  return generatedFiles;
}

function detectGeneratedFileContentType(filename) {
  const lower = String(filename).toLowerCase();
  if (lower.endsWith(".xml")) {
    return "application/xml";
  }
  if (lower.endsWith(".txt") || lower.endsWith(".aiken")) {
    return "text/plain; charset=utf-8";
  }
  return "application/octet-stream";
}

function getUniqueAttachmentName(inputName, usedNames) {
  const safeName = sanitizeDisplayName(inputName);
  let candidate = safeName;
  let counter = 2;

  while (usedNames.has(candidate)) {
    candidate = `${safeName} (${counter})`;
    counter += 1;
  }

  usedNames.add(candidate);
  return candidate;
}

function sanitizeDisplayName(inputName) {
  const collapsed = basename(String(inputName || "file"))
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

  return collapsed || "file";
}

function parseStopPayload(rawBody) {
  let payload;

  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new Error("Invalid JSON payload.");
  }

  const appId = typeof payload?.appId === "string" ? payload.appId.trim() : "";
  const chatId = typeof payload?.chatId === "string" ? payload.chatId.trim() : "";

  if (!/^[a-zA-Z0-9_-]+$/.test(appId)) {
    throw new Error("Invalid app id.");
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(chatId)) {
    throw new Error("Invalid chat id.");
  }

  return { appId, chatId };
}

function parseCleanupPayload(rawBody) {
  let payload;

  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new Error("Invalid JSON payload.");
  }

  const appId = typeof payload?.appId === "string" ? payload.appId.trim() : "";
  const chatId = typeof payload?.chatId === "string" ? payload.chatId.trim() : "";
  const workspacePath = typeof payload?.workspacePath === "string" && payload.workspacePath.trim() ? payload.workspacePath.trim() : null;
  const codexSessionId = typeof payload?.codexSessionId === "string" && payload.codexSessionId.trim() ? payload.codexSessionId.trim() : null;
  const copilotSessionId =
    typeof payload?.copilotSessionId === "string" && payload.copilotSessionId.trim() ? payload.copilotSessionId.trim() : null;

  if (!/^[a-zA-Z0-9_-]+$/.test(appId)) {
    throw new Error("Invalid app id.");
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(chatId)) {
    throw new Error("Invalid chat id.");
  }

  return {
    appId,
    chatId,
    workspacePath,
    codexSessionId,
    copilotSessionId,
  };
}

function parseCopilotAuthPayload(rawBody) {
  let payload;

  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new Error("Invalid JSON payload.");
  }

  const appId = typeof payload?.appId === "string" ? payload.appId.trim() : "";

  if (!/^[a-zA-Z0-9_-]+$/.test(appId)) {
    throw new Error("Invalid app id.");
  }

  return { appId };
}

function parseCopilotAuthStatusPayload(rawBody) {
  let payload;

  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new Error("Invalid JSON payload.");
  }

  const appId = typeof payload?.appId === "string" ? payload.appId.trim() : "";
  const authSessionId = typeof payload?.authSessionId === "string" ? payload.authSessionId.trim() : "";

  if (!/^[a-zA-Z0-9_-]+$/.test(appId)) {
    throw new Error("Invalid app id.");
  }

  if (!/^[a-f0-9-]{36}$/i.test(authSessionId)) {
    throw new Error("Invalid auth session id.");
  }

  return { appId, authSessionId };
}

async function startCopilotAuthSession(appConfig) {
  const existingSession = activeCopilotAuthSessionsByApp.get(appConfig.id);

  if (existingSession && !isCopilotAuthSessionFinal(existingSession)) {
    return existingSession;
  }

  const session = createCopilotAuthSession(appConfig);
  activeCopilotAuthSessionsByApp.set(appConfig.id, session);
  await mkdir(appConfig.copilotHome, { recursive: true });

  const env = {
    ...process.env,
    HOME: appConfig.appHome,
    COPILOT_HOME: appConfig.copilotHome,
  };

  delete env.COPILOT_GITHUB_TOKEN;
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;

  const child = spawn("script", ["-qefc", `copilot login --config-dir ${shellEscapeForPosix(appConfig.copilotHome)}`, "/dev/null"], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  session.child = child;
  session.acceptedPlaintextStorage = false;

  setTimeout(() => {
    if (session.child === child && !session.completed) {
      try {
        child.stdin.write("y\n");
      } catch {
        // Ignore stdin write failures if the process has already exited.
      }
    }
  }, 1000);

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    session.stdout += text;
    consumeCopilotAuthText(session, text);
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    session.stderr += text;
    consumeCopilotAuthText(session, text);
  });

  child.on("error", (error) => {
    session.status = "failed";
    session.error = error.message;
    session.finishedAt = new Date().toISOString();
    session.child = null;
  });

  child.on("close", (code) => {
    session.finishedAt = new Date().toISOString();
    session.child = null;

    if (code === 0) {
      session.status = "completed";
      session.completed = true;
      return;
    }

    if (session.status !== "failed") {
      session.status = "failed";
      session.error = buildCopilotAuthError(session) || `copilot login exited with status ${code ?? 1}.`;
    }
  });

  await waitForCopilotDeviceCode(session, 2500);
  return session;
}

function createCopilotAuthSession(appConfig) {
  return {
    id: randomUUID(),
    appId: appConfig.id,
    status: "starting",
    deviceCode: null,
    verificationUri: null,
    completed: false,
    error: null,
    stdout: "",
    stderr: "",
    acceptedPlaintextStorage: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    finishedAt: null,
    child: null,
  };
}

function consumeCopilotAuthText(session, text) {
  session.updatedAt = new Date().toISOString();

  const combined = `${session.stdout}\n${session.stderr}`;
  const codeMatch = combined.match(/enter code ([A-Z0-9-]+)\.?/i);
  const urlMatch = combined.match(/https:\/\/github\.com\/login\/device/i);
  const clipboardFailure = /failed to copy to clipboard/i.test(text);

  if (codeMatch) {
    session.deviceCode = codeMatch[1];
  }

  if (urlMatch) {
    session.verificationUri = urlMatch[0];
  }

  if (session.deviceCode && session.verificationUri && session.status === "starting") {
    session.status = "pending_authorization";
  }

  if (/successfully authenticated|login successful|signed in/i.test(combined)) {
    session.status = "completed";
    session.completed = true;
    session.finishedAt = new Date().toISOString();
  }

  if (!session.acceptedPlaintextStorage && /plaintext (configuration|config) file|store .*token.*config/i.test(combined)) {
    session.acceptedPlaintextStorage = true;

    try {
      session.child?.stdin.write("y\n");
    } catch {
      // Ignore stdin write failures if the process already exited.
    }
  }

  if (clipboardFailure && session.deviceCode && session.verificationUri) {
    session.status = "pending_authorization";
    session.error = null;
    return;
  }

  if (/no authentication information found|bad credentials|resource not accessible|denied|timed out/i.test(text) && !session.completed) {
    session.status = "failed";
    session.error = buildCopilotAuthError(session) || text.trim();
    session.finishedAt = new Date().toISOString();
  }
}

function buildCopilotAuthError(session) {
  const combined = `${session.stderr}\n${session.stdout}`;
  const lines = combined
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.find((line) => /error|failed|denied/i.test(line)) ?? null;
}

function isCopilotAuthSessionFinal(session) {
  return session.status === "completed" || session.status === "failed";
}

function serializeCopilotAuthSession(session) {
  return {
    authSessionId: session.id,
    appId: session.appId,
    status: session.status,
    deviceCode: session.deviceCode,
    verificationUri: session.verificationUri,
    completed: session.completed,
    error: session.error,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    finishedAt: session.finishedAt,
  };
}

function shellEscapeForPosix(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

async function waitForCopilotDeviceCode(session, timeoutMs) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (session.deviceCode || session.status === "failed" || session.status === "completed") {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function handleStopRequest(payload, response) {
  const runHandle = activeRunsByKey.get(buildRunKey(payload.appId, payload.chatId));

  if (!runHandle) {
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: true, stopped: false }));
    return;
  }

  await stopRunHandle(runHandle, "Run stopped by user.");
  response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ ok: true, stopped: true }));
}

async function stopRunHandle(runHandle, message) {
  if (runHandle.stopRequested) {
    await runHandle.done;
    return;
  }

  runHandle.stopRequested = true;
  runHandle.stopMessage = message;

  try {
    runHandle.child.kill("SIGTERM");
  } catch {
    // Ignore kill failures if the process already exited.
  }

  const forceKillTimer = setTimeout(() => {
    if (activeRunsByKey.get(runHandle.key) === runHandle) {
      try {
        runHandle.child.kill("SIGKILL");
      } catch {
        // Ignore kill failures if the process already exited.
      }
    }
  }, 5_000);
  forceKillTimer.unref();

  await runHandle.done;
}

async function handleCleanupRequest(payload, appConfig, response) {
  const runHandle = activeRunsByKey.get(buildRunKey(payload.appId, payload.chatId));

  if (runHandle) {
    await stopRunHandle(runHandle, "Run stopped because the chat was deleted.");
  }

  const workspacePath = resolveWorkspaceCleanupPath(appConfig, payload.chatId, payload.workspacePath);
  const deletedWorkspace = await removePathIfPresent(workspacePath);
  const deletedFileLibrary = await removePathIfPresent(join(appConfig.fileLibraryRoot, "chats", payload.chatId));
  const deletedCodexSessionFiles = await purgeCodexSessionArtifacts(appConfig, payload, workspacePath);
  const { deletedDirectories: deletedCopilotSessionDirs, deletedLogFiles: deletedCopilotLogFiles } =
    await purgeCopilotSessionArtifacts(appConfig, payload, workspacePath);

  response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  response.end(
    JSON.stringify({
      ok: true,
      deletedWorkspace,
      deletedFileLibrary,
      deletedCodexSessionFiles,
      deletedCopilotSessionDirs,
      deletedCopilotLogFiles,
    }),
  );
}

function resolveWorkspaceCleanupPath(appConfig, chatId, workspacePath) {
  const fallbackWorkspacePath = buildWorkspacePath(appConfig, chatId);

  if (!workspacePath) {
    return fallbackWorkspacePath;
  }

  const resolvedWorkspaceRoot = resolve(appConfig.workspaceRoot);
  const resolvedWorkspacePath = resolve(workspacePath);
  const relativeWorkspacePath = relative(resolvedWorkspaceRoot, resolvedWorkspacePath);

  if (isAbsolute(relativeWorkspacePath) || relativeWorkspacePath.startsWith("..")) {
    throw new Error("Workspace cleanup path is outside the application workspace root.");
  }

  return resolvedWorkspacePath;
}

async function removePathIfPresent(targetPath) {
  await rm(targetPath, { recursive: true, force: true });
  return true;
}

async function purgeCodexSessionArtifacts(appConfig, payload, workspacePath) {
  const sessionRoot = join(appConfig.codexHome, "sessions");
  const markers = [payload.chatId, workspacePath, payload.codexSessionId].filter(Boolean);

  if (markers.length === 0) {
    return 0;
  }

  return removeFilesByPredicate(sessionRoot, async (filePath) => {
    if (!filePath.endsWith(".jsonl")) {
      return false;
    }

    if (payload.codexSessionId && filePath.includes(payload.codexSessionId)) {
      return true;
    }

    const content = await safeReadUtf8(filePath);
    return markers.some((marker) => content.includes(marker));
  });
}

async function purgeCopilotSessionArtifacts(appConfig, payload, workspacePath) {
  const sessionStateRoot = join(appConfig.copilotHome, "session-state");
  const directoriesToDelete = new Set();
  const markers = [payload.chatId, workspacePath].filter(Boolean);

  if (payload.copilotSessionId) {
    directoriesToDelete.add(join(sessionStateRoot, payload.copilotSessionId));
  }

  for (const directoryPath of await findCopilotSessionDirectories(sessionStateRoot)) {
    const workspaceFilePath = join(directoryPath, "workspace.yaml");
    const content = await safeReadUtf8(workspaceFilePath);

    if (markers.some((marker) => content.includes(marker))) {
      directoriesToDelete.add(directoryPath);
    }
  }

  let deletedDirectories = 0;

  for (const directoryPath of directoriesToDelete) {
    await rm(directoryPath, { recursive: true, force: true });
    deletedDirectories += 1;
  }

  const deletedLogFiles = await removeFilesByPredicate(join(appConfig.copilotHome, "logs"), async (filePath) => {
    const content = await safeReadUtf8(filePath);
    return [payload.chatId, workspacePath, payload.copilotSessionId].filter(Boolean).some((marker) => content.includes(marker));
  });

  return { deletedDirectories, deletedLogFiles };
}

async function findCopilotSessionDirectories(sessionStateRoot) {
  let entries = [];

  try {
    entries = await readdir(sessionStateRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries.filter((entry) => entry.isDirectory()).map((entry) => join(sessionStateRoot, entry.name));
}

async function removeFilesByPredicate(rootPath, predicate) {
  let entries = [];

  try {
    entries = await readdir(rootPath, { withFileTypes: true });
  } catch {
    return 0;
  }

  let deletedCount = 0;

  for (const entry of entries) {
    const targetPath = join(rootPath, entry.name);

    if (entry.isDirectory()) {
      deletedCount += await removeFilesByPredicate(targetPath, predicate);
      continue;
    }

    if (await predicate(targetPath)) {
      await rm(targetPath, { force: true });
      deletedCount += 1;
    }
  }

  return deletedCount;
}

async function safeReadUtf8(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function spawnAgent(payload, appConfig, workspacePath) {
  const runtimeEnv = {
    ...process.env,
    HOME: appConfig.appHome,
    CODEX_HOME: appConfig.codexHome,
    COPILOT_HOME: appConfig.copilotHome,
  };

  if (payload.engine === "copilot") {
    applyCopilotAuthEnv(runtimeEnv, appConfig);
    const execArgs = [
      "--config-dir",
      appConfig.copilotHome,
      "--output-format=json",
      "--allow-all",
      "--no-ask-user",
      "--model",
      payload.model,
    ];

    if (payload.sessionId) {
      execArgs.push("--resume", payload.sessionId);
    }

    execArgs.push("-p", payload.prompt);

    return spawn("copilot", execArgs, {
      cwd: workspacePath,
      env: runtimeEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  const execArgs = payload.sessionId
    ? ["exec", "resume", payload.sessionId, "--skip-git-repo-check", "--json", "-"]
    : ["exec", "--skip-git-repo-check", "--json", "-"];
  const insertIndex = payload.sessionId ? 3 : 1;

  if (payload.allowBypassSandbox) {
    execArgs.splice(insertIndex, 0, "--dangerously-bypass-approvals-and-sandbox");
  }

  if (payload.model) {
    execArgs.splice(insertIndex, 0, "--model", payload.model);
  }

  if (payload.reasoningEffort) {
    execArgs.splice(insertIndex, 0, "-c", `reasoning_effort="${payload.reasoningEffort}"`);
  }

  return spawn("codex", ["-C", workspacePath, ...execArgs], {
    env: runtimeEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function applyCopilotAuthEnv(runtimeEnv, appConfig) {
  const appScopedToken = process.env[buildAppScopedCopilotTokenEnvName(appConfig.id)]?.trim() ?? "";
  const genericCopilotToken = process.env.COPILOT_GITHUB_TOKEN?.trim() ?? "";
  const selectedToken = appScopedToken || genericCopilotToken;

  if (selectedToken) {
    runtimeEnv.COPILOT_GITHUB_TOKEN = selectedToken;
  } else {
    delete runtimeEnv.COPILOT_GITHUB_TOKEN;
  }

  // Copilot CLI checks COPILOT_GITHUB_TOKEN first, then GH_TOKEN, then GITHUB_TOKEN.
  // Removing lower-priority tokens avoids accidental fallback to an unsupported or stale token.
  delete runtimeEnv.GH_TOKEN;
  delete runtimeEnv.GITHUB_TOKEN;
}

function buildAppScopedCopilotTokenEnvName(appId) {
  const normalized = String(appId)
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return `${normalized}_COPILOT_GITHUB_TOKEN`;
}

function shouldSerializeCodexRuns(payload) {
  return shouldSyncCodexAuth(payload);
}

function shouldSyncCodexAuth(payload) {
  return payload.engine === "codex" && Boolean(r2Bucket && r2Endpoint && r2AccessKeyId && r2SecretAccessKey);
}

function enqueueSerializedRun(queueKey, task) {
  const previous = runQueueByKey.get(queueKey) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  const tail = next.finally(() => {
    if (runQueueByKey.get(queueKey) === tail) {
      runQueueByKey.delete(queueKey);
    }
  });
  runQueueByKey.set(queueKey, tail);
  return next;
}

function authObjectKeyForApp(appId) {
  const envName = `${appId.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase().replace(/^_+|_+$/g, "")}_CODEX_AUTH_OBJECT_KEY`;
  const override = process.env[envName]?.trim();
  if (override) {
    return override;
  }

  return `${r2AuthPrefix.replace(/\/+$/, "")}/${appId}/auth.json`;
}

function authAwsEnv() {
  return {
    ...process.env,
    AWS_ACCESS_KEY_ID: r2AccessKeyId,
    AWS_SECRET_ACCESS_KEY: r2SecretAccessKey,
    AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION ?? "auto",
    AWS_EC2_METADATA_DISABLED: "true",
  };
}

function runAwsCommand(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("aws", args, {
      env: authAwsEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(stderr.trim() || stdout.trim() || `aws exited with status ${code}`));
    });
  });
}

async function restoreCodexAuthFromR2(appConfig) {
  const authPath = `${appConfig.codexHome}/auth.json`;
  const tempPath = `${authPath}.download`;
  const objectKey = authObjectKeyForApp(appConfig.id);

  await mkdir(appConfig.codexHome, { recursive: true });
  await rm(tempPath, { force: true });

  try {
    await runAwsCommand([
      "s3",
      "cp",
      `s3://${r2Bucket}/${objectKey}`,
      tempPath,
      "--endpoint-url",
      r2Endpoint,
      "--only-show-errors",
    ]);
    await rename(tempPath, authPath);
    await chmodSafe(authPath, 0o600);
  } catch (error) {
    await rm(tempPath, { force: true });
    console.error(`R2 auth restore skipped for ${appConfig.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function uploadCodexAuthToR2(appConfig) {
  const authPath = `${appConfig.codexHome}/auth.json`;
  const objectKey = authObjectKeyForApp(appConfig.id);

  try {
    await stat(authPath);
  } catch {
    return;
  }

  await runAwsCommand([
    "s3",
    "cp",
    authPath,
    `s3://${r2Bucket}/${objectKey}`,
    "--endpoint-url",
    r2Endpoint,
    "--only-show-errors",
  ]);
}

async function chmodSafe(filePath, mode) {
  try {
    await chmod(filePath, mode);
  } catch {
    // Ignore chmod failures on environments that don't support POSIX permissions.
  }
}

function validateSignedRequest({ method, path, headers, rawBody }) {
  const keyId = headers["x-proxy-key-id"];
  const timestamp = headers["x-proxy-timestamp"];
  const nonce = headers["x-proxy-nonce"];
  const bodyHash = headers["x-proxy-body-sha256"];
  const signature = headers["x-proxy-signature"];

  if (!keyId || !timestamp || !nonce || !bodyHash || !signature) {
    return { status: 401, message: "Missing proxy signature headers." };
  }

  const secret = keyRegistry.get(keyId);

  if (!secret) {
    return { status: 401, message: "Unknown proxy key id." };
  }

  const timestampNumber = Number.parseInt(timestamp, 10);

  if (!Number.isFinite(timestampNumber)) {
    return { status: 401, message: "Invalid proxy timestamp." };
  }

  const now = Math.floor(Date.now() / 1000);

  if (Math.abs(now - timestampNumber) > maxSkewSeconds) {
    return { status: 401, message: "Expired proxy timestamp." };
  }

  if (!/^[a-f0-9]{32}$/i.test(nonce)) {
    return { status: 401, message: "Invalid proxy nonce." };
  }

  if (nonceCache.has(`${keyId}:${nonce}`)) {
    return { status: 409, message: "Replayed proxy nonce." };
  }

  const actualBodyHash = createHash("sha256").update(rawBody).digest("hex");

  if (bodyHash !== actualBodyHash) {
    return { status: 401, message: "Invalid body hash." };
  }

  const signaturePayload = [method.toUpperCase(), path, timestamp, nonce, bodyHash].join("\n");
  const expectedSignature = createHmac("sha256", secret).update(signaturePayload).digest("hex");

  if (!safeEqual(signature, expectedSignature)) {
    return { status: 401, message: "Invalid proxy signature." };
  }

  nonceCache.set(`${keyId}:${nonce}`, Date.now() + nonceTtlSeconds * 1000);
  return null;
}

function validateUploadRequest(request, requestUrl) {
  const uploadToken = typeof request.headers["x-upload-token"] === "string" ? request.headers["x-upload-token"] : "";
  const filenameHeader = typeof request.headers["x-upload-filename"] === "string" ? request.headers["x-upload-filename"] : "";
  const contentTypeHeader = typeof request.headers["x-upload-content-type"] === "string" ? request.headers["x-upload-content-type"] : "";

  if (!uploadToken) {
    throw new Error("Missing upload token.");
  }

  const parsedToken = parseUploadToken(uploadToken);
  const appId = requestUrl.searchParams.get("appId")?.trim() ?? "";
  const chatId = requestUrl.searchParams.get("chatId")?.trim() ?? "";
  const fileId = requestUrl.searchParams.get("fileId")?.trim() ?? "";

  if (
    parsedToken.appId !== appId ||
    parsedToken.chatId !== chatId ||
    parsedToken.fileId !== fileId
  ) {
    throw new Error("Upload token does not match request target.");
  }

  return {
    appId,
    chatId,
    fileId,
    filename: decodeURIComponent(filenameHeader || parsedToken.filename),
    contentType: contentTypeHeader || parsedToken.contentType || "application/octet-stream",
    expectedSize: parsedToken.size,
  };
}

function parseUploadToken(token) {
  const [encodedPayload, signature] = String(token).split(".");

  if (!encodedPayload || !signature) {
    throw new Error("Invalid upload token.");
  }

  const serializedPayload = Buffer.from(encodedPayload, "base64url").toString("utf8");
  let payload;

  try {
    payload = JSON.parse(serializedPayload);
  } catch {
    throw new Error("Invalid upload token payload.");
  }

  const matchedSecret = Array.from(keyRegistry.values()).find((secret) => {
    const expectedSignature = createHmac("sha256", secret).update(serializedPayload).digest("base64url");
    return safeEqual(signature, expectedSignature);
  });

  if (!matchedSecret) {
    throw new Error("Invalid upload token signature.");
  }

  if (payload?.v !== "v1") {
    throw new Error("Unsupported upload token version.");
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(payload?.appId ?? "")) {
    throw new Error("Invalid upload token app id.");
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(payload?.chatId ?? "")) {
    throw new Error("Invalid upload token chat id.");
  }

  if (!/^[a-f0-9-]{36}$/i.test(payload?.fileId ?? "")) {
    throw new Error("Invalid upload token file id.");
  }

  if (typeof payload.exp !== "number" || Math.floor(Date.now() / 1000) > payload.exp) {
    throw new Error("Expired upload token.");
  }

  return payload;
}

async function streamUploadToDisk(request, fileDirectory, upload) {
  await mkdir(fileDirectory, { recursive: true });
  const tempPath = join(fileDirectory, "blob.uploading");
  const blobPath = join(fileDirectory, "blob");
  const metaPath = join(fileDirectory, "meta.json");
  await rm(tempPath, { force: true });

  const hash = createHash("sha256");
  let size = 0;

  await new Promise((resolve, reject) => {
    const output = createWriteStream(tempPath);

    request.on("data", (chunk) => {
      size += chunk.length;

      if (chatUploadMaxBytes > 0 && size > chatUploadMaxBytes) {
        request.destroy(new Error(`Upload exceeds the configured limit of ${chatUploadMaxBytes} bytes.`));
        return;
      }

      if (typeof upload.expectedSize === "number" && upload.expectedSize >= 0 && size > upload.expectedSize) {
        request.destroy(new Error("Upload exceeds ticket size."));
        return;
      }

      hash.update(chunk);
    });

    request.on("error", reject);
    output.on("error", reject);
    output.on("finish", resolve);
    request.pipe(output);
  }).catch(async (error) => {
    await rm(tempPath, { force: true });
    throw error;
  });

  if (typeof upload.expectedSize === "number" && upload.expectedSize >= 0 && size !== upload.expectedSize) {
    await rm(tempPath, { force: true });
    throw new Error("Upload size does not match ticket size.");
  }

  const sha256 = hash.digest("hex");
  const metadata = {
    id: upload.fileId,
    chatId: upload.chatId,
    originalName: sanitizeDisplayName(upload.filename),
    storedName: "blob",
    contentType: upload.contentType,
    size,
    sha256,
    createdAt: new Date().toISOString(),
  };

  await rename(tempPath, blobPath);
  await writeFile(metaPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

  return {
    ok: true,
    fileId: upload.fileId,
    size,
    sha256,
  };
}

function writeCorsHeaders(response, origin) {
  response.setHeader("Access-Control-Allow-Origin", origin || "*");
  response.setHeader("Access-Control-Allow-Methods", "PUT, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Upload-Token, X-Upload-Filename, X-Upload-Content-Type");
  response.setHeader("Vary", "Origin");
}

function normalizeHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.join(",") : value]),
  );
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    request.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function cleanExpiredNonces() {
  const now = Date.now();

  for (const [nonceKey, expiresAt] of nonceCache.entries()) {
    if (expiresAt <= now) {
      nonceCache.delete(nonceKey);
    }
  }
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}
