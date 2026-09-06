/* dsh-token-plan-quota — 浏览器半边（手写 lazy-CJS factory，无需构建步骤）。
 *
 * 由 dsh 的客户端模块系统经 /plugins/dsh-token-plan-quota/client.js 加载。
 * 职责：向宿主只读路由取快照；订阅当前会话的模型选择（ctx.sessions + ctx.modelDirectories），
 * 让**单个徽标跟随当前模型的供应商切换**对应的额度卡；点徽标展开全部数据源的明细。
 *
 * 观感：徽标做成工具行里的幽灵按钮（无边框、灰字、无表情符号、无状态圆点），
 * 余量渐变条本身就是状态表达（绿→蓝→橙红）。当前模型没有可显示的额度源时徽标整个隐藏。
 * 面板：按住标题栏可拖出屏幕任意位置悬浮（移动只走 transform，松手才提交坐标；
 * 位置记在 localStorage，跨刷新记住），双击标题栏归位贴回徽标。
 * 字体：UI 走 Geist Variable + Noto Sans SC（jsDelivr Fontsource 注入三枚 link，拉不到
 * 静默落 Aptos/Segoe UI 系统栈——不用 Calibri/Corbel，它们的默认旧式数字会忽上忽下）；
 * 等宽（Geist Mono→Cascadia/Consolas）只留给纯标识串（模型路径、debug 骨架），
 * 中英数混排行一律 UI 栈 + lining-nums,tabular-nums。
 *
 * 节奏：本地卡与滑动 TPM 宿主每次都实时重算，所以轮询可以很勤（pollSeconds，默认 10s）；
 * 面板底部「更新于」时间戳可点击，强制刷新官方源（本地数据一直是实时的）。
 */
