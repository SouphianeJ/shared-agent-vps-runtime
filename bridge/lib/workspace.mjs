import { createWriteStream } from "node:fs";
import { cp, mkdir, readdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export function buildWorkspacePath(appConfig, chatId) {
  return `${appConfig.workspaceRoot.replace(/\/+$/, "")}/${chatId}`;
}

export function getFileDirectory(appConfig, chatId, fileId) {
  return join(appConfig.fileLibraryRoot, "chats", chatId, fileId);
}

export function createActiveRunHandle({ key, appId, chatId, workspacePath, child, response }) {
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

export function registerActiveRun(activeRunsByKey, runHandle) {
  activeRunsByKey.set(runHandle.key, runHandle);
  runHandle.snapshotTimer = setInterval(() => {
    void emitWorkspaceSnapshot(runHandle, { force: false });
  }, 2_000);
  runHandle.snapshotTimer.unref();
}

export function unregisterActiveRun(activeRunsByKey, runHandle) {
  if (activeRunsByKey.get(runHandle.key) === runHandle) {
    activeRunsByKey.delete(runHandle.key);
  }

  runHandle.resolveDone?.();
}

export function stopWorkspaceSnapshotWatcher(runHandle) {
  if (runHandle.snapshotTimer) {
    clearInterval(runHandle.snapshotTimer);
    runHandle.snapshotTimer = null;
  }
}

export function emitNdjson(response, payload) {
  if (!response.writableEnded) {
    response.write(`${JSON.stringify(payload)}\n`);
  }
}

export async function emitWorkspaceSnapshot(runHandle, { force }) {
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

export function summarizeWorkspaceChange(added, removed, entries) {
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

export async function collectWorkspaceEntries(workspacePath) {
  const entries = [];
  await collectWorkspaceEntriesRecursive(workspacePath, "", 0, 2, entries);
  return entries.sort((left, right) => left.localeCompare(right));
}

export async function collectWorkspaceEntriesRecursive(rootPath, relativePath, depth, maxDepth, output) {
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

export function shouldSkipWorkspaceSnapshotDirectory(name) {
  return [".git", "node_modules", ".next"].includes(name);
}

export function arraysEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}

export async function materializeAttachedFiles(appConfig, workspacePath, chatId, attachmentIds) {
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

export async function resetGeneratedFilesDirectory(workspacePath) {
  const generatedDir = join(workspacePath, "__generated_files__");
  await rm(generatedDir, { recursive: true, force: true });
  await mkdir(generatedDir, { recursive: true });
}

export async function collectGeneratedFiles(appConfig, workspacePath, chatId) {
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

export function detectGeneratedFileContentType(filename) {
  const lower = String(filename).toLowerCase();
  if (lower.endsWith(".png")) {
    return "image/png";
  }
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (lower.endsWith(".webm")) {
    return "video/webm";
  }
  if (lower.endsWith(".json")) {
    return "application/json";
  }
  if (lower.endsWith(".xml")) {
    return "application/xml";
  }
  if (lower.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }
  if (lower.endsWith(".txt") || lower.endsWith(".aiken")) {
    return "text/plain; charset=utf-8";
  }
  return "application/octet-stream";
}

export function getUniqueAttachmentName(inputName, usedNames) {
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

export function sanitizeDisplayName(inputName) {
  const collapsed = basename(String(inputName || "file"))
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

  return collapsed || "file";
}

export async function streamUploadToDisk(request, fileDirectory, upload, { chatUploadMaxBytes = 0 } = {}) {
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
