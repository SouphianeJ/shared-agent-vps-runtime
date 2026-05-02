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

  const combined = normalizeCodexAuthText(`${session.stdout}\n${session.stderr}`);
  const verificationUri = extractVerificationUri(combined);
  const deviceCode = extractDeviceCode(combined, verificationUri);

  if (verificationUri) {
    session.verificationUri = verificationUri;
  }

  if (deviceCode) {
    session.deviceCode = deviceCode;
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

  const authError = extractCodexAuthFailure(text, combined);

  if (authError && !session.completed) {
    session.status = "failed";
    session.error = authError;
    session.finishedAt = new Date().toISOString();
  }
}

function buildCodexAuthError(session) {
  const combined = normalizeCodexAuthText(`${session.stderr}\n${session.stdout}`);
  const lines = combined
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.find((line) => /error|failed|denied|timed out|timeout|could not|unable to/i.test(line)) ?? null;
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

function normalizeCodexAuthText(value) {
  return value
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\r/g, "\n")
    .replace(/[^\S\n]+/g, " ");
}

function extractVerificationUri(value) {
  const urlMatch = value.match(/https?:\/\/[^\s<>"')\]}]+/i);

  if (!urlMatch) {
    return null;
  }

  return urlMatch[0].replace(/[),.;:]+$/, "");
}

function extractDeviceCode(value, verificationUri) {
  const standaloneCode = findStandaloneDeviceCodeLine(value);

  if (standaloneCode) {
    return standaloneCode;
  }

  const patterns = [
    /(?:user|device|one-time)[ -]?code(?: is)?[:\s]+([A-Z0-9]{4,}(?:-[A-Z0-9]{4,})*)/i,
    /enter (?:the )?code[:\s]+([A-Z0-9]{4,}(?:-[A-Z0-9]{4,})*)/i,
  ];

  for (const pattern of patterns) {
    const match = value.match(pattern);

    if (match?.[1]) {
      return match[1].trim();
    }
  }

  if (!verificationUri) {
    return null;
  }

  try {
    const url = new URL(verificationUri);
    const fromQuery = url.searchParams.get("user_code") ?? url.searchParams.get("code");
    return fromQuery?.trim() || null;
  } catch {
    return null;
  }
}

function findStandaloneDeviceCodeLine(value) {
  const lines = value
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (/^[A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+$/.test(line) && !isForbiddenCodeWord(line)) {
      return line;
    }
  }

  return null;
}

function isForbiddenCodeWord(value) {
  return /^(authorization|authorisation|device|code|login|openai|chatgpt)$/i.test(value);
}

function extractCodexAuthFailure(text, combined) {
  const normalizedChunk = normalizeCodexAuthText(text);
  const lines = normalizedChunk
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const failureLine =
    lines.find((line) => /error|failed|denied|timed out|timeout|could not|unable to/i.test(line) && !/expires? in/i.test(line)) ?? null;

  if (failureLine) {
    return failureLine;
  }

  if (/authorization pending|waiting for authorization|expires? in/i.test(combined)) {
    return null;
  }

  return null;
}
