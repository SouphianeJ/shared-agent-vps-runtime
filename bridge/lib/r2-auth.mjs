import { chmod, mkdir, rename, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";

export function shouldSerializeCodexRuns(payload, options) {
  return shouldSyncCodexAuth(payload, options);
}

export function shouldSyncCodexAuth(payload, options) {
  const { r2Bucket, r2Endpoint, r2AccessKeyId, r2SecretAccessKey } = options;
  return payload.engine === "codex" && Boolean(r2Bucket && r2Endpoint && r2AccessKeyId && r2SecretAccessKey);
}

export function enqueueSerializedRun(runQueueByKey, queueKey, task) {
  const previous = runQueueByKey.get(queueKey) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  const tail = next.finally(() => {
    if (runQueueByKey.get(queueKey) === tail) {
      runQueueByKey.delete(queueKey);
    }
  });
  runQueueByKey.set(queueKey, tail);
  return next;
}

export function authObjectKeyForApp(appId, r2AuthPrefix) {
  const envName = `${String(appId).replace(/[^A-Za-z0-9]+/g, "_").toUpperCase().replace(/^_+|_+$/g, "")}_CODEX_AUTH_OBJECT_KEY`;
  const override = process.env[envName]?.trim();
  if (override) {
    return override;
  }

  return `${String(r2AuthPrefix).replace(/\/+$/, "")}/${appId}/auth.json`;
}

export function authAwsEnv(r2AccessKeyId, r2SecretAccessKey) {
  return {
    ...process.env,
    AWS_ACCESS_KEY_ID: r2AccessKeyId,
    AWS_SECRET_ACCESS_KEY: r2SecretAccessKey,
    AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION ?? "auto",
    AWS_EC2_METADATA_DISABLED: "true",
  };
}

export function runAwsCommand(args, options) {
  const { r2AccessKeyId, r2SecretAccessKey } = options;
  return new Promise((resolve, reject) => {
    const child = spawn("aws", args, {
      env: authAwsEnv(r2AccessKeyId, r2SecretAccessKey),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(stderr.trim() || stdout.trim() || `aws exited with status ${code}`));
    });
  });
}

export async function restoreCodexAuthFromR2(appConfig, options) {
  const { r2Bucket, r2Endpoint, r2AccessKeyId, r2SecretAccessKey, r2AuthPrefix } = options;
  const authPath = `${appConfig.codexHome}/auth.json`;
  const tempPath = `${authPath}.download`;
  const objectKey = authObjectKeyForApp(appConfig.id, r2AuthPrefix);

  await mkdir(appConfig.codexHome, { recursive: true });
  await rm(tempPath, { force: true });

  try {
    await runAwsCommand([
      "s3",
      "cp",
      `s3://${r2Bucket}/${objectKey}`,
      tempPath,
      "--endpoint-url",
      r2Endpoint,
      "--only-show-errors",
    ], { r2AccessKeyId, r2SecretAccessKey });
    await rename(tempPath, authPath);
    await chmodSafe(authPath, 0o600);
  } catch (error) {
    await rm(tempPath, { force: true });
    console.error(`R2 auth restore skipped for ${appConfig.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function uploadCodexAuthToR2(appConfig, options) {
  const { r2Bucket, r2Endpoint, r2AccessKeyId, r2SecretAccessKey, r2AuthPrefix } = options;
  const authPath = `${appConfig.codexHome}/auth.json`;
  const objectKey = authObjectKeyForApp(appConfig.id, r2AuthPrefix);

  try {
    await stat(authPath);
  } catch {
    return;
  }

  await runAwsCommand([
    "s3",
    "cp",
    authPath,
    `s3://${r2Bucket}/${objectKey}`,
    "--endpoint-url",
    r2Endpoint,
    "--only-show-errors",
  ], { r2AccessKeyId, r2SecretAccessKey });
}

export async function chmodSafe(filePath, mode) {
  try {
    await chmod(filePath, mode);
  } catch {
    // Ignore chmod failures on environments that don't support POSIX permissions.
  }
}
