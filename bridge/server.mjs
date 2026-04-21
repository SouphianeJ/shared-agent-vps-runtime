import { createWriteStream } from "node:fs";
import { cp, mkdir, readdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
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

    await ensureAppPaths(appConfig, workspacePath, payload.enabledMcpServers);
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

    child.on("close", async (code) => {
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
      } else if (!response.writableEnded) {
        const generatedFiles = await collectGeneratedFiles(appConfig, workspacePath, payload.chatId);
        for (const file of generatedFiles) {
          response.write(`${JSON.stringify({ type: "generated_file", file })}\n`);
        }
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

function getFileDirectory(appConfig, chatId, fileId) {
  return join(appConfig.fileLibraryRoot, "chats", chatId, fileId);
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
