"use strict";
const { Markup } = require("telegraf");
const { PLANS, estimate, gb } = require("./limits");

const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const B = Markup.button.callback;
const HEAD = "⚡ <b>SAVAGE VPS CREATOR</b>";
const LINE = "━━━━━━━━━━━━━━━━━━";
const FOOT = "⚡ <i>POWERED BY SAVAGE VPS CREATOR</i>";

const bar = pct => {
  const n = Math.round(pct / 10);
  return "▰".repeat(n) + "▱".repeat(10 - n) + ` ${pct}%`;
};

const mainMenu = () =>
  Markup.inlineKeyboard([
    [B("🚀 CREATE VPS", "create")],
    [B("🖥️ MY VPS", "list"), B("📊 APP INFO", "info")],
    [B("⚙️ SETTINGS", "settings"), B("💎 ABOUT", "about")]
  ]);

const homeText = name =>
  `${HEAD}\n${LINE}\nWelcome${name ? ", <b>" + esc(name) + "</b>" : ""}! Deploy and manage real cloud VPS machines in seconds.\n\n` +
  "🔐 Private • ⚡ Fast • 🌍 Global regions\n\n<i>Creating machines is billable on Fly.io.</i>";

const createModeKb = () =>
  Markup.inlineKeyboard([
    [B("📦 DEFAULT VPS PLANS", "plans")],
    [B("⚙️ CUSTOM VPS CONFIGURATION", "custom")],
    [B("🔙 BACK", "home")]
  ]);

const plansKb = () =>
  Markup.inlineKeyboard([
    ...PLANS.map(p => [B(`${p.icon} ${p.ram}GB VPS | ${p.cpu} CORE`, `plan:${p.id}`)]),
    [B("🔙 BACK", "create")]
  ]);

const plansText = () =>
  `${HEAD}\n${LINE}\n📦 <b>DEFAULT VPS PLANS</b>\n\n` +
  PLANS.map(p => `${p.icon} <b>${p.ram} GB</b> • ${p.cpu} vCPU • ${p.disk} GB storage`).join("\n") +
  "\n\n<i>Each plan is checked against Fly.io limits before anything is created.</i>";

const cancelKb = () => Markup.inlineKeyboard([[B("❌ CANCEL", "cancel")]]);

const PROMPTS = {
  ram: "💾 <b>How much RAM do you want for your VPS?</b>\n\nSend the amount in GB (e.g. <code>8</code>). Max 128 GB.",
  cpu: "⚙️ <b>How many CPU cores do you want?</b>\n\nPick one below or send a number. Fly.io offers 1, 2, 4, 8 or 16 vCPU.",
  disk: "💽 <b>How much storage do you want?</b>\n\nSend the amount in GB (e.g. <code>80</code>). Range 1–500 GB (persistent volume)."
};

const cpuKb = () =>
  Markup.inlineKeyboard([
    [1, 2, 4, 8, 16].map(n => B(`${n}`, `cpu:${n}`)),
    [B("❌ CANCEL", "cancel")]
  ]);

const osKb = images =>
  Markup.inlineKeyboard([
    ...["22.04", "24.04"].filter(o => images[o]).map(o => [B(`🐧 Ubuntu ${o}`, `os:${o.replace(".", "")}`)]),
    [B("❌ CANCEL", "cancel")]
  ]);

