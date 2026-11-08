"use strict";

// Owners built into source (preserved from the original bot) + optional OWNER_IDS env.
const BUILTIN_OWNERS = ["7532448669", "7094344384"];

const ids = v => (v || "").split(/[,\s]+/).filter(x => /^\d{3,20}$/.test(x));

function load(env = process.env) {
  const missing = ["BOT_TOKEN", "FLY_API_TOKEN", "FLY_APP_NAME", "VPS_IMAGE"].filter(k => !env[k]);

  const images = {};
  if (env.VPS_IMAGE_2404) images["24.04"] = env.VPS_IMAGE_2404;
  if (env.VPS_IMAGE_2204) images["22.04"] = env.VPS_IMAGE_2204;
  // Legacy single image: treated as the OS named by VPS_IMAGE_OS (default 24.04).
  const legacyOs = ["22.04", "24.04"].includes(env.VPS_IMAGE_OS) ? env.VPS_IMAGE_OS : "24.04";
  if (env.VPS_IMAGE && !images[legacyOs]) images[legacyOs] = env.VPS_IMAGE;

  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

  return {
    missing,
    botToken: env.BOT_TOKEN,
    flyToken: env.FLY_API_TOKEN,
    app: env.FLY_APP_NAME,
    apiBase: env.FLY_API_BASE || "https://api.machines.dev/v1",
    graphqlUrl: env.FLY_GRAPHQL_URL || "https://api.fly.io/graphql",
    telegramApiRoot: env.TELEGRAM_API_ROOT || undefined,
    defaultRegion: (env.FLY_REGION || "iad").toLowerCase(),
    images,
    ownerKey: env.SSH_AUTHORIZED_KEY || "",
    owners: new Set([...BUILTIN_OWNERS, ...ids(env.OWNER_IDS)]),
    allowedUsers: new Set(ids(env.ALLOWED_USER_IDS)),
    allowAll: String(env.ALLOW_ALL_USERS).toLowerCase() === "true",
    maxPerUser: num(env.MAX_VPS_PER_USER, 5),
    ipType: env.PUBLIC_IP_TYPE === "v6" ? "v6" : "v4",
    portMin: num(env.SSH_PORT_MIN, 20000),
    portMax: num(env.SSH_PORT_MAX, 29999),
    volumePath: env.VOLUME_PATH || "/data",
    sshVerify: String(env.SSH_VERIFY).toLowerCase() !== "false",
    sshVerifyHost: env.SSH_VERIFY_HOST || "",
    credSecret: env.CREDENTIAL_SECRET || env.BOT_TOKEN || "",
    flyTimeoutMs: num(env.FLY_TIMEOUT_MS, 25000),
    startTimeoutMs: num(env.START_TIMEOUT_MS, 120000),
    sshTimeoutMs: num(env.SSH_TIMEOUT_MS, 120000)
  };
}

module.exports = { load, BUILTIN_OWNERS };
