export function parsePayload(rawBody, { defaultModel = "", allowDangerousDefault = true } = {}) {
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

export function parseFileDeletePayload(rawBody) {
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

export function parseStopPayload(rawBody) {
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

export function parseCleanupPayload(rawBody) {
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

export function parseCopilotAuthPayload(rawBody) {
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

export function parseCopilotAuthStatusPayload(rawBody) {
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
