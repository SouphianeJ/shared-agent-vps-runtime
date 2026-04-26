import { createServer } from "node:http";
import { spawn } from "node:child_process";

import { loadAppRegistry } from "./lib/apps.mjs";
import { handleCleanupRequest } from "./lib/cleanup.mjs";
import {
  applyCopilotAuthEnv,
  refreshCopilotAuthSessionStatus,
  serializeCopilotAuthSession,
  startCopilotAuthSession,
} from "./lib/copilot-auth.mjs";
import { ensureAppPaths, ensureCopilotWorkspaceSettings } from "./lib/mcp-config.mjs";
import {
  parseCleanupPayload,
  parseCopilotAuthPayload,
  parseCopilotAuthStatusPayload,
  parseFileDeletePayload,
  parsePayload,
  parseStopPayload,
} from "./lib/payloads.mjs";
import {
  enqueueSerializedRun,
  restoreCodexAuthFromR2,
  shouldSerializeCodexRuns,
  shouldSyncCodexAuth,
  uploadCodexAuthToR2,
} from "./lib/r2-auth.mjs";
import {
  cleanExpiredNonces,
  normalizeHeaders,
  readRequestBody,
  registerKey,
  validateSignedRequest,
  validateUploadRequest,
  writeCorsHeaders,
} from "./lib/security.mjs";
import {
  buildWorkspacePath,
  collectGeneratedFiles,
  createActiveRunHandle,
  emitNdjson,
  emitWorkspaceSnapshot,
  getFileDirectory,
  materializeAttachedFiles,
  registerActiveRun,
  resetGeneratedFilesDirectory,
  stopWorkspaceSnapshotWatcher,
  streamUploadToDisk,
  unregisterActiveRun,
} from "./lib/workspace.mjs";

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
const appRegistryPromise = loadAppRegistry(runtimeAppsConfigPath, runtimeRoot);
const r2Options = {
  r2Bucket,
  r2Endpoint,
  r2AccessKeyId,
  r2SecretAccessKey,
  r2AuthPrefix,
};

registerKey(keyRegistry, process.env.PROXY_KEY_ID_ACTIVE, process.env.PROXY_SIGNING_KEY_ACTIVE);
registerKey(keyRegistry, process.env.PROXY_KEY_ID_PREVIOUS, process.env.PROXY_SIGNING_KEY_PREVIOUS);

if (keyRegistry.size === 0) {
  throw new Error("No proxy signing keys configured.");
}

