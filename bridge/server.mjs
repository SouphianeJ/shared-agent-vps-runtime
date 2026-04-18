import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

const port = Number.parseInt(process.env.PORT ?? "11437", 10);
const host = process.env.HOST ?? "127.0.0.1";
const maxSkewSeconds = Number.parseInt(process.env.PROXY_MAX_SKEW_SECONDS ?? "90", 10);
const nonceTtlSeconds = Number.parseInt(process.env.PROXY_NONCE_TTL_SECONDS ?? "120", 10);
const runtimeRoot = process.env.RUNTIME_ROOT ?? "/runtime";
const runtimeAppsConfigPath = process.env.RUNTIME_APPS_CONFIG ?? "/app/config/apps.json";
const defaultModel = process.env.CODEX_MODEL ?? "";
const allowDangerousDefault = /^(1|true|yes|on)$/i.test(process.env.CODEX_ALLOW_DANGEROUS ?? "true");

const keyRegistry = new Map();
const nonceCache = new Map();
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

    if (request.url === "/codex/health" && request.method === "GET") {
      const rawBody = Buffer.alloc(0);
      const headers = normalizeHeaders(request.headers);
      const validationError = validateSignedRequest({
        method: request.method,
        path: request.url,
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

    if (request.url !== "/codex/run" || request.method !== "POST") {
      response.writeHead(404).end("Not found");
      return;
    }

    const rawBody = await readRequestBody(request);
    const headers = normalizeHeaders(request.headers);
    const validationError = validateSignedRequest({
      method: request.method,
      path: request.url,
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

    await ensureAppPaths(appConfig, workspacePath);

    if (payload.engine === "copilot") {
      await ensureCopilotWorkspaceSettings(appConfig, workspacePath, payload.reasoningEffort);
    }

    response.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });

    const child = spawnAgent(payload, appConfig, workspacePath);
    let stderrBuffer = "";
    let sawStdout = false;

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
      if (!response.headersSent) {
        response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      }

      response.end(error.message);
    });

    child.on("close", (code) => {
      const errorMessage = stderrBuffer.trim();

      if (code && !response.writableEnded) {
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
      }

      response.end();
    });

    if (payload.engine === "codex") {
      child.stdin.write(payload.prompt);
      child.stdin.end();
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

      return [
        appId,
        {
          id: appId,
          displayName: String(app.displayName ?? appId),
          copilotMcpEnvPrefix: String(app.copilotMcpEnvPrefix ?? "").trim(),
          appHome: buildRuntimePath(String(app.paths?.appHome ?? "")),
          codexHome: buildRuntimePath(String(app.paths?.codexHome ?? "")),
          copilotHome: buildRuntimePath(String(app.paths?.copilotHome ?? "")),
          workspaceRoot: buildRuntimePath(String(app.paths?.workspaceRoot ?? "")),
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
  };
}

function buildWorkspacePath(appConfig, chatId) {
  return `${appConfig.workspaceRoot.replace(/\/+$/, "")}/${chatId}`;
}

async function ensureAppPaths(appConfig, workspacePath) {
  await mkdir(appConfig.appHome, { recursive: true });
  await mkdir(appConfig.codexHome, { recursive: true });
  await mkdir(appConfig.copilotHome, { recursive: true });
  await mkdir(appConfig.workspaceRoot, { recursive: true });
  await mkdir(workspacePath, { recursive: true });
}

function buildCopilotMcpPayload(appConfig) {
  const prefix = appConfig.copilotMcpEnvPrefix;
  const defaults = {
    GithubPerso: "https://mcp-github-client-proxy.vercel.app/mcp",
    DBanalyzer: "https://mcp-dbanalyzer-client-proxy.vercel.app/mcp",
    DBworker: "https://mcp-dbworker-client-proxy.vercel.app/mcp",
    MCPcompetencies: "https://mcp-personal-competencies-client-pr.vercel.app/mcp",
    Moodle: "https://mcp-moodle-client-proxy.vercel.app/mcp",
  };
  const enabledServersRaw = process.env[`${prefix}_COPILOT_ENABLED_SERVERS`]?.trim() ?? "";
  const enabledServers = enabledServersRaw
    ? new Set(
        enabledServersRaw
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      )
    : null;
  const selectedEntries = Object.entries(defaults).filter(([name]) => !enabledServers || enabledServers.has(name));

  return {
    mcpServers: Object.fromEntries(
      selectedEntries.map(([name, fallback]) => {
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

        return [
          name,
          {
            type: "http",
            url: process.env[envName]?.trim() || fallback,
            tools: ["*"],
          },
        ];
      }),
    ),
  };
}

async function ensureCopilotWorkspaceSettings(appConfig, workspacePath, reasoningEffort) {
  const settingsDir = `${workspacePath}/.github/copilot`;
  const settingsPath = `${settingsDir}/settings.local.json`;
  const workspaceMcpConfigPath = `${workspacePath}/.mcp.json`;
  const settingsPayload = reasoningEffort ? { effortLevel: reasoningEffort } : {};
  const mcpPayload = buildCopilotMcpPayload(appConfig);

  await mkdir(settingsDir, { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(settingsPayload, null, 2)}\n`, "utf8");
  await writeFile(workspaceMcpConfigPath, `${JSON.stringify(mcpPayload, null, 2)}\n`, "utf8");
}

function spawnAgent(payload, appConfig, workspacePath) {
  const runtimeEnv = {
    ...process.env,
    HOME: appConfig.appHome,
    CODEX_HOME: appConfig.codexHome,
    COPILOT_HOME: appConfig.copilotHome,
  };

  if (payload.engine === "copilot") {
    const execArgs = [
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
