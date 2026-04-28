import { mkdir, copyFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";

import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { chromium } from "playwright";

const workspacePath = process.env.BROWSER_WORKSPACE_PATH?.trim() || process.cwd();
const sessionDir = process.env.BROWSER_SESSION_DIR?.trim() || join(workspacePath, "__browser__");
const generatedDir = process.env.BROWSER_GENERATED_DIR?.trim() || join(workspacePath, "__generated_files__");
const storageStateDir = process.env.BROWSER_STORAGE_STATE_DIR?.trim() || join(sessionDir, "storage-state");
const headless = !/^(0|false|no)$/i.test(process.env.BROWSER_HEADLESS?.trim() || "true");
const r2Bucket = process.env.R2_BUCKET?.trim() || "";
const r2Endpoint = process.env.R2_ENDPOINT?.trim() || "";
const r2AccessKeyId = process.env.R2_ACCESS_KEY_ID?.trim() || process.env.AWS_ACCESS_KEY_ID?.trim() || "";
const r2SecretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim() || process.env.AWS_SECRET_ACCESS_KEY?.trim() || "";
const r2BrowserStatePrefix = process.env.R2_BROWSER_STATE_PREFIX?.trim().replace(/^\/+|\/+$/g, "") || "browser-storage-state";

class BrowserSession {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.lastUrl = null;
    this.pendingVideo = null;
    this.recordingActive = false;
    this.storageStatePath = null;
    this.storageStateScope = null;
    this.storageStateRestored = null;
  }

  async ensureDirectories() {
    await mkdir(sessionDir, { recursive: true });
    await mkdir(generatedDir, { recursive: true });
    await mkdir(storageStateDir, { recursive: true });
  }

  async ensureBrowser() {
    if (!this.browser) {
      await this.ensureDirectories();
      this.browser = await chromium.launch({ headless });
    }

    if (!this.context) {
      await this.createContext();
    }

    if (!this.page) {
      this.page = await this.context.newPage();
    }

    return this.page;
  }

  async createContext() {
    const contextOptions = {
      viewport: { width: 1440, height: 960 },
    };

    if (this.pendingVideo) {
      contextOptions.recordVideo = {
        dir: join(sessionDir, "videos"),
        size: this.pendingVideo.size,
      };
      this.recordingActive = true;
    } else {
      this.recordingActive = false;
    }

    if (this.storageStatePath && existsSync(this.storageStatePath)) {
      contextOptions.storageState = this.storageStatePath;
    }

    this.context = await this.browser.newContext(contextOptions);
    this.page = null;
  }

  async closeContext() {
    if (this.page) {
      try {
        await this.page.close();
      } catch {
        // Ignore page close failures.
      }
    }

    if (this.context) {
      try {
        await this.context.close();
      } catch {
        // Ignore context close failures.
      }
    }

    this.page = null;
    this.context = null;
  }

  async shutdown() {
    await this.closeContext();

    if (this.browser) {
      try {
        await this.browser.close();
      } catch {
        // Ignore browser close failures.
      }
    }

    this.browser = null;
  }
}

const session = new BrowserSession();
let s3Client;

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

function requireObject(value) {
  return value && typeof value === "object" ? value : {};
}

function resolveTimestampedFile(prefix, extension) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(generatedDir, `${prefix}-${stamp}.${extension}`);
}

function sanitizeSegment(input) {
  return String(input || "unknown")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";
}

function sanitizeStateFileName(input) {
  const normalized = String(input || "browser-storage-state.json")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!normalized) {
    return "browser-storage-state.json";
  }

  return normalized.toLowerCase().endsWith(".json") ? normalized : `${normalized}.json`;
}

function resolveStorageStatePath(fileName) {
  return join(storageStateDir, sanitizeStateFileName(fileName));
}

function hasR2Config() {
  return Boolean(r2Bucket && r2Endpoint && r2AccessKeyId && r2SecretAccessKey);
}

function getS3Client() {
  if (!hasR2Config()) {
    return null;
  }

  if (!s3Client) {
    s3Client = new S3Client({
      region: "auto",
      endpoint: r2Endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: r2AccessKeyId,
        secretAccessKey: r2SecretAccessKey,
      },
    });
  }

  return s3Client;
}

