"use strict";
try { require("dotenv").config(); } catch {}

const { Telegraf } = require("telegraf");
const { load } = require("./config");
const { createFly } = require("./fly");
const { register } = require("./handlers");

const cfg = load();
if (cfg.missing.length) {
  console.error(`Missing required environment variable(s): ${cfg.missing.join(", ")}`);
  process.exit(1);
}
if (!cfg.ownerKey) console.warn("SSH_AUTHORIZED_KEY not set: machines will only allow password login.");

const bot = new Telegraf(cfg.botToken, {
  handlerTimeout: 120000,
  ...(cfg.telegramApiRoot ? { telegram: { apiRoot: cfg.telegramApiRoot } } : {})
});
const fly = createFly(cfg);
register(bot, { cfg, fly });

bot.telegram
  .setMyCommands([
    { command: "start", description: "Open the main menu" },
    { command: "myvps", description: "Manage your VPS" }
  ])
  .catch(() => {});

bot.launch({ dropPendingUpdates: true }, () => console.log("SAVAGE VPS CREATOR is running.")).catch(e => {
  console.error("Failed to start bot:", e.message);
  process.exit(1);
});

for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, () => bot.stop(sig));
process.on("unhandledRejection", e => console.error("Unhandled rejection:", String(e?.message || e)));
