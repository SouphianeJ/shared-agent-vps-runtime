import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { chromium } from "playwright";

const port = Number.parseInt(process.env.BROWSER_PROVISIONER_PORT ?? "11438", 10);
const host = process.env.BROWSER_PROVISIONER_HOST ?? "0.0.0.0";
const headless = !/^(0|false|no|off)$/i.test(process.env.BROWSER_PROVISIONER_HEADLESS ?? "true");
const displayName = process.env.BROWSER_PROVISIONER_DISPLAY?.trim() || ":99";
const screenSize = process.env.BROWSER_PROVISIONER_SCREEN_SIZE?.trim() || "1440x960x24";
const rfbPort = Number.parseInt(process.env.BROWSER_PROVISIONER_RFB_PORT ?? "5900", 10);
const noVncPort = Number.parseInt(process.env.BROWSER_PROVISIONER_NOVNC_PORT ?? "6080", 10);
const publicBaseUrl = process.env.BROWSER_PROVISIONER_PUBLIC_BASE_URL?.trim().replace(/\/+$/, "") || "";
const browserStatePrefix = process.env.R2_BROWSER_STATE_PREFIX?.trim().replace(/^\/+|\/+$/g, "") || "browser-storage-state";
const r2Bucket = process.env.R2_BUCKET?.trim() || "";
const r2Endpoint = process.env.R2_ENDPOINT?.trim() || "";
const r2AccessKeyId = process.env.R2_ACCESS_KEY_ID?.trim() || process.env.AWS_ACCESS_KEY_ID?.trim() || "";
const r2SecretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim() || process.env.AWS_SECRET_ACCESS_KEY?.trim() || "";

const sessions = new Map();
let sharedBrowserPromise;
let displayStatePromise;
let remoteDesktopStatePromise;

function json(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function requireObject(value) {
  return value && typeof value === "object" ? value : null;
}

function getString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function sanitizeSegment(input) {
  return String(input || "unknown")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";
}

function sanitizeFileName(input) {
  const normalized = basename(String(input || "state.json"))
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!normalized) {
    return "state.json";
  }

  return normalized.toLowerCase().endsWith(".json") ? normalized : `${normalized}.json`;
}

function requireR2Config() {
  if (!r2Bucket || !r2Endpoint || !r2AccessKeyId || !r2SecretAccessKey) {
    throw new Error("Missing R2 configuration for browser provisioner.");
  }
}

function getS3Client() {
  requireR2Config();
  return new S3Client({
    region: "auto",
    endpoint: r2Endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: r2AccessKeyId,
      secretAccessKey: r2SecretAccessKey,
    },
  });
}