window.__ModuleLoader__.load({
  id: "dsh-token-plan-quota",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require("react");

    const SUMMARY = "/token-plan-quota/summary";
    const REFRESH = "/token-plan-quota/refresh";
    const STYLE_ID = "dsh-token-plan-quota.css";
    /** CDN 字体（jsDelivr Fontsource 可变字体，锁 5 大版本）：Geist + Geist Mono + Noto Sans SC。
     *  拉不到就静默降级到 --tpq-font 里的系统圆润栈，插件功能与断网场景零影响。 */
    const FONT_CSS = [
      "https://cdn.jsdelivr.net/npm/@fontsource-variable/geist@5/index.css",
      "https://cdn.jsdelivr.net/npm/@fontsource-variable/geist-mono@5/index.css",
      "https://cdn.jsdelivr.net/npm/@fontsource-variable/noto-sans-sc@5/index.css",
    ];
    const FALLBACK_POLL_SECONDS = 10;
    /** 限流标记的显示时效：超过就不在徽标上打扰。 */
    const THROTTLE_FRESH_MS = 15 * 60_000;
    /** 徽标上的速度标签：最近一次流结束超过这个时间就不显示（避免挂旧数）。 */
    const SPEED_FRESH_MS = 90_000;
    /** 宿主没回 bindProviders 时的兜底绑定（老宿主兼容）。 */
    const DEFAULT_BINDINGS = {
      "deepseek-balance": ["deepseek"],
      "token-plan-window": ["qwen-token-plan-cn"],
      "token-plan-console": ["qwen-token-plan-cn"],
    };

    /* ------------------------------------------------------------ 文案 */

    const COPY = {
      zh: {
        plan: "Token Plan",
        loading: "额度加载中",
        noData: "无官方额度数据",
        noOfficial: "无官方额度接口",
        failed: "查询失败",
        throttle: "限流",
        retried: "自动重试",
        abandoned: "已放弃",
        refreshing: "刷新中…",
        updated: "更新于",
        updatedTip: "点击强制刷新官方源（本地实测与吞吐每次都是实时）",
        remaining: "剩余",
        used: "已用",
        seat: "坐席额度",
        cycleReset: "周期重置",
        daysLeft: "剩",
        daysUnit: "天",
        calls: "次请求",
        cacheRead: "缓存读",
        fixed: "固定间隔",
        backoff: "指数退避",
        quotaRetryableOff: "QUOTA 不可重试（会被终态处理）",
        models: "模型明细",
        hidden: "条被关键词过滤",
        estimated: "实测",
        official: "官方",
        estimatedTip: "只统计经过本 DSH 实例的调用，不含其它工具/设备消耗；不是官方余量",
        configHint: "配置",
        detailTitle: "额度明细",
        modelNow: "当前模型",
        monthTokens: "本月",
        windowUsed: "窗口内已用",
        throughput: "吞吐",
        throughputTip: "实测：速度=输出 tokens ÷ 流式活跃秒；近 60 秒/近 5 分是全部 tokens（含缓存读）的吞吐视角",
        lastMinute: "近 60 秒",
        lastFive: "近 5 分",
        activeFor: "活跃",
        tokPerSec: "tok/s",
        dragTip: "按住标题栏可拖到任意位置悬浮，双击标题栏归位",
      },
      en: {
        plan: "Token plan",
        loading: "loading",
        noData: "no data",
        noOfficial: "no official balance endpoint",
        failed: "query failed",
        throttle: "throttled",
        retried: "retried",
        abandoned: "gave up",
        refreshing: "refreshing…",
        updated: "updated",
        updatedTip: "Click to force a refresh of official sources (local measurements and throughput are always live)",
        remaining: "Left",
        used: "Used",
        seat: "Seat",
        cycleReset: "Resets",
        daysLeft: "in",
        daysUnit: "d",
        calls: "requests",
        cacheRead: "cached",
        fixed: "fixed delay",
        backoff: "backoff",
        quotaRetryableOff: "QUOTA not retryable (terminal)",
        models: "By model",
        hidden: "rows filtered by keyword",
        estimated: "measured",
        official: "official",
        estimatedTip: "Covers only calls made through this DSH instance; not the official remaining quota",
        configHint: "Config",
        detailTitle: "Quota detail",
        modelNow: "current model",
        monthTokens: "This month",
        windowUsed: "Used in window",
        throughput: "Throughput",
        throughputTip: "Measured: speed = output tokens ÷ streaming active seconds; the 60s/5min figures are total tokens (cache reads included)",
        lastMinute: "Last 60s",
        lastFive: "Last 5min",
        activeFor: "active",
        tokPerSec: "tok/s",
        dragTip: "Drag the title bar to float it anywhere; double-click to re-anchor",
      },
    };

    function pickLocale() {
      const tags = [
        typeof document !== "undefined" ? document.documentElement?.lang : "",
        typeof navigator !== "undefined" ? navigator.language : "",
      ].filter(Boolean);
      return tags.some(tag => String(tag).toLowerCase().startsWith("zh")) ? COPY.zh : COPY.en;
    }

    /* ------------------------------------------------------------ 格式化 */

    /** 不换行空格：把单位（Credits 等）钉在数字后面，避免孤字换行。 */
    const NBSP = String.fromCharCode(0xa0);

    function formatTokens(value) {
      if (typeof value !== "number" || !Number.isFinite(value)) return "—";
      const abs = Math.abs(value);
      if (abs >= 1e8) return `${(value / 1e8).toFixed(2)}亿`;
      if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
      if (abs >= 1e4) return `${(value / 1e4).toFixed(1)}万`;
      if (abs >= 1000) return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
      return String(Math.round(value * 100) / 100);
    }

    function formatCredits(value) {
      if (typeof value !== "number" || !Number.isFinite(value)) return "—";
      return value >= 1000 ? value.toLocaleString("en-US", { maximumFractionDigits: 0 }) : String(Math.round(value * 10) / 10);
    }

    function formatMoney(value, unit) {
      if (typeof value !== "number" || !Number.isFinite(value)) return "—";
      const symbol = unit === "USD" ? "$" : "¥";
      return `${symbol}${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }

    function cardValueText(card, copy) {
      if (card.metric === "money") return formatMoney(card.remaining, card.unit);
      if (typeof card.remainingPercent === "number") return `${Math.round(card.remainingPercent)}%`;
      if (typeof card.remaining === "number") return `${formatCredits(card.remaining)}${card.unit && card.unit !== "Credits" ? ` ${card.unit}` : ""}`;
      if (typeof card.used === "number") return formatCredits(card.used);
      if (typeof card.tokens === "number") return card.tokens === 0 ? "—" : `${formatTokens(card.tokens)} tok`;
      return copy.noData;
    }

    function formatDay(ms) {
      if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
      const d = new Date(ms);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }

    function formatClock(ms) {
      if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
      const d = new Date(ms);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
    }

    /** tok/s 的人话格式：38 / 1.2k；无效返回 null（不渲染）。 */
    function formatSpeed(value) {
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
      if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
      return value >= 100 ? String(Math.round(value)) : String(Math.round(value * 10) / 10);
    }

    /* ---- 余量渐变条：只用绿/蓝/橙/红四色，同族渐变、跨区不混色（避免灰紫脏色）。
     * ≥70% 绿渐变；40–70% 蓝渐变；<40% 橙→红渐变。轨道中性灰。 */
    function barGradient(p) {
      if (p >= 70) return { fill: "linear-gradient(90deg,#3ecf8e,#2fa96b)", track: "rgba(128,128,128,.18)" };
      if (p >= 40) return { fill: "linear-gradient(90deg,#6a8dff,#4176e6)", track: "rgba(128,128,128,.18)" };
      return { fill: "linear-gradient(90deg,#f5a623,#d64545)", track: "rgba(128,128,128,.18)" };
    }
    /** 填充段：渐变按整条宽度铺开（background-size 反推），填充缩短不重排渐变。 */
    function barFillStyle(p) {
      const g = barGradient(p);
      return {
        width: `${p}%`,
        background: g.fill,
        backgroundSize: p > 0 ? `${10000 / p}% 100%` : undefined,
      };
    }
    function barTrackStyle(p) {
      return { background: barGradient(p).track };
    }

    /** 徽标速度取数（统一为生成速度口径）：最近单流（90 秒内新鲜）→ 近 60 秒输出均速 → 近 5 分钟生成速度。 */
    function chipSpeedTps(row) {
      if (row == null) return null;
      const now = Date.now();
      const tpsAge = row.lastTpsAt ?? row.lastAt;
      if (tpsAge != null && now - tpsAge < SPEED_FRESH_MS && typeof row.lastTps === "number" && row.lastTps > 0) return row.lastTps;
      if (typeof row.outTps60 === "number" && row.outTps60 > 0) return row.outTps60;
      if (typeof row.genTps === "number" && row.genTps > 0 && row.lastAt != null && now - row.lastAt < 5 * 60_000) return row.genTps;
      return null;
    }

    function isMoney(card) {
      return card.metric === "money";
    }

    /** 卡片有没有可展示的数字（含实测窗口卡的 tokens）。 */
    function hasNumbers(card) {
      return typeof card?.remaining === "number" || typeof card?.total === "number"
        || typeof card?.used === "number" || typeof card?.tokens === "number";
    }

    /** 最近一次限流（重试或放弃）发生在上限时间之内吗。 */
    function recentThrottle(card) {
      for (const row of card.retry ?? []) {
        const at = Math.max(row.lastAt ?? 0, row.lastAbandonAt ?? 0);
        if (at > 0 && Date.now() - at < THROTTLE_FRESH_MS) return row;
      }
      return null;
    }

    function severityOf(card) {
      if (card.error) return "bad";
      const row = recentThrottle(card);
      if (row !== null) return (row.abandoned > 0 && Date.now() - (row.lastAbandonAt ?? 0) < THROTTLE_FRESH_MS) ? "danger" : "warn";
      if (card.estimated) {
        return typeof card.tokens === "number" && card.tokens > 0 ? "ok" : "muted";
      }
      if (!hasNumbers(card)) return "muted";
      if (isMoney(card)) {
        if (typeof card.remaining === "number" && card.remaining <= 0) return "danger";
        return typeof card.remaining === "number" && card.remaining < 10 ? "warn" : "ok";
      }
      const used = card.usedPercent;
      if (typeof used === "number") {
        if (used >= 100) return "danger";
        if (used >= 60) return "warn";
      }
      const days = typeof card.expiresAt === "number" ? Math.ceil((card.expiresAt - Date.now()) / 86_400_000) : undefined;
      if (days !== undefined && days <= 3) return "danger";
      if (days !== undefined && days <= 7) return "warn";
      return "ok";
    }

    /* ------------------------------------------------------------ 数据 */

    const cache = { snapshot: null, inflight: null, error: null };

    /** 面板拖出后的悬浮位置（localStorage 跨刷新；读不到/非法就当没拖过）。 */
    const FLOAT_KEY = "dsh-token-plan-quota.panel";
    function loadFloatPos() {
      try {
        const parsed = JSON.parse(localStorage.getItem(FLOAT_KEY));
        if (Number.isFinite(parsed?.x) && Number.isFinite(parsed?.y)) return { x: parsed.x, y: parsed.y };
      } catch { /* 无 localStorage / 隐私模式 / 脏数据 */ }
      return null;
    }
    function saveFloatPos(pos) {
      try {
        if (pos === null) localStorage.removeItem(FLOAT_KEY);
        else localStorage.setItem(FLOAT_KEY, JSON.stringify(pos));
      } catch { /* 存不上不影响悬浮 */ }
    }

    async function request(path, method) {
      const response = await fetch(path, {
        method: method ?? "GET",
        credentials: "same-origin",
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload === null) {
        throw new Error(typeof payload?.error === "string" ? payload.error : `HTTP ${response.status}`);
      }
      return payload;
    }

    async function load(fresh) {
      if (cache.inflight !== null) return await cache.inflight;
      const run = (async () => {
        try {
          const snapshot = await request(`${SUMMARY}?fresh=${fresh ? 1 : 0}`);
          cache.snapshot = snapshot;
          cache.error = null;
          return snapshot;
        } catch (error) {
          cache.error = error instanceof Error ? error.message : String(error);
          return cache.snapshot;
        } finally {
          cache.inflight = null;
        }
      })();
      cache.inflight = run;
      return await run;
    }

    /* ------------------------------------------------------ 当前模型观察 */

    /**
     * 当前会话模型供应商的观察态。数据源是客户端运行时两份现成 store：
     * sessions.list（当前会话 id）→ modelDirectories.directoryFor(id).store（宿主报的当前选择）。
     * 不轮询、不打网络；模型一切换，宿主 selectModel 的 echo 立刻推给我们。
     */
    const modelWatch = {
      provider: null,
      model: null,
      listeners: new Set(),
      set(provider, model) {
        if (this.provider === provider && this.model === model) return;
        this.provider = provider;
        this.model = model;
        for (const listener of [...this.listeners]) {
          try { listener(); } catch { /* 单个订阅者炸不影响别的 */ }
        }
      },
      subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      },
    };

    /**
     * 接上运行时 store。缺服务（老外壳 / 非 web profile）返回 null，徽标退回全量显示。
     * @param ctx - client 根上下文。
     * @returns 卸载函数，或 null（服务不可用）。
     */
    function attachModelWatch(ctx) {
      const sessions = ctx.get("sessions");
      const directories = ctx.get("modelDirectories");
      const listStore = sessions?.list;
      // 两份服务缺一不可：只有目录服务在，才知道「当前模型是谁」；
      // 缺任何一份都退回 legacy（官方卡全量显示），绝不把徽标整个藏掉。
      if (typeof listStore?.subscribe !== "function" || typeof directories?.directoryFor !== "function") return null;
      let dirUnsub = null;
      let watchedSession = null;
      const clearDir = () => {
        if (dirUnsub !== null) {
          try { dirUnsub(); } catch { /* 幂等 */ }
          dirUnsub = null;
        }
      };
      const follow = (sessionId) => {
        clearDir();
        if (sessionId == null) {
          modelWatch.set(null, null);
          return;
        }
        let directory = null;
        try { directory = directories.directoryFor(sessionId); } catch { modelWatch.set(null, null); return; }
        if (typeof directory?.store?.subscribe !== "function") { modelWatch.set(null, null); return; }
        const publish = () => {
          const current = directory.store.getSnapshot?.()?.current ?? null;
          modelWatch.set(current?.provider ?? null, current?.model ?? null);
        };
        publish();
        try { dirUnsub = directory.store.subscribe(publish); } catch { dirUnsub = null; }
        // 目录可能从没被打开过（current 还是 null）：拉一次，宿主是唯一事实源。
        try {
          const pending = directory.load?.();
          if (pending !== undefined && typeof pending.catch === "function") pending.catch(() => {});
        } catch { /* 子代理会话等不可用场景，静默 */ }
      };
      const initial = listStore.getSnapshot?.()?.current ?? null;
      watchedSession = initial;
      follow(initial);
      const stopList = listStore.subscribe(() => {
        const current = listStore.getSnapshot?.()?.current ?? null;
        if (current === watchedSession) return;
        watchedSession = current;
        follow(current);
      });
      return () => {
        try { stopList(); } catch { /* 幂等 */ }
        clearDir();
      };
    }

    /** 卡片绑定的供应商列表（宿主 bindProviders 优先，兜底表兼容老宿主）。 */
    function bindOf(card) {
      if (Array.isArray(card.bindProviders)) return card.bindProviders;
      return DEFAULT_BINDINGS[card.id] ?? [];
    }

    /* ------------------------------------------------------------ 样式 */

    function cssText() {
      return `
.tpq{display:inline-flex;align-items:center;gap:4px;position:relative;
 --tpq-font:"Geist Variable","Noto Sans SC Variable","Aptos","Segoe UI Variable Text","Segoe UI",
  "PingFang SC","Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif;
 --tpq-mono:"Geist Mono Variable","Cascadia Mono","Cascadia Code","SF Mono",Consolas,ui-monospace,SFMono-Regular,monospace;
 font-family:var(--tpq-font)}
.tpq-chip{display:inline-flex;align-items:center;gap:7px;height:24px;padding:0 8px;border-radius:7px;
 border:1px solid transparent;background:transparent;
 color:var(--dsw-alias-label-secondary,inherit);font:inherit;font-size:12px;line-height:1;
 cursor:pointer;white-space:nowrap;max-width:100%;
 transition:background .2s cubic-bezier(.16,1,.3,1),transform .12s ease}
.tpq-chip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.10))}
.tpq-chip:active{transform:scale(.98)}
.tpq-chip:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4176e6);outline-offset:1px}
.tpq-chip[data-sev=bad]{border-style:dashed;border-color:var(--dsw-alias-border-l2,rgba(128,128,128,.35))}
.tpq-chip[data-sev=muted]{opacity:.72}
.tpq-chip[data-busy] .tpq-num{animation:tpq-breathe 1.4s ease-in-out infinite}
@keyframes tpq-breathe{0%,100%{opacity:1}50%{opacity:.4}}
.tpq-name{color:var(--dsw-alias-label-secondary,inherit);letter-spacing:.01em}
.tpq-num{font-variant-numeric:lining-nums,tabular-nums;color:var(--dsw-alias-label-primary,inherit)}
.tpq-pill{font-size:10px;line-height:15px;padding:0 7px;border-radius:999px;flex:none;letter-spacing:.08em;
 border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));color:var(--dsw-alias-label-tertiary,inherit)}
