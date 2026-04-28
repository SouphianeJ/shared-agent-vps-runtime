import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { MongoClient } from "mongodb";

const workspacePath = process.env.PERSIST_WORKSPACE_PATH?.trim() || process.cwd();
const generatedDir = process.env.PERSIST_GENERATED_DIR?.trim() || join(workspacePath, "__generated_files__");
const browserStateDir = process.env.PERSIST_BROWSER_STATE_DIR?.trim() || join(workspacePath, "__browser__", "storage-state");
const appId = process.env.PERSIST_APP_ID?.trim() || process.env.AGENT_RUNTIME_APP_ID?.trim() || "unknown-app";
const chatId = process.env.PERSIST_CHAT_ID?.trim() || basename(workspacePath);

const r2Bucket = process.env.R2_BUCKET?.trim() || "";
const r2Endpoint = process.env.R2_ENDPOINT?.trim() || "";
const r2AccessKeyId = process.env.R2_ACCESS_KEY_ID?.trim() || process.env.AWS_ACCESS_KEY_ID?.trim() || "";
const r2SecretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim() || process.env.AWS_SECRET_ACCESS_KEY?.trim() || "";
const r2PublicBaseUrl = process.env.R2_PUBLIC_BASE_URL?.trim()?.replace(/\/+$/, "") || "";
const r2PortfolioPublicPrefix = process.env.R2_PORTFOLIO_PUBLIC_PREFIX?.trim().replace(/^\/+|\/+$/g, "") || "proof-artifacts";
const r2BrowserStatePrefix = process.env.R2_BROWSER_STATE_PREFIX?.trim().replace(/^\/+|\/+$/g, "") || "browser-storage-state";

const seedPortfolioMongoUri = process.env.SEEDPORTFOLIO_MONGODB_URI?.trim() || "";
const seedPortfolioMongoDb = process.env.SEEDPORTFOLIO_MONGODB_DB?.trim() || "";
const seedPortfolioProofsCollection = process.env.SEEDPORTFOLIO_PROOFS_COLLECTION?.trim() || "proofs";

let mongoClient;
let mongoClientPromise;

function requireObject(value) {
  return value && typeof value === "object" ? value : {};
}

function textResult(payload) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload,
  };
}

function sanitizeSegment(input) {
  return String(input || "unknown")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";
}

function sanitizeFileName(input) {
  return basename(String(input || "file"))
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "") || "file";
}

function inferArtifactKind(filename, contentType = "") {
  const lower = String(filename).toLowerCase();
  const normalizedContentType = String(contentType).toLowerCase();

  if (normalizedContentType.startsWith("image/") || /\.(png|jpe?g|gif|webp|svg)$/.test(lower)) {
    return "image";
  }

  if (normalizedContentType.startsWith("video/") || /\.(webm|mp4|mov|m4v)$/.test(lower)) {
    return "video";
  }

  return null;
}

function detectContentType(filename) {
  const lower = String(filename).toLowerCase();

  if (lower.endsWith(".png")) {
    return "image/png";
  }
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (lower.endsWith(".gif")) {
    return "image/gif";
  }
  if (lower.endsWith(".webp")) {
    return "image/webp";
  }
  if (lower.endsWith(".svg")) {
    return "image/svg+xml";
  }
  if (lower.endsWith(".webm")) {
    return "video/webm";
  }
  if (lower.endsWith(".mp4")) {
    return "video/mp4";
  }
  if (lower.endsWith(".mov")) {
    return "video/quicktime";
  }
  if (lower.endsWith(".json")) {
    return "application/json";
  }
  if (lower.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }

  return "application/octet-stream";
}

async function ensureGeneratedDir() {
  await mkdir(generatedDir, { recursive: true });
}

async function ensureBrowserStateDir() {
  await mkdir(browserStateDir, { recursive: true });
}