function stateObjectKey(appId, siteScope, accountAlias) {
  return [
    browserStatePrefix,
    sanitizeSegment(appId),
    sanitizeSegment(siteScope),
    sanitizeSegment(accountAlias || "default"),
    "latest.json",
  ].join("/");
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function ensureSharedBrowser() {
  if (!headless) {
    await ensureVirtualDisplay();
  }

  if (!sharedBrowserPromise) {
    sharedBrowserPromise = chromium.launch({
      headless,
      args: ["--disable-dev-shm-usage", "--no-sandbox"],
    });
  }

  return sharedBrowserPromise;
}

function buildSessionRoot(appHome, sessionId) {
  return join(appHome, "browser-provisioner", "sessions", sessionId);
}

function buildStatePath(sessionRoot) {
  return join(sessionRoot, "storage-state", "latest.json");
}

function buildScreenshotPath(sessionRoot) {
  return join(sessionRoot, "screenshots", "latest.png");
}

async function ensureSessionDirectories(session) {
  await mkdir(join(session.sessionRoot, "storage-state"), { recursive: true });
  await mkdir(join(session.sessionRoot, "screenshots"), { recursive: true });
}

async function createSessionContext(session, storageStatePath = null) {
  const browser = await ensureSharedBrowser();
  session.context = await browser.newContext(
    storageStatePath && existsSync(storageStatePath)
      ? {
          storageState: storageStatePath,
        }
      : undefined,
  );
  session.page = await session.context.newPage();
}

async function closeSessionResources(session) {
  await session.page?.close().catch(() => {});
  await session.context?.close().catch(() => {});
  session.page = null;
  session.context = null;
}

async function closeAndDeleteSession(sessionId) {
  const session = sessions.get(sessionId);

  if (!session) {
    return false;
  }

  await closeSessionResources(session);
  sessions.delete(sessionId);

  if (sessions.size === 0) {
    await stopRemoteDesktop().catch(() => undefined);
  }

  return true;
}

function serializeSession(session) {
  return {
    sessionId: session.id,
    appId: session.appId,
    siteScope: session.siteScope,
    accountAlias: session.accountAlias,
    url: session.url,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastScreenshotAt: session.lastScreenshotAt,
    lastSavedStateAt: session.lastSavedStateAt,
    lastUploadedStateAt: session.lastUploadedStateAt,
    lastError: session.lastError,
    currentUrl: session.currentUrl,
    interactiveUrl: session.interactiveUrl,
    interactivePassword: session.interactivePassword,
    interactiveDisplay: session.interactiveDisplay,
  };
}

async function captureScreenshot(session) {
  if (!session.page) {
    throw new Error("No active page.");
  }

  const screenshotPath = buildScreenshotPath(session.sessionRoot);
  const buffer = await session.page.screenshot({ path: screenshotPath, fullPage: true, type: "png" });
  session.lastScreenshotAt = new Date().toISOString();
  session.updatedAt = session.lastScreenshotAt;
  session.currentUrl = session.page.url();

  return {
    fileName: basename(screenshotPath),
    imageBase64: buffer.toString("base64"),
    contentType: "image/png",
  };
}

async function saveStorageState(session) {
  if (!session.context) {
    throw new Error("No active browser context.");
  }

  const targetPath = buildStatePath(session.sessionRoot);
  await session.context.storageState({ path: targetPath });
  session.lastSavedStateAt = new Date().toISOString();
  session.updatedAt = session.lastSavedStateAt;

  const info = await stat(targetPath);

  return {
    path: targetPath,
    fileName: basename(targetPath),
    size: Number(info.size ?? 0),
  };
}

async function uploadStorageState(session) {
  const statePath = buildStatePath(session.sessionRoot);

  if (!existsSync(statePath)) {
    throw new Error("No saved local storage state to upload.");
  }

  const s3 = getS3Client();
  const objectKey = stateObjectKey(session.appId, session.siteScope, session.accountAlias);
  const body = await readFile(statePath);
  await s3.send(
    new PutObjectCommand({
      Bucket: r2Bucket,
      Key: objectKey,
      Body: body,
      ContentType: "application/json",
      CacheControl: "no-store",
    }),
  );
  session.lastUploadedStateAt = new Date().toISOString();
  session.updatedAt = session.lastUploadedStateAt;

  return {
    objectKey,
    size: body.byteLength,
  };
}

async function downloadStateToPath({ appId, siteScope, accountAlias, targetPath }) {
  const s3 = getS3Client();
  const objectKey = stateObjectKey(appId, siteScope, accountAlias);
  const response = await s3.send(
    new GetObjectCommand({
      Bucket: r2Bucket,
      Key: objectKey,
    }),
  );

  if (!response.Body) {
    throw new Error("Empty storage state response from R2.");
  }

  const buffer = await streamToBuffer(response.Body);
  await mkdir(dirname(targetPath), { recursive: true }).catch(() => undefined);
  await writeFile(targetPath, buffer);
  return { objectKey, size: buffer.byteLength };
}

async function restoreStateForSession(session) {
  const targetPath = buildStatePath(session.sessionRoot);
  await ensureSessionDirectories(session);
  return downloadStateToPath({
    appId: session.appId,
    siteScope: session.siteScope,
    accountAlias: session.accountAlias,
    targetPath,
  });
}

async function createProvisioningSession(input) {
  if (sessions.size > 0) {
    const [existingSession] = sessions.values();

    if (
      existingSession &&
      existingSession.appId === input.appId &&
      existingSession.siteScope === input.siteScope &&
      existingSession.accountAlias === (input.accountAlias || "default") &&
      existingSession.url === input.url
    ) {
      existingSession.updatedAt = new Date().toISOString();
      existingSession.status = existingSession.status || "ready";
      return existingSession;
    }

    if (existingSession) {
      await closeAndDeleteSession(existingSession.id);
    }
  }

  const id = randomUUID();
  const sessionRoot = buildSessionRoot(input.appHome, id);
  const interactivePassword = randomUUID().replace(/-/g, "").slice(0, 16);
  const interactiveUrl = buildInteractiveUrl();
  const session = {
    id,
    appId: input.appId,
    appHome: input.appHome,
    siteScope: input.siteScope,
    accountAlias: input.accountAlias || "default",
    url: input.url,
    status: "starting",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastScreenshotAt: null,
    lastSavedStateAt: null,
    lastUploadedStateAt: null,
    lastError: null,
    currentUrl: null,
    interactiveUrl,
    interactivePassword,
    interactiveDisplay: displayName,
    sessionRoot,
    context: null,
    page: null,
  };

  sessions.set(id, session);
  await ensureSessionDirectories(session);
  await ensureRemoteDesktop(session);

  if (input.restoreFromR2) {
    try {
      await restoreStateForSession(session);
    } catch (error) {
      session.lastError = error instanceof Error ? error.message : "Unable to restore state from R2.";
    }
  }

  const statePath = buildStatePath(sessionRoot);
  await createSessionContext(session, existsSync(statePath) ? statePath : null);
  await session.page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  session.currentUrl = session.page.url();
  session.status = "ready";
  session.updatedAt = new Date().toISOString();

  return session;
}

async function validateStateWithScreenshot(input) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-dev-shm-usage", "--no-sandbox"],
  });
  const sessionRoot = buildSessionRoot(input.appHome, randomUUID());
  const statePath = buildStatePath(sessionRoot);
  await mkdir(join(sessionRoot, "storage-state"), { recursive: true });
  await mkdir(join(sessionRoot, "screenshots"), { recursive: true });
  const download = await downloadStateToPath({
    appId: input.appId,
    siteScope: input.siteScope,
    accountAlias: input.accountAlias || "default",
    targetPath: statePath,
  });
  const context = await browser.newContext({ storageState: statePath });
  const page = await context.newPage();
  await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const screenshotPath = buildScreenshotPath(sessionRoot);
  const buffer = await page.screenshot({ path: screenshotPath, fullPage: true, type: "png" });
  const currentUrl = page.url();
  await page.close().catch(() => {});
  await context.close().catch(() => {});
  await browser.close().catch(() => {});

  return {
    download,
    currentUrl,
    screenshot: {
      fileName: basename(screenshotPath),
      imageBase64: buffer.toString("base64"),
      contentType: "image/png",
    },
  };
}

