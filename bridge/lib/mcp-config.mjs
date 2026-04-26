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
  const { payloadEnabledServers = null, runtimeRoot } = options;
  await mkdir(appConfig.appHome, { recursive: true });
  await mkdir(appConfig.codexHome, { recursive: true });
  await mkdir(appConfig.copilotHome, { recursive: true });
  await mkdir(appConfig.workspaceRoot, { recursive: true });
  await mkdir(workspacePath, { recursive: true });
  await mkdir(join(appConfig.fileLibraryRoot, "chats"), { recursive: true });
  await ensureCodexHomeConfig(appConfig, workspacePath, { payloadEnabledServers, runtimeRoot });
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

export function buildCopilotMcpPayload(appConfig, workspacePath, payloadEnabledServers = null) {
  const selectedEntries = getSelectedMcpServerEntries(appConfig, payloadEnabledServers);

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
      Browser: buildCopilotBrowserMcpServerConfig(workspacePath),
    },
  };
}

export function buildCodexConfigToml(appConfig, workspacePath, options = {}) {
  const { payloadEnabledServers = null, runtimeRoot } = options;
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

  const browserConfig = buildBrowserServerPaths(workspacePath);
  lines.push("[mcp_servers.Browser]");
  lines.push(`command = "${escapeToml(browserConfig.command)}"`);
  lines.push(`args = [${browserConfig.args.map((value) => `"${escapeToml(value)}"`).join(", ")}]`);
  lines.push("env = {");
  lines.push(`  BROWSER_WORKSPACE_PATH = "${escapeToml(browserConfig.workspacePath)}",`);
  lines.push(`  BROWSER_SESSION_DIR = "${escapeToml(browserConfig.sessionDir)}",`);
  lines.push(`  BROWSER_GENERATED_DIR = "${escapeToml(browserConfig.generatedDir)}",`);
  lines.push(`  PLAYWRIGHT_BROWSERS_PATH = "${escapeToml(browserConfig.browsersPath)}",`);
  lines.push('  BROWSER_HEADLESS = "true"');
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

export async function ensureCopilotWorkspaceSettings(appConfig, workspacePath, reasoningEffort, payloadEnabledServers = null) {
  const settingsDir = `${workspacePath}/.github/copilot`;
  const settingsPath = `${settingsDir}/settings.local.json`;
  const workspaceMcpConfigPath = `${workspacePath}/.mcp.json`;
  const settingsPayload = reasoningEffort ? { effortLevel: reasoningEffort } : {};
  const mcpPayload = buildCopilotMcpPayload(appConfig, workspacePath, payloadEnabledServers);

  await mkdir(settingsDir, { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(settingsPayload, null, 2)}\n`, "utf8");
  await writeFile(workspaceMcpConfigPath, `${JSON.stringify(mcpPayload, null, 2)}\n`, "utf8");
}

export function buildBrowserServerPaths(workspacePath) {
  return {
    command: "node",
    args: ["/app/browser-mcp/server.mjs"],
    workspacePath,
    sessionDir: join(workspacePath, "__browser__"),
    generatedDir: join(workspacePath, "__generated_files__"),
    browsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH?.trim() || "/ms-playwright",
  };
}

export function buildCopilotBrowserMcpServerConfig(workspacePath) {
  const browserConfig = buildBrowserServerPaths(workspacePath);

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
      "browser_close",
    ],
    env: {
      BROWSER_WORKSPACE_PATH: browserConfig.workspacePath,
      BROWSER_SESSION_DIR: browserConfig.sessionDir,
      BROWSER_GENERATED_DIR: browserConfig.generatedDir,
      PLAYWRIGHT_BROWSERS_PATH: browserConfig.browsersPath,
      BROWSER_HEADLESS: "true",
    },
  };
}