.tpq-pill[data-kind=official]{border-color:var(--dsw-alias-brand-primary,#4176e6);
 color:var(--dsw-alias-brand-primary,#4176e6);background:transparent;letter-spacing:.04em}
.tpq-pill[data-kind=measured]{border:none;color:var(--dsw-alias-label-secondary,inherit);
 background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.16))}
.tpq-bar{position:relative;width:40px;height:5px;border-radius:999px;overflow:hidden;flex:none;
 background:var(--dsw-alias-border-l2,rgba(128,128,128,.22))}
.tpq-bar>i{position:absolute;inset:0 auto 0 0;border-radius:999px;background-repeat:no-repeat;
 transition:width .5s cubic-bezier(.16,1,.3,1),background .6s ease}
.tpq-speed{font-size:11px;font-variant-numeric:lining-nums,tabular-nums;min-width:5.6em;text-align:right;flex:none;
 padding-left:8px;border-left:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.24));
 color:var(--dsw-alias-label-secondary,inherit)}
.tpq-tag{font-size:11px;color:var(--dsw-alias-label-tertiary,inherit);font-variant-numeric:lining-nums,tabular-nums}
.tpq-panel{position:absolute;bottom:calc(100% + 6px);left:0;z-index:60;width:min(380px,88vw);
 max-height:min(52vh,460px);overflow:auto;padding:12px 14px;border-radius:12px;
 border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));
 background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-3,#1e1e1e));
 color:var(--dsw-alias-label-primary,inherit);font-size:12px;line-height:1.55;
 box-shadow:0 12px 32px rgba(0,0,0,.26),0 2px 6px rgba(0,0,0,.12),inset 0 1px 0 rgba(255,255,255,.05);
 animation:tpq-rise .26s cubic-bezier(.16,1,.3,1)}
