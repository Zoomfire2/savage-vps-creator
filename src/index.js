require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const crypto = require("crypto");

const required = ["BOT_TOKEN", "FLY_API_TOKEN", "OWNER_IDS", "FLY_APP_NAME", "VPS_IMAGE", "SSH_AUTHORIZED_KEY"];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}
const owners = new Set(process.env.OWNER_IDS.split(",").map(x => x.trim()));
const bot = new Telegraf(process.env.BOT_TOKEN);
const api = "https://api.machines.dev/v1";
const app = process.env.FLY_APP_NAME;
const region = process.env.FLY_REGION || "iad";
const image = process.env.VPS_IMAGE;
const publicKey = process.env.SSH_AUTHORIZED_KEY;
const pending = new Map();

function isOwner(ctx) {
  return owners.has(String(ctx.from?.id));
}
function guard(ctx) {
  if (!isOwner(ctx)) {
    ctx.reply("⛔ Access denied. This is a private owner-only bot.");
    return false;
  }
  return true;
}
async function fly(path, method = "GET", body) {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.FLY_API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const raw = await res.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
  if (!res.ok) throw new Error(data.error || data.message || `Fly API returned HTTP ${res.status}`);
  return data;
}
function menu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("➕ CREATE VPS", "create")],
    [Markup.button.callback("🖥 MY VPS", "list"), Markup.button.callback("📊 APP INFO", "info")]
  ]);
}
bot.start(async ctx => {
  if (!guard(ctx)) return;
  await ctx.reply(
    "╭━━〔 SAVAGE VPS CREATOR 〕━━╮\n" +
    "┃ Private Fly.io machine manager\n" +
    "┃ Built by Savage EC\n" +
    "╰━━━━━━━━━━━━━━━━━━━━━━╯\n\n" +
    "Choose an action. Creating Machines can incur charges.",
    menu()
  );
});
bot.action("create", async ctx => {
  if (!guard(ctx)) return;
  await ctx.answerCbQuery();
  const id = crypto.randomBytes(4).toString("hex");
  pending.set(ctx.from.id, id);
  await ctx.reply(
    "⚠️ COST CONFIRMATION\n\nThis will create a billable Fly.io Machine in the configured app.\n" +
    `Region: ${region}\nImage: ${image}\n\n` +
    "Send a name for this VPS (3–30 characters; lowercase letters, numbers and hyphens)."
  );
});
bot.on("text", async ctx => {
  if (!guard(ctx)) return;
  const name = ctx.message.text.trim().toLowerCase();
  if (!pending.has(ctx.from.id)) return;
  if (!/^[a-z0-9-]{3,30}$/.test(name)) {
    return ctx.reply("Invalid name. Use 3–30 lowercase letters, numbers or hyphens.");
  }
  pending.delete(ctx.from.id);
  await ctx.reply(`Final confirmation: create "${name}"? This may incur charges.`,
    Markup.inlineKeyboard([
      [Markup.button.callback("✅ CONFIRM CREATE", `confirm:${name}`)],
      [Markup.button.callback("Cancel", "cancel")]
    ]));
});
bot.action("cancel", async ctx => {
  if (!guard(ctx)) return;
  await ctx.answerCbQuery("Cancelled");
  await ctx.editMessageText("Creation cancelled.");
});
bot.action(/^confirm:([a-z0-9-]{3,30})$/, async ctx => {
  if (!guard(ctx)) return;
  await ctx.answerCbQuery();
  const name = ctx.match[1];
  await ctx.reply("Creating Machine…");
  try {
    const result = await fly(`/apps/${encodeURIComponent(app)}/machines`, "POST", {
      name,
      region,
      config: {
        image,
        env: { SSH_AUTHORIZED_KEY: publicKey },
        guest: {
          cpu_kind: "shared",
          cpus: Number(process.env.DEFAULT_CPUS || 1),
          memory_mb: Number(process.env.DEFAULT_MEMORY_MB || 512)
        },
        restart: { policy: "always" }
      }
    });
    const machineId = result.id;
    await ctx.reply(
      "✅ Machine created.\n\n" +
      `Name: ${name}\nMachine ID: ${machineId || "pending"}\n` +
      `Region: ${result.region || region}\n` +
      `State: ${result.state || "starting"}\n\n` +
      "A public IP is not automatically guaranteed. Allocate one in Fly.io networking for this app, then check /myvps. SSH must also be enabled in your custom image."
    );
  } catch (e) {
    await ctx.reply(`❌ Creation failed: ${e.message}\nCheck that the app exists, the image is available, and the token has permission.`);
  }
});
bot.action("list", async ctx => {
  if (!guard(ctx)) return;
  await ctx.answerCbQuery();
  try {
    const data = await fly(`/apps/${encodeURIComponent(app)}/machines`);
    if (!Array.isArray(data) || !data.length) return ctx.reply("No Machines found in the configured app.");
    for (const m of data) {
      await ctx.reply(
        `🖥 ${m.name || "Unnamed"}\nID: ${m.id}\nRegion: ${m.region}\nState: ${m.state}`,
        Markup.inlineKeyboard([
          [Markup.button.callback("▶ Start", `start:${m.id}`), Markup.button.callback("⏹ Stop", `stop:${m.id}`)],
          [Markup.button.callback("🗑 Delete", `delete:${m.id}`)]
        ])
      );
    }
  } catch (e) { await ctx.reply(`Could not list Machines: ${e.message}`); }
});
bot.action("info", async ctx => {
  if (!guard(ctx)) return;
  await ctx.answerCbQuery();
  try {
    const d = await fly(`/apps/${encodeURIComponent(app)}/machines`);
    await ctx.reply(`App: ${app}\nMachines: ${Array.isArray(d) ? d.length : "unknown"}\nRegion default: ${region}`);
  } catch (e) { await ctx.reply(`App info unavailable: ${e.message}`); }
});
for (const action of ["start", "stop", "delete"]) {
  bot.action(new RegExp(`^${action}:([a-f0-9]+)$`), async ctx => {
    if (!guard(ctx)) return;
    await ctx.answerCbQuery();
    const id = ctx.match[1];
    try {
      if (action === "delete") {
        await ctx.reply(`Confirm permanent deletion of Machine ${id}?`,
          Markup.inlineKeyboard([[Markup.button.callback("Confirm delete", `reallydelete:${id}`)], [Markup.button.callback("Cancel", "cancel")]]));
        return;
      }
      const endpoint = action === "start" ? `/apps/${app}/machines/${id}/start` : `/apps/${app}/machines/${id}/stop`;
      await fly(endpoint, "POST", {});
      await ctx.reply(`Request sent: ${action} ${id}`);
    } catch (e) { await ctx.reply(`Operation failed: ${e.message}`); }
  });
}
bot.action(/^reallydelete:([a-f0-9]+)$/, async ctx => {
  if (!guard(ctx)) return;
  await ctx.answerCbQuery();
  try {
    await fly(`/apps/${app}/machines/${ctx.match[1]}`, "DELETE");
    await ctx.reply("Machine deletion requested.");
  } catch (e) { await ctx.reply(`Deletion failed: ${e.message}`); }
});
bot.catch((err) => console.error("Bot error:", err));
bot.launch().then(() => console.log("SAVAGE VPS CREATOR is running."));
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