async function resolveGeneratedFile(args) {
  await ensureGeneratedDir();

  const relativePathRaw = typeof args.relativePath === "string" ? args.relativePath.trim() : "";
  const relativePath = relativePathRaw.replace(/^__generated_files__[\\/]/, "");
  const fileName = typeof args.fileName === "string" ? args.fileName.trim() : "";

  if (!relativePath && !fileName) {
    throw new Error("Provide relativePath or fileName.");
  }

  const candidatePath = relativePath
    ? resolve(generatedDir, relativePath)
    : join(generatedDir, basename(fileName));
  const normalizedGeneratedDir = resolve(generatedDir);
  const normalizedCandidate = resolve(candidatePath);
  const relativeToGenerated = relative(normalizedGeneratedDir, normalizedCandidate);

  if (relativeToGenerated.startsWith("..") || relativeToGenerated.includes("..\\")) {
    throw new Error("Only files inside __generated_files__ can be uploaded.");
  }

  const sourceStat = await stat(normalizedCandidate).catch(() => null);

  if (!sourceStat || !sourceStat.isFile()) {
    throw new Error(`Generated file not found: ${relativePath || fileName}`);
  }

  return {
    absolutePath: normalizedCandidate,
    relativePath: relativeToGenerated.replace(/\\/g, "/"),
    fileName: basename(normalizedCandidate),
    size: Number(sourceStat.size ?? 0),
  };
}

function sanitizeStateFileName(input) {
  const normalized = basename(String(input || "browser-storage-state.json"))
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!normalized) {
    return "browser-storage-state.json";
  }

  return normalized.toLowerCase().endsWith(".json") ? normalized : `${normalized}.json`;
}

async function resolveBrowserStateFile(args) {
  await ensureBrowserStateDir();

  const relativePathRaw = typeof args.relativePath === "string" ? args.relativePath.trim() : "";
  const relativePath = relativePathRaw.replace(/^(__browser__[\\/])?storage-state[\\/]/, "");
  const fileName = typeof args.fileName === "string" ? args.fileName.trim() : "";

  if (!relativePath && !fileName) {
    throw new Error("Provide relativePath or fileName.");
  }

  const candidatePath = relativePath
    ? resolve(browserStateDir, relativePath)
    : join(browserStateDir, sanitizeStateFileName(fileName));
  const normalizedStateDir = resolve(browserStateDir);
  const normalizedCandidate = resolve(candidatePath);
  const relativeToStateDir = relative(normalizedStateDir, normalizedCandidate);

  if (relativeToStateDir.startsWith("..") || relativeToStateDir.includes("..\\")) {
    throw new Error("Only files inside the browser storage-state directory are allowed.");
  }

  const sourceStat = await stat(normalizedCandidate).catch(() => null);

  if (!sourceStat || !sourceStat.isFile()) {
    throw new Error(`Browser storage state file not found: ${relativePath || fileName}`);
  }

  return {
    absolutePath: normalizedCandidate,
    relativePath: relativeToStateDir.replace(/\\/g, "/"),
    fileName: basename(normalizedCandidate),
    size: Number(sourceStat.size ?? 0),
  };
}

function requireR2Config() {
  if (!r2Bucket || !r2Endpoint || !r2AccessKeyId || !r2SecretAccessKey) {
    throw new Error("Missing R2 configuration. Set R2_BUCKET, R2_ENDPOINT, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY.");
  }
}

function buildPublicUrl(objectKey) {
  if (!r2PublicBaseUrl) {
    return null;
  }

  const encodedPath = objectKey
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  return `${r2PublicBaseUrl}/${encodedPath}`;
}

function buildObjectKey(repoFullName, fileName) {
  const repoScope = repoFullName ? sanitizeSegment(String(repoFullName).replace("/", "--")) : "unscoped";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const uniqueSuffix = randomUUID();

  return [
    r2PortfolioPublicPrefix,
    repoScope,
    `${timestamp}-${uniqueSuffix}-${sanitizeFileName(fileName)}`,
  ].join("/");
}

