import { isAbsolute, join, relative, resolve } from "node:path";
import { readdir, readFile, rm } from "node:fs/promises";
import { buildWorkspacePath } from "./workspace.mjs";

export async function handleCleanupRequest(payload, appConfig, response, activeRunsByKey, buildRunKey, stopRunHandle) {
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

export function resolveWorkspaceCleanupPath(appConfig, chatId, workspacePath) {
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

export async function removePathIfPresent(targetPath) {
  await rm(targetPath, { recursive: true, force: true });
  return true;
}

export async function purgeCodexSessionArtifacts(appConfig, payload, workspacePath) {
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

export async function purgeCopilotSessionArtifacts(appConfig, payload, workspacePath) {
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

export async function findCopilotSessionDirectories(sessionStateRoot) {
  let entries = [];

  try {
    entries = await readdir(sessionStateRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries.filter((entry) => entry.isDirectory()).map((entry) => join(sessionStateRoot, entry.name));
}

export async function removeFilesByPredicate(rootPath, predicate) {
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

export async function safeReadUtf8(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}
