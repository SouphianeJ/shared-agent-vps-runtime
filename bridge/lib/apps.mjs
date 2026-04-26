import { readFile } from "node:fs/promises";

export async function loadAppRegistry(runtimeAppsConfigPath, runtimeRoot) {
  const raw = await readFile(runtimeAppsConfigPath, "utf8");
  const parsed = JSON.parse(raw);
  const apps = Array.isArray(parsed?.apps) ? parsed.apps : [];

  return new Map(
    apps.map((app) => {
      const appId = String(app.id ?? "").trim();

      if (!appId) {
        throw new Error("Invalid app id in runtime apps config.");
      }

      const appHome = buildRuntimePath(String(app.paths?.appHome ?? ""), runtimeRoot);

      return [
        appId,
        {
          id: appId,
          displayName: String(app.displayName ?? appId),
          copilotMcpEnvPrefix: String(app.copilotMcpEnvPrefix ?? "").trim(),
          appHome,
          codexHome: buildRuntimePath(String(app.paths?.codexHome ?? ""), runtimeRoot),
          copilotHome: buildRuntimePath(String(app.paths?.copilotHome ?? ""), runtimeRoot),
          workspaceRoot: buildRuntimePath(String(app.paths?.workspaceRoot ?? ""), runtimeRoot),
          fileLibraryRoot: `${appHome}/file-library`,
        },
      ];
    }),
  );
}

export function buildRuntimePath(relativePath, runtimeRoot) {
  const normalized = String(relativePath).replace(/^\/+/, "").replace(/\\/g, "/");

  if (!normalized) {
    throw new Error("Invalid runtime path.");
  }

  return `${String(runtimeRoot).replace(/\/+$/, "")}/${normalized}`;
}
