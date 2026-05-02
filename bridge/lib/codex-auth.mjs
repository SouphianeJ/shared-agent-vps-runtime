import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

import { uploadCodexAuthToR2 } from "./r2-auth.mjs";

export async function startCodexAuthSession(appConfig, activeCodexAuthSessionsByApp, r2Options) {
  const existingSession = activeCodexAuthSessionsByApp.get(appConfig.id);

  if (existingSession && !isCodexAuthSessionFinal(existingSession)) {
    return existingSession;
  }

  const session = createCodexAuthSession(appConfig);
  activeCodexAuthSessionsByApp.set(appConfig.id, session);
  await mkdir(appConfig.codexHome, { recursive: true });
  await mkdir(appConfig.appHome, { recursive: true });

  const env = {
    ...process.env,
    HOME: appConfig.appHome,
    CODEX_HOME: appConfig.codexHome,
  };

  const child = spawn("codex", ["login", "--device-auth"], {
    env,
    cwd: appConfig.appHome,
    stdio: ["ignore", "pipe", "pipe"],
  });
  session.child = child;

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    session.stdout += text;
    consumeCodexAuthText(session, text);
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    session.stderr += text;
    consumeCodexAuthText(session, text);
  });

  child.on("error", (error) => {
    session.status = "failed";
    session.error = error.message;
    session.finishedAt = new Date().toISOString();
    session.child = null;
  });

  child.on("close", async (code) => {
    session.finishedAt = new Date().toISOString();
    session.child = null;

    if (code === 0) {
      try {
        await uploadCodexAuthToR2(appConfig, r2Options);
        session.status = "completed";
        session.completed = true;
        session.error = null;
      } catch (error) {
        session.status = "failed";
        session.error = error instanceof Error ? error.message : "Unable to upload auth.json to R2.";
      }

      return;
    }

    if (session.status !== "failed") {
      session.status = "failed";
      session.error = buildCodexAuthError(session) || `codex login exited with status ${code ?? 1}.`;
    }
  });

  await waitForCodexDeviceCode(session, 2500);
  return session;
}

function createCodexAuthSession(appConfig) {
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

function consumeCodexAuthText(session, text) {
  session.updatedAt = new Date().toISOString();

  const combined = `${session.stdout}\n${session.stderr}`;
  const urlMatch = combined.match(/https?:\/\/[^\s)]+/i);
  const codeMatch = combined.match(/(?:user code|device code|one-time code|code)[:\s]+([A-Z0-9-]{4,})/i);

  if (urlMatch) {
    session.verificationUri = urlMatch[0];
  }

  if (codeMatch) {
    session.deviceCode = codeMatch[1];
  }

  if (session.deviceCode && session.verificationUri && session.status === "starting") {
    session.status = "pending_authorization";
  }

  if (/login successful|authenticated|successfully logged in|auth complete/i.test(combined)) {
    session.status = "completed";
    session.completed = true;
    session.error = null;
    session.finishedAt = new Date().toISOString();
  }

  if (/error|failed|timed out|denied|expired/i.test(text) && !session.completed) {
    session.status = "failed";
    session.error = buildCodexAuthError(session) || text.trim();
    session.finishedAt = new Date().toISOString();
  }
}

function buildCodexAuthError(session) {
  const combined = `${session.stderr}\n${session.stdout}`;
  const lines = combined
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.find((line) => /error|failed|denied|expired/i.test(line)) ?? null;
}

function isCodexAuthSessionFinal(session) {
  return session.status === "completed" || session.status === "failed";
}

export function serializeCodexAuthSession(session) {
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

async function waitForCodexDeviceCode(session, timeoutMs) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (session.deviceCode || session.status === "failed" || session.status === "completed") {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function refreshCodexAuthSessionStatus(session, appConfig, r2Options) {
  if (session.completed || session.status === "failed") {
    return session;
  }

  const authPath = join(appConfig.codexHome, "auth.json");

  try {
    await stat(authPath);

    if (!session.child) {
      await uploadCodexAuthToR2(appConfig, r2Options);
      session.status = "completed";
      session.completed = true;
      session.error = null;
      session.finishedAt = new Date().toISOString();
      return session;
    }
  } catch {
    // Ignore missing auth.json while the device login is still pending.
  }

  return session;
}
