import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_MCP_SERVER_URLS = {
  GithubPerso: "https://mcp-github-client-proxy.vercel.app/mcp",
  DBanalyzer: "https://mcp-dbanalyzer-client-proxy.vercel.app/mcp",
  DBworker: "https://mcp-dbworker-client-proxy.vercel.app/mcp",
  MCPcompetencies: "https://mcp-personal-competencies-client-pr.vercel.app/mcp",
  Moodle: "https://mcp-moodle-client-proxy.vercel.app/mcp",
};

export async function ensureAppPaths(appConfig, workspacePath, options = {}) {
  const { payloadEnabledServers = null, includeBrowserMcp = true, runtimeRoot } = options;
  await mkdir(appConfig.appHome, { recursive: true });
  await mkdir(appConfig.codexHome, { recursive: true });
  await mkdir(appConfig.copilotHome, { recursive: true });
  await mkdir(appConfig.workspaceRoot, { recursive: true });
  await mkdir(workspacePath, { recursive: true });
  await mkdir(join(appConfig.fileLibraryRoot, "chats"), { recursive: true });
  await ensureCodexHomeConfig(appConfig, workspacePath, { payloadEnabledServers, includeBrowserMcp, runtimeRoot });
}

export function getSelectedMcpServerEntries(appConfig, payloadEnabledServers = null) {
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

export function buildCopilotMcpPayload(appConfig, workspacePath, options = {}) {
  const { payloadEnabledServers = null, includeBrowserMcp = true } = options;
  const selectedEntries = getSelectedMcpServerEntries(appConfig, payloadEnabledServers);
  const browserConfig = includeBrowserMcp ? buildBrowserServerPaths(workspacePath, appConfig.id) : null;
  const persistConfig = buildPersistServerPaths(appConfig, workspacePath);

  return {
    mcpServers: {
      ...Object.fromEntries(
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
      ...(includeBrowserMcp ? { Browser: buildCopilotBrowserMcpServerConfig(browserConfig) } : {}),
      Persist: buildCopilotPersistMcpServerConfig(persistConfig),
    },
  };
}

export function buildCodexConfigToml(appConfig, workspacePath, options = {}) {
  const { payloadEnabledServers = null, includeBrowserMcp = true, runtimeRoot } = options;
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

  if (includeBrowserMcp) {
    const browserConfig = buildBrowserServerPaths(workspacePath, appConfig.id);
    lines.push("[mcp_servers.Browser]");
    lines.push(`command = "${escapeToml(browserConfig.command)}"`);
    lines.push(`args = [${browserConfig.args.map((value) => `"${escapeToml(value)}"`).join(", ")}]`);
    lines.push("env = {");
    lines.push(`  BROWSER_WORKSPACE_PATH = "${escapeToml(browserConfig.workspacePath)}",`);
    lines.push(`  BROWSER_SESSION_DIR = "${escapeToml(browserConfig.sessionDir)}",`);
    lines.push(`  BROWSER_GENERATED_DIR = "${escapeToml(browserConfig.generatedDir)}",`);
    lines.push(`  BROWSER_STORAGE_STATE_DIR = "${escapeToml(browserConfig.storageStateDir)}",`);
    lines.push(`  R2_BUCKET = "${escapeToml(process.env.R2_BUCKET?.trim() || "")}",`);
    lines.push(`  R2_ENDPOINT = "${escapeToml(process.env.R2_ENDPOINT?.trim() || "")}",`);
    lines.push(`  R2_ACCESS_KEY_ID = "${escapeToml(process.env.R2_ACCESS_KEY_ID?.trim() || process.env.AWS_ACCESS_KEY_ID?.trim() || "")}",`);
    lines.push(`  R2_SECRET_ACCESS_KEY = "${escapeToml(process.env.R2_SECRET_ACCESS_KEY?.trim() || process.env.AWS_SECRET_ACCESS_KEY?.trim() || "")}",`);
    lines.push(`  R2_BROWSER_STATE_PREFIX = "${escapeToml(process.env.R2_BROWSER_STATE_PREFIX?.trim() || "browser-storage-state")}",`);
    lines.push(`  AGENT_RUNTIME_APP_ID = "${escapeToml(browserConfig.appId)}",`);
    lines.push(`  PLAYWRIGHT_BROWSERS_PATH = "${escapeToml(browserConfig.browsersPath)}",`);
    lines.push('  BROWSER_HEADLESS = "true"');
    lines.push("}");
    lines.push("startup_timeout_sec = 30");
    lines.push("tool_timeout_sec = 120");
    lines.push("");
  }

  const persistConfig = buildPersistServerPaths(appConfig, workspacePath);
  lines.push("[mcp_servers.Persist]");
  lines.push(`command = "${escapeToml(persistConfig.command)}"`);
  lines.push(`args = [${persistConfig.args.map((value) => `"${escapeToml(value)}"`).join(", ")}]`);
  lines.push("env = {");
  lines.push(`  PERSIST_APP_ID = "${escapeToml(persistConfig.appId)}",`);
  lines.push(`  PERSIST_CHAT_ID = "${escapeToml(persistConfig.chatId)}",`);
  lines.push(`  PERSIST_WORKSPACE_PATH = "${escapeToml(persistConfig.workspacePath)}",`);
  lines.push(`  PERSIST_GENERATED_DIR = "${escapeToml(persistConfig.generatedDir)}",`);
  lines.push(`  PERSIST_BROWSER_STATE_DIR = "${escapeToml(persistConfig.browserStateDir)}",`);
  lines.push(`  R2_BUCKET = "${escapeToml(process.env.R2_BUCKET?.trim() || "")}",`);
  lines.push(`  R2_ENDPOINT = "${escapeToml(process.env.R2_ENDPOINT?.trim() || "")}",`);
  lines.push(`  R2_ACCESS_KEY_ID = "${escapeToml(process.env.R2_ACCESS_KEY_ID?.trim() || process.env.AWS_ACCESS_KEY_ID?.trim() || "")}",`);
  lines.push(`  R2_SECRET_ACCESS_KEY = "${escapeToml(process.env.R2_SECRET_ACCESS_KEY?.trim() || process.env.AWS_SECRET_ACCESS_KEY?.trim() || "")}",`);
  lines.push(`  R2_PUBLIC_BASE_URL = "${escapeToml(process.env.R2_PUBLIC_BASE_URL?.trim() || "")}",`);
  lines.push(`  R2_PORTFOLIO_PUBLIC_PREFIX = "${escapeToml(process.env.R2_PORTFOLIO_PUBLIC_PREFIX?.trim() || "proof-artifacts")}",`);
  lines.push(`  R2_BROWSER_STATE_PREFIX = "${escapeToml(process.env.R2_BROWSER_STATE_PREFIX?.trim() || "browser-storage-state")}",`);
  lines.push(`  SEEDPORTFOLIO_MONGODB_URI = "${escapeToml(process.env.SEEDPORTFOLIO_MONGODB_URI?.trim() || "")}",`);
  lines.push(`  SEEDPORTFOLIO_MONGODB_DB = "${escapeToml(process.env.SEEDPORTFOLIO_MONGODB_DB?.trim() || "")}",`);
  lines.push(`  SEEDPORTFOLIO_PROOFS_COLLECTION = "${escapeToml(process.env.SEEDPORTFOLIO_PROOFS_COLLECTION?.trim() || "proofs")}"`);
  lines.push("}");
  lines.push("startup_timeout_sec = 30");
  lines.push("tool_timeout_sec = 120");
  lines.push("");

  return `${lines.join("\n").trim()}\n`;
}

export async function ensureCodexHomeConfig(appConfig, workspacePath, options = {}) {
  const { payloadEnabledServers = null, runtimeRoot } = options;
  const configPath = `${appConfig.codexHome}/config.toml`;
  const payload = buildCodexConfigToml(appConfig, workspacePath, { payloadEnabledServers, runtimeRoot });
  await writeFile(configPath, payload, "utf8");
}

export async function ensureCopilotWorkspaceSettings(appConfig, workspacePath, reasoningEffort, options = {}) {
  const { payloadEnabledServers = null, includeBrowserMcp = true } = Array.isArray(options)
    ? { payloadEnabledServers: options, includeBrowserMcp: true }
    : options;
  const settingsDir = `${workspacePath}/.github/copilot`;
  const settingsPath = `${settingsDir}/settings.local.json`;
  const workspaceMcpConfigPath = `${workspacePath}/.mcp.json`;
  const settingsPayload = reasoningEffort ? { effortLevel: reasoningEffort } : {};
  const mcpPayload = buildCopilotMcpPayload(appConfig, workspacePath, { payloadEnabledServers, includeBrowserMcp });

  await mkdir(settingsDir, { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(settingsPayload, null, 2)}\n`, "utf8");
  await writeFile(workspaceMcpConfigPath, `${JSON.stringify(mcpPayload, null, 2)}\n`, "utf8");
}

export function buildBrowserServerPaths(workspacePath, appId = "") {
  return {
    command: "node",
    args: ["/app/browser-mcp/server.mjs"],
    workspacePath,
    appId,
    sessionDir: join(workspacePath, "__browser__"),
    generatedDir: join(workspacePath, "__generated_files__"),
    storageStateDir: join(workspacePath, "__browser__", "storage-state"),
    browsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH?.trim() || "/ms-playwright",
  };
}

export function buildCopilotBrowserMcpServerConfig(browserConfig) {
  return {
    type: "local",
    command: browserConfig.command,
    args: browserConfig.args,
    tools: [
      "browser_open",
      "browser_click",
      "browser_fill",
      "browser_submit",
      "browser_read",
      "browser_extract",
      "browser_wait_for",
      "browser_screenshot",
      "browser_video_start",
      "browser_video_stop",
      "browser_storage_state_save",
      "browser_storage_state_load",
      "browser_restore_storage_state",
      "browser_storage_state_clear",
      "browser_close",
    ],
    env: {
      BROWSER_WORKSPACE_PATH: browserConfig.workspacePath,
      BROWSER_SESSION_DIR: browserConfig.sessionDir,
      BROWSER_GENERATED_DIR: browserConfig.generatedDir,
      BROWSER_STORAGE_STATE_DIR: browserConfig.storageStateDir,
      R2_BUCKET: process.env.R2_BUCKET?.trim() || "",
      R2_ENDPOINT: process.env.R2_ENDPOINT?.trim() || "",
      R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID?.trim() || process.env.AWS_ACCESS_KEY_ID?.trim() || "",
      R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY?.trim() || process.env.AWS_SECRET_ACCESS_KEY?.trim() || "",
      R2_BROWSER_STATE_PREFIX: process.env.R2_BROWSER_STATE_PREFIX?.trim() || "browser-storage-state",
      AGENT_RUNTIME_APP_ID: browserConfig.appId,
      PLAYWRIGHT_BROWSERS_PATH: browserConfig.browsersPath,
      BROWSER_HEADLESS: "true",
    },
  };
}

export function buildPersistServerPaths(appConfig, workspacePath) {
  return {
    command: "node",
    args: ["/app/persist-mcp/server.mjs"],
    appId: appConfig.id,
    chatId: String(workspacePath).split(/[\\/]/).pop() || "unknown-chat",
    workspacePath,
    generatedDir: join(workspacePath, "__generated_files__"),
    browserStateDir: join(workspacePath, "__browser__", "storage-state"),
  };
}

export function buildCopilotPersistMcpServerConfig(persistConfig) {
  return {
    type: "local",
    command: persistConfig.command,
    args: persistConfig.args,
    tools: [
      "persist_r2_upload_generated_file",
      "persist_portfolio_attach_repo_proof",
      "persist_r2_upload_and_attach_repo_proof",
      "persist_list_generated_files",
      "persist_browser_storage_state_upload",
      "persist_browser_storage_state_download",
    ],
    env: {
      PERSIST_APP_ID: persistConfig.appId,
      PERSIST_CHAT_ID: persistConfig.chatId,
      PERSIST_WORKSPACE_PATH: persistConfig.workspacePath,
      PERSIST_GENERATED_DIR: persistConfig.generatedDir,
      PERSIST_BROWSER_STATE_DIR: persistConfig.browserStateDir,
    },
  };
}