function parseJsonBody(rawBody) {
  if (!rawBody.length) {
    return {};
  }

  const parsed = JSON.parse(rawBody.toString("utf8"));
  return requireObject(parsed) ?? {};
}

function requireStartPayload(payload) {
  const appId = getString(payload.appId);
  const appHome = getString(payload.appHome);
  const siteScope = getString(payload.siteScope);
  const url = getString(payload.url);
  const accountAlias = getString(payload.accountAlias) || "default";

  if (!appId || !appHome || !siteScope || !url) {
    throw new Error("Missing provisioning start payload fields.");
  }

  return {
    appId,
    appHome,
    siteScope,
    url,
    accountAlias,
    restoreFromR2: payload.restoreFromR2 !== false,
  };
}

function requireSessionPayload(payload) {
  const sessionId = getString(payload.sessionId);

  if (!sessionId) {
    throw new Error("Missing session id.");
  }

  const session = sessions.get(sessionId);

  if (!session) {
    const error = new Error("Provisioning session not found.");
    error.statusCode = 404;
    throw error;
  }

  return session;
}

function requireValidationPayload(payload) {
  const appId = getString(payload.appId);
  const appHome = getString(payload.appHome);
  const siteScope = getString(payload.siteScope);
  const url = getString(payload.url);
  const accountAlias = getString(payload.accountAlias) || "default";

  if (!appId || !appHome || !siteScope || !url) {
    throw new Error("Missing validation payload fields.");
  }

  return {
    appId,
    appHome,
    siteScope,
    url,
    accountAlias,
  };
}

function buildInteractiveUrl() {
  if (!publicBaseUrl) {
    return null;
  }

  const target = new URL(`${publicBaseUrl}/vnc.html`);
  target.searchParams.set("autoconnect", "1");
  target.searchParams.set("resize", "scale");
  target.searchParams.set("view_only", "0");
  target.searchParams.set("path", "browser/websockify");
  return target.toString();
}

