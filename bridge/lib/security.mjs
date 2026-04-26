import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function registerKey(keyRegistry, keyId, key) {
  if (!keyId || !key) {
    return;
  }

  keyRegistry.set(keyId, key);
}

export function validateSignedRequest({ method, path, headers, rawBody, keyRegistry, nonceCache, maxSkewSeconds, nonceTtlSeconds }) {
  const keyId = headers["x-proxy-key-id"];
  const timestamp = headers["x-proxy-timestamp"];
  const nonce = headers["x-proxy-nonce"];
  const bodyHash = headers["x-proxy-body-sha256"];
  const signature = headers["x-proxy-signature"];

  if (!keyId || !timestamp || !nonce || !bodyHash || !signature) {
    return { status: 401, message: "Missing proxy signature headers." };
  }

  const secret = keyRegistry.get(keyId);

  if (!secret) {
    return { status: 401, message: "Unknown proxy key id." };
  }

  const timestampNumber = Number.parseInt(timestamp, 10);

  if (!Number.isFinite(timestampNumber)) {
    return { status: 401, message: "Invalid proxy timestamp." };
  }

  const now = Math.floor(Date.now() / 1000);

  if (Math.abs(now - timestampNumber) > maxSkewSeconds) {
    return { status: 401, message: "Expired proxy timestamp." };
  }

  if (!/^[a-f0-9]{32}$/i.test(nonce)) {
    return { status: 401, message: "Invalid proxy nonce." };
  }

  if (nonceCache.has(`${keyId}:${nonce}`)) {
    return { status: 409, message: "Replayed proxy nonce." };
  }

  const actualBodyHash = createHash("sha256").update(rawBody).digest("hex");

  if (bodyHash !== actualBodyHash) {
    return { status: 401, message: "Invalid body hash." };
  }

  const signaturePayload = [method.toUpperCase(), path, timestamp, nonce, bodyHash].join("\n");
  const expectedSignature = createHmac("sha256", secret).update(signaturePayload).digest("hex");

  if (!safeEqual(signature, expectedSignature)) {
    return { status: 401, message: "Invalid proxy signature." };
  }

  nonceCache.set(`${keyId}:${nonce}`, Date.now() + nonceTtlSeconds * 1000);
  return null;
}

export function validateUploadRequest(request, requestUrl, keyRegistry) {
  const uploadToken = typeof request.headers["x-upload-token"] === "string" ? request.headers["x-upload-token"] : "";
  const filenameHeader = typeof request.headers["x-upload-filename"] === "string" ? request.headers["x-upload-filename"] : "";
  const contentTypeHeader = typeof request.headers["x-upload-content-type"] === "string" ? request.headers["x-upload-content-type"] : "";

  if (!uploadToken) {
    throw new Error("Missing upload token.");
  }

  const parsedToken = parseUploadToken(uploadToken, keyRegistry);
  const appId = requestUrl.searchParams.get("appId")?.trim() ?? "";
  const chatId = requestUrl.searchParams.get("chatId")?.trim() ?? "";
  const fileId = requestUrl.searchParams.get("fileId")?.trim() ?? "";

  if (parsedToken.appId !== appId || parsedToken.chatId !== chatId || parsedToken.fileId !== fileId) {
    throw new Error("Upload token does not match request target.");
  }

  return {
    appId,
    chatId,
    fileId,
    filename: decodeURIComponent(filenameHeader || parsedToken.filename),
    contentType: contentTypeHeader || parsedToken.contentType || "application/octet-stream",
    expectedSize: parsedToken.size,
  };
}

export function parseUploadToken(token, keyRegistry) {
  const [encodedPayload, signature] = String(token).split(".");

  if (!encodedPayload || !signature) {
    throw new Error("Invalid upload token.");
  }

  const serializedPayload = Buffer.from(encodedPayload, "base64url").toString("utf8");
  let payload;

  try {
    payload = JSON.parse(serializedPayload);
  } catch {
    throw new Error("Invalid upload token payload.");
  }

  const matchedSecret = Array.from(keyRegistry.values()).find((secret) => {
    const expectedSignature = createHmac("sha256", secret).update(serializedPayload).digest("base64url");
    return safeEqual(signature, expectedSignature);
  });

  if (!matchedSecret) {
    throw new Error("Invalid upload token signature.");
  }

  if (payload?.v !== "v1") {
    throw new Error("Unsupported upload token version.");
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(payload?.appId ?? "")) {
    throw new Error("Invalid upload token app id.");
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(payload?.chatId ?? "")) {
    throw new Error("Invalid upload token chat id.");
  }

  if (!/^[a-f0-9-]{36}$/i.test(payload?.fileId ?? "")) {
    throw new Error("Invalid upload token file id.");
  }

  if (typeof payload.exp !== "number" || Math.floor(Date.now() / 1000) > payload.exp) {
    throw new Error("Expired upload token.");
  }

  return payload;
}

export function writeCorsHeaders(response, origin) {
  response.setHeader("Access-Control-Allow-Origin", origin || "*");
  response.setHeader("Access-Control-Allow-Methods", "PUT, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Upload-Token, X-Upload-Filename, X-Upload-Content-Type");
  response.setHeader("Vary", "Origin");
}

export function normalizeHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.join(",") : value]),
  );
}

export function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    request.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

export function cleanExpiredNonces(nonceCache) {
  const now = Date.now();

  for (const [nonceKey, expiresAt] of nonceCache.entries()) {
    if (expiresAt <= now) {
      nonceCache.delete(nonceKey);
    }
  }
}

export function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}