function buildBrowserStateObjectKey(siteScope, accountAlias = "default") {
  return [
    r2BrowserStatePrefix,
    sanitizeSegment(process.env.AGENT_RUNTIME_APP_ID?.trim() || process.env.PERSIST_APP_ID?.trim() || "unknown-app"),
    sanitizeSegment(siteScope),
    sanitizeSegment(accountAlias),
    "latest.json",
  ].join("/");
}

function inferSiteScope(url, args) {
  const explicitScope = typeof args.siteScope === "string" ? args.siteScope.trim() : "";

  if (explicitScope) {
    return explicitScope;
  }

  try {
    return new URL(url).hostname || "";
  } catch {
    return "";
  }
}

async function maybeRestoreStorageState(url, args) {
  if (args.restoreStorageState === false || session.context) {
    return null;
  }

  const siteScope = inferSiteScope(url, args);
  if (!siteScope) {
    return null;
  }

  const accountAlias = typeof args.accountAlias === "string" && args.accountAlias.trim() ? args.accountAlias.trim() : "default";
  return await restoreStorageStateForScope({
    siteScope,
    accountAlias,
    allowAliasFallback: !("accountAlias" in args),
  });
}

async function restoreStorageStateForScope({ siteScope, accountAlias = "default", allowAliasFallback = true }) {
  const desiredScopeKey = `${siteScope}::${accountAlias}`;

  if (session.storageStatePath && session.storageStateScope === desiredScopeKey && existsSync(session.storageStatePath)) {
    session.storageStateRestored = {
      source: "local",
      siteScope,
      accountAlias,
      fileName: basename(session.storageStatePath),
      objectKey: null,
    };
    return session.storageStateRestored;
  }

  const localCandidates = [
    resolveStorageStatePath(`${sanitizeSegment(siteScope)}-${sanitizeSegment(accountAlias)}.json`),
    resolveStorageStatePath(`${sanitizeSegment(siteScope)}.json`),
  ];

  for (const candidate of localCandidates) {
    if (existsSync(candidate)) {
      session.storageStatePath = candidate;
      session.storageStateScope = desiredScopeKey;
      session.storageStateRestored = {
        source: "local",
        siteScope,
        accountAlias,
        fileName: basename(candidate),
        objectKey: null,
      };
      return session.storageStateRestored;
    }
  }

  const client = getS3Client();
  if (!client) {
    return null;
  }

  const exactResult = await downloadStorageStateObject(client, siteScope, accountAlias, desiredScopeKey);
  if (exactResult) {
    return exactResult;
  }

  if (allowAliasFallback) {
    const latestResult = await downloadLatestStorageStateObject(client, siteScope);
    if (latestResult) {
      return latestResult;
    }
  }

  session.storageStatePath = null;
  session.storageStateScope = null;
  session.storageStateRestored = {
    source: "missing",
    siteScope,
    accountAlias,
    fileName: null,
    objectKey: buildBrowserStateObjectKey(siteScope, accountAlias),
  };
  return session.storageStateRestored;
}

async function downloadStorageStateObject(client, siteScope, accountAlias, desiredScopeKey) {
  const objectKey = buildBrowserStateObjectKey(siteScope, accountAlias);

  try {
    const response = await client.send(
      new GetObjectCommand({
        Bucket: r2Bucket,
        Key: objectKey,
      }),
    );

    if (!response.Body || typeof response.Body.transformToByteArray !== "function") {
      return null;
    }

    const bytes = await response.Body.transformToByteArray();
    const targetPath = resolveStorageStatePath(`${sanitizeSegment(siteScope)}-${sanitizeSegment(accountAlias)}.json`);
    await mkdir(storageStateDir, { recursive: true });
    await writeFile(targetPath, Buffer.from(bytes));
    session.storageStatePath = targetPath;
    session.storageStateScope = desiredScopeKey;
    session.storageStateRestored = {
      source: "r2",
      siteScope,
      accountAlias,
      fileName: basename(targetPath),
      objectKey,
    };
    return session.storageStateRestored;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errorName = error && typeof error === "object" && "name" in error ? String(error.name) : "";
    const statusCode =
      error && typeof error === "object" && "$metadata" in error && error.$metadata && typeof error.$metadata === "object"
        ? Number(error.$metadata.httpStatusCode ?? 0)
        : 0;

    if (/NoSuchKey|NotFound|404/i.test(message) || /NoSuchKey|NotFound/i.test(errorName) || statusCode === 404) {
      return null;
    }

    throw error;
  }
}