function createChildProcess(command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ...extraEnv,
    },
  });

  child.stdout?.on("data", (chunk) => {
    process.stdout.write(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    process.stderr.write(chunk);
  });

  return child;
}

async function killStaleRemoteDesktopProcesses() {
  await new Promise((resolve) => {
    const child = spawn("sh", ["-lc", "pkill -f 'x11vnc|websockify' >/dev/null 2>&1 || true"], {
      stdio: ["ignore", "ignore", "ignore"],
      env: process.env,
    });
    child.once("exit", () => resolve(undefined));
    child.once("error", () => resolve(undefined));
  });
}

async function isVirtualDisplayProcessRunning() {
  return await new Promise((resolve) => {
    const escapedDisplay = displayName.replace(/"/g, '\\"');
    const child = spawn("sh", ["-lc", `pgrep -f "Xvfb ${escapedDisplay}" >/dev/null 2>&1`], {
      stdio: ["ignore", "ignore", "ignore"],
      env: process.env,
    });
    child.once("exit", (code) => resolve(code === 0));
    child.once("error", () => resolve(false));
  });
}

async function cleanupStaleVirtualDisplayLock(displayLockPath) {
  await new Promise((resolve) => {
    const displayNumber = displayName.replace(/^:/, "");
    const child = spawn("sh", ["-lc", `rm -f "${displayLockPath}" "/tmp/.X11-unix/X${displayNumber}" >/dev/null 2>&1 || true`], {
      stdio: ["ignore", "ignore", "ignore"],
      env: process.env,
    });
    child.once("exit", () => resolve(undefined));
    child.once("error", () => resolve(undefined));
  });
}

async function waitForChildExit(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) {
      resolve(undefined);
      return;
    }

    child.once("exit", () => resolve(undefined));
    try {
      child.kill("SIGTERM");
    } catch {
      resolve(undefined);
      return;
    }
    setTimeout(() => {
      if (child.exitCode === null && !child.killed) {
        try {
          child.kill("SIGKILL");
        } catch {
          resolve(undefined);
        }
      }
    }, 1_500).unref();
  });
}

async function ensureVirtualDisplay() {
  if (displayStatePromise) {
    return displayStatePromise;
  }

  displayStatePromise = (async () => {
    const displayLockPath = `/tmp/.X${displayName.replace(/^:/, "")}-lock`;
    const displayRunning = await isVirtualDisplayProcessRunning();

    if (existsSync(displayLockPath) && displayRunning) {
      process.env.DISPLAY = displayName;
      return {
        child: null,
      };
    }

    if (existsSync(displayLockPath) && !displayRunning) {
      await cleanupStaleVirtualDisplayLock(displayLockPath);
    }

    const child = createChildProcess("Xvfb", [displayName, "-screen", "0", screenSize, "-ac", "-nolisten", "tcp"]);
    await new Promise((resolve) => setTimeout(resolve, 600));

    if (child.exitCode !== null) {
      if (existsSync(displayLockPath) && (await isVirtualDisplayProcessRunning())) {
        process.env.DISPLAY = displayName;
        return {
          child: null,
        };
      }

      throw new Error("Unable to start Xvfb for browser provisioning.");
    }

    process.env.DISPLAY = displayName;

    return {
      child,
    };
  })();

  return displayStatePromise;
}