@keyframes tpq-rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
.tpq-title{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:-2px -4px 8px;
 padding:2px 4px 8px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.16));
 cursor:grab;user-select:none;-webkit-user-select:none;touch-action:none}
.tpq-title:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.06));border-radius:6px}
.tpq-panel[data-float=1]{box-shadow:0 18px 46px rgba(0,0,0,.32),0 2px 8px rgba(0,0,0,.16),inset 0 1px 0 rgba(255,255,255,.05)}
.tpq-panel[data-dragging]{cursor:grabbing;will-change:transform;animation:none;transition:none}
.tpq-panel[data-dragging] .tpq-title{cursor:grabbing}
.tpq-title>span:first-child{font-weight:600;font-size:13px;letter-spacing:.02em}
.tpq-card{padding:9px 1px;position:relative;
 animation:tpq-in .32s cubic-bezier(.16,1,.3,1) both;
 animation-delay:calc(40ms + var(--tpq-i,0)*70ms)}
.tpq-card+.tpq-card{border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.16))}
@keyframes tpq-in{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}
@media (prefers-reduced-motion:reduce){
 .tpq-panel,.tpq-card{animation:none}
 .tpq-chip[data-busy] .tpq-num{animation:none}
 .tpq-bar>i,.tpq-bar-lg>i{transition:none}
 .tpq-chip{transition:none}
}
.tpq-h{display:flex;align-items:center;gap:6px;font-weight:500;letter-spacing:.02em;margin-bottom:2px}
.tpq-big{font-size:15px;font-weight:600;font-variant-numeric:lining-nums,tabular-nums;
 color:var(--dsw-alias-label-primary,inherit)}
.tpq-bar-lg{position:relative;height:6px;border-radius:999px;overflow:hidden;margin:7px 0 3px;
 background:var(--dsw-alias-border-l2,rgba(128,128,128,.18))}
.tpq-bar-lg>i{position:absolute;inset:0 auto 0 0;border-radius:999px;background-repeat:no-repeat;
 transition:width .5s cubic-bezier(.16,1,.3,1),background .6s ease}
.tpq-row{display:flex;justify-content:space-between;align-items:baseline;gap:12px;row-gap:2px;padding:1px 0;flex-wrap:wrap}
.tpq-row>span:first-child{color:var(--dsw-alias-label-tertiary,inherit)}
.tpq-row>span:last-child{font-variant-numeric:lining-nums,tabular-nums}
.tpq-sub{margin-top:6px;padding:6px 8px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.10))}
.tpq-plain{margin:2px 0 8px}
.tpq-plain .tpq-row>span:first-child{color:var(--dsw-alias-label-tertiary,inherit);flex:none;margin-right:10px}
.tpq-item{display:flex;justify-content:space-between;gap:10px;padding:2px 0}
.tpq-item>span:last-child{font-variant-numeric:lining-nums,tabular-nums}
.tpq-note{margin-top:6px;padding:6px 8px;border-radius:8px;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.1));color:var(--dsw-alias-label-secondary,inherit)}
.tpq-err{color:var(--dsw-alias-state-error-primary,#d64545);word-break:break-all}
.tpq-hint{color:var(--dsw-alias-label-secondary,inherit)}
.tpq-updated{display:block;width:100%;margin-top:8px;padding:6px 0 2px;background:transparent;
 border:none;border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.14));
 font:inherit;font-family:var(--tpq-font);font-size:11px;font-variant-numeric:lining-nums,tabular-nums;
 text-align:right;cursor:pointer;color:var(--dsw-alias-label-tertiary,inherit)}