async function downloadLatestStorageStateObject(client, siteScope) {
  const prefix = [
    r2BrowserStatePrefix,
    sanitizeSegment(process.env.AGENT_RUNTIME_APP_ID?.trim() || process.env.PERSIST_APP_ID?.trim() || "unknown-app"),
    sanitizeSegment(siteScope),
    "",
  ].join("/");

  const listing = await client.send(
    new ListObjectsV2Command({
      Bucket: r2Bucket,
      Prefix: prefix,
    }),
  );

  const candidates = (listing.Contents || [])
    .filter((entry) => typeof entry.Key === "string" && entry.Key.endsWith("/latest.json"))
    .sort((left, right) => {
      const leftTime = left.LastModified ? new Date(left.LastModified).getTime() : 0;
      const rightTime = right.LastModified ? new Date(right.LastModified).getTime() : 0;
      return rightTime - leftTime;
    });

  const latest = candidates[0];
  if (!latest?.Key) {
    return null;
  }

  const alias = latest.Key.split("/").at(-2) || "default";
  return await downloadStorageStateObject(client, siteScope, alias, `${siteScope}::${alias}`);
}

async function resolveLocator(page, args) {
  const selector = typeof args.selector === "string" ? args.selector.trim() : "";
  const text = typeof args.text === "string" ? args.text.trim() : "";
  const role = typeof args.role === "string" ? args.role.trim() : "";
  const name = typeof args.name === "string" ? args.name.trim() : "";

  if (selector) {
    return page.locator(selector).first();
  }

  if (role) {
    return page.getByRole(role, name ? { name } : {}).first();
  }

  if (text) {
    return page.getByText(text, { exact: Boolean(args.exact) }).first();
  }

  throw new Error("Missing target locator. Provide selector, role, or text.");
}

async function buildOpenResult(page, response, label = "opened") {
  const title = await page.title();
  const content = await page.evaluate(() => {
    const text = document.body?.innerText || "";
    return text.replace(/\s+/g, " ").trim().slice(0, 1200);
  });

  return {
    ok: true,
    action: label,
    url: page.url(),
    title,
    status: response?.status?.() ?? null,
    contentPreview: content,
    storageStateRestored: session.storageStateRestored,
  };
}

async function listLinks(page, limit = 20) {
  return await page.evaluate((max) => {
    return Array.from(document.querySelectorAll("a"))
      .slice(0, max)
      .map((anchor) => ({
        text: (anchor.textContent || "").replace(/\s+/g, " ").trim(),
        href: anchor.getAttribute("href") || "",
      }));
  }, limit);
}

async function listHeadings(page, limit = 20) {
  return await page.evaluate((max) => {
    return Array.from(document.querySelectorAll("h1, h2, h3"))
      .slice(0, max)
      .map((heading) => ({
        level: heading.tagName.toLowerCase(),
        text: (heading.textContent || "").replace(/\s+/g, " ").trim(),
      }));
  }, limit);
}

async function listForms(page, limit = 10) {
  return await page.evaluate((max) => {
    return Array.from(document.querySelectorAll("form"))
      .slice(0, max)
      .map((form, index) => ({
        index,
        action: form.getAttribute("action") || "",
        method: form.getAttribute("method") || "get",
        fields: Array.from(form.querySelectorAll("input, textarea, select"))
          .slice(0, 20)
          .map((field) => ({
            tag: field.tagName.toLowerCase(),
            type: field.getAttribute("type") || "",
            name: field.getAttribute("name") || "",
            id: field.getAttribute("id") || "",
            placeholder: field.getAttribute("placeholder") || "",
          })),
      }));
  }, limit);
}

