// Minimal stand-in for telegraf used only by tests (telegraf can't be installed offline here).
const Markup = {
  button: { callback: (text, callback_data) => ({ text, callback_data }) },
  inlineKeyboard: rows => ({ reply_markup: { inline_keyboard: rows } })
};
class Telegraf {
  constructor() { this.mws = []; this.actions = []; this.cmds = {}; this.textH = null; this.out = []; this.alerts = []; this.nextId = 1; this.store = new Map(); }
  use(f) { this.mws.push(f); }
  start(f) { this.cmds.start = f; }
  command(c, f) { this.cmds[c] = f; }
  action(re, f) { this.actions.push([re instanceof RegExp ? re : new RegExp(`^${re}$`), f]); }
  on(t, f) { if (t === "text") this.textH = f; }
  catch(f) { this.errH = f; }
  get telegram() {
    const self = this;
    return {
      editMessageText: async (chat, id, _i, text, extra) => { const m = self.store.get(id); Object.assign(m, { text, extra }); },
      sendMessage: async (chat, text, extra) => self._send(chat, text, extra)
    };
  }
  _send(chat, text, extra) { const m = { id: this.nextId++, chat, text, extra }; this.store.set(m.id, m); this.out.push(m); return m; }
  ctxFor(update) {
    const self = this; const from = update.from; const chat = { id: from.id, type: update.chatType || "private" };
    const ctx = { from, chat, telegram: this.telegram,
      reply: async (text, extra) => self._send(chat.id, text, extra),
      answerCbQuery: async (text, o) => { self.alerts.push({ user: from.id, text, alert: !!o?.show_alert }); },
      deleteMessage: async () => {}, };
    if (update.data) { const m = this.store.get(update.msgId); ctx.callbackQuery = { data: update.data, message: { message_id: m.id, chat } };
      ctx.editMessageText = async (text, extra) => { Object.assign(m, { text, extra }); }; }
    if (update.text) ctx.message = { text: update.text };
    return ctx;
  }
  async dispatch(update) {
    const ctx = this.ctxFor(update);
    const route = async () => {
      if (update.data) { for (const [re, f] of this.actions) { const m = re.exec(update.data); if (m) { ctx.match = m; return f(ctx); } } return; }
      if (update.text?.startsWith("/")) { const f = this.cmds[update.text.slice(1).split(" ")[0]]; return f && f(ctx); }
      return this.textH && this.textH(ctx);
    };
    let i = 0; const nxt = async () => (i < this.mws.length ? this.mws[i++](ctx, nxt) : route());
    try { await nxt(); } catch (e) { if (this.errH) this.errH(e, ctx); else throw e; }
  }
}
module.exports = { Telegraf, Markup };