async function writeVncPasswordFile(passwordFilePath, password) {
  await new Promise((resolve, reject) => {
    const child = spawn("x11vnc", ["-storepasswd", password, passwordFilePath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("exit", (code) => {
      if (code === 0) {
        resolve(undefined);
        return;
      }

      reject(new Error(stderr.trim() || "Unable to write x11vnc password file."));
    });
    child.once("error", reject);
  });
}

async function stopRemoteDesktop() {
  if (!remoteDesktopStatePromise) {
    return;
  }

  const state = await remoteDesktopStatePromise.catch(() => null);

  if (!state) {
    remoteDesktopStatePromise = null;
    return;
  }

  await Promise.all([waitForChildExit(state.vncChild), waitForChildExit(state.websockifyChild)]).catch(() => undefined);
  remoteDesktopStatePromise = null;
}

async function ensureRemoteDesktop(session) {
  await ensureVirtualDisplay();
  await stopRemoteDesktop();
  await killStaleRemoteDesktopProcesses();
  const passwordFilePath = join(session.sessionRoot, "x11vnc.pass");
  await writeVncPasswordFile(passwordFilePath, session.interactivePassword);

  remoteDesktopStatePromise = (async () => {
    const vncChild = createChildProcess(
      "x11vnc",
      ["-display", displayName, "-rfbport", String(rfbPort), "-forever", "-shared", "-rfbauth", passwordFilePath],
      { DISPLAY: displayName },
    );
    await new Promise((resolve) => setTimeout(resolve, 600));

    if (vncChild.exitCode !== null) {
      throw new Error("Unable to start x11vnc for browser provisioning.");
    }

    const websockifyChild = createChildProcess("websockify", ["--web", "/usr/share/novnc", String(noVncPort), `127.0.0.1:${rfbPort}`]);
    await new Promise((resolve) => setTimeout(resolve, 600));

    if (websockifyChild.exitCode !== null) {
      await waitForChildExit(vncChild).catch(() => undefined);
      throw new Error("Unable to start websockify for browser provisioning.");
    }

    return {
      vncChild,
      websockifyChild,
      passwordFilePath,
    };
  })();

  return remoteDesktopStatePromise;
}

const server = createServer(async (request, response) => {
  try {
    if (!request.url || !request.method) {
      json(response, 400, { error: "Invalid request." });
      return;
    }

    const requestUrl = new URL(request.url, `http://${request.headers.host ?? "127.0.0.1"}`);
    const rawBody = request.method === "POST" ? await readRequestBody(request) : Buffer.alloc(0);
    const payload = parseJsonBody(rawBody);

    if (requestUrl.pathname === "/health" && request.method === "GET") {
      json(response, 200, { ok: true, sessions: sessions.size });
      return;
    }

    if (requestUrl.pathname === "/sessions/start" && request.method === "POST") {
      const session = await createProvisioningSession(requireStartPayload(payload));
      json(response, 200, { ok: true, session: serializeSession(session) });
      return;
    }

    if (requestUrl.pathname === "/sessions/status" && request.method === "POST") {
      const session = requireSessionPayload(payload);
      json(response, 200, { ok: true, session: serializeSession(session) });
      return;
    }

    if (requestUrl.pathname === "/sessions/screenshot" && request.method === "POST") {
      const session = requireSessionPayload(payload);
      const screenshot = await captureScreenshot(session);
      json(response, 200, { ok: true, session: serializeSession(session), screenshot });
      return;
    }

    if (requestUrl.pathname === "/sessions/save-upload" && request.method === "POST") {
      const session = requireSessionPayload(payload);
      const saved = await saveStorageState(session);
      const upload = await uploadStorageState(session);
      json(response, 200, { ok: true, session: serializeSession(session), saved, upload });
      return;
    }

    if (requestUrl.pathname === "/sessions/restore-screenshot" && request.method === "POST") {
      const result = await validateStateWithScreenshot(requireValidationPayload(payload));
      json(response, 200, { ok: true, validation: result });
      return;
    }

    if (requestUrl.pathname === "/sessions/close" && request.method === "POST") {
      const session = requireSessionPayload(payload);
      await closeAndDeleteSession(session.id);
      json(response, 200, { ok: true, sessionId: session.id });
      return;
    }

    json(response, 404, { error: "Not found." });
  } catch (error) {
    json(
      response,
      typeof error === "object" && error !== null && "statusCode" in error && Number.isInteger(error.statusCode) ? error.statusCode : 500,
      { error: error instanceof Error ? error.message : "Unexpected browser provisioner error." },
    );
  }
});

server.listen(port, host, () => {
  console.log(`browser-provisioner listening on ${host}:${port}`);
});

async function shutdown() {
  for (const sessionId of Array.from(sessions.keys())) {
    await closeAndDeleteSession(sessionId).catch(() => undefined);
  }

  if (sharedBrowserPromise) {
    const browser = await sharedBrowserPromise.catch(() => null);
    await browser?.close().catch(() => undefined);
  }
}

process.on("SIGINT", async () => {
  await shutdown();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await shutdown();
  process.exit(0);
});
