/* dsh-token-plan-quota — 浏览器半边（手写 lazy-CJS factory，无需构建步骤）。
 *
 * 由 dsh 的客户端模块系统经 /plugins/dsh-token-plan-quota/client.js 加载。
 * 职责：向宿主只读路由取快照；订阅当前会话的模型选择（ctx.sessions + ctx.modelDirectories），
 * 让**单个徽标跟随当前模型的供应商切换**对应的额度卡；点徽标展开全部数据源的明细。
 *
 * 观感：徽标做成工具行里的幽灵按钮（无边框、灰字、无表情符号、无状态圆点），
 * 余量渐变条本身就是状态表达（绿→蓝→橙红）。当前模型没有可显示的额度源时徽标整个隐藏。
 * 面板：经 react-dom 的 createPortal 挂到 body 用 fixed 定位（createPortal 在 react-dom
 * 上，不在 react 上——踩过坑；宿主工具栏的 transform/backdrop-filter 也会劫持 inline
 * fixed 的包含块，body 下才是视口坐标系）。按住标题栏可拖到任意位置悬浮（移动只走
 * transform，松手才提交坐标；位置记在 localStorage，跨刷新记住），右下角斜纹握柄（常驻
 * 显示）拖拽缩放（280×160 起，夹到视口边，尺寸同样记住），双击标题栏归位贴回徽标。
 * 老宿主没有 react-dom 种子词时退回内联 CSS 锚定，拖拽缩放悬浮自动禁用。
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
    const module = { exports: {} };
    const exports = module.exports;
    const React = require("react");
    /** createPortal 在 react-dom 上（react 本体没有！）；老宿主没有这个种子词时
     *  退回内联 CSS 锚定渲染，悬浮/拖拽整体禁用。 */
    let createPortal = null;
    try {
      const ReactDOM = require("react-dom");
      if (typeof ReactDOM?.createPortal === "function") createPortal = ReactDOM.createPortal;
    } catch { /* 无 react-dom 种子词：内联回退 */ }

    const SUMMARY = "/token-plan-quota/summary";
    /* POST /token-plan-quota/refresh 这个路由宿主仍在提供（外部脚本可用），但浏览器侧不再单独打它：
       `summary?fresh=1` 与它同源同口径，见「更新于」按钮的注释。 */
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
      "deepseek-balance": ["deepseek", "deepseek-official"],
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
        toppedUp: "充值",
        granted: "赠款",
        credit: "信控",
        quotaLimit: "限额",
        resetIn: "剩{n}天后重置",
        source: "来源",
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
        resizeTip: "拖拽调整面板大小",
        close: "关闭",
        closeTip: "关闭明细面板（也可以再点一次徽标，或按 Esc）",
        capTotal: "额度上限",
        // 以下都是「会进画面」的文案，一律走字典：英文界面里冒出一句中文，
        // 比少一个词更难读（审查第 6 条：硬编码中文绕过 COPY）。
        provOfficial: "官方接口",
        provMeasured: "本实例实测",
        provSource: "数据源",
        detectedByHost: "按 {host} 自动识别",
        detectedByProvider: "按供应商名自动识别",
        detectedByKeyPrefix: "按 Key 前缀自动识别",
        detectedFallback: "没匹配到官方额度接口，按本实例实测显示",
        detectedAuto: "自动识别",
        failCode: "失败码",
        retryAttempt: "第 {n} 次重试",
        fiveHourWindow: "5h窗口",
        regionLabel: "区 {r}",
        colon: "：",
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
        toppedUp: "topped up",
        granted: "granted",
        credit: "credit",
        quotaLimit: "limit",
        resetIn: "resets in {n}d",
        source: "source",
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
        capTotal: "cap",
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
        resizeTip: "Drag to resize the panel",
        close: "Close",
        closeTip: "Close the detail panel (click the chip again, or press Esc)",
        provOfficial: "official API",
        provMeasured: "measured on this instance",
        provSource: "data source",
        detectedByHost: "auto-detected via {host}",
        detectedByProvider: "auto-detected by provider name",
        detectedByKeyPrefix: "auto-detected by key prefix",
        detectedFallback: "no official quota endpoint matched, showing this instance's measurements",
        detectedAuto: "auto-detected",
        failCode: "failure code",
        retryAttempt: "retry #{n}",
        fiveHourWindow: "5h window",
        regionLabel: "region {r}",
        colon: ": ",
      },
    };

    /**
     * token 的紧凑单位跟着界面语言走。写死「万/亿」时英文界面会印出 `84.7万 tok`
     * ——给英文读者看一个中文字符。用模块内变量而不是给 `formatTokens` 加参数：
     * 它有 14 个调用点，漏一个就是同一屏里两种单位并存。
     */
    let cjkTokenUnits = true
    /** 界面是否英文。与 `cjkTokenUnits` 同源，都由 `pickLocale()` 在 apply 时定一次。 */
    let uiEnglish = false

    function pickLocale() {
      // 以 `<html lang>` 为准，拿不到才退回浏览器语言。
      // 之前是"两个来源里有任何一个说 zh 就算 zh"：宿主语言是用户在设置里选的
      // （locale 插件把它写进 `<html lang>`），浏览器语言只是操作系统默认——
      // 一个中文系统 + 英文界面的用户，徽标会自己挑中文，和整屏英文对不上。
      const declared = typeof document !== "undefined" ? document.documentElement?.lang : "";
      const browser = typeof navigator !== "undefined" ? navigator.language : "";
      const tag = String(declared || browser || "").toLowerCase();
      const table = tag.startsWith("zh") ? COPY.zh : COPY.en;
      cjkTokenUnits = table === COPY.zh;
      uiEnglish = table === COPY.en;
      return table;
    }

    /**
     * 标签按界面语言取。服务端**同时**发 `label`（中文）与 `labelEn`（英文），
     * 而客户端过去只读 `label`——于是英文界面里整屏标签都是中文
     * （`5 小时窗口`、`openai` 那张卡的标题等）。
     * 拿不到 `labelEn` 时退回 `label`，绝不自己编一个名字。
     */
    function labelOf(item) {
      const label = item?.label
      if (uiEnglish && typeof item?.labelEn === "string" && item.labelEn !== "") return item.labelEn
      return label
    }

    /* ------------------------------------------------------------ 格式化 */

    /** 不换行空格：把单位（Credits 等）钉在数字后面，避免孤字换行。 */
    const NBSP = String.fromCharCode(0xa0);

    function formatTokens(value) {
      if (typeof value !== "number" || !Number.isFinite(value)) return "—";
      const abs = Math.abs(value);
      if (cjkTokenUnits) {
        // 中文阶梯只用 万 / 亿，**不在中间插一个 M**：插了就会出现同一行里
        // 「近 60 秒 38.4万 · 近 5 分 2.47M」这种两套量纲并排的样子，读者得先猜单位。
        if (abs >= 1e8) return `${(value / 1e8).toFixed(2)}亿`;
        if (abs >= 1e4) return `${(value / 1e4).toFixed(1)}万`;
        if (abs >= 1000) return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
        return String(Math.round(value * 100) / 100);
      }
      // 拉丁单位：≥1e4 直接取整到 K（847K 而不是 847.0K），1e3~1e4 留一位小数（1.2K）。
      if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
      if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
      if (abs >= 1e4) return `${Math.round(value / 1e3)}K`;
      if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
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
      // 实测卡只报"用了多少 token"：既没有官方分母，百分比与「剩余」都是凭空造出来的。
      if (isMeasured(card)) {
        return typeof card.tokens === "number" ? (card.tokens === 0 ? "—" : `${formatTokens(card.tokens)} tok`) : copy.noData;
      }
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

    /** 实测卡（本实例账本）永不表达"余量比例"：宿主已剥掉百分比，这里再兜一道——
     *  没有官方分母的进度条就是估算，而估算不是本插件的口径（README「不做什么」）。 */
    function isMeasured(card) {
      return card?.estimated === true || card?.veracity === "local";
    }

    /** 卡片有没有可展示的数字（含实测窗口卡的 tokens）。 */
    function hasNumbers(card) {
      return typeof card?.remaining === "number" || typeof card?.total === "number"
        || typeof card?.used === "number" || typeof card?.tokens === "number";
    }

    /** 余量渐变条的百分比：徽标和明细卡是同一支条的两种尺寸，算法必须只有一份。
     *  （老写法在两处各抄一遍嵌套三元，改一漏一；实测卡一律不出条——没有官方分母
     *  的比例就是估算，见 README「不做什么」。）返回 null 表示「这里不该有条」。 */
    function remainingPercentOf(card) {
      if (isMeasured(card)) return null;
      if (typeof card?.remainingPercent === "number") return Math.max(0, Math.min(100, card.remainingPercent));
      if (typeof card?.usedPercent === "number") return Math.max(0, Math.min(100, 100 - card.usedPercent));
      return null;
    }

    /** 最近一次限流（重试或放弃）发生在上限时间之内吗。
     *  守卫写在取数处：宿主把 `retry` 给成非数组（对象/字符串）时，`?? []` 挡不住
     *  for...of，一次抛错就会把整枚徽标连带面板卸载掉——徽标的字典是「不出错优先于好看」。 */
    function recentThrottle(card) {
      const rows = Array.isArray(card?.retry) ? card.retry : [];
      for (const row of rows) {
        const at = Math.max(Number(row?.lastAt) || 0, Number(row?.lastAbandonAt) || 0);
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

    const cache = { snapshot: null, inflight: null, inflightFresh: false, error: null };

    /** 悬浮面板缩放下限（再小内容就没法看了）。 */
    const PANEL_MIN_W = 280;
    const PANEL_MIN_H = 160;

    /** 面板拖出后的悬浮矩形（视口坐标+尺寸；localStorage 跨刷新；读不到/非法当没拖过）。 */
    const FLOAT_KEY = "dsh-token-plan-quota.panel";
    function loadFloatBox() {
      try {
        const parsed = JSON.parse(localStorage.getItem(FLOAT_KEY));
        if (Number.isFinite(parsed?.x) && Number.isFinite(parsed?.y)) {
          return {
            x: parsed.x, y: parsed.y,
            w: Number.isFinite(parsed.w) ? parsed.w : null,
            h: Number.isFinite(parsed.h) ? parsed.h : null,
          };
        }
      } catch { /* 无 localStorage / 隐私模式 / 脏数据 */ }
      return null;
    }
    function saveFloatBox(box) {
      try {
        if (box === null) localStorage.removeItem(FLOAT_KEY);
        else localStorage.setItem(FLOAT_KEY, JSON.stringify(box));
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

    /**
     * 取一次快照。`fresh` 必须真的影响到网络请求：
     * 老写法「只要在飞就搭车」会让强制刷新静默复用一条没带 ?fresh=1 的请求
     * （宿主侧 ?fresh=1 与 POST /refresh 都会绕开 cacheMs 回源，见 lib/index.js），
     * 用户点了「更新于」等于没点。收口规则：**只有比这次调用更新鲜的那条请求才允许搭车**——
     * 已在飞的是 fresh 请求时，普通轮询搭它的车（结果只会更准）；反之强制刷新自己开一条。
     */
    async function load(fresh) {
      const wanted = fresh === true;
      if (cache.inflight !== null && (cache.inflightFresh || !wanted)) return await cache.inflight;
      const run = (async () => {
        try {
          const snapshot = await request(`${SUMMARY}?fresh=${wanted ? 1 : 0}`);
          cache.snapshot = snapshot;
          cache.error = null;
          return snapshot;
        } catch (error) {
          cache.error = error instanceof Error ? error.message : String(error);
          return cache.snapshot;
        } finally {
          // 并发时后开的那条不能被先结束的那条摘掉，否则 dedupe 出现空窗。
          if (cache.inflight === run) {
            cache.inflight = null;
            cache.inflightFresh = false;
          }
        }
      })();
      cache.inflight = run;
      cache.inflightFresh = wanted;
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

    /** 模型观察的兜底重挂周期（毫秒）：与默认轮询同量级，够快又不额外打宿主。 */
    const MODEL_RETRY_MS = 10000;

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
      // 重连自愈：宿主断线重连后会重建会话 store，`list.current` 常常还是同一个会话 id，
      // 于是"只在 id 变化时重挂"的写法永远等不到第二次 follow，而旧订阅挂在已被替换的
      // 目录 store 上再也收不到发布 —— modelWatch 永久停在 (null,null)，Badge 里
      // `watchActive && provider == null` 那条分支就把徽标整个藏空（实机反馈：
      // "长时间不看这个页面之后插件会消失"）。两条口子一起补：
      // 1) id 没变但我们已经看不到模型时，照样重挂一次；
      // 2) 定时兜底重挂（宿主不发布任何变化时也能靠 directory.load() 拉回来）。
      const stuck = () => modelWatch.provider == null;
      const rehang = () => {
        const current = listStore.getSnapshot?.()?.current ?? null;
        watchedSession = current;
        follow(current);
      };
      const stopList = listStore.subscribe(() => {
        const current = listStore.getSnapshot?.()?.current ?? null;
        if (current === watchedSession && !stuck()) return;
        watchedSession = current;
        follow(current);
      });
      const retryTimer = typeof setInterval === "function"
        ? setInterval(() => { if (stuck()) rehang(); }, MODEL_RETRY_MS)
        : null;
      return () => {
        if (retryTimer !== null && typeof clearInterval === "function") clearInterval(retryTimer);
        try { stopList(); } catch { /* 幂等 */ }
        clearDir();
      };
    }

    /** 卡片绑定的供应商列表（宿主 bindProviders 优先，兜底表兼容老宿主）。 */
    function bindOf(card) {
      if (Array.isArray(card.bindProviders)) return card.bindProviders;
      return DEFAULT_BINDINGS[card.id] ?? [];
    }

    /**
     * 一家只展示一张额度卡：某个供应商已经有官方真值卡带数字时，把**自动检测挂上的**实测兜底卡收起。
     *
     * 两条边界：
     * - 只收 `detected.fallback === true` 的卡（检测自己挂的兜底）。用户自己在 `sources` 里写的
     *   实测源是他的意图，绝不替他藏起来；
     * - 判定看的是「有没有数」，不是「源有没有开」：Cookie 过期时官方卡是错误卡、没有数字，
     *   兜底卡必须还在——否则徽标直接变空白（2026-09-06 实机踩过：在规划阶段关掉兜底就是这个问题）。
     */
    function dropShadowedMeasured(cards) {
      const officialNumbered = [];
      for (const card of cards) {
        if (card.veracity !== "verified" || isMeasured(card) || card.error) continue;
        if (typeof card.remaining !== "number" && typeof card.total !== "number") continue;
        officialNumbered.push({ card, providers: bindOf(card) });
      }
      if (officialNumbered.length === 0) return cards;
      return cards.filter(card => !(
        card.detected?.fallback === true
        // 关键：不能自己 shade 自己（官方卡也可能带 fallback 标记，同一对象要排除）。
        && officialNumbered.some(entry => entry.card !== card
          && entry.providers.some(route => bindOf(card).includes(route)))
      ));
    }

    /* ------------------------------------------------------------ 样式 */

    function cssText() {
      return `
.tpq{display:inline-flex;align-items:center;gap:4px;position:relative;min-width:0;
 --tpq-font:"Geist Variable","Noto Sans SC Variable","Aptos","Segoe UI Variable Text","Segoe UI",
  "PingFang SC","Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif;
 --tpq-mono:"Geist Mono Variable","Cascadia Mono","Cascadia Code","SF Mono",Consolas,ui-monospace,SFMono-Regular,monospace;
 font-family:var(--tpq-font)}
/* dock 座位是一条通栏行（跟输入卡片同宽的最外层），徽标直接挂上去会孤零零贴在视口最左边、
   和居中的卡片对不上。这里复刻卡片的居中几何：外层 padding = side-clearance（同 InputBar.root），
   内层 .tpq max-width = 卡片宽并居中，于是徽标左缘正好落在输入卡片左缘上方。工具行座位不套这层。 */
.tpq-dock{display:flex;justify-content:center;width:100%;box-sizing:border-box;
 padding:0 var(--dsh-composer-side-clearance,16px)}
.tpq-dock>.tpq{width:100%;max-width:var(--dsh-composer-card-max-width,780px)}
/* 徽标是一枚小胶囊：只放「渐变条 + 余量数字」，速度/天数/实测口径/模型/来源都进 tooltip 与明细面板。
   收成胶囊后宽度约 90px，和「+」、工作区、模型选择器、上下文条、发送键挤在同一条 flex-wrap 工具行里
   也放得下（卡片约 773px，最坏情况仍 < 764px），不再挤换行。仍留 min-width:0 + overflow:hidden 兜底：
   极端窄屏先收缩，裁掉的只会是数字以外的部分。胶囊观感 = 全圆角 + 一层淡底 + 细边框。
   注意：这段在 JS 模板字符串里，注释里不能出现反引号。 */
.tpq-chip{display:inline-flex;align-items:center;gap:7px;height:24px;padding:0 10px;border-radius:999px;
 border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18));
 background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.10));
 color:var(--dsw-alias-label-secondary,inherit);font:inherit;font-size:12px;line-height:1;
 cursor:pointer;white-space:nowrap;min-width:0;max-width:min(220px,100%);overflow:hidden;
 transition:background .2s cubic-bezier(.16,1,.3,1),border-color .2s ease,transform .12s ease}
.tpq-chip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.10))}
.tpq-chip:active{transform:scale(.98)}
.tpq-chip:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4176e6);outline-offset:1px}
.tpq-chip[data-sev=bad]{border-style:dashed;border-color:var(--dsw-alias-border-l2,rgba(128,128,128,.35))}
.tpq-chip[data-sev=muted]{opacity:.72}
.tpq-chip[data-busy] .tpq-num{animation:tpq-breathe 1.4s ease-in-out infinite}
@keyframes tpq-breathe{0%,100%{opacity:1}50%{opacity:.4}}
.tpq-name{color:var(--dsw-alias-label-secondary,inherit);letter-spacing:.01em;
 flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
.tpq-num{font-variant-numeric:lining-nums,tabular-nums;color:var(--dsw-alias-label-primary,inherit);flex:none}
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
.tpq-tag{font-size:11px;color:var(--dsw-alias-label-tertiary,inherit);font-variant-numeric:lining-nums,tabular-nums;flex:none}
.tpq-panel{position:absolute;bottom:calc(100% + 6px);left:0;z-index:1000;width:min(380px,88vw);
 /* 必须 border-box：拖拽/缩放存进 localStorage 的是 getBoundingClientRect 的
    border box，而 style.width/height 默认按 content box 解释 —— 于是"点一下标题栏
    （pointerdown 会 detach 并存尺寸）就把面板永久放大 2px"，越点越大。
    实测六次点击 382→394；改成 border-box 后六次纹丝不动。 */
 box-sizing:border-box;
 --tpq-font:"Geist Variable","Noto Sans SC Variable","Aptos","Segoe UI Variable Text","Segoe UI",
  "PingFang SC","Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif;
 --tpq-mono:"Geist Mono Variable","Cascadia Mono","Cascadia Code","SF Mono",Consolas,ui-monospace,SFMono-Regular,monospace;
 font-family:var(--tpq-font);
 border-radius:12px;overflow:hidden;
 border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));
 background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-3,#1e1e1e));
 color:var(--dsw-alias-label-primary,inherit);font-size:12px;line-height:1.55;
 box-shadow:0 12px 32px rgba(0,0,0,.26),0 2px 6px rgba(0,0,0,.12),inset 0 1px 0 rgba(255,255,255,.05);
 animation:tpq-rise .26s cubic-bezier(.16,1,.3,1)}
@keyframes tpq-rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
.tpq-body{max-height:min(52vh,460px);overflow:auto;padding:12px 14px}
.tpq-panel[data-float=1] .tpq-body{max-height:none;height:100%}
.tpq-resize{position:absolute;right:0;bottom:0;width:18px;height:18px;
 cursor:nwse-resize;touch-action:none;border-bottom-right-radius:12px}
.tpq-resize::before{content:"";position:absolute;inset:0;border-bottom-right-radius:12px;
 background:radial-gradient(circle at 100% 100%,var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14)) 0 70%,transparent 72%);
 opacity:0;transition:opacity .15s ease}
.tpq-resize:hover::before{opacity:1}
.tpq-resize::after{content:"";position:absolute;right:4px;bottom:4px;width:10px;height:10px;opacity:.7;
 background:repeating-linear-gradient(45deg,var(--dsw-alias-label-secondary,#8a8a8a) 0 1.5px,transparent 1.5px 4px);
 -webkit-mask:linear-gradient(135deg,transparent 0 44%,#000 44%);
 mask:linear-gradient(135deg,transparent 0 44%,#000 44%);
 transition:opacity .15s ease}
.tpq-resize:hover::after{opacity:1}
.tpq-panel[data-resizing]{cursor:nwse-resize}
.tpq-title{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:-2px -4px 8px;
 padding:2px 4px 8px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.16));
 cursor:grab;user-select:none;-webkit-user-select:none;touch-action:none}
.tpq-title:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.06));border-radius:6px}
.tpq-panel[data-float=1]{box-shadow:0 18px 46px rgba(0,0,0,.32),0 2px 8px rgba(0,0,0,.16),inset 0 1px 0 rgba(255,255,255,.05)}
.tpq-panel[data-dragging]{cursor:grabbing;will-change:transform}
.tpq-panel[data-dragging] .tpq-title{cursor:grabbing}
.tpq-title>span:first-child{font-weight:600;font-size:13px;letter-spacing:.02em;flex:none;white-space:nowrap}
/* 标题行必须永远是一行：模型名（qwen-token-plan-cn/qwen3.8-flash 这种）在默认 380px 面板里
   会折成两行，把标题栏撑高，右边的 ✕ 就跟着错位、看着像压在「额度明细」上。
   所以这里让它省略号收尾（完整名进 tooltip），而不是换行。
   只作用于标题里的那个 .tpq-meta——面板体内同类的行要的是换行，不能一起改。
   这段在 JS 模板字符串里：注释里出现反引号会直接截断模板串（这条已经栽过两次）。 */
.tpq-title .tpq-meta{flex:0 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* 关闭按钮：标题栏整条是拖拽把手，所以它得明确"我不是把手"（cursor:pointer），
   并且要盖在 meta 那串模型名右边，不跟着 flex 伸长。
   外边距不能给负值——那会把按钮拽到面板圆角和边框上去。 */
.tpq-close{flex:none;width:20px;height:20px;margin:0;padding:0;display:inline-flex;
 align-items:center;justify-content:center;border:none;border-radius:5px;background:transparent;
 color:var(--dsw-alias-label-tertiary,inherit);font:inherit;font-size:15px;line-height:1;cursor:pointer;
 transition:background .15s ease,color .15s ease}
.tpq-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16));
 color:var(--dsw-alias-label-primary,inherit)}
.tpq-close:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4176e6);outline-offset:1px}
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
.tpq-meters{margin-top:5px;padding-top:3px;border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.14))}
.tpq-meter{padding:2px 0}
.tpq-meter .tpq-row{font-size:12px}
.tpq-meter .tpq-bar-lg{height:4px;margin:3px 0 1px}
.tpq-note{margin-top:6px;padding:6px 8px;border-radius:8px;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.1));color:var(--dsw-alias-label-secondary,inherit)}
.tpq-err{color:var(--dsw-alias-state-error-primary,#d64545);word-break:break-all}
.tpq-hint{color:var(--dsw-alias-label-secondary,inherit)}
.tpq-updated{display:block;width:100%;margin-top:8px;padding:6px 18px 2px 0;background:transparent;
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
      const fillPct = remainingPercentOf(card);
      const speed = formatSpeed(speedTps);
      // 这三颗值只喂给下面的 tooltip（速度/剩余天数/重试都收进 title，不占徽标位）。
      // 漏声明会在渲染非错误卡时抛 ReferenceError，React 直接把整枚徽标卸载掉——"胶囊不显示"的根因。
      const throttle = recentThrottle(card);
      const expDays = typeof card.expiresAt === "number" ? Math.ceil((card.expiresAt - Date.now()) / 86_400_000) : undefined;
      const resetDays = typeof card.resetAt === "number" ? Math.max(0, Math.ceil((card.resetAt - Date.now()) / 86_400_000)) : undefined;
      // 小胶囊只露「余量」本身：渐变条=状态、数字=剩余（或余额/实测用量）、实测时再挂那颗 pill。
      // 名字不进徽标是安全的——单徽标只挂**当前模型那一家**，旁边的模型按钮已经说明了是谁；
      // 但「实测」必须留在脸上：它是"这张卡不是官方余量"的唯一即时信号，收进 tooltip
      // 就等于把本插件最要紧的立场藏到悬停后面。
      // 速度、剩余天数、重试次数一律进 title，详细内容交给点开后的明细面板。
      const title = card.error
        ? `${labelOf(card)}: ${card.error}`
        : `${labelOf(card)} ${cardValueText(card, copy)}${speed === null ? "" : ` · ${speed} ${copy.tokPerSec}`}${card.estimated ? ` · ${copy.estimatedTip}` : ""}${resetDays !== undefined ? ` · ${copy.resetIn.replace("{n}", resetDays)}` : (expDays !== undefined && expDays <= 7 ? ` · ${copy.resetIn.replace("{n}", expDays)}` : "")}${throttle === null ? "" : ` · ${copy.throttle}×${throttle.attempts}${throttle.abandoned > 0 ? `/${copy.abandoned}×${throttle.abandoned}` : ""}`}${modelText ? `\n${copy.modelNow}: ${modelText}` : ""}${typeof card.sourceNote === "string" ? `\n${copy.source}: ${card.sourceNote}` : ""}`;
      return React.createElement("button", {
        type: "button",
        className: "tpq-chip",
        "data-sev": severity,
        "data-busy": busy ? "1" : undefined,
        title,
        "aria-expanded": expanded,
        onClick: onToggle,
      },
        fillPct === null ? null : React.createElement("span", { className: "tpq-bar", style: barTrackStyle(fillPct) },
          React.createElement("i", { style: barFillStyle(fillPct) })),
        React.createElement("span", { className: "tpq-num" }, cardValueText(card, copy)),
        card.estimated ? React.createElement("span", { className: "tpq-pill", "data-kind": "measured", title: copy.estimatedTip }, copy.estimated) : null,
      );
    }

    /** 吞吐一行摘要（实测）：速度优先（生成速度，缺了用近 60 秒均速），口径细节进 tooltip；多供应商才加第二行。 */
    function ThroughputBlock({ tp, copy }) {
      const head = tp.genTps != null ? tp.genTps : tp.outTps60;
      // 只报一个聚合值，**不再逐家列一遍速度**：头部已经是这一实例的总速度，再列
      // `qwen-token-plan-cn 50.2 tok/s · deepseek-official 161 tok/s · …` 既和它重复，
      // 又常常出现两家同速（看着像坏了），还把这一格撑到换行。逐家数据仍在快照里，
      // 需要时走模型工具 `action=status`，不占面板。
      const kids = [React.createElement("div", { className: "tpq-row", key: "t" },
        React.createElement("span", null, copy.throughput),
        React.createElement("span", { title: `${copy.throughputTip}；${copy.activeFor} ${tp.activeSeconds}s / ${copy.lastFive}${tp.cacheRead60 ? ` · ${copy.cacheRead} ${formatTokens(tp.cacheRead60)} tok` : ""}` },
          // 每个数都带单位：光写「近 60 秒 38.4万」读者不知道那是 token 还是请求数，
          // 而 `247.0万/8` 这种写法看起来更像一个除法。
          `${head != null && head > 0 ? `${formatSpeed(head)} ${copy.tokPerSec}` : "—"} · ${copy.lastMinute} ${formatTokens(tp.tpm60)} tok · ${copy.lastFive} ${formatTokens(tp.tokens300)} tok / ${tp.calls300} ${copy.calls}`))];
      return React.createElement("div", { className: "tpq-plain" }, kids);
    }

    /** 每供应商一行：重试次数/间隔/QUOTA 可否重试；最近失败细节进 tooltip。 */
    function RetryBlock({ rows, copy }) {
      return React.createElement("div", { className: "tpq-plain" },
        rows.slice(0, 3).map((row, index) => React.createElement("div", { className: "tpq-row", key: `${row.provider}-${index}` },
          React.createElement("span", null, row.provider),
          React.createElement("span", {
            className: row.quotaRetryable === false ? "tpq-err" : undefined,
            title: row.lastAt != null ? `${formatClock(row.lastAt)} ${copy.failCode} ${row.lastCode ?? "?"}${row.lastRetry != null ? ` · ${copy.retryAttempt.replace("{n}", row.lastRetry)}` : ""}` : undefined,
          },
            `${copy.retried}×${row.attempts}${row.lastDelayMs !== undefined && row.lastDelayMs !== null ? ` (${Math.round(row.lastDelayMs / 1000)}s)` : ""}`
            + `${row.abandoned ? ` · ${copy.abandoned}×${row.abandoned}` : ""}`
            + ` · ${row.fixedDelayMs !== undefined && row.fixedDelayMs !== null ? `${copy.fixed} ${Math.round(row.fixedDelayMs / 1000)}s × ${row.maxRetries ?? "?"}` : `${copy.backoff} ${row.mode ?? "?"}`}`
            + ` · ${row.quotaRetryable != null ? (row.quotaRetryable ? "✓QUOTA" : `✗QUOTA（${copy.quotaRetryableOff}）`) : ""}`))));
    }

    /** 多计量条：宿主把一张卡的多个窗口（千问 7 天/5 小时、智谱 5h/周/日）按主次排进 `card.meters`，
     *  `meters[0]` 与顶层 `remaining/total` 同源、已由标题行＋大条表达，这里只渲染其余窗口。
     *  实测卡（宿主 `estimated`）永不带百分比，故这里天然不出条——「不估算」由宿主与前端各守一道。 */
    function MeterRows({ meters, copy, allowBar }) {
      return React.createElement("div", { className: "tpq-meters" },
        meters.map(meter => {
          const pct = !allowBar || typeof meter.remainingPercent !== "number"
            ? null
            : Math.max(0, Math.min(100, meter.remainingPercent));
          const value = !allowBar && typeof meter.tokens === "number"
            ? `${copy.windowUsed} ${formatTokens(meter.tokens)}${meter.unit ? NBSP + meter.unit : ""}`
            : (typeof meter.remaining === "number"
              ? `${copy.remaining} ${meter.unit === "Credits" ? formatCredits(meter.remaining) : formatTokens(meter.remaining)}${typeof meter.total === "number" ? ` / ${meter.unit === "Credits" ? formatCredits(meter.total) : formatTokens(meter.total)}` : ""}${meter.unit ? NBSP + meter.unit : ""}`
              : (typeof meter.total === "number" ? `${copy.capTotal} ${meter.unit === "Credits" ? formatCredits(meter.total) : formatTokens(meter.total)}${NBSP + (meter.unit ?? "")}` : "—"));
          const day = formatDay(meter.resetAt ?? meter.expiresAt);
          return React.createElement("div", { className: "tpq-meter", key: meter.key ?? value },
            React.createElement("div", { className: "tpq-row" },
              React.createElement("span", null, labelOf(meter) ?? meter.key ?? ""),
              React.createElement("span", null,
                value,
                allowBar && typeof meter.usedPercent === "number" ? ` · ${copy.used} ${Math.round(meter.usedPercent * 10) / 10}%` : "",
                day !== null ? ` · ${copy.cycleReset} ${day}` : "")),
            pct === null ? null : React.createElement("div", { className: "tpq-bar-lg", style: barTrackStyle(pct), title: `${copy.remaining} ${Math.round(pct)}%` },
              React.createElement("i", { style: barFillStyle(pct) })));
        }));
    }

    /** 紧凑卡：标题行（官方/实测标签，完整来源与口径进 tooltip）+ 一行摘要 + 错误/空因 + 明细最多 6 行。
     *  index 只用来喂 CSS 交错渐入的 --tpq-i（首帧后 DOM 稳定，轮询更新不会重播动画）。 */
    function CardDetail({ card, copy, index }) {
      const bits = [];
      // `meters[0]` 与顶层 remaining/total 同源（宿主排序契约），这里只取其余窗口；
      // 再丢掉"只有配置数字、没有任何读数"的窗口——那是档位噪声，不是额度。
      const extraMeters = (Array.isArray(card.meters) ? card.meters : [])
        .slice(1)
        .filter(meter => typeof meter.remaining === "number" || typeof meter.usedPercent === "number" || typeof meter.tokens === "number");
      const hasFiveHourMeter = extraMeters.some(meter => meter.key === "fiveHour");
      if (isMoney(card)) {
        if (typeof card.remaining === "number") bits.push(formatMoney(card.remaining, card.unit));
        const parts = [];
        if (typeof card.extra?.toppedUp === "number") parts.push(`${copy.toppedUp} ${formatMoney(card.extra.toppedUp, card.unit)}`);
        if (typeof card.extra?.granted === "number" && card.extra.granted > 0) parts.push(`${copy.granted} ${formatMoney(card.extra.granted, card.unit)}`);
        if (typeof card.extra?.cash === "number" && card.extra.cash > 0) parts.push(`${copy.seat} ${formatMoney(card.extra.cash, card.unit)}`);
        if (typeof card.extra?.credit === "number" && card.extra.credit > 0) parts.push(`${copy.credit} ${formatMoney(card.extra.credit, card.unit)}`);
        if (typeof card.extra?.quotaLimit === "number" && card.extra.quotaLimit > 0) parts.push(`${copy.quotaLimit} ${formatMoney(card.extra.quotaLimit, card.unit)}`);
        if (parts.length > 0) bits.push(`· ${parts.join(" · ")}`);
      } else if (card.metric === "count" || isMeasured(card)) {
        // 实测卡（含宿主误喂分母的情况）一律只报「用了多少」，不报「还剩多少/百分之几」：
        // 没有官方分母的比例就是估算，那不是本插件的口径。
        if (typeof card.tokens === "number") {
          const scope = card.resetAt !== undefined ? `${copy.windowUsed} ${card.windowDays ?? 7}${copy.daysUnit}` : copy.monthTokens;
          // 带 tok：吞吐那几行都标了单位，这一行漏掉就成了同一屏里的例外
          // （`窗口内已用 7天 84.7万` 要读者自己猜那是 token 还是次数）。
          bits.push(`${scope} ${formatTokens(card.tokens)} tok`);
          bits.push(`· ${card.calls ?? 0} ${copy.calls}`);
          if (card.remainingDays !== undefined) bits.push(`· ${copy.resetIn.replace("{n}", card.remainingDays)}`);
        }
      } else {
        if (typeof card.remaining === "number") bits.push(`${copy.remaining} ${card.unit === "Credits" ? formatCredits(card.remaining) : formatTokens(card.remaining)}${card.unit ? NBSP + card.unit : ""}`);
        if (typeof card.total === "number") bits.push(`/ ${card.unit === "Credits" ? formatCredits(card.total) : formatTokens(card.total)}`);
        if (typeof card.usedPercent === "number") bits.push(`· ${copy.used} ${Math.round(card.usedPercent * 10) / 10}%`);
        // 5h 窗口只在「下方计量行里真的没有它」时补一行。这里必须用**函数级**那两份
        // extraMeters/hasFiveHourMeter：早先在本块内又抄了一遍同名 const（只 slice 没 filter），
        // 于是外层永远读不到，判定用的是「原始 meters」而 MeterRows 渲染的是「过滤后 meters」——
        // 一个被当噪声滤掉的 fiveHour 窗口会既不出条也不补行，信号凭空少一路。
        if (typeof card.extra?.fiveHourUsedPercent === "number" && !hasFiveHourMeter) bits.push(`· ${copy.fiveHourWindow} ${copy.used} ${card.extra.fiveHourUsedPercent}%`);
      }
      const day = formatDay(card.expiresAt);
      if (day !== null) bits.push(`· ${copy.cycleReset} ${day}`);
      // 这张卡的可信度来源。写死中文时英文界面会印出「官方接口：…」这种半截母语，
      // 所以三段都在字典里（顺序语句而不是嵌套三元：审查规范禁嵌套）。
      let provenance = copy.provSource;
      if (card.veracity === "verified") provenance = copy.provOfficial;
      else if (card.estimated) provenance = copy.provMeasured;
      // 自动检测必须可解释：这张卡凭什么出现（按哪个 host、按路由名、还是谁都没认出来）。
      const DETECTED_BY = {
        baseURL: host => copy.detectedByHost.replace("{host}", host ?? "?"),
        routeId: () => copy.detectedByProvider,
        keyPrefix: () => copy.detectedByKeyPrefix,
        "fallback-window": () => copy.detectedFallback,
      };
      const howDetected = card.detected !== undefined && typeof card.detected === "object"
        ? (DETECTED_BY[card.detected.by] ?? (() => copy.detectedAuto))(card.detected.host)
        : null;
      const headerTitle = [
        typeof card.sourceNote === "string" ? `${provenance}${copy.colon}${card.sourceNote}` : provenance,
        howDetected,
        typeof card.region === "string" ? copy.regionLabel.replace("{r}", card.region) : null,
      ].filter(part => part !== null).join(" · ");
      // items 明细行的口径按「这条有什么数字」选，不是一路嵌套三元猜到底：
      // 到底那一版遇到既无 remaining 又无 tokens 的条目会印出「— / 2000 Cr」，
      // 看着像数据被吃掉了。这里宁可行短一点也不摆一个假的破折号；
      // 「次」也统一走 copy.calls（原第三家用了硬编码，英文界面会中英混排）。
      const itemText = (item) => {
        const hasTokens = typeof item.tokens === "number";
        if (typeof item.remaining !== "number") {
          if (hasTokens) return `${formatTokens(item.tokens)} tok · ${item.calls} ${copy.calls}`;
          if (typeof item.total === "number") return `${copy.capTotal} ${formatTokens(item.total)}${item.unit ? NBSP + item.unit : ""}`;
          return formatDay(item.expiresAt) ?? "—";
        }
        if (item.unit === "Credits" && hasTokens) {
          return `${formatCredits(item.remaining)} Cr · ${formatTokens(item.tokens)} tok · ${item.calls} ${copy.calls}`;
        }
        const total = typeof item.total === "number" ? ` / ${formatTokens(item.total)}` : "";
        const unit = typeof item.unit === "string" && item.unit !== "" ? NBSP + item.unit : "";
        const day = formatDay(item.expiresAt);
        return `${formatTokens(item.remaining)}${total}${unit}${day === null ? "" : ` · ${day}`}`;
      };

      const fillPct = remainingPercentOf(card);

      return React.createElement("div", { className: "tpq-card", style: { "--tpq-i": index } },
        React.createElement("div", { className: "tpq-h", title: headerTitle },          React.createElement("span", null, labelOf(card) ?? card.id),
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
        extraMeters.length > 0 ? React.createElement(MeterRows, { meters: extraMeters, copy, allowBar: !isMeasured(card) }) : null,
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
      const [floatBox, setFloatBox] = React.useState(loadFloatBox);
      /** 拖/缩起手瞬间冻结的视口矩形：操作期间面板样式用冻结值，位移走 transform、
       *  尺寸走行内 width/height（命令式），轮询重渲染不会把面板打回锚定位。 */
      const [dragBox, setDragBox] = React.useState(null);
      /** 只有 portal 到 body 才存在「fixed=视口坐标」的保证；不能 portal 就一切退回
       *  旧的 CSS 锚定（宿主工具栏的 transform 会劫持 inline fixed）。 */
      const canPortal = createPortal !== null && typeof document !== "undefined" && document.body !== undefined;

      /** 拖拽/缩放共同的起手式：钉成 fixed 停在当前 rect，并掐掉仍在跑的入场动画
       *  （动画的 transform 优先级高于行内样式会抢手势；cancel 不改 animation-name，
       *  不会像 CSS 开关那样把动画从 none 拨回来触发重播）。 */
      const detachToFixed = (node, rect) => {
        node.style.position = "fixed";
        node.style.left = `${rect.left}px`;
        node.style.top = `${rect.top}px`;
        node.style.bottom = "auto";
        try {
          for (const running of node.getAnimations?.() ?? []) running.cancel();
        } catch { /* 老内核没有 getAnimations，忽略 */ }
      };
      const viewSize = (rect) => ({
        vw: Number.isFinite(window?.innerWidth) ? window.innerWidth : rect.left + rect.width + 2000,
        vh: Number.isFinite(window?.innerHeight) ? window.innerHeight : rect.top + rect.height + 2000,
      });
      /** 手势期间的解绑入口：指针捕获后 `wrappedUp` 只在 pointerup/cancel 跑。宿主在
       *  拖拽途中把面板卸掉（换会话重挂座位、三座席迁移、Esc 关窗）时这两个事件都不会再来，
       *  监听器和 onMove 闭包就永久挂在节点上。这里留一个幂等收口给卸载清理。 */
      const gestureRelease = React.useRef(null);
      /** 统一手势接线：指针捕获（浏览器外松手也收得到 up）+ 松手/取消即解绑。 */
      const bindGesture = (event, onMove, onUp) => {
        const handle = event.currentTarget;
        let bound = true;
        const release = () => {
          if (!bound) return;
          bound = false;
          handle.removeEventListener("pointermove", onMove);
          handle.removeEventListener("pointerup", release);
          handle.removeEventListener("pointercancel", release);
          if (gestureRelease.current === release) gestureRelease.current = null;
        };
        const wrappedUp = () => {
          release();
          // onUp 会把中途的矩形写回 localStorage，只在真松手时跑；卸载路径故意不调它。
          onUp();
        };
        try { handle.setPointerCapture?.(event.pointerId); } catch { /* 老内核忽略 */ }
        handle.addEventListener("pointermove", onMove);
        handle.addEventListener("pointerup", wrappedUp);
        handle.addEventListener("pointercancel", wrappedUp);
        gestureRelease.current = release;
        event.preventDefault();
      };
      React.useEffect(() => () => {
        const release = gestureRelease.current;
        if (release !== null) release();
      }, []);
      const gestureNode = (event) => {
        const node = panelRef.current;
        if (node === null || event.button !== 0 || !canPortal
          || typeof node.getBoundingClientRect !== "function") return null;
        return node;
      };
      /** 标题栏按住即拖：位移全程 transform translate3d（GPU 合成，零 React 重渲染），
       *  松手才把最终矩形交还 state。视口留 8px 边距夹逼，拖不出去。 */
      const beginDrag = (event) => {
        const node = gestureNode(event);
        if (node === null) return;
        const rect = node.getBoundingClientRect();
        const { vw, vh } = viewSize(rect);
        detachToFixed(node, rect);
        node.dataset.dragging = "1";
        const box = { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) };
        setDragBox(box);
        const startX = event.clientX;
        const startY = event.clientY;
        let dx = 0;
        let dy = 0;
        bindGesture(event, (moveEvent) => {
          const nx = Math.max(8, Math.min(vw - rect.width - 8, rect.left + moveEvent.clientX - startX));
          const ny = Math.max(8, Math.min(vh - rect.height - 8, rect.top + moveEvent.clientY - startY));
          dx = nx - rect.left;
          dy = ny - rect.top;
          node.style.transform = `translate3d(${dx}px,${dy}px,0)`;
        }, () => {
          delete node.dataset.dragging;
          node.style.transform = "";
          const next = { ...box, x: Math.round(rect.left + dx), y: Math.round(rect.top + dy) };
          saveFloatBox(next);
          setDragBox(null);
          setFloatBox(next);
        });
      };
      /** 右下角手柄按住即缩放：只动行内 width/height（布局属性，缩放本来就要重排，
       *  不上 transform——scale 会把文字糊成拉伸的假字）。夹逼：下限 MIN，上限到视口边。 */
      const beginResize = (event) => {
        const node = gestureNode(event);
        if (node === null) return;
        const rect = node.getBoundingClientRect();
        const { vw, vh } = viewSize(rect);
        detachToFixed(node, rect);
        node.dataset.resizing = "1";
        const box = { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) };
        setDragBox(box);
        const startX = event.clientX;
        const startY = event.clientY;
        let w = box.w;
        let h = box.h;
        bindGesture(event, (moveEvent) => {
          w = Math.max(PANEL_MIN_W, Math.min(vw - rect.left - 8, box.w + moveEvent.clientX - startX));
          h = Math.max(PANEL_MIN_H, Math.min(vh - rect.top - 8, box.h + moveEvent.clientY - startY));
          node.style.width = `${w}px`;
          node.style.height = `${h}px`;
        }, () => {
          delete node.dataset.resizing;
          const next = { ...box, w: Math.round(w), h: Math.round(h) };
          saveFloatBox(next);
          setDragBox(null);
          setFloatBox(next);
        });
      };
      /** 双击标题栏：清掉悬浮矩形（含尺寸），回到贴着徽标的默认锚定态。 */
      const resetFloat = () => {
        saveFloatBox(null);
        setFloatBox(null);
      };
      // 窗口变小时把悬浮面板（位置+尺寸）夹回视口。
      React.useEffect(() => {
        if (floatBox === null) return undefined;
        if (typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined;
        const onResize = () => {
          const node = panelRef.current;
          if (node === null || typeof node.getBoundingClientRect !== "function") return;
          const rect = node.getBoundingClientRect();
          const x = Math.max(8, Math.min(window.innerWidth - rect.width - 8, floatBox.x));
          const y = Math.max(8, Math.min(window.innerHeight - rect.height - 8, floatBox.y));
          const w = Math.max(PANEL_MIN_W, Math.min(window.innerWidth - 16, floatBox.w ?? rect.width));
          const h = Math.max(PANEL_MIN_H, Math.min(window.innerHeight - 16, floatBox.h ?? rect.height));
          if (x !== floatBox.x || y !== floatBox.y || w !== floatBox.w || h !== floatBox.h) {
            const next = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
            saveFloatBox(next);
            setFloatBox(next);
          }
        };
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
      }, [floatBox]);
      // 轮询周期跟着宿主回的 pollSeconds 走：第一次用兜底值，拿到快照后按需重建定时器。
      const pollSeconds = Math.max(FALLBACK_POLL_SECONDS, Number(snapshot?.pollSeconds) || FALLBACK_POLL_SECONDS);

      /** 在飞的取数条数：强制刷新和轮询可以并发（load 只允许新搭旧，不允许旧搭新），
       *  busy 必须按计数收，否则先结束那条会把「刷新中…」提前掐掉。 */
      const pending = React.useRef(0);
      const reload = React.useCallback(async (fresh) => {
        pending.current += 1;
        setBusy(true);
        try {
          const next = await load(fresh);
          if (next !== null) {
            // 迟到的旧响应不能盖掉已经拿到的新快照：并发时按 generatedAt 取胜，
            // 否则点完「更新于」数字会先跳新再跳旧，看起来像刷新把数据弄坏了。
            setSnapshot(prev => (prev !== null && typeof prev?.generatedAt === "number"
              && typeof next.generatedAt === "number" && prev.generatedAt > next.generatedAt) ? prev : next);
          }
        } finally {
          pending.current -= 1;
          if (pending.current === 0) setBusy(false);
        }
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
        // 明细面板是**常驻小窗**，不是下拉菜单：没有「点外面就关」。
        // 它会悬浮、可拖、可缩、位置还记进 localStorage，关掉只该由用户决定——
        // 再点徽标（toggle）或按 Esc。靠选择器猜宿主 DOM（输入卡片长什么样）既脆又必然漏：
        // 实测线上产物里连 data-composer-card / data-input-scroll 都不存在。
        const onKey = (event) => {
          if (event.key !== "Escape") return;
          setOpen(false);
          // Esc 能把手势打断（拖到一半按键）：dragBox 是 pointerdown 才有的临时态，
          // 不清掉的话下次打开会停在半路位置，且再也回不到锚定态。
          setDragBox(null);
        };
        document.addEventListener("keydown", onKey);
        return () => {
          document.removeEventListener("keydown", onKey);
        };
      }, [open]);
      // 锚定态是 JS 算的视口坐标：窗口变化时重渲染一次跟着挪。
      React.useEffect(() => {
        if (!open) return undefined;
        if (typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined;
        const onResize = () => setModelTick(tick => tick + 1);
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
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
      const boundPanel = scoped ? allPanel.filter(card => bindOf(card).includes(provider)) : allPanel;
      // 收敛后一张不剩，等于把面板整个关上（实机反馈："匹配不到就改成全量显示"）。
      // 自定义路由、`providers` 写成通用名（moonshot 而不是路由 id）都会落到这里——
      // 与其让界面空白一片，不如把别的源的余量照常列出来，"这条路由没有额度源"
      // 由徽标那侧的降级去表达。
      const panelCards = dropShadowedMeasured(boundPanel.length === 0 ? allPanel : boundPanel).slice(0, 8);
      const modelText = watchActive && modelWatch.provider != null
        ? `${modelWatch.provider}${modelWatch.model ? `/${modelWatch.model}` : ""}`
        : null;
      const children = [];

      // 原先这里有一条早退："模型观察已接上但当前没有可读的选择（空白会话 / 目录未加载）
      // 就不打扰"，直接返回一个空的 .tpq。它和"挂机后消失""打开会话又消失"是同一个病灶：
      // 目录在重连/切会话的瞬间 current 还是 null，徽标就整个藏空，而且没人会想到是
      // "模型未知"而不是"插件坏了"。按已定口径统一成降级：provider 为 null 就走全量
      // （下面的 bound 收敛自然为空集 → fullChips，panelScope 的 scoped 也要求 provider
      // 非空 → 面板同样全量），等目录发布后再由观察订阅切回跟随。

      // 拿不到模型（老外壳）或当前路由没有归属卡时的统一选择：官方卡全量。
      const fullChips = () => official.filter(card => hasNumbers(card) || card.error).slice(0, 3);
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
        // 匹配不到就退回全量，而不是把徽标藏成 0×0：自定义路由、`providers` 写成
        // 通用名这类情况，过去表现为"插件又坏了"（实机反馈："匹配不到就改成全量显示"）。
        chips = primary === null ? fullChips() : [primary];
      } else {
        // 老外壳（拿不到模型）：退回官方卡全量显示。
        chips = fullChips();
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
        // 面板一律 portal 到 body + fixed 定位：宿主工具栏链路上任何 transform/filter/
        // backdrop-filter/contain 都可能劫持 fixed 包含块，body 之下永远是视口坐标系。
        const vw = Number.isFinite(window?.innerWidth) ? window.innerWidth : null;
        const vh = Number.isFinite(window?.innerHeight) ? window.innerHeight : null;
        let panelStyle;
        let bodyStyle;
        if (canPortal && dragBox !== null) {
          panelStyle = {
            position: "fixed", left: `${dragBox.x}px`, top: `${dragBox.y}px`, bottom: "auto",
            width: `${dragBox.w}px`, height: `${dragBox.h}px`,
          };
        } else if (canPortal && floatBox !== null) {
          panelStyle = { position: "fixed", left: `${floatBox.x}px`, top: `${floatBox.y}px`, bottom: "auto" };
          if (Number.isFinite(floatBox.w)) panelStyle.width = `${floatBox.w}px`;
          if (Number.isFinite(floatBox.h)) panelStyle.height = `${floatBox.h}px`;
        } else if (canPortal && vw !== null && vh !== null && root.current !== null
          && typeof root.current.getBoundingClientRect === "function") {
          const r = root.current.getBoundingClientRect();
          // 面板要躲开的是**整张输入卡片**，不是徽标所在的那一行：徽标在卡片底部的工具行里，
          // 只贴到徽标上方，486px 高的面板就把卡片连同输入框整个盖住，点开就打不了字
          // （实机反馈"面板遮挡"；探针量到 position:fixed + parent=BODY + 面板自己压在最上层，
          // 说明不是被遮，而是它在遮别人）。底边改贴卡片上缘，取不到卡片才退回徽标上缘。
          const cardEl = typeof root.current.closest === "function"
            ? root.current.closest("[class*='_card']")
            : null;
          const cardRect = cardEl && typeof cardEl.getBoundingClientRect === "function"
            ? cardEl.getBoundingClientRect()
            : null;
          // 重连后徽标可能已被卸载或尚未布局：rect 全是 0，老写法算出 bottom = vh + 6
          // 把面板整个顶出视口，看着就是"面板跑到左上角"（实机反馈）。锚点不可信时退到
          // 「水平居中、上三分之一处」的悬浮位，至少面板完整可见、✕ 点得到。
          const detached = root.current.isConnected === false
            || (r.width === 0 && r.height === 0 && r.top === 0);
          // 优先级写成顺序语句：嵌套三元是审查规范里明令禁止的写法。
          let anchorTop = r.top;
          if (cardRect !== null && cardRect.height > 0) anchorTop = cardRect.top;
          if (detached) anchorTop = Math.round(vh * 0.35);
          const w = Math.min(380, vw * 0.88);
          const anchorLeft = detached ? Math.round((vw - w) / 2) : r.left;
          // 锚定态朝上展开，标题栏（含 ✕）在面板顶端。徽标离屏幕顶不够高时（短窗口、hero 居中态），
          // 整块面板会顶出视口、把 ✕ 裁掉。面板底边贴**输入卡片上缘** 6px，把面板体高度夹到
          // 卡片上方可用空间以内——夹高度等于把顶边往下挪，✕ 永远留在屏内。
          const GAP = 6;
          const MARGIN = 8;
          const spaceAbove = anchorTop - GAP - MARGIN;
          const bodyMax = Math.max(PANEL_MIN_H, Math.min(vh * 0.52, 460, spaceAbove));
          panelStyle = {
            position: "fixed",
            left: `${Math.max(MARGIN, Math.min(anchorLeft, vw - w - MARGIN))}px`,
            bottom: `${Math.max(MARGIN, vh - anchorTop + GAP)}px`,
            top: "auto",
          };
          bodyStyle = { maxHeight: `${bodyMax}px` };
        }
        const panelEl = React.createElement("div", {
          className: "tpq-panel", role: "dialog", key: "panel", ref: panelRef,
          "data-float": canPortal && (floatBox !== null || dragBox !== null) ? "1" : undefined,
          style: panelStyle,
        },
          React.createElement("div", { className: "tpq-body", style: bodyStyle },
            React.createElement("div", { className: "tpq-title", title: copy.dragTip, onPointerDown: beginDrag, onDoubleClick: resetFloat },
              React.createElement("span", null, copy.detailTitle),
              // 会被省略号截断，所以完整模型名进 tooltip（悬停子元素的 title 盖过父级那条）。
              modelText === null ? null : React.createElement("span", { className: "tpq-meta", title: modelText },
                React.createElement("span", { className: "tpq-meta-label" }, `${copy.modelNow}: `), modelText),
              // 常驻小窗没有「点外面就关」，关掉必须由用户决定：再点徽标、Esc，或者这颗叉。
              // onPointerDown 要挡一下——整条标题栏都是拖拽把手，不挡的话按下就被 beginDrag 捕获，
              // 点击事件根本轮不到按钮（双击归位同理，所以它只在标题栏的其余区域生效）。
              React.createElement("button", {
                type: "button",
                className: "tpq-close",
                "aria-label": copy.close,
                title: copy.closeTip,
                onPointerDown: event => event.stopPropagation(),
                onClick: () => setOpen(false),
              }, "\u00d7")),
            throughput !== null && throughput !== undefined
              ? React.createElement(ThroughputBlock, { tp: throughput, copy })
              : null,
            // key 带 index：用户手写出两个同名源（比如同一家的两个区）时，重复 key 会让 React
            // 把两张卡当一张，交错渐入的序号也跟着错。
            panelCards.map((card, index) => React.createElement(CardDetail, { key: `${card.id}-${index}`, card, copy, index })),
            React.createElement("button", {
              type: "button",
              className: "tpq-updated",
              disabled: busy,
              title: `${copy.updatedTip}${snapshot?.config?.file ? ` · ${copy.configHint} ${snapshot.config.file}` : ""}`,
              // 走 reload(true) 而不是直接打 /refresh：宿主侧 GET summary?fresh=1 与 POST refresh
              // 都是 buildStatus({fresh:true})（见 lib/index.js 路由），口径相同；而直接打网络会绕过
              // busy 与 cache——按钮不会显示「刷新中…》，结果也不写回 cache，会被并发轮询盖回去。
              onClick: () => void reload(true),
            }, busy ? copy.refreshing : `${copy.updated} ${formatClock(snapshot?.generatedAt)}`)),
          // 缩放手柄挂外层（不随内容滚动），锚定/悬浮两态常驻——锚定态直接拖角
          // 会先自动 detach 成悬浮再缩放。
          React.createElement("div", { className: "tpq-resize", title: copy.resizeTip, onPointerDown: beginResize }));
        children.push(canPortal ? createPortal(panelEl, document.body) : panelEl);
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
      if (slots === undefined) {
        ctx.logger?.warn?.(new Error("token-plan-quota: 宿主未提供 slots 服务，徽标无法挂载"));
        return;
      }
      // 语言在**每次渲染时**重取，不在 apply 时定一次：宿主的 locale 插件是异步把
      // `zh-CN` 写进 `<html lang>` 的（packages/client/locale/src/client/index.ts:149），
      // 而动态插件的 apply 可能跑在它之前——那一刻 `<html lang>` 还是空的，pickLocale
      // 只能退回 navigator.language（操作系统语言），于是中文界面里徽标自己变成英文，
      // 而且要等到下次重载才纠正（实机反馈："插件变成英文了"）。
      const BadgeEntry = () => React.createElement(Badge, { copy: pickLocale(), watchActive });
      // dock 是一条通栏行（跟输入卡片同宽的最外层），徽标直接挂上去会孤零零贴在视口最左边，
      // 和居中的输入卡片对不上（实机反馈"效果太差"）。所以 dock 态包一层 .tpq-dock，把徽标夹到
      // 卡片那条居中列（max-width = --dsh-composer-card-max-width，左右内边距 = side-clearance），
      // 徽标左缘就正好落在输入卡片左缘上方。工具行座位（老外壳回退）不包这层，直接内联。
      const DockEntry = () => React.createElement("div", { className: "tpq-dock" },
        React.createElement(Badge, { copy: pickLocale(), watchActive }));
      // 座位偏好（数组顺序 = 优先级，实机反馈定的）：
      // 1. conversation.input.right —— 输入行右侧、紧贴模型选择器左边。徽标本来就跟随
      //    当前模型的供应商，和模型选择器归成同一组最好读（用户原话：位置不对 → 选此项）。
      // 2. conversation.input.left —— 老位置（+ / 权限 之后），右侧没有这一格时用它。
      // 3. conversation.input.dock —— 通栏行，仅在前面两格都不存在的老外壳上退到这里。
      // 徽标已收成「渐变条 + 余量数字」的小胶囊（约 90px）；卡片约 773px，最坏情况
      // （工作区名+模型名都拉满）也 < 764px，不会挤换行。速度/天数/实测口径/来源都不
      // 占位，进 tooltip 与点开后的明细面板。
      const seats = [
        { name: "conversation.input.right", order: 40, entry: BadgeEntry },
        { name: "conversation.input.left", order: 40, entry: BadgeEntry },
        { name: "conversation.input.dock", order: 40, entry: DockEntry },
      ];
      // 座位优先级：数组顺序就是偏好顺序（工具行 > 通栏 dock）。宿主的 inject 工厂会在
      // 每次该座位被渲染时回调一次，所以这里必须同时满足三件事，少一件就是实机症状：
      // 1) 同一时刻只有一个座位挂着徽标，否则两条胶囊重复；
      // 2) 占位随 disposer 释放。早先是个只进不出的布尔闩锁（mounted 置 true 后再不复位），
      //    切换会话把输入区卸载重挂之后徽标就永久消失——"上次启动还能看到，重启后所有
      //    历史会话都看不到"就是它；
      // 3) 更好的座位后到时必须能接手。宿主先渲染通栏行、再渲染工具行，只认"先到先得"
      //    就会把徽标永久钉在最左边的通栏上——"位置不对"就是它。
      let live = null;
      for (const [index, seat] of seats.entries()) {
        ctx.effect(() => slots.inject(seat.name, () => {
          if (live !== null && live.index <= index) return () => {};
          if (live !== null) {
            const previous = live;
            live = null;
            try { previous.dispose(); } catch { /* 让位给更优座位，旧座位的卸载幂等 */ }
          }
          try {
            const dispose = slots.register({ name: seat.name, id: "token-plan-quota", order: seat.order }, seat.entry);
            const release = typeof dispose === "function" ? dispose : () => {};
            live = { index, name: seat.name, dispose: release };
            return () => {
              if (live !== null && live.index === index) live = null;
              try { release(); } catch { /* 幂等 */ }
            };
          } catch (error) {
            // 这里原本是个裸 catch：座位契约一变（0.1.2 的 register 会做载入期校验），
            // 徽标就静默消失，控制台与宿主日志里都不留线索。失败必须留痕，且必须让位。
            live = null;
            ctx.logger?.warn?.(new Error(`token-plan-quota: 挂载到 ${seat.name} 失败 —— ${error instanceof Error ? error.message : String(error)}`));
            return () => {};
          }
        }), `dsh-token-plan-quota: ${seat.name}`);
      }
    }

    exports.apply = apply;
    // 动态插件的 fiber 只看得见自己声明过的服务。0.1.2 起这条规则是硬的：没声明时
    // ctx.get("slots") 只会返回 undefined（直读 ctx.slots 则抛 "cannot get property
    // \"slots\" without inject"），于是徽标静默不挂载。slots 是徽标的硬依赖，
    // 所以在这里声明。sessions / modelDirectories 也在这一列，不是顺手加的：徽标
    // 「跟随当前模型供应商」和「面板只显示当前模型」（宿主默认 panelScope:"current"）
    // 都依赖这两份服务，缺了 watchActive 恒为 false，面板就退回全量显示。
    // 代价要写明白：fiber 会等这三份服务，任一缺席（例如 profile 停用了模型选择插件）
    // 整个徽标就不出现，而不是退回全量——这是"跟随模型"这个卖点本身的取舍。
    exports.inject = ["slots", "sessions", "modelDirectories"];
    return module.exports;
  },
});