setInterval(() => cleanExpiredNonces(nonceCache), 30_000).unref();

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
        keyRegistry,
        nonceCache,
        maxSkewSeconds,
        nonceTtlSeconds,
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
      const upload = validateUploadRequest(request, requestUrl, keyRegistry);
      const appConfig = await resolveAppConfig(upload.appId);
      const fileDirectory = getFileDirectory(appConfig, upload.chatId, upload.fileId);
      const writtenFile = await streamUploadToDisk(request, fileDirectory, upload, { chatUploadMaxBytes });

      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(writtenFile));
      return;
    }

    if (requestUrl.pathname === "/codex/files" && request.method === "DELETE") {
      const rawBody = await readSignedBody(request, requestUrl.pathname);
      const payload = parseFileDeletePayload(rawBody);
      const appConfig = await resolveAppConfig(payload.appId);
      await rmFileDirectory(appConfig, payload.chatId, payload.fileId);

      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: true, fileId: payload.fileId }));
      return;
    }

    if (requestUrl.pathname === "/codex/runs/stop" && request.method === "POST") {
      const rawBody = await readSignedBody(request, requestUrl.pathname);
      const payload = parseStopPayload(rawBody);
      await resolveAppConfig(payload.appId);
      await handleStopRequest(payload, response);
      return;
    }

    if (requestUrl.pathname === "/codex/chats/cleanup" && request.method === "POST") {
      const rawBody = await readSignedBody(request, requestUrl.pathname);
      const payload = parseCleanupPayload(rawBody);
      const appConfig = await resolveAppConfig(payload.appId);
      await handleCleanupRequest(payload, appConfig, response, activeRunsByKey, buildRunKey, stopRunHandle);
      return;
    }

    if (requestUrl.pathname === "/codex/copilot-auth/start" && request.method === "POST") {
      const rawBody = await readSignedBody(request, requestUrl.pathname);
      const payload = parseCopilotAuthPayload(rawBody);
      const appConfig = await resolveAppConfig(payload.appId);
      const session = await startCopilotAuthSession(appConfig, activeCopilotAuthSessionsByApp);
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(serializeCopilotAuthSession(session)));
      return;
    }

    if (requestUrl.pathname === "/codex/copilot-auth/status" && request.method === "POST") {
      const rawBody = await readSignedBody(request, requestUrl.pathname);
      const payload = parseCopilotAuthStatusPayload(rawBody);
      const appConfig = await resolveAppConfig(payload.appId);
      const session = activeCopilotAuthSessionsByApp.get(payload.appId);

      if (!session || session.id !== payload.authSessionId) {
        response.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: "Copilot auth session not found." }));
        return;
      }

      await refreshCopilotAuthSessionStatus(session, appConfig);

      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(serializeCopilotAuthSession(session)));
      return;
    }

    if (requestUrl.pathname !== "/codex/run" || request.method !== "POST") {
      response.writeHead(404).end("Not found");
      return;
    }

    const rawBody = await readSignedBody(request, requestUrl.pathname);
    const payload = parsePayload(rawBody, { defaultModel, allowDangerousDefault });
    const appConfig = await resolveAppConfig(payload.appId);
    const workspacePath = buildWorkspacePath(appConfig, payload.chatId);
    const runHandler = () => handleRunRequest(payload, appConfig, workspacePath, response);

    if (shouldSerializeCodexRuns(payload, r2Options)) {
      await enqueueSerializedRun(runQueueByKey, `codex:${payload.appId}`, runHandler);
    } else {
      await runHandler();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected bridge error";
    const statusCode =
      typeof error === "object" && error !== null && "statusCode" in error && Number.isInteger(error.statusCode)
        ? error.statusCode
        : 502;
    response.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(message);
  }
});

server.listen(port, host, () => {
  console.log(`shared-agent-runtime bridge listening on ${host}:${port}`);
});

async function resolveAppConfig(appId) {
  const registry = await appRegistryPromise;
  const app = registry.get(appId);

  if (!app) {
    throw new Error(`Unknown app id: ${appId}`);
  }

  return app;
}

function buildRunKey(appId, chatId) {
  return `${appId}:${chatId}`;
}

async function readSignedBody(request, path) {
  const rawBody = await readRequestBody(request);
  const headers = normalizeHeaders(request.headers);
  const validationError = validateSignedRequest({
    method: request.method,
    path,
    headers,
    rawBody,
    keyRegistry,
    nonceCache,
    maxSkewSeconds,
    nonceTtlSeconds,
  });

  if (validationError) {
    const error = new Error(validationError.message);
    error.statusCode = validationError.status;
    throw error;
  }

  return rawBody;
}

async function rmFileDirectory(appConfig, chatId, fileId) {
  const { rm } = await import("node:fs/promises");
  await rm(getFileDirectory(appConfig, chatId, fileId), { recursive: true, force: true });
}

async function handleRunRequest(payload, appConfig, workspacePath, response) {
  await ensureAppPaths(appConfig, workspacePath, {
    payloadEnabledServers: payload.enabledMcpServers,
    includeBrowserMcp: payload.includeBrowserMcp,
    runtimeRoot,
  });

  if (shouldSyncCodexAuth(payload, r2Options)) {
    await restoreCodexAuthFromR2(appConfig, r2Options);
  }

  await materializeAttachedFiles(appConfig, workspacePath, payload.chatId, payload.attachmentIds);
  await resetGeneratedFilesDirectory(workspacePath);

  if (payload.engine === "copilot") {
    await ensureCopilotWorkspaceSettings(appConfig, workspacePath, payload.reasoningEffort, {
      payloadEnabledServers: payload.enabledMcpServers,
      includeBrowserMcp: payload.includeBrowserMcp,
    });
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
      unregisterActiveRun(activeRunsByKey, runHandle);
      stopWorkspaceSnapshotWatcher(runHandle);
      const errorMessage = processError?.message?.trim() || stderrBuffer.trim();

      try {
        if (shouldSyncCodexAuth(payload, r2Options)) {
          await uploadCodexAuthToR2(appConfig, r2Options);
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

    registerActiveRun(activeRunsByKey, runHandle);
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
