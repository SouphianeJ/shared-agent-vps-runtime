import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

export async function startCopilotAuthSession(appConfig, activeCopilotAuthSessionsByApp) {
  const existingSession = activeCopilotAuthSessionsByApp.get(appConfig.id);

  if (existingSession && !isCopilotAuthSessionFinal(existingSession)) {
    return existingSession;
  }

  const session = createCopilotAuthSession(appConfig);
  activeCopilotAuthSessionsByApp.set(appConfig.id, session);
  await mkdir(appConfig.copilotHome, { recursive: true });
  await mkdir(join(appConfig.appHome, ".config", "gh"), { recursive: true });

  const env = {
    ...process.env,
    HOME: appConfig.appHome,
    COPILOT_HOME: appConfig.copilotHome,
    GH_CONFIG_DIR: join(appConfig.appHome, ".config", "gh"),
  };

  delete env.COPILOT_GITHUB_TOKEN;
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;

  const child = spawn("gh", ["auth", "login", "--hostname", "github.com", "--web", "--git-protocol", "https", "--scopes", "gist,read:org,read:user,repo"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  session.child = child;

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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    finishedAt: null,
    child: null,
  };
}

function consumeCopilotAuthText(session, text) {
  session.updatedAt = new Date().toISOString();

  const combined = `${session.stdout}\n${session.stderr}`;
  const codeMatch = combined.match(/(?:enter code|one-time code:)\s*([A-Z0-9-]+)\.?/i);
  const urlMatch = combined.match(/https:\/\/github\.com\/login\/device/i);

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

export function serializeCopilotAuthSession(session) {
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

async function waitForCopilotDeviceCode(session, timeoutMs) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (session.deviceCode || session.status === "failed" || session.status === "completed") {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function refreshCopilotAuthSessionStatus(session, appConfig) {
  if (session.completed || session.status === "failed") {
    return session;
  }

  const ghAuthOk = await hasGhAuthSession(appConfig);

  if (ghAuthOk) {
    session.status = "completed";
    session.completed = true;
    session.error = null;
    session.finishedAt = new Date().toISOString();

    try {
      session.child?.kill("SIGTERM");
    } catch {
      // Ignore kill failures if the process already exited.
    }

    session.child = null;
    return session;
  }

  return session;
}

export async function hasGhAuthSession(appConfig) {
  const env = {
    ...process.env,
    HOME: appConfig.appHome,
    COPILOT_HOME: appConfig.copilotHome,
    GH_CONFIG_DIR: join(appConfig.appHome, ".config", "gh"),
  };

  delete env.COPILOT_GITHUB_TOKEN;
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;

  return await new Promise((resolve) => {
    const child = spawn("gh", ["auth", "status", "--hostname", "github.com"], {
      env,
      stdio: ["ignore", "ignore", "ignore"],
    });

    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

export function applyCopilotAuthEnv(runtimeEnv, appConfig) {
  const appScopedToken = process.env[buildAppScopedCopilotTokenEnvName(appConfig.id)]?.trim() ?? "";
  const fallbackToken = process.env.COPILOT_GITHUB_TOKEN?.trim() ?? "";
  const token = appScopedToken || fallbackToken;

  if (token) {
    runtimeEnv.COPILOT_GITHUB_TOKEN = token;
  } else {
    delete runtimeEnv.COPILOT_GITHUB_TOKEN;
  }

  delete runtimeEnv.GH_TOKEN;
  delete runtimeEnv.GITHUB_TOKEN;
}

export function buildAppScopedCopilotTokenEnvName(appId) {
  const normalized = String(appId)
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return `${normalized}_COPILOT_GITHUB_TOKEN`;
}