async function captureVideoArtifact(page, lastUrl) {
  const video = page?.video?.();

  if (!video) {
    return null;
  }

  const sourcePath = await video.path();

  if (!sourcePath || !existsSync(sourcePath)) {
    return null;
  }

  const targetPath = resolveTimestampedFile("browser-video", "webm");
  await copyFile(sourcePath, targetPath);

  await session.closeContext();
  session.pendingVideo = null;
  session.recordingActive = false;

  if (lastUrl) {
    const restoredPage = await session.ensureBrowser();
    await restoredPage.goto(lastUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    session.lastUrl = lastUrl;
  }

  return {
    ok: true,
    action: "video_saved",
    path: targetPath,
    fileName: basename(targetPath),
  };
}

const tools = [
  {
    name: "browser_open",
    description: "Open a page and return URL, title, status, and a short readable preview.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        waitUntil: { type: "string", enum: ["load", "domcontentloaded", "networkidle", "commit"] },
        timeoutMs: { type: "number" },
        recordVideo: { type: "boolean" },
        siteScope: { type: "string" },
        accountAlias: { type: "string" },
        restoreStorageState: { type: "boolean" },
      },
      required: ["url"],
    },
  },
  {
    name: "browser_click",
    description: "Click an element using selector, role/name, or text.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        text: { type: "string" },
        role: { type: "string" },
        name: { type: "string" },
        exact: { type: "boolean" },
        timeoutMs: { type: "number" },
      },
    },
  },
  {
    name: "browser_fill",
    description: "Fill an input, textarea, or similar field.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        text: { type: "string" },
        role: { type: "string" },
        name: { type: "string" },
        exact: { type: "boolean" },
        value: { type: "string" },
        timeoutMs: { type: "number" },
      },
      required: ["value"],
    },
  },
  {
    name: "browser_submit",
    description: "Submit a form by click, locator Enter key, or generic Enter.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        text: { type: "string" },
        role: { type: "string" },
        name: { type: "string" },
        exact: { type: "boolean" },
        mode: { type: "string", enum: ["click", "pressEnter"] },
        timeoutMs: { type: "number" },
      },
    },
  },
  {
    name: "browser_read",
    description: "Read the visible contents of a page or a targeted section precisely.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        includeHtml: { type: "boolean" },
        includeLinks: { type: "boolean" },
        includeHeadings: { type: "boolean" },
        includeForms: { type: "boolean" },
        maxChars: { type: "number" },
      },
    },
  },
  {
    name: "browser_extract",
    description: "Extract structured values using explicit selectors.",
    inputSchema: {
      type: "object",
      properties: {
        fields: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              selector: { type: "string" },
              attribute: { type: "string" },
              multiple: { type: "boolean" },
            },
            required: ["name", "selector"],
          },
        },
      },
      required: ["fields"],
    },
  },
  {
    name: "browser_wait_for",
    description: "Wait for selector, text, or load state.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        text: { type: "string" },
        state: { type: "string", enum: ["attached", "detached", "visible", "hidden"] },
        loadState: { type: "string", enum: ["load", "domcontentloaded", "networkidle"] },
        timeoutMs: { type: "number" },
      },
    },
  },
  {
    name: "browser_screenshot",
    description: "Capture a screenshot and save it as a generated file.",
    inputSchema: {
      type: "object",
      properties: {
        fullPage: { type: "boolean" },
        selector: { type: "string" },
      },
    },
  },
  {
    name: "browser_video_start",
    description: "Arm video recording for the next opened browser context.",
    inputSchema: {
      type: "object",
      properties: {
        width: { type: "number" },
        height: { type: "number" },
      },
    },
  },
  {
    name: "browser_video_stop",
    description: "Finalize the current recorded video and save it as a generated file.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "browser_close",
    description: "Close the active browser context and release Playwright resources.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "browser_storage_state_save",
    description: "Save the current Playwright storageState JSON for reuse in later browser contexts.",
    inputSchema: {
      type: "object",
      properties: {
        fileName: { type: "string" },
      },
    },
  },
  {
    name: "browser_storage_state_load",
    description: "Load a saved storageState JSON and recreate future browser contexts with it.",
    inputSchema: {
      type: "object",
      properties: {
        fileName: { type: "string" },
      },
      required: ["fileName"],
    },
  },
  {
    name: "browser_storage_state_clear",
    description: "Clear the configured storageState so future browser contexts start fresh.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "browser_restore_storage_state",
    description: "Restore a previously persisted Playwright storage state for a site scope into Browser MCP and prepare future pages to use it.",
    inputSchema: {
      type: "object",
      properties: {
        siteScope: { type: "string" },
        accountAlias: { type: "string" },
        allowAliasFallback: { type: "boolean" },
      },
      required: ["siteScope"],
    },
  },
];

