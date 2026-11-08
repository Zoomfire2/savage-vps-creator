const Module = require("module"), path = require("path"), assert = require("assert");
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...a) {
  if (req === "telegraf") return path.join(__dirname, "fake-telegraf.js");
  if (req === "dotenv") return path.join(__dirname, "fake-dotenv.js");
  return orig.call(this, req, ...a);
};
const { startMock } = require("./mock-fly");
const L = require("../src/limits");
const { load } = require("../src/config");
const { createFly } = require("../src/fly");
const { provision } = require("../src/provision");
const { register } = require("../src/handlers");
const { Telegraf } = require("telegraf");
const secure = require("../src/secure");

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; console.log("  ✓", m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log("Limits / validation");
  const plans = L.PLANS.map(p => [p.id, L.validate({ ramGb: p.ram, cpus: p.cpu, diskGb: p.disk })]);
  ok(plans[0][1].ok && plans[0][1].spec.cpuKind === "shared", "plan1 4GB/2c valid (shared)");
  ok(plans[1][1].ok && plans[2][1].ok, "plan2 & plan3 valid");
  ok(!plans[3][1].ok && plans[3][1].suggestion?.cpus === 16, "plan4 12 vCPU rejected, suggests 16 (not applied)");
  ok(!plans[4][1].ok && plans[4][1].suggestion?.cpus === 16, "plan5 12 vCPU rejected, suggests 16");
  ok(!plans[5][1].ok && plans[5][1].errors.length >= 3 && !plans[5][1].suggestion, "plan6 rejected: vCPU, RAM, storage; no suggestion");
  ok(L.validate({ ramGb: 64, cpus: 16, diskGb: 256 }).spec.cpuKind === "performance", "64GB/16c -> performance");
  ok(!L.validate({ ramGb: 64, cpus: 2, diskGb: 10 }).ok, "64GB on 2 vCPU rejected");
  ok(!L.validate({ ramGb: 8, cpus: 4, diskGb: 501 }).ok, "501GB volume rejected");
  ok(L.estimate(plans[0][1].spec).total > 0, "cost estimate available");

  console.log("Secure");
  const pw = secure.generatePassword();
  ok(pw.length === 24 && /[a-z]/.test(pw) && /[A-Z]/.test(pw) && /\d/.test(pw), "strong password");
  ok((await secure.hashPassword(pw)).startsWith("$6$"), "sha512 hash");
  ok(secure.decrypt(secure.encrypt(pw, "k"), "k") === pw && secure.decrypt(secure.encrypt(pw, "k"), "x") === null, "encrypt/decrypt");

  const mock = await startMock();
  for (let p = 22100; p < 22110; p++) await mock.banner(p);
  const env = { BOT_TOKEN: "123:TELE", FLY_API_TOKEN: "FLYTOKEN", FLY_APP_NAME: "fleet", VPS_IMAGE: "img24", VPS_IMAGE_2204: "img22",
    FLY_API_BASE: mock.url + "/v1", FLY_GRAPHQL_URL: mock.url + "/graphql", SSH_PORT_MIN: "22100", SSH_PORT_MAX: "22109",
    SSH_VERIFY_HOST: "127.0.0.1", ALLOWED_USER_IDS: "555555", SSH_TIMEOUT_MS: "4000", CREDENTIAL_SECRET: "sekret" };
  const cfg = load(env);
  ok(cfg.images["24.04"] === "img24" && cfg.images["22.04"] === "img22", "config images");
  const fly = createFly(cfg);

  console.log("Provision (direct)");
  const r = await provision({ fly, cfg, userId: "1", input: { ramGb: 8, cpus: 4, diskGb: 80 }, os: "24.04", region: "iad" });
  const mm = mock.st.machines.get(r.id);
  ok(mm.config.guest.cpus === 4 && mm.config.guest.memory_mb === 8192 && mm.config.guest.cpu_kind === "shared", "machine uses exact CPU/RAM");
  ok([...mock.st.volumes.values()][0].size_gb === 80 && mm.config.mounts[0].path === "/data", "80GB volume attached");
  ok(r.ip === "203.0.113.7" && mock.st.ips.length === 1, "public IP allocated & verified");
  ok(mm.config.services[0].ports[0].port === r.port && mm.config.services[0].internal_port === 22, "SSH port mapped to 22");
  ok(!JSON.stringify(mm.config.env).includes(r.password), "plaintext password not in machine env");
  ok(secure.decrypt(mm.config.metadata.savage_cred, "sekret") === r.password, "password retrievable from encrypted metadata");

  let e1; try { mock.st.rejectMemAtLeast = 131072; await provision({ fly, cfg, userId: "1", input: { ramGb: 128, cpus: 16, diskGb: 100 }, os: "24.04", region: "iad" }); } catch (e) { e1 = e; }
  mock.st.rejectMemAtLeast = Infinity;
  ok(e1 && /capacity|insufficient/i.test(e1.message) && mock.st.volumes.size === 1, "Fly rejection reported + volume rolled back");

  const cfgBad = load({ ...env, SSH_PORT_MIN: "22300", SSH_PORT_MAX: "22300", SSH_TIMEOUT_MS: "3500" });
  let e2; try { await provision({ fly: createFly(cfgBad), cfg: cfgBad, userId: "1", input: { ramGb: 4, cpus: 2, diskGb: 10 }, os: "24.04", region: "iad" }); } catch (e) { e2 = e; }
  ok(e2 && /SSH did not become reachable/.test(e2.message) && mock.st.machines.size === 1 && mock.st.volumes.size === 1, "SSH failure => no success, machine+volume rolled back");

  console.log("Telegram handlers");
  const bot = new Telegraf();
  register(bot, { cfg, fly });
  const A = { id: 7532448669, first_name: "Z" }, B = { id: 555555, first_name: "B" }, C = { id: 999, first_name: "C" };
  const last = u => [...bot.out].reverse().find(m => m.chat === u.id);
  const click = async (u, data, msg = last(u)) => bot.dispatch({ from: u, data, msgId: msg.id });
  const say = (u, text) => bot.dispatch({ from: u, text });
  const kb = m => (m.extra?.reply_markup?.inline_keyboard || []).flat();
  const btn = (m, re) => kb(m).find(b => re.test(b.text));
  const wait = async (u, re, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const m = [...bot.out].reverse().find(x => x.chat === u.id && re.test(x.text)); if (m) return m; await sleep(50); } throw new Error("timeout waiting for " + re); };
  const settle = () => sleep(150);

  await say(A, "/start"); let m = last(A);
  ok(["CREATE VPS", "MY VPS", "APP INFO", "SETTINGS", "ABOUT"].every(t => btn(m, new RegExp(t))), "/start shows premium main menu");
  await say(C, "/start"); ok(/Access denied/.test(last(C).text), "unauthorized user denied");

  await click(A, "create"); await settle(); m = last(A);
  ok(btn(m, /DEFAULT VPS PLANS/) && btn(m, /CUSTOM VPS/), "create shows default/custom");
  await click(A, "plans"); await settle(); m = last(A);
  ok(kb(m).filter(b => /VPS \| \d+ CORE/.test(b.text)).length === 6, "six plan buttons");
  await click(A, "plan:6"); await settle(); m = last(A);
  ok(/UNAVAILABLE/.test(m.text) && /128 GB/.test(m.text) && /16 vCPU/.test(m.text) && /500 GB/.test(m.text) && !btn(m, /INSTEAD/), "plan6 explained as unavailable, nothing created");
  await click(A, "plans"); await click(A, "plan:4"); await settle(); m = last(A);
  ok(/12 vCPU/.test(m.text) && btn(m, /USE 16 vCPU INSTEAD/), "plan4 offers explicit adjustment");
  await click(A, "adopt"); await settle(); m = last(A);
  ok(/Select a deployment region/.test(m.text), "adopt -> region step"); await click(A, "reg:lhr"); await settle(); m = last(A);
  ok(/ADJUSTED/.test(m.text) && /16 vCPU/.test(m.text) && /Estimated cost/.test(m.text), "adjusted summary labelled + cost shown");
  await click(A, "cancel"); await settle(); ok(/Cancelled/.test(last(A).text) && mock.st.machines.size === 1, "cancel creates nothing");

  await click(A, "plans"); await click(A, "plan:2"); await settle(); m = last(A);
  ok(/Select a deployment region/.test(m.text), "plan2 -> region"); await click(A, "reg:ams"); await settle(); m = last(A);
  ok(/VPS CONFIGURATION/.test(m.text) && /8 GB/.test(m.text) && /Ubuntu 24.04/.test(m.text) && /AMS/.test(m.text), "confirmation card");
  const confirm = btn(m, /CONFIRM CREATE/).callback_data;
  await Promise.all([click(A, confirm, m), click(A, confirm, m)]);
  const dep = await wait(A, /VPS DEPLOYED SUCCESSFULLY/);
  ok(dep.extra.protect_content === true && /203\.0\.113\.7/.test(dep.text) && /PORT:/.test(dep.text) && /STATUS:<\/b> RUNNING/.test(dep.text), "deployed message with real IP/port, protected");
  ok(mock.st.machines.size === 2 && bot.alerts.some(a => /Already submitted/.test(a.text)), "double-tap created exactly one machine");
  const deliveredPw = dep.text.match(/PASSWORD:<\/b> <code>([^<]+)/)[1];
  const aId = [...mock.st.machines.values()].find(x => x.region === "ams").id;

  // custom flow
  await click(A, "create"); await click(A, "custom"); await settle();
  ok(/How much RAM/.test(last(A).text), "custom step 1 RAM");
  await say(A, "abc"); ok(/plain number/.test(last(A).text), "RAM text validated");
  await say(A, "200"); ok(/maximum of 128/.test(last(A).text), "RAM 200 refused with reason");
  await say(A, "8"); await settle(); ok(/How many CPU cores/.test(last(A).text), "step 2 CPU");
  await say(A, "12"); ok(/not offered/.test(last(A).text), "12 vCPU refused, not silently changed");
  await click(A, "cpu:4"); await settle(); ok(/How much storage/.test(last(A).text), "step 3 storage");
  await say(A, "600"); ok(/maximum of 500/.test(last(A).text), "600GB refused");
  await say(A, "50"); await settle(); ok(btn(last(A), /22\.04/) && btn(last(A), /24\.04/), "step 4 OS options");
  await click(A, "os:2204"); await settle(); await click(A, "reg:fra"); await settle(); m = last(A);
  ok(/CUSTOM VPS CONFIGURATION/.test(m.text) && /Ubuntu 22.04/.test(m.text) && btn(m, /EDIT CONFIGURATION/) && btn(m, /CREATE VPS/), "custom summary");

  // concurrent users
  await say(B, "/start");
  await click(A, "create"); await click(A, "plans"); await click(A, "plan:1"); await click(B, "create"); await click(B, "plans"); await click(B, "plan:3");
  await settle(); await click(A, "reg:iad"); await click(B, "reg:iad"); await settle();
  const ca = btn(last(A), /CONFIRM CREATE/).callback_data, cb = btn(last(B), /CONFIRM CREATE/).callback_data;
  ok(/4 GB/.test(last(A).text) && /16 GB/.test(last(B).text), "sessions isolated between users");
  await Promise.all([click(A, ca, last(A)), click(B, cb, last(B))]);
  const depA = await wait(A, /VPS DEPLOYED/ , 8000); const depB = await wait(B, /VPS DEPLOYED/, 8000);
  const portA = depA.text.match(/PORT:<\/b> <code>(\d+)/)[1], portB = depB.text.match(/PORT:<\/b> <code>(\d+)/)[1];
  ok(depB && portA !== portB, "two users deployed simultaneously on different ports");
  const ms = [...mock.st.machines.values()];
  ok(ms.find(x => x.config.metadata.savage_owner === String(B.id)).config.guest.memory_mb === 16384, "B machine has B's 16GB");

  // my vps + isolation
  await click(B, "list"); await settle();
  ok(kb(last(B)).filter(b => /^m:/.test(b.callback_data)).length === 1, "B sees only own VPS");
  await click(B, `m:${aId}`, last(B)); await settle();
  ok(bot.alerts.some(a => /does not belong/.test(a.text)), "B cannot open A's VPS");
  await click(B, `ma:x:${aId}`, last(B)); await settle(); await click(B, `dely:${aId}`, last(B)); await settle();
  ok(mock.st.machines.get(aId)?.state === "started", "B cannot stop/delete A's VPS");

  await click(A, `m:${aId}`, last(A)); await settle(); m = last(A);
  ok(/Machine ID/.test(m.text) && /8 GB/.test(m.text) && /4 vCPU/.test(m.text) && /80 GB/.test(m.text) && /RUNNING/.test(m.text) && ["START", "STOP", "RESTART", "SSH DETAILS", "VPS INFO", "DELETE"].every(t => btn(m, new RegExp(t))), "VPS card complete");
  await click(A, `ma:x:${aId}`, m); await settle(); await settle();
  ok(mock.st.machines.get(aId).state === "stopped" && /STOPPED/.test(last(A).text), "stop works + card refreshed");
  await click(A, `ma:s:${aId}`, last(A)); await settle(); await settle();
  ok(mock.st.machines.get(aId).state === "started" && /RUNNING/.test(last(A).text), "start works");
  await click(A, `ma:r:${aId}`, last(A)); await settle(); await settle(); ok(/restarted/.test(last(A).text), "restart works");
  await click(A, `ssh:${aId}`, last(A)); await settle();
  const pwShown = last(A).text.match(/Password: <code>([^<]+)/)?.[1];
  ok(pwShown && pwShown.length === 24 && pwShown === deliveredPw, "SSH DETAILS returns the same password that was delivered");
  await click(A, `del:${aId}`, last(A)); await settle(); ok(/permanently destroys/.test(last(A).text) && mock.st.machines.has(aId), "delete asks confirmation");
  const vols = mock.st.volumes.size;
  await click(A, `dely:${aId}`, last(A)); await settle(); await settle();
  ok(!mock.st.machines.has(aId) && mock.st.volumes.size === vols - 1 && /VPS deleted/.test(last(A).text), "delete removes machine + volume");

  // Fly rejects a config
  mock.st.rejectMemAtLeast = 131072;
  await click(A, "create"); await click(A, "custom"); await say(A, "128"); await click(A, "cpu:16"); await say(A, "100"); await settle();
  await click(A, "os:2404"); await settle(); await click(A, "reg:iad"); await settle();
  const before = mock.st.machines.size; const volsBefore = mock.st.volumes.size;
  await click(A, btn(last(A), /CREATE VPS/).callback_data, last(A)); const fail = await wait(A, /DEPLOYMENT FAILED/);
  ok(/capacity/i.test(fail.text) && mock.st.machines.size === before && mock.st.volumes.size === volsBefore, "Fly rejection explained, no leftovers");

  ok(!bot.out.some(m => /FLYTOKEN|123:TELE/.test(m.text)), "no tokens in any message");
  mock.close();
  console.log(`\nALL ${pass} CHECKS PASSED`);
  process.exit(0);
})().catch(e => { console.error("\nFAILED:", e); process.exit(1); });