.tpq-updated:hover{color:var(--dsw-alias-brand-primary,#4176e6);text-decoration:underline}
.tpq-updated:disabled{opacity:.6;cursor:default;text-decoration:none}
.tpq-meta{font-size:11px;color:var(--dsw-alias-label-tertiary,inherit);word-break:normal;overflow-wrap:anywhere;
 font-family:var(--tpq-mono)}
.tpq-meta-label{font-family:var(--tpq-font)}
.tpq-aux{font-size:11px;color:var(--dsw-alias-label-tertiary,inherit);word-break:normal;overflow-wrap:anywhere;
 font-family:var(--tpq-font);font-variant-numeric:lining-nums,tabular-nums}
.tpq-raw{margin:4px 0 0;padding:6px;border-radius:6px;white-space:pre-wrap;word-break:break-all;
 font-family:var(--tpq-mono);font-size:10px;
 background:var(--dsw-alias-markdown-code-block,rgba(128,128,128,.1))}
`;
    }

    /* ------------------------------------------------------------ 组件 */

    function Chip({ card, copy, busy, expanded, onToggle, modelText, speedTps }) {
      const severity = severityOf(card);
      // 余量渐变条即状态表达（无圆点、无表情符号）：绿→蓝渐变，宽度=剩余百分比；用量变化由 CSS 过渡平滑。
      const fillPct = typeof card.remainingPercent === "number"
        ? Math.max(0, Math.min(100, card.remainingPercent))
        : (typeof card.usedPercent === "number" ? Math.max(0, Math.min(100, 100 - card.usedPercent)) : null);
      const throttle = recentThrottle(card);
      const speed = formatSpeed(speedTps);
      const expDays = typeof card.expiresAt === "number" ? Math.ceil((card.expiresAt - Date.now()) / 86_400_000) : undefined;
      const resetDays = typeof card.resetAt === "number" ? Math.max(0, Math.ceil((card.resetAt - Date.now()) / 86_400_000)) : undefined;
      const title = card.error
        ? `${card.label}: ${card.error}`
        : `${card.label} ${cardValueText(card, copy)}${speed === null ? "" : ` · ${speed} ${copy.tokPerSec}`}${card.estimated ? ` · ${copy.estimatedTip}` : ""}${modelText ? `\n${copy.modelNow}: ${modelText}` : ""}${typeof card.sourceNote === "string" ? `\n来源: ${card.sourceNote}` : ""}`;
      return React.createElement("button", {
        type: "button",
        className: "tpq-chip",
        "data-sev": severity,
        "data-busy": busy ? "1" : undefined,
        title,
        "aria-expanded": expanded,
        onClick: onToggle,
      },
        React.createElement("span", { className: "tpq-name" }, card.label ?? copy.plan),
        fillPct === null ? null : React.createElement("span", { className: "tpq-bar", style: barTrackStyle(fillPct) },
          React.createElement("i", { style: barFillStyle(fillPct) })),
        React.createElement("span", { className: "tpq-num" }, cardValueText(card, copy)),
        speed === null ? null : React.createElement("span", { className: "tpq-speed", title: copy.throughputTip }, `${speed} ${copy.tokPerSec}`),
        card.estimated ? React.createElement("span", { className: "tpq-pill", "data-kind": "measured", title: copy.estimatedTip }, copy.estimated) : null,
        throttle !== null
          ? React.createElement("span", { className: "tpq-tag" }, `${copy.throttle}×${throttle.attempts}${throttle.abandoned > 0 ? `/${copy.abandoned}×${throttle.abandoned}` : ""}`)
          : null,
        resetDays !== undefined && throttle === null ? React.createElement("span", { className: "tpq-tag" }, `${copy.daysLeft}${resetDays}${copy.daysUnit}`) : null,
        expDays !== undefined && expDays <= 7 && resetDays === undefined && throttle === null ? React.createElement("span", { className: "tpq-tag" }, `${copy.daysLeft}${expDays}${copy.daysUnit}`) : null,
      );
    }

    /** 吞吐一行摘要（实测）：速度优先（生成速度，缺了用近 60 秒均速），口径细节进 tooltip；多供应商才加第二行。 */
    function ThroughputBlock({ tp, copy }) {
      const head = tp.genTps != null ? tp.genTps : tp.outTps60;
      const kids = [React.createElement("div", { className: "tpq-row", key: "t" },
        React.createElement("span", null, copy.throughput),
        React.createElement("span", { title: `${copy.throughputTip}；${copy.activeFor} ${tp.activeSeconds}s / ${copy.lastFive}${tp.cacheRead60 ? ` · ${copy.cacheRead} ${formatTokens(tp.cacheRead60)}` : ""}` },
          `${head != null && head > 0 ? `${formatSpeed(head)} ${copy.tokPerSec}` : "—"} · ${copy.lastMinute} ${formatTokens(tp.tpm60)} · ${copy.lastFive} ${formatTokens(tp.tokens300)}/${tp.calls300}`))];
      const rows = (tp.byProvider ?? []).filter(row => row.genTps != null && row.genTps > 0).slice(0, 3);
      if (rows.length > 1) kids.push(React.createElement("div", { className: "tpq-meta", key: "p" },
        rows.map(row => `${row.provider} ${formatSpeed(row.genTps)}`).join(" · ")));
      return React.createElement("div", { className: "tpq-plain" }, kids);
    }

    /** 每供应商一行：重试次数/间隔/QUOTA 可否重试；最近失败细节进 tooltip。 */
    function RetryBlock({ rows, copy }) {
      return React.createElement("div", { className: "tpq-plain" },
        rows.slice(0, 3).map((row, index) => React.createElement("div", { className: "tpq-row", key: `${row.provider}-${index}` },
          React.createElement("span", null, row.provider),
          React.createElement("span", {
            className: row.quotaRetryable === false ? "tpq-err" : undefined,
            title: row.lastAt != null ? `${formatClock(row.lastAt)} 失败码 ${row.lastCode ?? "?"}${row.lastRetry != null && row.lastRetry !== undefined ? ` · 第 ${row.lastRetry} 次重试` : ""}` : undefined,
          },
            `${copy.retried}×${row.attempts}${row.lastDelayMs !== undefined && row.lastDelayMs !== null ? ` (${Math.round(row.lastDelayMs / 1000)}s)` : ""}`
            + `${row.abandoned ? ` · ${copy.abandoned}×${row.abandoned}` : ""}`
            + ` · ${row.fixedDelayMs !== undefined && row.fixedDelayMs !== null ? `${copy.fixed} ${Math.round(row.fixedDelayMs / 1000)}s × ${row.maxRetries ?? "?"}` : `${copy.backoff} ${row.mode ?? "?"}`}`
            + ` · ${row.quotaRetryable != null ? (row.quotaRetryable ? "✓QUOTA" : `✗QUOTA（${copy.quotaRetryableOff}）`) : ""}`))));
    }

    /** 紧凑卡：标题行（官方/实测标签，完整来源与口径进 tooltip）+ 一行摘要 + 错误/空因 + 明细最多 6 行。
     *  index 只用来喂 CSS 交错渐入的 --tpq-i（首帧后 DOM 稳定，轮询更新不会重播动画）。 */
    function CardDetail({ card, copy, index }) {
      const bits = [];
      if (isMoney(card)) {
        if (typeof card.remaining === "number") bits.push(formatMoney(card.remaining, card.unit));
        const parts = [];
        if (typeof card.extra?.toppedUp === "number") parts.push(`充值 ${formatMoney(card.extra.toppedUp, card.unit)}`);
        if (typeof card.extra?.granted === "number" && card.extra.granted > 0) parts.push(`赠款 ${formatMoney(card.extra.granted, card.unit)}`);
        if (typeof card.extra?.cash === "number" && card.extra.cash > 0) parts.push(`${copy.seat} ${formatMoney(card.extra.cash, card.unit)}`);
        if (typeof card.extra?.credit === "number" && card.extra.credit > 0) parts.push(`信控 ${formatMoney(card.extra.credit, card.unit)}`);
        if (typeof card.extra?.quotaLimit === "number" && card.extra.quotaLimit > 0) parts.push(`限额 ${formatMoney(card.extra.quotaLimit, card.unit)}`);
        if (parts.length > 0) bits.push(`· ${parts.join(" · ")}`);
      } else if (card.metric === "count") {
        if (typeof card.tokens === "number") {
          const scope = card.resetAt !== undefined ? `${copy.windowUsed} ${card.windowDays ?? 7}${copy.daysUnit}` : copy.monthTokens;
          bits.push(`${scope} ${formatTokens(card.tokens)}`);
          bits.push(`· ${card.calls ?? 0} ${copy.calls}`);
          if (card.remainingDays !== undefined) bits.push(`· ${copy.daysLeft}${card.remainingDays}${copy.daysUnit}后重置`);
        }
      } else {
        if (typeof card.remaining === "number") bits.push(`${copy.remaining} ${card.unit === "Credits" ? formatCredits(card.remaining) : formatTokens(card.remaining)}${card.unit ? NBSP + card.unit : ""}`);
        if (typeof card.total === "number") bits.push(`/ ${card.unit === "Credits" ? formatCredits(card.total) : formatTokens(card.total)}`);
        if (typeof card.usedPercent === "number") bits.push(`· ${copy.used} ${Math.round(card.usedPercent * 10) / 10}%`);
        if (typeof card.extra?.fiveHourUsedPercent === "number") bits.push(`· 5h窗口 ${copy.used} ${card.extra.fiveHourUsedPercent}%`);
      }
      const day = formatDay(card.expiresAt);
      if (day !== null) bits.push(`· ${copy.cycleReset} ${day}`);
      const provenance = card.veracity === "verified" ? "官方接口" : card.estimated ? "本实例实测" : "数据源";
      const headerTitle = typeof card.sourceNote === "string" ? `${provenance}：${card.sourceNote}` : provenance;
      const itemText = (item) => typeof item.remaining !== "number" && typeof item.tokens === "number"
        ? `${formatTokens(item.tokens)} tok · ${item.calls} ${copy.calls}`
        : item.unit === "Credits" && typeof item.tokens === "number"
          ? `${formatCredits(item.remaining)} Cr · ${formatTokens(item.tokens)} tok · ${item.calls} 次`
          : `${formatTokens(item.remaining)}${typeof item.total === "number" ? ` / ${formatTokens(item.total)}` : ""} ${item.unit ?? ""}${item.expiresAt !== undefined ? ` · ${formatDay(item.expiresAt)}` : ""}`;

      const fillPct = typeof card.remainingPercent === "number"
        ? Math.max(0, Math.min(100, card.remainingPercent))
        : (typeof card.usedPercent === "number" ? Math.max(0, Math.min(100, 100 - card.usedPercent)) : null);

      return React.createElement("div", { className: "tpq-card", style: { "--tpq-i": index } },
        React.createElement("div", { className: "tpq-h", title: headerTitle },
          React.createElement("span", null, card.label ?? card.id),
          card.estimated
            ? React.createElement("span", { className: "tpq-pill", "data-kind": "measured", title: copy.estimatedTip }, copy.estimated)
            : (card.veracity === "verified" ? React.createElement("span", { className: "tpq-pill", "data-kind": "official" }, copy.official) : null),
          card.action ? React.createElement("span", { className: "tpq-aux" }, card.action) : null),
        bits.length > 0
          ? React.createElement("div", { className: "tpq-row" },
              React.createElement("span", { className: "tpq-big" }, bits[0]),
              bits.length > 1
                ? React.createElement("span", { className: "tpq-aux", style: { alignSelf: "center", textAlign: "right" } }, bits.slice(1).join(" "))
                : null)
          : null,
        fillPct === null ? null : React.createElement("div", { className: "tpq-bar-lg", style: barTrackStyle(fillPct), title: `${copy.remaining} ${Math.round(fillPct)}%` },
          React.createElement("i", { style: barFillStyle(fillPct) })),
        card.error
          ? React.createElement("div", { className: "tpq-note" },
              React.createElement("div", { className: "tpq-err" }, String(card.error)),
              card.hint ? React.createElement("div", { className: "tpq-hint" }, card.hint) : null)
          : null,
        !card.error && card.emptyReason ? React.createElement("div", { className: "tpq-note" }, card.emptyReason) : null,
        Array.isArray(card.retry) && card.retry.length > 0 ? React.createElement(RetryBlock, { rows: card.retry, copy }) : null,
        Array.isArray(card.items) && card.items.length > 0
          ? React.createElement("div", { className: "tpq-sub" },
              React.createElement("div", { className: "tpq-h" }, `${copy.models}${card.hiddenCount ? ` · ${card.hiddenCount} ${copy.hidden}` : ""}`),
              card.items.slice(0, 6).map((item, index) => React.createElement("div", { className: "tpq-item", key: `${item.name}-${index}` },
                React.createElement("span", null, item.name),
                React.createElement("span", { className: "tpq-num" }, itemText(item)))))
          : null,
        card.shape !== undefined ? React.createElement("pre", { className: "tpq-raw" }, JSON.stringify(card.shape, null, 1)) : null);
    }

    function Badge({ copy, watchActive }) {
      const [snapshot, setSnapshot] = React.useState(cache.snapshot);
      const [busy, setBusy] = React.useState(false);
      const [open, setOpen] = React.useState(false);
      const [, setModelTick] = React.useState(0);
      const root = React.useRef(null);
      const panelRef = React.useRef(null);
      const [floatPos, setFloatPos] = React.useState(loadFloatPos);

      /** 标题栏按住即拖：先冻结成 fixed（left/top 定在当前位置），位移全程走
       *  transform translate3d（GPU 合成，不触发 React 重渲染），松手才把最终
       *  坐标交还给 state。视口留 8px 边距夹逼，拖不出去。 */
      const beginDrag = (event) => {
        const node = panelRef.current;
        if (node === null || event.button !== 0 || typeof node.getBoundingClientRect !== "function") return;
        const rect = node.getBoundingClientRect();
        const vw = Number.isFinite(window?.innerWidth) ? window.innerWidth : rect.left + rect.width + 2000;
        const vh = Number.isFinite(window?.innerHeight) ? window.innerHeight : rect.top + rect.height + 2000;
        node.style.position = "fixed";
        node.style.left = `${rect.left}px`;
        node.style.top = `${rect.top}px`;
        node.style.bottom = "auto";
        node.dataset.dragging = "1";
        const startX = event.clientX;
        const startY = event.clientY;
        let dx = 0;
        let dy = 0;
        const onMove = (moveEvent) => {
          const nx = Math.max(8, Math.min(vw - rect.width - 8, rect.left + moveEvent.clientX - startX));
          const ny = Math.max(8, Math.min(vh - rect.height - 8, rect.top + moveEvent.clientY - startY));
          dx = nx - rect.left;
          dy = ny - rect.top;
          node.style.transform = `translate3d(${dx}px,${dy}px,0)`;
        };
        const onUp = () => {
          handle.removeEventListener("pointermove", onMove);
          handle.removeEventListener("pointerup", onUp);
          handle.removeEventListener("pointercancel", onUp);
          delete node.dataset.dragging;
          node.style.transform = "";
          const pos = { x: Math.round(rect.left + dx), y: Math.round(rect.top + dy) };
          saveFloatPos(pos);
          setFloatPos(pos);
        };
        // 指针捕获：哪怕在浏览器窗口外松手，也收得到 up，不会卡成粘滞拖拽。
        const handle = event.currentTarget;
        try { handle.setPointerCapture?.(event.pointerId); } catch { /* 老内核忽略 */ }
        handle.addEventListener("pointermove", onMove);
        handle.addEventListener("pointerup", onUp);
        handle.addEventListener("pointercancel", onUp);
        event.preventDefault();
      };
      /** 双击标题栏：清掉悬浮坐标，回到贴着徽标的锚定态。 */
      const resetFloat = () => {
        saveFloatPos(null);
        setFloatPos(null);
      };
      // 窗口变小时把悬浮面板夹回视口。
      React.useEffect(() => {
        if (floatPos === null) return undefined;
        if (typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined;
        const onResize = () => {
          const node = panelRef.current;
          if (node === null || typeof node.getBoundingClientRect !== "function") return;
          const rect = node.getBoundingClientRect();
          const x = Math.max(8, Math.min(window.innerWidth - rect.width - 8, floatPos.x));
          const y = Math.max(8, Math.min(window.innerHeight - rect.height - 8, floatPos.y));
          if (x !== floatPos.x || y !== floatPos.y) {
            const next = { x: Math.round(x), y: Math.round(y) };
            saveFloatPos(next);
            setFloatPos(next);
          }
        };
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
      }, [floatPos]);
      // 轮询周期跟着宿主回的 pollSeconds 走：第一次用兜底值，拿到快照后按需重建定时器。
      const pollSeconds = Math.max(FALLBACK_POLL_SECONDS, Number(snapshot?.pollSeconds) || FALLBACK_POLL_SECONDS);

      const reload = React.useCallback(async (fresh) => {
        setBusy(true);
        const next = await load(fresh);
        if (next !== null) setSnapshot(next);
        setBusy(false);
      }, []);

      React.useEffect(() => {
        void reload(false);
        const timer = setInterval(() => {
          if (typeof document !== "undefined" && document.hidden) return;
          void reload(false);
        }, pollSeconds * 1000);
        const onVisible = () => {
          if (typeof document !== "undefined" && !document.hidden) void reload(false);
        };
        if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
        return () => {
          clearInterval(timer);
          if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
        };
      }, [reload, pollSeconds]);

      // 模型供应商一变就重渲染（徽标跟着换卡）。
      React.useEffect(() => modelWatch.subscribe(() => setModelTick(tick => tick + 1)), []);

      React.useEffect(() => {
        if (!open) return undefined;
        const onDown = (event) => {
          if (root.current !== null && !root.current.contains(event.target)) setOpen(false);
        };
        const onKey = (event) => {
          if (event.key === "Escape") setOpen(false);
        };
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey);
        return () => {
          document.removeEventListener("mousedown", onDown);
          document.removeEventListener("keydown", onKey);
        };
      }, [open]);

      const cards = snapshot?.cards ?? [];
      const throughput = snapshot?.throughput ?? null;
      const official = cards.filter(card => card.veracity === "verified");
      const measured = cards.filter(card => card.estimated === true);
      const instance = cards.find(card => card.id === "instance-usage");
      const provider = watchActive ? modelWatch.provider : null;
      // 面板跟随当前模型：只列绑定这个供应商的卡（官方余量 + 实测窗口），
      // 本实例实测用量卡不进面板；panelScope=all 或老外壳退回全量。
      const allPanel = [...official, ...measured, ...(instance ? [instance] : [])];
      const scoped = watchActive && provider != null && (snapshot?.config?.panelScope ?? "all") === "current";
      const panelCards = (scoped
        ? allPanel.filter(card => bindOf(card).includes(provider))
        : allPanel).slice(0, 8);
      const modelText = watchActive && modelWatch.provider != null
        ? `${modelWatch.provider}${modelWatch.model ? `/${modelWatch.model}` : ""}`
        : null;
      const children = [];

      if (watchActive && provider == null) {
        // 模型观察已接上但当前没有可读的选择（空白会话 / 目录未加载）：不打扰。
        return React.createElement("span", { ref: root, className: "tpq" }, children);
      }

      let chips;
      if (watchActive) {
        // 单徽标跟随：只挂当前模型供应商绑定的卡。有数字的官方卡 > 有数字的实测卡
        // > 报错的官方卡（提示去配 Cookie）> 其它实测卡。
        const bound = [...official, ...measured].filter(card => bindOf(card).includes(provider));
        const primary = bound.find(card => card.veracity === "verified" && hasNumbers(card))
          ?? bound.find(card => card.estimated === true && hasNumbers(card))
          ?? bound.find(card => card.veracity === "verified")
          ?? bound.find(card => card.estimated === true)
          ?? null;
        chips = primary === null ? [] : [primary];
      } else {
        // 老外壳（拿不到模型）：退回官方卡全量显示。
        chips = official.filter(card => hasNumbers(card) || card.error).slice(0, 3);
      }

      if (snapshot === null) {
        if (!watchActive) {
          children.push(React.createElement("span", { key: "boot", className: "tpq-chip", "data-sev": "muted" },
            React.createElement("span", { className: "tpq-name" }, copy.plan),
            React.createElement("span", { className: "tpq-num" }, cache.error === null ? copy.loading : copy.failed)));
        }
      } else if (chips.length === 0) {
        if (!watchActive) {
          children.push(React.createElement("span", { key: "empty", className: "tpq-chip", "data-sev": "muted", onClick: () => { setOpen(true); void reload(false); }, title: (snapshot.notices ?? []).join(" ") },
            React.createElement("span", { className: "tpq-name" }, copy.plan),
            React.createElement("span", { className: "tpq-num" }, official.length === 0 ? copy.noOfficial : copy.noData)));
        }
      } else {
        const rows = Array.isArray(throughput?.byProvider) ? throughput.byProvider : [];
        for (const card of chips) {
          // 徽标速度只取**这张卡绑定的供应商**的行；legacy 模式退回全局行。
          const row = watchActive
            ? rows.find(entry => bindOf(card).includes(entry.provider)) ?? null
            : throughput;
          children.push(React.createElement(Chip, {
            key: card.id,
            card,
            copy,
            busy,
            expanded: open,
            modelText,
            speedTps: chipSpeedTps(row),
            onToggle: () => {
              setOpen(value => !value);
              void reload(false);
            },
          }));
        }
      }
      if (open && children.length > 0) {
        children.push(React.createElement("div", {
          className: "tpq-panel", role: "dialog", key: "panel", ref: panelRef,
          "data-float": floatPos !== null ? "1" : undefined,
          style: floatPos === null ? undefined
            : { position: "fixed", left: `${floatPos.x}px`, top: `${floatPos.y}px`, bottom: "auto" },
        },
          React.createElement("div", { className: "tpq-title", title: copy.dragTip, onPointerDown: beginDrag, onDoubleClick: resetFloat },
            React.createElement("span", null, copy.detailTitle),
            modelText === null ? null : React.createElement("span", { className: "tpq-meta" },
              React.createElement("span", { className: "tpq-meta-label" }, `${copy.modelNow}: `), modelText)),
          throughput !== null && throughput !== undefined
            ? React.createElement(ThroughputBlock, { tp: throughput, copy })
            : null,
          panelCards.map((card, index) => React.createElement(CardDetail, { key: card.id, card, copy, index })),
          React.createElement("button", {
            type: "button",
            className: "tpq-updated",
            disabled: busy,
            title: `${copy.updatedTip}${snapshot?.config?.file ? ` · ${copy.configHint} ${snapshot.config.file}` : ""}`,
            onClick: () => void request(REFRESH, "POST").then(next => setSnapshot(next)).catch(() => {}),
          }, busy ? copy.refreshing : `${copy.updated} ${formatClock(snapshot?.generatedAt)}`)));
      }
      return React.createElement("span", { ref: root, className: "tpq" }, children);
    }

    /* ------------------------------------------------------------ 注册 */

    /**
     * 浏览器半边入口。
     * @param ctx - client 根上下文。
     */
    function apply(ctx) {
      const copy = pickLocale();

      ctx.effect(() => {
        if (typeof document === "undefined") return undefined;
        const existing = document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`);
        if (existing !== null) return () => {};
        const style = document.createElement("style");
        style.dataset.plugin = "dsh-token-plan-quota";
        style.dataset.pluginCss = STYLE_ID;
        style.textContent = cssText();
        document.head.appendChild(style);
        return () => {
          style.remove();
        };
      }, "dsh-token-plan-quota: styles");

      // 字体：三枚 CDN link，与样式同一生命周期；重复挂载靠 data-plugin-css 去重。
      ctx.effect(() => {
        if (typeof document === "undefined") return undefined;
        const added = [];
        for (const href of FONT_CSS) {
          if (document.querySelector(`link[data-plugin-css="${href}"]`) !== null) continue;
          const link = document.createElement("link");
          link.rel = "stylesheet";
          link.href = href;
          link.dataset.plugin = "dsh-token-plan-quota";
          link.dataset.pluginCss = href;
          document.head.appendChild(link);
          added.push(link);
        }
        return () => {
          for (const node of added) node.remove();
        };
      }, "dsh-token-plan-quota: fonts");

      // 当前模型观察：sessions.list → modelDirectories 的会话目录 store。
      let watchActive = false;
      ctx.effect(() => {
        const dispose = attachModelWatch(ctx);
        watchActive = dispose !== null;
        return () => {
          watchActive = false;
          if (dispose !== null) dispose();
        };
      }, "dsh-token-plan-quota: model watch");

      const slots = ctx.get("slots");
      if (slots === undefined) return;
      const BadgeEntry = () => React.createElement(Badge, { copy, watchActive });
      // 首选输入框工具行内的小控件座位；老外壳没声明它时退到输入框上方的整行座位。
      const seats = [
        { name: "conversation.input.left", order: 40 },
        { name: "conversation.input.dock", order: 40 },
      ];
      let mounted = false;
      for (const seat of seats) {
        ctx.effect(() => slots.inject(seat.name, () => {
          if (mounted) return () => {};
          mounted = true;
          try {
            return slots.register({ name: seat.name, id: "token-plan-quota", order: seat.order }, BadgeEntry);
          } catch {
            mounted = false;
            return () => {};
          }
        }), `dsh-token-plan-quota: ${seat.name}`);
      }
    }

    exports.apply = apply;
    return module.exports;
  },
});