const server = new Server(
  {
    name: "runtime-browser-mcp",
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
  const timeoutMs = Number.isFinite(args.timeoutMs) ? Number(args.timeoutMs) : 15_000;

  switch (request.params.name) {
    case "browser_open": {
      const url = String(args.url || "").trim();

      if (!url) {
        throw new Error("Missing url.");
      }

      if (Boolean(args.recordVideo)) {
        session.pendingVideo = {
          size: {
            width: Number.isFinite(args.width) ? Number(args.width) : 1280,
            height: Number.isFinite(args.height) ? Number(args.height) : 720,
          },
        };
      }

      await maybeRestoreStorageState(url, args);

      const page = await session.ensureBrowser();
      const response = await page.goto(url, {
        waitUntil: typeof args.waitUntil === "string" ? args.waitUntil : "domcontentloaded",
        timeout: timeoutMs,
      });
      session.lastUrl = page.url();
      return textResult(await buildOpenResult(page, response));
    }

    case "browser_click": {
      const page = await session.ensureBrowser();
      const locator = await resolveLocator(page, args);
      await locator.click({ timeout: timeoutMs });
      await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => {});
      session.lastUrl = page.url();
      return textResult(await buildOpenResult(page, null, "clicked"));
    }

    case "browser_fill": {
      const page = await session.ensureBrowser();
      const locator = await resolveLocator(page, args);
      await locator.fill(String(args.value ?? ""), { timeout: timeoutMs });
      return textResult({
        ok: true,
        action: "filled",
        url: page.url(),
        target: args.selector || args.text || args.role || null,
        valueLength: String(args.value ?? "").length,
      });
    }

    case "browser_submit": {
      const page = await session.ensureBrowser();
      if ((args.mode || "click") === "pressEnter") {
        if (args.selector || args.text || args.role) {
          const locator = await resolveLocator(page, args);
          await locator.press("Enter", { timeout: timeoutMs });
        } else {
          await page.keyboard.press("Enter");
        }
      } else {
        const locator = await resolveLocator(page, args);
        await locator.click({ timeout: timeoutMs });
      }
      await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => {});
      session.lastUrl = page.url();
      return textResult(await buildOpenResult(page, null, "submitted"));
    }

    case "browser_read": {
      const page = await session.ensureBrowser();
      const maxChars = Number.isFinite(args.maxChars) ? Number(args.maxChars) : 12_000;
      const target = typeof args.selector === "string" && args.selector.trim() ? page.locator(args.selector).first() : null;
      const text = target
        ? await target.innerText({ timeout: timeoutMs }).catch(async () => target.textContent() || "")
        : await page.evaluate(() => document.body?.innerText || "");
      const result = {
        ok: true,
        action: "read",
        url: page.url(),
        title: await page.title(),
        text: String(text || "").replace(/\s+\n/g, "\n").trim().slice(0, maxChars),
        headings: args.includeHeadings ? await listHeadings(page) : undefined,
        links: args.includeLinks ? await listLinks(page) : undefined,
        forms: args.includeForms ? await listForms(page) : undefined,
        html: args.includeHtml
          ? target
            ? await target.evaluate((node) => node.outerHTML)
            : await page.content()
          : undefined,
      };
      return textResult(result);
    }

    case "browser_extract": {
      const page = await session.ensureBrowser();
      const fields = Array.isArray(args.fields) ? args.fields : [];
      const output = {};

      for (const field of fields) {
        const name = String(field?.name || "").trim();
        const selector = String(field?.selector || "").trim();

        if (!name || !selector) {
          continue;
        }

        const locator = page.locator(selector);

        if (field.multiple) {
          output[name] = await locator.evaluateAll((nodes, attribute) => {
            return nodes.map((node) => {
              if (typeof attribute === "string" && attribute) {
                return node.getAttribute(attribute);
              }

              return (node.textContent || "").replace(/\s+/g, " ").trim();
            });
          }, typeof field.attribute === "string" ? field.attribute : "");
          continue;
        }

        output[name] = await locator.first().evaluate((node, attribute) => {
          if (typeof attribute === "string" && attribute) {
            return node.getAttribute(attribute);
          }

          return (node.textContent || "").replace(/\s+/g, " ").trim();
        }, typeof field.attribute === "string" ? field.attribute : "");
      }

      return textResult({
        ok: true,
        action: "extract",
        url: page.url(),
        data: output,
      });
    }

    case "browser_wait_for": {
      const page = await session.ensureBrowser();
      if (typeof args.loadState === "string" && args.loadState) {
        await page.waitForLoadState(args.loadState, { timeout: timeoutMs });
      } else if (typeof args.selector === "string" && args.selector.trim()) {
        await page.waitForSelector(args.selector, {
          state: typeof args.state === "string" ? args.state : "visible",
          timeout: timeoutMs,
        });
      } else if (typeof args.text === "string" && args.text.trim()) {
        await page.getByText(args.text).first().waitFor({
          state: typeof args.state === "string" ? args.state : "visible",
          timeout: timeoutMs,
        });
      } else {
        throw new Error("Provide loadState, selector, or text.");
      }

      return textResult({
        ok: true,
        action: "waited",
        url: page.url(),
      });
    }

    case "browser_screenshot": {
      const page = await session.ensureBrowser();
      const targetPath = resolveTimestampedFile("browser-screenshot", "png");

      if (typeof args.selector === "string" && args.selector.trim()) {
        await page.locator(args.selector).first().screenshot({ path: targetPath });
      } else {
        await page.screenshot({
          path: targetPath,
          fullPage: Boolean(args.fullPage),
        });
      }

      return textResult({
        ok: true,
        action: "screenshot_saved",
        url: page.url(),
        path: targetPath,
        fileName: basename(targetPath),
      });
    }

    case "browser_video_start": {
      if (session.context) {
        return textResult({
          ok: false,
          action: "video_start_rejected",
          reason: "Video recording can only be armed before browser_open in this MVP.",
          url: session.lastUrl,
        });
      }

      session.pendingVideo = {
        size: {
          width: Number.isFinite(args.width) ? Number(args.width) : 1280,
          height: Number.isFinite(args.height) ? Number(args.height) : 720,
        },
      };

      return textResult({
        ok: true,
        action: "video_armed",
        size: session.pendingVideo.size,
      });
    }

    case "browser_video_stop": {
      if (!session.context || !session.page || !session.recordingActive) {
        return textResult({
          ok: false,
          action: "video_stop_rejected",
          reason: "No active recorded browser context.",
        });
      }

      const artifact = await captureVideoArtifact(session.page, session.lastUrl);
      return textResult(
        artifact || {
          ok: false,
          action: "video_stop_failed",
          reason: "No saved video artifact was produced.",
        },
      );
    }

    case "browser_close": {
      await session.shutdown();
      session.lastUrl = null;
      session.pendingVideo = null;
      session.recordingActive = false;
      return textResult({
        ok: true,
        action: "closed",
      });
    }

    case "browser_storage_state_save": {
      await session.ensureDirectories();

      if (!session.context) {
        await session.ensureBrowser();
      }

      const targetPath = resolveStorageStatePath(args.fileName);
      await session.context.storageState({ path: targetPath });
      session.storageStatePath = targetPath;
      session.storageStateRestored = {
        source: "local",
        siteScope: null,
        accountAlias: null,
        fileName: basename(targetPath),
        objectKey: null,
      };
      const fileInfo = await stat(targetPath);

      return textResult({
        ok: true,
        action: "storage_state_saved",
        path: targetPath,
        fileName: basename(targetPath),
        size: Number(fileInfo.size ?? 0),
      });
    }

    case "browser_storage_state_load": {
      await session.ensureDirectories();
      const targetPath = resolveStorageStatePath(args.fileName);

      if (!existsSync(targetPath)) {
        throw new Error(`Storage state file not found: ${basename(targetPath)}`);
      }

      session.storageStatePath = targetPath;
      session.storageStateScope = null;
      session.storageStateRestored = {
        source: "local",
        siteScope: null,
        accountAlias: null,
        fileName: basename(targetPath),
        objectKey: null,
      };
      await session.closeContext();

      return textResult({
        ok: true,
        action: "storage_state_loaded",
        path: targetPath,
        fileName: basename(targetPath),
      });
    }

    case "browser_storage_state_clear": {
      session.storageStatePath = null;
      session.storageStateScope = null;
      session.storageStateRestored = null;
      await session.closeContext();

      return textResult({
        ok: true,
        action: "storage_state_cleared",
      });
    }

    case "browser_restore_storage_state": {
      const siteScope = String(args.siteScope || "").trim();
      if (!siteScope) {
        throw new Error("Missing siteScope.");
      }

      await session.ensureDirectories();
      const restored = await restoreStorageStateForScope({
        siteScope,
        accountAlias: typeof args.accountAlias === "string" && args.accountAlias.trim() ? args.accountAlias.trim() : "default",
        allowAliasFallback: args.allowAliasFallback !== false,
      });
      await session.closeContext();

      return textResult({
        ok: Boolean(restored && restored.source !== "missing"),
        action: "storage_state_restored",
        restored,
      });
    }

    default:
      throw new Error(`Unknown tool: ${request.params.name}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

process.on("SIGINT", async () => {
  await session.shutdown();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await session.shutdown();
  process.exit(0);
});