function buildBrowserStateObjectKey(siteScope, accountAlias = "default") {
  return [
    r2BrowserStatePrefix,
    sanitizeSegment(appId),
    sanitizeSegment(siteScope),
    sanitizeSegment(accountAlias),
    "latest.json",
  ].join("/");
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

async function uploadToR2({ absolutePath, fileName, repoFullName = null, contentType = "" }) {
  const body = await readFile(absolutePath);
  const sha256 = createHash("sha256").update(body).digest("hex");
  const objectKey = buildObjectKey(repoFullName, fileName);
  const resolvedContentType = contentType || detectContentType(fileName);

  await getS3Client().send(
    new PutObjectCommand({
      Bucket: r2Bucket,
      Key: objectKey,
      Body: body,
      ContentType: resolvedContentType,
      CacheControl: "public, max-age=31536000, immutable",
      Metadata: {
        appid: sanitizeSegment(appId),
        chatid: sanitizeSegment(chatId),
        sourcefilename: sanitizeFileName(fileName),
        sha256,
      },
    }),
  );

  return {
    bucket: r2Bucket,
    objectKey,
    publicUrl: buildPublicUrl(objectKey),
    contentType: resolvedContentType,
    size: body.byteLength,
    sha256,
  };
}

async function uploadBrowserStateToR2({ absolutePath, fileName, siteScope, accountAlias = "default" }) {
  const body = await readFile(absolutePath);
  const sha256 = createHash("sha256").update(body).digest("hex");
  const objectKey = buildBrowserStateObjectKey(siteScope, accountAlias);

  await getS3Client().send(
    new PutObjectCommand({
      Bucket: r2Bucket,
      Key: objectKey,
      Body: body,
      ContentType: "application/json",
      Metadata: {
        appid: sanitizeSegment(appId),
        chatid: sanitizeSegment(chatId),
        sourcefilename: sanitizeStateFileName(fileName),
        sha256,
        sitescope: sanitizeSegment(siteScope),
        accountalias: sanitizeSegment(accountAlias),
      },
    }),
  );

  return {
    bucket: r2Bucket,
    objectKey,
    contentType: "application/json",
    size: body.byteLength,
    sha256,
    siteScope: sanitizeSegment(siteScope),
    accountAlias: sanitizeSegment(accountAlias),
  };
}

async function downloadBrowserStateFromR2({ siteScope, accountAlias = "default", fileName }) {
  await ensureBrowserStateDir();
  const objectKey = buildBrowserStateObjectKey(siteScope, accountAlias);
  const response = await getS3Client().send(
    new GetObjectCommand({
      Bucket: r2Bucket,
      Key: objectKey,
    }),
  );

  if (!response.Body || typeof response.Body.transformToByteArray !== "function") {
    throw new Error(`Unexpected R2 response body for ${objectKey}.`);
  }

  const bytes = await response.Body.transformToByteArray();
  const targetPath = join(browserStateDir, sanitizeStateFileName(fileName || `${sanitizeSegment(siteScope)}-${sanitizeSegment(accountAlias)}.json`));
  await writeFile(targetPath, Buffer.from(bytes));
  const targetStat = await stat(targetPath);

  return {
    bucket: r2Bucket,
    objectKey,
    fileName: basename(targetPath),
    path: targetPath,
    size: Number(targetStat.size ?? 0),
    siteScope: sanitizeSegment(siteScope),
    accountAlias: sanitizeSegment(accountAlias),
  };
}

function requireSeedPortfolioConfig() {
  if (!seedPortfolioMongoUri || !seedPortfolioMongoDb) {
    throw new Error("Missing SeedPortfolio Mongo configuration. Set SEEDPORTFOLIO_MONGODB_URI and SEEDPORTFOLIO_MONGODB_DB.");
  }
}

async function getSeedPortfolioDb() {
  requireSeedPortfolioConfig();

  if (!mongoClient) {
    mongoClient = new MongoClient(seedPortfolioMongoUri);
  }

  if (!mongoClientPromise) {
    mongoClientPromise = mongoClient.connect();
  }

  const connectedClient = await mongoClientPromise;
  return connectedClient.db(seedPortfolioMongoDb);
}

async function attachRepoProof({
  repoFullName,
  publicUrl,
  artifactKind,
  objectKey,
  sourceFileName,
  proofName,
  description,
}) {
  if (!repoFullName || typeof repoFullName !== "string" || !repoFullName.trim()) {
    throw new Error("Missing repoFullName.");
  }

  if (!publicUrl || typeof publicUrl !== "string" || !publicUrl.trim()) {
    throw new Error("Missing publicUrl. Configure R2_PUBLIC_BASE_URL before attaching portfolio proofs.");
  }

  if (artifactKind !== "image" && artifactKind !== "video") {
    throw new Error("artifactKind must be image or video.");
  }

  const collection = (await getSeedPortfolioDb()).collection(seedPortfolioProofsCollection);
  const matches = await collection
    .find({
      kind: "repo_card",
      "repo.repoFullName": repoFullName.trim(),
    })
    .project({
      _id: 1,
      proofName: 1,
      kind: 1,
      link: 1,
      type: 1,
      description: 1,
      repo: 1,
      mediaArtifacts: 1,
    })
    .toArray();

  if (matches.length === 0) {
    throw new Error(`No existing repo_card proof matches ${repoFullName.trim()}.`);
  }

  if (matches.length > 1) {
    throw new Error(`Multiple repo_card proofs match ${repoFullName.trim()}; aborting explicit attach.`);
  }

  const [existing] = matches;
  const nextMediaArtifact = {
    kind: artifactKind,
    url: publicUrl.trim(),
    objectKey: typeof objectKey === "string" && objectKey.trim() ? objectKey.trim() : null,
    sourceFileName: typeof sourceFileName === "string" && sourceFileName.trim() ? sourceFileName.trim() : null,
    createdAt: new Date().toISOString(),
  };
  const existingMediaArtifacts = Array.isArray(existing.mediaArtifacts)
    ? existing.mediaArtifacts.filter(
        (entry) =>
          entry &&
          typeof entry === "object" &&
          typeof entry.url === "string" &&
          entry.url.trim(),
      )
    : [];
  const dedupedMediaArtifacts = existingMediaArtifacts.filter((entry) => {
    if (nextMediaArtifact.objectKey && typeof entry.objectKey === "string" && entry.objectKey === nextMediaArtifact.objectKey) {
      return false;
    }

    return entry.url !== nextMediaArtifact.url;
  });
  const mediaArtifacts = [...dedupedMediaArtifacts, nextMediaArtifact];
  const update = {
    link:
      existing.kind === "repo_card"
        ? existing.repo?.repoUrl?.trim() || existing.link?.trim() || publicUrl.trim()
        : publicUrl.trim(),
    type: existing.kind === "repo_card" ? existing.type ?? "Site URL" : artifactKind,
    mediaArtifacts,
    ...(typeof proofName === "string" && proofName.trim() ? { proofName: proofName.trim() } : {}),
    ...(typeof description === "string" && description.trim() ? { description: description.trim() } : {}),
  };

  await collection.updateOne(
    { _id: existing._id },
    {
      $set: update,
    },
  );

  return {
    proofId: String(existing._id),
    repoFullName: repoFullName.trim(),
    previous: {
      link: existing.link ?? null,
      type: existing.type ?? null,
      description: existing.description ?? null,
      proofName: existing.proofName ?? null,
      mediaArtifacts: existing.mediaArtifacts ?? [],
    },
    next: update,
  };
}

async function listGeneratedFiles(limit = 20) {
  await ensureGeneratedDir();
  const entries = await readdir(generatedDir, { withFileTypes: true }).catch(() => []);

  return entries
    .filter((entry) => entry.isFile())
    .slice(0, Math.max(1, Math.min(100, limit)))
    .map((entry) => ({
      fileName: entry.name,
      contentType: detectContentType(entry.name),
      artifactKind: inferArtifactKind(entry.name, detectContentType(entry.name)),
    }));
}

const tools = [
  {
    name: "persist_r2_upload_generated_file",
    description: "Upload a file from __generated_files__ to the configured R2 public prefix and return metadata.",
    inputSchema: {
      type: "object",
      properties: {
        relativePath: { type: "string" },
        fileName: { type: "string" },
        repoFullName: { type: "string" },
      },
    },
  },
  {
    name: "persist_portfolio_attach_repo_proof",
    description: "Attach a public artifact URL to an existing seedPortfolio repo_card proof matched by exact repoFullName.",
    inputSchema: {
      type: "object",
      properties: {
        repoFullName: { type: "string" },
        publicUrl: { type: "string" },
        artifactKind: { type: "string", enum: ["image", "video"] },
        objectKey: { type: "string" },
        sourceFileName: { type: "string" },
        proofName: { type: "string" },
        description: { type: "string" },
      },
      required: ["repoFullName", "publicUrl", "artifactKind"],
    },
  },
  {
    name: "persist_r2_upload_and_attach_repo_proof",
    description: "Upload a generated screenshot or video to R2, then update the existing matching seedPortfolio repo_card proof.",
    inputSchema: {
      type: "object",
      properties: {
        relativePath: { type: "string" },
        fileName: { type: "string" },
        repoFullName: { type: "string" },
        proofName: { type: "string" },
        description: { type: "string" },
      },
      required: ["repoFullName"],
    },
  },
  {
    name: "persist_list_generated_files",
    description: "List visible files currently available in __generated_files__.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number" },
      },
    },
  },
  {
    name: "persist_browser_storage_state_upload",
    description: "Upload a local Playwright storageState JSON from the browser storage-state directory to a private R2 prefix.",
    inputSchema: {
      type: "object",
      properties: {
        relativePath: { type: "string" },
        fileName: { type: "string" },
        siteScope: { type: "string" },
        accountAlias: { type: "string" },
      },
      required: ["siteScope"],
    },
  },
  {
    name: "persist_browser_storage_state_download",
    description: "Download the latest private browser storageState JSON for a site scope from R2 into the local browser storage-state directory.",
    inputSchema: {
      type: "object",
      properties: {
        siteScope: { type: "string" },
        accountAlias: { type: "string" },
        fileName: { type: "string" },
      },
      required: ["siteScope"],
    },
  },
];

