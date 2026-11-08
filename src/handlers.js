"use strict";
const crypto = require("crypto");
const { Markup } = require("telegraf");
const L = require("./limits");
const ui = require("./ui");
const { friendlyError } = require("./fly");
const { provision, destroy } = require("./provision");
const { decrypt, redact } = require("./secure");

const { esc, B } = ui;
const SESSION_TTL = 15 * 60 * 1000;
const MAX_SESSIONS = 5000;
const ID = "([0-9a-f]{8,20})";

function register(bot, { cfg, fly }) {
  const sessions = new Map(); // userId -> session (strictly per user)
  const prefs = new Map(); // userId -> { region }
  const busy = new Set(); // users with a creation in flight
  const opLocks = new Set(); // machine ids with an operation in flight

  // Single timer purges abandoned sessions (no leaks, unref'd so it never blocks exit).
  setInterval(() => {
    const now = Date.now();
    for (const [k, s] of sessions) if (s.exp < now && !s.creating) sessions.delete(k);
  }, 60000).unref();

  const uidOf = ctx => String(ctx.from.id);
  const isOwner = uid => cfg.owners.has(uid);
  const allowed = uid => cfg.allowAll || isOwner(uid) || cfg.allowedUsers.has(uid);

  function getSession(uid) {
    const s = sessions.get(uid);
    if (!s) return null;
    if (s.exp < Date.now() && !s.creating) { sessions.delete(uid); return null; }
    s.exp = Date.now() + SESSION_TTL;
    return s;
  }
  function newSession(uid, mode) {
    if (sessions.size >= MAX_SESSIONS && !sessions.has(uid)) sessions.delete(sessions.keys().next().value);
    const s = { mode, step: null, spec: { ramGb: null, cpus: null, diskGb: null, os: null, region: null }, nonce: null, creating: false, suggestion: null, regionPage: 0, planId: null, adjusted: false, exp: Date.now() + SESSION_TTL };
    sessions.set(uid, s);
    return s;
  }

  // ---------- rendering helpers ----------
  const OPTS = { parse_mode: "HTML", link_preview_options: { is_disabled: true } };
  async function render(ctx, text, kb) {
    const extra = { ...OPTS, ...(kb || {}) };
    if (ctx.callbackQuery?.message) {
      try { return await ctx.editMessageText(text, extra); }
      catch (e) {
        if (/not modified/i.test(e.description || e.message)) return;
      }
    }
    return ctx.reply(text, extra);
  }
  const safeAnswer = (ctx, text, alert) => ctx.answerCbQuery(text, alert ? { show_alert: true } : undefined).catch(() => {});
  const bg = (ctx, fn) => {
    Promise.resolve().then(fn).catch(e => {
      console.error("Handler error:", redact(e?.stack || e, cfg.botToken, cfg.flyToken));
      render(ctx, `⚠️ <b>Something went wrong.</b>\n${esc(friendlyError(e))}`, Markup.inlineKeyboard([[B("🏠 MENU", "home")]])).catch(() => {});
    });
  };
  const errView = (ctx, e, back = "home") =>
    render(ctx, `❌ <b>Error</b>\n${esc(friendlyError(e))}`, Markup.inlineKeyboard([[B("🔙 BACK", back)]]));

  // ---------- access control ----------
  bot.use(async (ctx, next) => {
    if (!ctx.from) return;
    if (ctx.chat && ctx.chat.type !== "private") {
      if (ctx.callbackQuery) await safeAnswer(ctx, "Please use this bot in a private chat.", true);
      return;
    }
    if (!allowed(uidOf(ctx))) {
      if (ctx.callbackQuery) await safeAnswer(ctx, "⛔ Access denied", true);
      else await ctx.reply("⛔ Access denied. This is a private bot.");
      return;
    }
    return next();
  });

  // ---------- main menu ----------
  const home = async ctx => {
    sessions.delete(uidOf(ctx));
    await render(ctx, ui.homeText(ctx.from.first_name), ui.mainMenu());
  };
  bot.start(home);
  bot.command("menu", home);
  bot.command("help", home);
  bot.action("home", async ctx => { await safeAnswer(ctx); await home(ctx); });
  bot.action("cancel", async ctx => {
    await safeAnswer(ctx, "Cancelled");
    sessions.delete(uidOf(ctx));
    await render(ctx, `${ui.HEAD}\n${ui.LINE}\n❌ Cancelled. Nothing was created.`, Markup.inlineKeyboard([[B("🏠 MENU", "home")]]));
  });

  // ---------- create flow ----------
  bot.action("create", async ctx => {
    await safeAnswer(ctx);
    sessions.delete(uidOf(ctx));
    await render(ctx, `${ui.HEAD}\n${ui.LINE}\n🚀 <b>CREATE VPS</b>\n\nChoose how you want to configure your VPS:`, ui.createModeKb());
  });
  bot.action("plans", async ctx => { await safeAnswer(ctx); await render(ctx, ui.plansText(), ui.plansKb()); });

  bot.action(/^plan:([1-6])$/, async ctx => {
    await safeAnswer(ctx);
    const plan = L.PLANS.find(p => p.id === Number(ctx.match[1]));
    const s = newSession(uidOf(ctx), "plan");
    s.planId = plan.id;
    s.spec = { ramGb: plan.ram, cpus: plan.cpu, diskGb: plan.disk, os: cfg.images["24.04"] ? "24.04" : null, region: null };
    bg(ctx, () => next(ctx, s));
  });

  bot.action("custom", async ctx => {
    await safeAnswer(ctx);
    const s = newSession(uidOf(ctx), "custom");
    bg(ctx, () => next(ctx, s));
  });

  const FIELD = { ram: "ramGb", cpu: "cpus", disk: "diskGb", os: "os", region: "region" };

  async function next(ctx, s) {
    const sp = s.spec;
    if (sp.ramGb != null && sp.cpus != null && sp.diskGb != null) {
      const v = L.validate(sp);
      if (!v.ok) return showInvalid(ctx, s, v);
      s.valid = v.spec;
    }
    for (const f of ["ram", "cpu", "disk", "os", "region"]) {
      if (sp[FIELD[f]] == null) { s.step = f; return prompt(ctx, s, f); }
    }
    return summary(ctx, s);
  }

  async function showInvalid(ctx, s, v) {
    s.step = null;
    s.suggestion = v.suggestion;
    const title = s.mode === "plan" ? `PLAN ${s.planId} (${L.PLANS[s.planId - 1].ram} GB / ${L.PLANS[s.planId - 1].cpu} vCPU)` : "CUSTOM CONFIGURATION";
    const rows = [];
    if (v.suggestion) rows.push([B(`✅ USE ${v.suggestion.cpus} vCPU INSTEAD`, "adopt")]);
    rows.push(s.mode === "plan" ? [B("🔙 PLANS", "plans")] : [B("✏️ EDIT CONFIGURATION", "edit")]);
    rows.push([B("❌ CANCEL", "cancel")]);
    let text = ui.invalidText(title, v.errors);
    if (v.suggestion) text += `\n\n💡 Closest supported option: <b>${L.gb(v.suggestion.ramGb)} GB RAM / ${v.suggestion.cpus} vCPU / ${L.gb(v.suggestion.diskGb)} GB</b>. It will only be used if you tap the button.`;
    return render(ctx, text, Markup.inlineKeyboard(rows));
  }

  async function prompt(ctx, s, f) {
    if (f === "ram" || f === "disk") return render(ctx, ui.PROMPTS[f], ui.cancelKb());
    if (f === "cpu") return render(ctx, ui.PROMPTS.cpu, ui.cpuKb());
    if (f === "os") {
      if (!Object.keys(cfg.images).length) return render(ctx, ui.invalidText("OPERATING SYSTEM", ["No VPS image is configured (VPS_IMAGE)."]), ui.cancelKb());
      return render(ctx, "🐧 <b>Select the operating system</b>", ui.osKb(cfg.images));
    }
    if (f === "region") {
      let regions;
      try { regions = await fly.regions(); } catch (e) { return errView(ctx, e, "create"); }
      return render(ctx, ui.regionText(s.regionPage), ui.regionKb(regions, s.regionPage, prefs.get(uidOf(ctx))?.region || cfg.defaultRegion));
    }
  }

  async function summary(ctx, s) {
    const os = s.spec.os;
    if (!cfg.images[os]) {
      return render(ctx, ui.invalidText(`Ubuntu ${os}`, [`No VPS image is configured for Ubuntu ${os}.`]), Markup.inlineKeyboard([[B("🔙 BACK", "create")]]));
    }
    s.nonce = crypto.randomBytes(5).toString("hex");
    const title = s.mode === "custom" ? "CUSTOM VPS CONFIGURATION" : s.adjusted ? "ADJUSTED VPS CONFIGURATION" : "VPS CONFIGURATION";
    return render(ctx, ui.summaryText(title, s.valid, os, s.spec.region, cfg), ui.confirmKb(s.nonce, s.mode === "custom" || s.adjusted));
  }

  bot.action("adopt", async ctx => {
    const s = getSession(uidOf(ctx));
    if (!s?.suggestion) return safeAnswer(ctx, "Expired", true);
    await safeAnswer(ctx);
    const g = s.suggestion;
    s.spec.ramGb = g.ramGb; s.spec.cpus = g.cpus; s.spec.diskGb = g.diskGb;
    s.suggestion = null; s.adjusted = true;
    bg(ctx, () => next(ctx, s));
  });

  bot.action("edit", async ctx => {
    await safeAnswer(ctx);
    await render(ctx, `${ui.HEAD}\n${ui.LINE}\n✏️ <b>EDIT CONFIGURATION</b>\nWhat do you want to change?`, ui.editKb());
  });
  bot.action("backsum", async ctx => {
    const s = getSession(uidOf(ctx));
    await safeAnswer(ctx);
    if (!s) return home(ctx);
    bg(ctx, () => next(ctx, s));
  });
  bot.action(/^ed:(ram|cpu|disk|os|region)$/, async ctx => {
    const s = getSession(uidOf(ctx));
    if (!s) return safeAnswer(ctx, "Session expired — start again.", true);
    await safeAnswer(ctx);
    s.spec[FIELD[ctx.match[1]]] = null;
    s.nonce = null;
    s.regionPage = 0;
    bg(ctx, () => next(ctx, s));
  });

  bot.action(/^cpu:(\d+)$/, async ctx => {
    const s = getSession(uidOf(ctx));
    if (!s || s.step !== "cpu") return safeAnswer(ctx, "Expired", true);
    await safeAnswer(ctx);
    s.spec.cpus = Number(ctx.match[1]);
    bg(ctx, () => next(ctx, s));
  });
  bot.action(/^os:(2204|2404)$/, async ctx => {
    const s = getSession(uidOf(ctx));
    if (!s || s.step !== "os") return safeAnswer(ctx, "Expired", true);
    const os = ctx.match[1] === "2204" ? "22.04" : "24.04";
    if (!cfg.images[os]) return safeAnswer(ctx, "Image not configured", true);
    await safeAnswer(ctx);
    s.spec.os = os;
    bg(ctx, () => next(ctx, s));
  });

  bot.action(/^regp:(\d+)$/, async ctx => {
    const s = getSession(uidOf(ctx));
    if (!s) return safeAnswer(ctx, "Expired", true);
    await safeAnswer(ctx);
    s.regionPage = Number(ctx.match[1]);
    bg(ctx, () => prompt(ctx, s, "region"));
  });
  bot.action(/^reg:([a-z0-9]{2,5})$/, async ctx => {
    const uid = uidOf(ctx);
    const s = getSession(uid);
    if (!s || (s.step !== "region" && s.mode !== "pref")) return safeAnswer(ctx, "Expired", true);
    await safeAnswer(ctx);
    bg(ctx, async () => {
      const regions = await fly.regions();
      const code = ctx.match[1];
      if (!regions.some(r => r.code === code)) return safeAnswer(ctx, "Unknown region", true);
      if (s.mode === "pref") {
        if (prefs.size > 10000) prefs.delete(prefs.keys().next().value);
        prefs.set(uid, { region: code });
        sessions.delete(uid);
        return settingsView(ctx);
      }
      s.spec.region = code;
      await next(ctx, s);
    });
  });

  // Free-text answers for RAM / CPU / storage.
  bot.on("text", async ctx => {
    const s = getSession(uidOf(ctx));
    if (!s || !["ram", "cpu", "disk"].includes(s.step)) return;
    const raw = ctx.message.text.trim().replace(/\s*(gb|g|cores?|vcpu|c)$/i, "");
    if (!/^\d+(\.\d+)?$/.test(raw)) return ctx.reply("⚠️ Please send a plain number (for example 8).", ui.cancelKb());
    const n = Number(raw);
    const retry = t => ctx.reply(`⚠️ ${t}`, s.step === "cpu" ? ui.cpuKb() : ui.cancelKb());
    if (s.step === "ram") {
      if (n <= 0) return retry("RAM must be greater than 0.");
      if (n > L.MAX_RAM_GB) return retry(`${L.gb(n)} GB exceeds the Fly.io maximum of ${L.MAX_RAM_GB} GB per Machine. Enter ${L.MAX_RAM_GB} or less.`);
      if ((n * 1024) % 256 !== 0) return retry("RAM must be a multiple of 0.25 GB.");
      s.spec.ramGb = n;
    } else if (s.step === "cpu") {
      if (!L.CPU_OPTIONS.includes(n)) return retry(n > 16 ? `${n} vCPU exceeds the Fly.io maximum of 16.` : `${L.gb(n)} vCPU is not offered by Fly.io. Choose 1, 2, 4, 8 or 16.`);
      s.spec.cpus = n;
    } else {
      if (!Number.isInteger(n) || n < 1) return retry("Storage must be a whole number of GB (minimum 1).");
      if (n > L.MAX_VOLUME_GB) return retry(`${n} GB exceeds the Fly.io volume maximum of ${L.MAX_VOLUME_GB} GB.`);
      s.spec.diskGb = n;
    }
    bg(ctx, () => next(ctx, s));
  });

  // ---------- confirm & deploy ----------
  bot.action(/^ok:([0-9a-f]{10})$/, async ctx => {
    const uid = uidOf(ctx);
    const s = getSession(uid);
    // Duplicate/replayed taps are rejected: the nonce is single-use.
    if (!s || !s.nonce || s.nonce !== ctx.match[1] || s.creating || busy.has(uid)) {
      return safeAnswer(ctx, "⚠️ Already submitted or expired.", true);
    }
    s.nonce = null; s.creating = true; busy.add(uid);
    await safeAnswer(ctx, "🚀 Deploying…");
    const input = { ramGb: s.spec.ramGb, cpus: s.spec.cpus, diskGb: s.spec.diskGb };
    const { os, region } = s.spec;
    const msg = ctx.callbackQuery.message;
    let last = 0;
    const progress = async (pct, label) => {
      const now = Date.now();
      if (pct < 100 && now - last < 800) return;
      last = now;
      try { await ctx.telegram.editMessageText(msg.chat.id, msg.message_id, undefined, `${ui.HEAD}\n${ui.LINE}\n⏳ <b>DEPLOYING YOUR VPS</b>\n\n${ui.bar(pct)}\n${esc(label)}…`, OPTS); } catch {}
    };
    Promise.resolve().then(async () => {
      try {
        const r = await provision({ fly, cfg, userId: uid, input, os, region, progress });
        await ctx.telegram.editMessageText(msg.chat.id, msg.message_id, undefined, `${ui.HEAD}\n${ui.LINE}\n✅ <b>Deployment complete</b> — credentials are in the next message.`, OPTS).catch(() => {});
        await ctx.telegram.sendMessage(msg.chat.id, ui.deployedText(r), {
          ...OPTS,
          protect_content: true, // cannot be forwarded or saved
          ...Markup.inlineKeyboard([[B("🖥️ MY VPS", "list"), B("🏠 MENU", "home")]])
        });
      } catch (e) {
        console.error("Provision failed:", redact(e.message, cfg.botToken, cfg.flyToken));
        const cl = e.cleanup?.length ? `\n\n🧹 Cleanup: ${esc(e.cleanup.join(", "))}` : "";
        await ctx.telegram.editMessageText(msg.chat.id, msg.message_id, undefined,
          `${ui.HEAD}\n${ui.LINE}\n❌ <b>DEPLOYMENT FAILED</b>\n\n${esc(e.message)}${cl}\n\n<i>No VPS was created${e.cleanup?.some(x => /FAILED/.test(x)) ? " (some resources need manual cleanup)" : ", and you were not left with partial resources"}.</i>`,
          { ...OPTS, ...Markup.inlineKeyboard([[B("🔁 TRY AGAIN", "create"), B("🏠 MENU", "home")]]) }).catch(() => {});
      } finally {
        busy.delete(uid);
        sessions.delete(uid);
      }
    });
  });

  // ---------- MY VPS ----------
  const visible = (m, uid) => {
    const o = m.config?.metadata?.savage_owner;
    return o ? o === uid : isOwner(uid); // unowned legacy machines: owners only
  };
  async function owned(ctx, id) {
    const m = await fly.getMachine(id);
    if (!m) { await safeAnswer(ctx, "VPS not found.", true); return null; }
    if (!visible(m, uidOf(ctx))) { await safeAnswer(ctx, "⛔ This VPS does not belong to you.", true); return null; }
    return m;
  }
  const pickIp = async () => {
    try {
      const ips = await fly.appIps();
      return (ips.find(i => i.type === "v4") || ips.find(i => i.type === "v6"))?.address || null;
    } catch { return null; }
  };

  async function listView(ctx) {
    const uid = uidOf(ctx);
    let machines;
    try { machines = (await fly.listMachines()).filter(m => visible(m, uid)); } catch (e) { return errView(ctx, e); }
    if (!machines.length) {
      return render(ctx, `${ui.HEAD}\n${ui.LINE}\n🖥️ <b>MY VPS</b>\n\nYou have no VPS yet.`, Markup.inlineKeyboard([[B("🚀 CREATE VPS", "create")], [B("🏠 MENU", "home")]]));
    }
    const rows = machines.slice(0, 40).map(m => {
      const g = m.config?.guest || {};
      return [B(`${ui.statusOf(m.state).split(" ")[0]} ${m.name} · ${g.memory_mb ? L.gb(g.memory_mb / 1024) : "?"}GB/${g.cpus ?? "?"}C · ${(m.region || "").toUpperCase()}`, `m:${m.id}`)];
    });
    rows.push([B("🔄 REFRESH", "list"), B("🏠 MENU", "home")]);
    return render(ctx, `${ui.HEAD}\n${ui.LINE}\n🖥️ <b>MY VPS</b> — ${machines.length} machine${machines.length > 1 ? "s" : ""}\n\nTap one to manage it:`, Markup.inlineKeyboard(rows));
  }
  bot.action("list", async ctx => { await safeAnswer(ctx); bg(ctx, () => listView(ctx)); });
  bot.command("myvps", ctx => bg(ctx, () => listView(ctx)));

  async function cardView(ctx, m, note) {
    const fresh = m.state ? m : await fly.getMachine(m.id);
    if (!fresh) return listView(ctx);
    const ip = await pickIp();
    return render(ctx, ui.cardText(ui.describe(fresh, ip)) + (note ? `\n\n${note}` : ""), ui.cardKb(fresh.id));
  }
  bot.action(new RegExp(`^m:${ID}$`), async ctx => {
    await safeAnswer(ctx);
    bg(ctx, async () => { const m = await owned(ctx, ctx.match[1]); if (m) await cardView(ctx, m); });
  });

  const OPS = {
    s: { verb: "Starting", past: "started", want: "started", call: id => fly.startMachine(id) },
    x: { verb: "Stopping", past: "stopped", want: "stopped", call: id => fly.stopMachine(id) },
    r: { verb: "Restarting", past: "restarted", want: "started", call: id => fly.restartMachine(id) }
  };
  bot.action(new RegExp(`^ma:([sxr]):${ID}$`), async ctx => {
    const op = OPS[ctx.match[1]], id = ctx.match[2];
    if (opLocks.has(id)) return safeAnswer(ctx, "⏳ Another operation is in progress.", true);
    opLocks.add(id);
    await safeAnswer(ctx, `${op.verb}…`);
    bg(ctx, async () => {
      try {
        const m = await owned(ctx, id);
        if (!m) return;
        if (ctx.match[1] !== "r" && m.state === op.want) return cardView(ctx, m, `ℹ️ Already ${op.want === "started" ? "running" : "stopped"}.`);
        await render(ctx, `${ui.HEAD}\n${ui.LINE}\n⏳ <b>${op.verb} ${esc(m.name)}…</b>`, Markup.inlineKeyboard([]));
        await op.call(id);
        let note = `✅ VPS ${op.past}.`;
        try { await fly.waitForState(id, op.want, 60000, ["destroyed", "failed"]); }
        catch (e) { note = `⚠️ ${esc(friendlyError(e))}`; }
        await cardView(ctx, await fly.getMachine(id), note);
      } catch (e) {
        await render(ctx, `❌ <b>Operation failed</b>\n${esc(friendlyError(e))}`, Markup.inlineKeyboard([[B("🔙 BACK", `m:${id}`)]]));
      } finally { opLocks.delete(id); }
    });
  });

  bot.action(new RegExp(`^ssh:${ID}$`), async ctx => {
    await safeAnswer(ctx);
    bg(ctx, async () => {
      const m = await owned(ctx, ctx.match[1]);
      if (!m) return;
      const d = ui.describe(m, await pickIp());
      const enc = m.config?.metadata?.savage_cred;
      const pw = enc ? decrypt(enc, cfg.credSecret) : null;
      let text = `🔐 <b>SSH DETAILS</b> — <code>${esc(d.name)}</code>\n\n`;
      if (!d.port) text += "This machine has no public SSH service configured.";
      else {
        text += `🌐 IP: <code>${esc(d.ip || "unknown")}</code>\n👤 User: <code>root</code>\n🔌 Port: <code>${d.port}</code>\n`;
        text += pw ? `🔐 Password: <code>${esc(pw)}</code>\n` : "🔐 Password: <i>not available (key-based machine or credential key changed)</i>\n";
        if (d.ip) text += `\n<code>ssh -p ${d.port} root@${esc(d.ip)}</code>`;
      }
      text += `\n\n📡 Status: <b>${ui.statusOf(d.state)}</b>\n🔒 Private message — delete it when done.`;
      await ctx.telegram.sendMessage(ctx.chat.id, text, { ...OPTS, protect_content: true, ...Markup.inlineKeyboard([[B("🗑️ HIDE", "hide")]]) });
    });
  });
  bot.action("hide", async ctx => { await safeAnswer(ctx); await ctx.deleteMessage().catch(() => {}); });

  bot.action(new RegExp(`^del:${ID}$`), async ctx => {
    await safeAnswer(ctx);
    bg(ctx, async () => {
      const m = await owned(ctx, ctx.match[1]);
      if (!m) return;
      await render(ctx,
        `⚠️ <b>DELETE VPS?</b>\n\n🖥️ <code>${esc(m.name)}</code>\n\nThis <b>permanently destroys</b> the machine and its storage volume. This cannot be undone.`,
        Markup.inlineKeyboard([[B("🗑️ YES, DELETE FOREVER", `dely:${m.id}`)], [B("❌ CANCEL", `m:${m.id}`)]]));
    });
  });
  bot.action(new RegExp(`^dely:${ID}$`), async ctx => {
    const id = ctx.match[1];
    if (opLocks.has(id)) return safeAnswer(ctx, "⏳ Another operation is in progress.", true);
    opLocks.add(id);
    await safeAnswer(ctx, "Deleting…");
    bg(ctx, async () => {
      try {
        const m = await owned(ctx, id);
        if (!m) return;
        await render(ctx, `⏳ <b>Deleting ${esc(m.name)}…</b>`, Markup.inlineKeyboard([]));
        const r = await destroy(fly, m);
        const warn = r.failedVolumes.length ? `\n⚠️ Volume ${esc(r.failedVolumes.join(", "))} could not be removed — delete it in the Fly dashboard.` : "";
        await render(ctx, `✅ <b>VPS deleted</b>: <code>${esc(m.name)}</code>${warn}`, Markup.inlineKeyboard([[B("🖥️ MY VPS", "list"), B("🏠 MENU", "home")]]));
      } catch (e) {
        await render(ctx, `❌ <b>Deletion failed</b>\n${esc(friendlyError(e))}`, Markup.inlineKeyboard([[B("🔙 BACK", `m:${id}`)]]));
      } finally { opLocks.delete(id); }
    });
  });

  // ---------- APP INFO / SETTINGS / ABOUT ----------
  bot.action("info", async ctx => {
    await safeAnswer(ctx);
    bg(ctx, async () => {
      const uid = uidOf(ctx);
      let all;
      try { all = await fly.listMachines(); } catch (e) { return errView(ctx, e); }
      const mine = all.filter(m => visible(m, uid));
      const run = mine.filter(m => m.state === "started").length;
      const ip = await pickIp();
      await render(ctx,
        `${ui.HEAD}\n${ui.LINE}\n📊 <b>APP INFO</b>\n\n` +
        `📦 App: <code>${esc(cfg.app)}</code>\n🌐 Public IP: <code>${esc(ip || "none yet (allocated on first deploy)")}</code>\n` +
        `🖥️ Your VPS: <b>${mine.length}</b> (${run} running)\n🏢 Total in app: <b>${all.length}</b>\n` +
        `📍 Default region: <b>${esc((prefs.get(uid)?.region || cfg.defaultRegion).toUpperCase())}</b>\n🐧 Images: ${Object.keys(cfg.images).map(o => "Ubuntu " + o).join(", ")}`,
        Markup.inlineKeyboard([[B("🔄 REFRESH", "info"), B("🏠 MENU", "home")]]));
    });
  });

  async function settingsView(ctx) {
    const uid = uidOf(ctx);
    return render(ctx,
      `${ui.HEAD}\n${ui.LINE}\n⚙️ <b>SETTINGS</b>\n\n👤 Your ID: <code>${uid}</code>\n🛡️ Role: <b>${isOwner(uid) ? "Owner" : "User"}</b>\n` +
      `📍 Default region: <b>${esc((prefs.get(uid)?.region || cfg.defaultRegion).toUpperCase())}</b>\n📦 VPS limit: <b>${cfg.maxPerUser}</b>`,
      Markup.inlineKeyboard([[B("🌍 DEFAULT REGION", "setreg")], [B("🏠 MENU", "home")]]));
  }
  bot.action("settings", async ctx => { await safeAnswer(ctx); await settingsView(ctx); });
  bot.action("setreg", async ctx => {
    await safeAnswer(ctx);
    const s = newSession(uidOf(ctx), "pref");
    s.step = "region";
    bg(ctx, () => prompt(ctx, s, "region"));
  });
  bot.action("about", async ctx => {
    await safeAnswer(ctx);
    await render(ctx,
      `${ui.HEAD}\n${ui.LINE}\n💎 <b>ABOUT</b>\n\nSAVAGE VPS CREATOR deploys real Ubuntu VPS machines on Fly.io with a public IP, SSH access, persistent storage and full lifecycle control — right from Telegram.\n\n` +
      "🔐 Per-user isolation • 💾 Persistent volumes • 🌍 Global regions\n\nBuilt by <b>Savage EC</b>.\n\n" + ui.FOOT,
      Markup.inlineKeyboard([[B("🏠 MENU", "home")]]));
  });

  bot.catch((err, ctx) => {
    console.error("Bot error:", redact(err?.stack || err, cfg.botToken, cfg.flyToken));
    ctx?.reply?.("⚠️ Something went wrong. Please try again.").catch(() => {});
  });

  return { sessions, prefs, busy };
}

module.exports = { register };