const REGIONS_PER_PAGE = 12;
function regionKb(regions, page, defaultRegion) {
  const sorted = [...regions].sort((a, b) => (b.code === defaultRegion) - (a.code === defaultRegion));
  const pages = Math.max(1, Math.ceil(sorted.length / REGIONS_PER_PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  const slice = sorted.slice(page * REGIONS_PER_PAGE, (page + 1) * REGIONS_PER_PAGE);
  const rows = [];
  for (let i = 0; i < slice.length; i += 2)
    rows.push(slice.slice(i, i + 2).map(r => B(`${r.code === defaultRegion ? "⭐ " : "📍 "}${r.code.toUpperCase()} · ${r.name.replace(/\s*\(.*\)/, "").slice(0, 16)}`, `reg:${r.code}`)));
  const nav = [];
  if (page > 0) nav.push(B("◀️ PREV", `regp:${page - 1}`));
  if (page < pages - 1) nav.push(B("NEXT ▶️", `regp:${page + 1}`));
  if (nav.length) rows.push(nav);
  rows.push([B("❌ CANCEL", "cancel")]);
  return Markup.inlineKeyboard(rows);
}
const regionText = (page = 0) =>
  `🌍 <b>Select a deployment region</b>\n<i>Page ${page + 1} • ⭐ = your default</i>`;

function specBlock(spec, os, region) {
  return (
    `RAM: <b>${gb(spec.ramGb)} GB</b>\n` +
    `CPU: <b>${gb(spec.cpus)} vCPU</b> (${spec.cpuKind})\n` +
    `Storage: <b>${gb(spec.diskGb)} GB</b> persistent volume\n` +
    `OS: <b>Ubuntu ${esc(os)}</b>\n` +
    `Region: <b>${esc((region || "—").toUpperCase())}</b>`
  );
}

function summaryText(title, spec, os, region, cfg) {
  const e = estimate(spec);
  return (
    `${HEAD}\n${LINE}\n⚡ <b>${title}</b>\n\n${specBlock(spec, os, region)}\n\n` +
    `💰 <b>Estimated cost</b> (approx., list prices)\n` +
    `Compute: ~$${e.compute.toFixed(2)}/mo • Storage: ~$${e.storage.toFixed(2)}/mo\n` +
    `Total: <b>~$${e.total.toFixed(2)}/mo</b> (~$${e.hourly.toFixed(3)}/hr while running)\n` +
    `Plus ${cfg.ipType === "v4" ? "dedicated IPv4 ~$2/mo (one per app, shared by all VPS)" : "IPv6 (free)"}. ` +
    `Check fly.io/docs/about/pricing for exact rates.\n\n` +
    "Are you sure you want to create this VPS?"
  );
}

const confirmKb = (nonce, custom) =>
  Markup.inlineKeyboard(
    custom
      ? [[B("✅ CREATE VPS", `ok:${nonce}`)], [B("✏️ EDIT CONFIGURATION", "edit")], [B("❌ CANCEL", "cancel")]]
      : [[B("✅ CONFIRM CREATE", `ok:${nonce}`)], [B("✏️ CHANGE REGION", "ed:region")], [B("❌ CANCEL", "cancel")]]
  );

const editKb = () =>
  Markup.inlineKeyboard([
    [B("💾 RAM", "ed:ram"), B("⚙️ CPU", "ed:cpu")],
    [B("💽 STORAGE", "ed:disk"), B("🐧 OS", "ed:os")],
    [B("🌍 REGION", "ed:region")],
    [B("🔙 BACK", "backsum")]
  ]);

function invalidText(title, errors) {
  return (
    `${HEAD}\n${LINE}\n🚫 <b>${esc(title)} — UNAVAILABLE</b>\n\n` +
    errors.map(e => `• ${esc(e)}`).join("\n") +
    "\n\n<i>Nothing was created and nothing was changed.</i>"
  );
}

function deployedText(r) {
  return (
    `✅ <b>VPS DEPLOYED SUCCESSFULLY</b>\n\n` +
    `🖥️ <b>HOSTNAME:</b> <code>${esc(r.name)}</code>\n\n` +
    `🌐 <b>IP ADDRESS:</b> <code>${esc(r.ip)}</code>\n\n` +
    `👤 <b>USERNAME:</b> <code>${esc(r.username)}</code>\n\n` +
    `🔌 <b>PORT:</b> <code>${r.port}</code>\n\n` +
    `🔐 <b>PASSWORD:</b> <code>${esc(r.password)}</code>\n\n` +
    `⚙️ <b>SYSTEM DETAILS</b>\n\n` +
    `OS: Ubuntu ${esc(r.os)}\nREGION: ${esc(r.region.toUpperCase())}\nCPU: ${gb(r.spec.cpus)} vCPU\nRAM: ${gb(r.spec.ramGb)} GB\nSTORAGE: ${gb(r.spec.diskGb)} GB (mounted at /data)\n\n` +
    `📡 <b>STATUS:</b> RUNNING\n\n` +
    `<code>ssh -p ${r.port} ${esc(r.username)}@${esc(r.ip)}</code>\n\n` +
    `🔒 Keep this private — change the password after first login.\n` +
    FOOT
  );
}

const statusOf = s =>
  ({ started: "🟢 RUNNING", stopped: "🔴 STOPPED", starting: "🟡 STARTING", stopping: "🟡 STOPPING", created: "🟡 CREATED", suspended: "⚪ SUSPENDED", destroyed: "⚫ DESTROYED" })[s] || `⚪ ${esc(String(s).toUpperCase())}`;

function describe(m, ip) {
  const g = m.config?.guest || {};
  const meta = m.config?.metadata || {};
  const port = Number(meta.savage_port) || m.config?.services?.[0]?.ports?.[0]?.port || null;
  return {
    id: m.id,
    name: m.name || "unnamed",
    state: m.state,
    region: m.region || "?",
    cpus: g.cpus,
    ramGb: g.memory_mb ? g.memory_mb / 1024 : null,
    disk: meta.savage_disk || null,
    os: meta.savage_os || null,
    port,
    ip: port ? ip || null : null,
    legacy: !meta.savage_owner
  };
}

function cardText(d) {
  return (
    `${HEAD}\n${LINE}\n🖥️ <b>${esc(d.name)}</b>${d.legacy ? " <i>(legacy)</i>" : ""}\n\n` +
    `🆔 Machine ID: <code>${esc(d.id)}</code>\n` +
    `🌐 Public IP: <code>${esc(d.ip || "not exposed")}</code>${d.port ? ` : <code>${d.port}</code>` : ""}\n` +
    `💾 RAM: <b>${d.ramGb != null ? gb(d.ramGb) + " GB" : "?"}</b>\n` +
    `⚙️ CPU: <b>${d.cpus ?? "?"} vCPU</b>\n` +
    `💽 Storage: <b>${d.disk ? d.disk + " GB" : "—"}</b>\n` +
    `📍 Region: <b>${esc(d.region.toUpperCase())}</b>\n` +
    `🐧 OS: <b>${d.os ? "Ubuntu " + esc(d.os) : "Unknown"}</b>\n\n` +
    `📡 Status: <b>${statusOf(d.state)}</b>`
  );
}

const cardKb = id =>
  Markup.inlineKeyboard([
    [B("▶️ START", `ma:s:${id}`), B("⏹️ STOP", `ma:x:${id}`)],
    [B("🔄 RESTART", `ma:r:${id}`), B("🔐 SSH DETAILS", `ssh:${id}`)],
    [B("📊 VPS INFO", `m:${id}`), B("🗑️ DELETE", `del:${id}`)],
    [B("🔙 MY VPS", "list")]
  ]);

module.exports = {
  esc, bar, HEAD, LINE, FOOT, mainMenu, homeText, createModeKb, plansKb, plansText, cancelKb, PROMPTS, cpuKb, osKb,
  regionKb, regionText, summaryText, confirmKb, editKb, invalidText, deployedText, describe, cardText, cardKb, statusOf, B
};