const server = new Server(
  {
    name: "runtime-persist-mcp",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = requireObject(request.params.arguments);

  switch (request.params.name) {
    case "persist_r2_upload_generated_file": {
      const source = await resolveGeneratedFile(args);
      const upload = await uploadToR2({
        absolutePath: source.absolutePath,
        fileName: source.fileName,
        repoFullName: typeof args.repoFullName === "string" ? args.repoFullName.trim() : null,
        contentType: detectContentType(source.fileName),
      });

      return textResult({
        ok: true,
        action: "r2_uploaded",
        source: {
          relativePath: source.relativePath,
          fileName: source.fileName,
        },
        upload,
      });
    }

    case "persist_portfolio_attach_repo_proof": {
      const attach = await attachRepoProof({
        repoFullName: String(args.repoFullName || "").trim(),
        publicUrl: String(args.publicUrl || "").trim(),
        artifactKind: args.artifactKind,
        objectKey: typeof args.objectKey === "string" ? args.objectKey : undefined,
        sourceFileName: typeof args.sourceFileName === "string" ? args.sourceFileName : undefined,
        proofName: typeof args.proofName === "string" ? args.proofName : undefined,
        description: typeof args.description === "string" ? args.description : undefined,
      });

      return textResult({
        ok: true,
        action: "portfolio_proof_attached",
        attach,
      });
    }

    case "persist_r2_upload_and_attach_repo_proof": {
      const repoFullName = String(args.repoFullName || "").trim();
      const source = await resolveGeneratedFile(args);
      const upload = await uploadToR2({
        absolutePath: source.absolutePath,
        fileName: source.fileName,
        repoFullName,
        contentType: detectContentType(source.fileName),
      });
      const artifactKind = inferArtifactKind(source.fileName, upload.contentType);

      if (!artifactKind) {
        throw new Error(`Unsupported artifact kind for ${source.fileName}. Expected an image or video file.`);
      }

      const attach = await attachRepoProof({
        repoFullName,
        publicUrl: upload.publicUrl,
        artifactKind,
        objectKey: upload.objectKey,
        sourceFileName: source.fileName,
        proofName: typeof args.proofName === "string" ? args.proofName : undefined,
        description: typeof args.description === "string" ? args.description : undefined,
      });

      return textResult({
        ok: true,
        action: "r2_uploaded_and_portfolio_proof_attached",
        source: {
          relativePath: source.relativePath,
          fileName: source.fileName,
        },
        upload,
        attach,
      });
    }

    case "persist_list_generated_files": {
      return textResult({
        ok: true,
        action: "generated_files_listed",
        files: await listGeneratedFiles(Number.isFinite(args.limit) ? Number(args.limit) : 20),
      });
    }

    case "persist_browser_storage_state_upload": {
      const siteScope = String(args.siteScope || "").trim();

      if (!siteScope) {
        throw new Error("Missing siteScope.");
      }

      const source = await resolveBrowserStateFile(args);
      const upload = await uploadBrowserStateToR2({
        absolutePath: source.absolutePath,
        fileName: source.fileName,
        siteScope,
        accountAlias: typeof args.accountAlias === "string" && args.accountAlias.trim() ? args.accountAlias.trim() : "default",
      });

      return textResult({
        ok: true,
        action: "browser_storage_state_uploaded",
        source: {
          relativePath: source.relativePath,
          fileName: source.fileName,
        },
        upload,
      });
    }

    case "persist_browser_storage_state_download": {
      const siteScope = String(args.siteScope || "").trim();

      if (!siteScope) {
        throw new Error("Missing siteScope.");
      }

      const download = await downloadBrowserStateFromR2({
        siteScope,
        accountAlias: typeof args.accountAlias === "string" && args.accountAlias.trim() ? args.accountAlias.trim() : "default",
        fileName: typeof args.fileName === "string" ? args.fileName.trim() : "",
      });

      return textResult({
        ok: true,
        action: "browser_storage_state_downloaded",
        download,
      });
    }

    default:
      throw new Error(`Unknown tool: ${request.params.name}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

async function shutdown() {
  if (mongoClient) {
    await mongoClient.close().catch(() => {});
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
