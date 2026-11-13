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

    /* 整页「用量统计」屏（spec 006）依赖的两块宿主契约：座位 id 与只读数据路由。
     * PANEL_ID 同时是 main 座位的 key 与 sidebar.panellist 的 id（INTERFACE.md §3）。
     * defineStore 同样是「有就用、没有就只留徽标」的可选依赖：老宿主的 client-store
     * 没有 defineStore 时整页座位不注册，徽标照常工作（不因为可选能力缺失而整体降级）。 */
    const PANEL_ID = "token-plan-quota.usage";
    const USAGE = "/token-plan-quota/usage";
    /* 008：官方账号侧用量（宿主读官方控制台的用量明细）。与本机路由**同一组查询参数**，
       失败体是 200 + {error:"official-unavailable", code, hint}（见 INTERFACE §2.1/§3.2）。 */
    const USAGE_OFFICIAL = "/token-plan-quota/usage-official";
    let defineStore = null;
    try {
      const clientStore = require("@deepseek-ai/dsh-client-store");
      if (typeof clientStore?.defineStore === "function") defineStore = clientStore.defineStore;
    } catch { /* 老宿主没有这个种子词：usage screen 不注册 */ }

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
        usageTitle: "Token 计划用量",
        usageRange: "近 {n} 天 · {from} 至 {to}",
        usageRangeToday: "今天 · {from}",
        usageRangeCustom: "自定义",
        usageRangeFrom: "开始日期",
        usageRangeTo: "结束日期",
        usageRangeApply: "查询",
        usageRangeBad: "起止日期不合法",
        usageRangeTooLong: "最多查 {maxDays} 天",
        usageRangeDayOne: "{from} 当天",
        // INTERFACE §3.3 只列了 8 个键，多天自定义标题没有模板键；补这一键避免在代码里
        // 拼中文语序（英文界面会印出中文连接词），zh/en 成对维护。
        usageRangeCustomTitle: "{from} 至 {to} · {n} 天",
        usageRangeLocalOnly: "仅统计本机 DSH 发出的调用；其他设备的用量不在此列。",
        // 009 §3：兜底目录扫描补回来的会话数（只在 rescued > 0 时多一行脚注）。
        usageScanRescued: "另有 {n} 个会话不在宿主的会话列表里，已按日志目录补扫。",
        // 008 官方账号侧对照条（INTERFACE §3.3 的 8 键 + 两枚补充键：格标签与夹紧说明）。
        usageOfficialTitle: "官方账号侧用量对照",
        usageOfficialOfficial: "官方",
        usageOfficialLocal: "本机实测",
        usageOfficialGap: "差额（官方 − 本机）",
        usageOfficialLoading: "正在读取官方账号侧用量…",
        usageOfficialError: "官方账号侧用量没取到",
        usageOfficialRetry: "重试官方查询",
        usageOfficialNote: "官方数字含其他设备、其他客户端用同一 Key 发出的调用，口径是 Token 总数；其中输入侧已含缓存读取，两项不相加。本机数字只统计本机会话记录，两边可能对不上。",
        usageOfficialEmpty: "官方账号侧这段时间也没有用量记录。",
        usageOfficialClamped: "你查的 {from} 起，官方最早只到 {officialFrom} 起。",
        usageClose: "关闭用量统计页",
        usageToday: "今日",
        usageDaysLabel: "天数（1–365）",
        usageModeLabel: "视图",
        usageMode2d: "2D",
        usageMode3d: "3D",
        usageTotalLabel: "区间 tokens 总数",
        usageTokensUnit: "tokens",
        usageMeasuredBadge: "本实例实测",
        usageScaleNote: "2D 与 3D 用同一线性刻度：柱高只跟 tokens 成正比。",
        usageCalls: "调用次数",
        usageSplitInput: "input",
        usageSplitOutput: "output",
        usageSplitCacheRead: "cacheRead",
        usageSplitCacheWrite: "cacheWrite",
        usageSplitTotal: "tokens",
        usageChartTitle: "每日用量",
        usageChartWeekTitle: "每周用量",
        usageWeeklyNote: "每 7 天汇总（周一起算）",
        usageModelsTitle: "按模型用量",
        usageNoModels: "这个区间还没有模型用量。",
        usageLoading: "正在读取会话记录…",
        usageBackfill: "正在回填历史（{indexed}/{sessions} 会话）",
        usageEmptyNoUsage: "这个区间没有记录到用量",
        usageEmptyNoUsageHint: "换个天数，或者等有新的调用后再来看。",
        usageEmptyNoPersistence: "宿主没有开启会话持久化，读不到历史用量",
        usageEmptyNoPersistenceHint: "开启会话持久化后才能按天回填；当前进程启动以来的用量仍然可用。",
        usageEmptyDisabled: "用量统计已关闭",
        usageEmptyDisabledHint: "在插件配置里把 usageStats 设为 true 后重开这一页。",
        usageEmptyNoSessions: "这个实例还没有会话记录",
        usageEmptyNoSessionsHint: "先开始一次对话、产生调用，这里才有可统计的用量。",
        usageError: "用量数据没取到",
        usageRetry: "重试",
        usageUpdated: "更新于",
        usageNoteSource: "数据源：{label}，不是官方余额。",
        usageNoteSourceFallback: "数据源：本实例实测（来自本地会话记录），不是官方余额。",
        usageSourceSessionIndex: "本实例实测（来自本地会话记录）",
        usageSourceLive: "本进程启动以来（实测）",
        usageSyncing: "正在同步…",
        usageBackfillPartial: "有 {failed} 个会话读取失败，这部分历史可能有缺口。",
        usageNoteDelay: "会话记录最长滞后 5 分钟；实时月度账本不受影响。",
        usageNoteCacheWrite: "当前宿主大多不上报 cacheWrite，这个数常年为 0 属正常。",
        usageNoteNoCredits: "不折算 Credits，也不估算余量。",
        usageEntry: "用量统计",
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
        usageTitle: "Token plan usage",
        usageRange: "Last {n} days · {from} to {to}",
        usageRangeToday: "Today · {from}",
        usageRangeCustom: "Custom",
        usageRangeFrom: "From",
        usageRangeTo: "To",
        usageRangeApply: "Apply",
        usageRangeBad: "Invalid date range",
        usageRangeTooLong: "Up to {maxDays} days",
        usageRangeDayOne: "{from} (one day)",
        usageRangeCustomTitle: "{from} to {to} · {n} days",
        usageRangeLocalOnly: "Only calls made by this DSH instance are counted; usage from other devices is not included.",
        usageScanRescued: "{n} more session(s) were not in the host list and were recovered from the log directory.",
        usageOfficialTitle: "Official account vs this instance",
        usageOfficialOfficial: "Official",
        usageOfficialLocal: "This instance",
        usageOfficialGap: "Difference (official - this instance)",
        usageOfficialLoading: "Reading official account usage…",
        usageOfficialError: "Could not load official account usage",
        usageOfficialRetry: "Retry official query",
        usageOfficialNote: "Official numbers include calls from other devices or clients using the same key, counted as total tokens with cache reads already inside the input side (do not add the two). This-instance numbers only cover local session records, so the two can differ.",
        usageOfficialEmpty: "The official account has no usage in this range either.",
        usageOfficialClamped: "You asked from {from}, but official data only starts at {officialFrom}.",
        usageClose: "Close usage page",
        usageToday: "Today",
        usageDaysLabel: "Days (1-365)",
        usageModeLabel: "View",
        usageMode2d: "2D",
        usageMode3d: "3D",
        usageTotalLabel: "Tokens in range",
        usageTokensUnit: "tokens",
        usageMeasuredBadge: "measured on this instance",
        usageScaleNote: "2D and 3D share one linear scale: bar height is proportional to tokens.",
        usageCalls: "requests",
        usageSplitInput: "input",
        usageSplitOutput: "output",
        usageSplitCacheRead: "cacheRead",
        usageSplitCacheWrite: "cacheWrite",
        usageSplitTotal: "tokens",
        usageChartTitle: "Daily usage",
        usageChartWeekTitle: "Weekly usage",
        usageWeeklyNote: "Bucketed by week (starting Monday)",
        usageModelsTitle: "Usage by model",
        usageNoModels: "No model usage recorded in this range yet.",
        usageLoading: "Reading session records…",
        usageBackfill: "Backfilling history ({indexed}/{sessions} sessions)",
        usageEmptyNoUsage: "No usage recorded in this range",
        usageEmptyNoUsageHint: "Try a wider range, or come back after some new calls.",
        usageEmptyNoPersistence: "Session persistence is off, so past usage cannot be read",
        usageEmptyNoPersistenceHint: "Enable session persistence to backfill by day; usage since this process started is still available.",
        usageEmptyDisabled: "Usage stats are turned off",
        usageEmptyDisabledHint: "Set usageStats to true in the plugin config, then reopen this page.",
        usageEmptyNoSessions: "This instance has no sessions yet",
        usageEmptyNoSessionsHint: "Start a conversation to make some requests, then usage will show up here.",
        usageError: "Could not load usage data",
        usageRetry: "Retry",
        usageUpdated: "Updated",
        usageNoteSource: "Source: {label}, not an official balance.",
        usageNoteSourceFallback: "Source: measured on this instance (local session records), not an official balance.",
        usageSourceSessionIndex: "measured in this instance (from local session records)",
        usageSourceLive: "since this process started (measured)",
        usageSyncing: "syncing…",
        usageBackfillPartial: "{failed} sessions could not be read, so this range may have gaps.",
        usageNoteDelay: "Session records lag by up to 5 minutes; the live monthly ledger is unaffected.",
        usageNoteCacheWrite: "Most current hosts do not report cacheWrite, so 0 here is expected.",
        usageNoteNoCredits: "No Credits conversion and no remaining-quota estimates.",
        usageEntry: "Usage stats",
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
      // 报错卡且没有任何数字时正面说「失败」，不落进 copy.noData：「无官方额度数据」读起来
      // 像"接口好的、只是没数据"，实机反馈就是"插件又没有正常显示"。错误码与修复提示
      // 本来就在 tooltip 与明细面板里，正面只负责把"这是失败"说清楚。
      if (card.error && !hasNumbers(card)) return copy.failed;
      // 实测卡只报"用了多少 token"：既没有官方分母，百分比与「剩余」都是凭空造出来的。
      if (isMeasured(card)) {
        return typeof card.tokens === "number" ? (card.tokens === 0 ? "—" : `${formatTokens(card.tokens)} tok`) : copy.noData;
      }
      if (card.metric === "money") return formatMoney(card.remaining, card.unit);
      // 数字与条必须同一个来源：remainingPercentOf 既认宿主在有官方分母时给的 remainingPercent，
      // 也认上游**直接返回**的 usedPercent（余量 = 100 − 已用，是同一个官方数的另一种写法，
      // 不是估算）。所以档位额度那一路偶发取不到时，徽标照旧是「96% + 条」，
      // 只是不报绝对剩余量（那个真算不出来）。
      const barPct = remainingPercentOf(card);
      if (typeof barPct === "number") return `${Math.round(barPct)}%`;
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

    /** 卡片有没有可展示的数字（含实测窗口卡的 tokens，以及"上游直接给了比例但档位额度
     *  那一路没取到"的官方比例 —— 那是真值，不该被当成空卡收起）。 */
    function hasNumbers(card) {
      return typeof card?.remaining === "number" || typeof card?.total === "number"
        || typeof card?.used === "number" || typeof card?.tokens === "number"
        || typeof card?.usedPercent === "number";
    }

    /** 余量渐变条的百分比：徽标和明细卡是同一支条的两种尺寸，算法必须只有一份。
     *  （老写法在两处各抄一遍嵌套三元，改一漏一。）返回 null 表示「这里不该有条」。
     *  两个合法来源：① 宿主在有官方分母时派生的 remainingPercent；② 上游**直接返回**的
     *  usedPercent（100−它 就是余量 —— 同一个官方数的反向写法，不是估算）。实测卡一律不出条：
     *  它没有任何官方读数（宪法原则 I v2.0.0：禁的是估算与凭空折算，不是官方给的数）。 */
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

    /** 失败对象：message 也用 code（日志/兜底都只出现稳定短码），绝不裹宿主原文。 */
    function usageFailure(code) {
      const error = new Error(code);
      error.code = code;
      return error;
    }

    /**
     * 宿主 API 请求。失败抛的 Error 只带机器可读的 code（payload.error 的短横线码，
     * 拿不到就是 "http-status"），**绝不把宿主原文当文案**：宿主 500 的 payload.error
     * 可能是内部 error.message（路径、栈、SQL 片段），上屏既不可读也是信息泄漏面
     * （与宿主侧「/usage 异常固定回 usage-unavailable」的收口配对，C10）。
     * options 支持 method / signal（切天时 abort 在飞请求，C4）。
     */
    async function request(path, options) {
      const opts = options !== null && typeof options === "object" ? options : {};
      const response = await fetch(path, {
        method: opts.method ?? "GET",
        credentials: "same-origin",
        headers: { accept: "application/json" },
        cache: "no-store",
        signal: opts.signal,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload === null) {
        const failure = usageFailure(typeof payload?.error === "string" ? payload.error : "http-status");
        // 007：usage-range-too-long 的 400 带 maxDays（宿主配置的 usageBackfillDays）。
        // 错误文案要报真上限而不是本地常量，所以把它带到 Error 上；别的错误码不读这个字段。
        if (payload !== null && payload !== undefined) {
          const maxDays = Number(payload.maxDays);
          if (Number.isFinite(maxDays) && maxDays >= 1) failure.maxDays = Math.round(maxDays);
        }
        throw failure;
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
     * 当前会话 id：**两代外壳都认**。
     *
     * DSH 0.2 起（本机桌面版 0.2.0-rc.2）`sessions.list` 的快照是 `{ ids, byId, phase }`，
     * **没有 `current`**；宿主自己取"主区域正在看的那一个"用的是
     * `retainedBy.mainView > 0` 那一行（ui-workspace / open-in-app / 会话面板都是这个写法）。
     * 0.1.x 老外壳才有 `{ current }`，先认它。
     *
     * 老写法只读 `.current`：在 0.2 外壳上恒为 undefined → provider 恒为 null →
     * 徽标永远走"路由解析不到"的降级挑选。实机症状：额度徽标不再跟随模型，
     * 只剩一枚「无官方额度数据」。两代都认之后，跟随逻辑才真正生效。
     *
     * @param listStore - `ctx.get("sessions").list`。
     * @returns 会话 id；两代形状都取不到时给 null（退回降级，不抛）。
     */
    function currentSessionId(listStore) {
      const snapshot = typeof listStore?.getSnapshot === "function" ? listStore.getSnapshot() : null;
      if (snapshot === null || typeof snapshot !== "object") return null;
      if (typeof snapshot.current === "string" && snapshot.current !== "") return snapshot.current;
      const byId = snapshot.byId;
      if (byId === null || typeof byId !== "object") return null;
      for (const [id, row] of Object.entries(byId)) {
        const retained = row?.retainedBy?.mainView ?? 0;
        if (retained > 0) return typeof row?.id === "string" && row.id !== "" ? row.id : id;
      }
      return null;
    }

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
      const initial = currentSessionId(listStore);
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
        const current = currentSessionId(listStore);
        watchedSession = current;
        follow(current);
      };
      const stopList = listStore.subscribe(() => {
        const current = currentSessionId(listStore);
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

    /** 两个供应商名是不是指同一条路由。
     *
     *  当前路由 id 经常是**包装层**：`modlens-qwen-token-plan-cn` 之于 `qwen-token-plan-cn`
     *  （代理/中转路由把原路由名当后缀）。精确相等时匹配不到 → 走"匹配不到就全量显示"的兜底
     *  → 实机反馈是**两个胶囊同时出现**（余量 + 余额），但用户只需要一个。
     *  所以再认一层按 `-` 边界的包含：任一方是另一方的完整尾段。边界是必须的 ——
     *  否则 `qwen` 这种短名会把 `qwen-token-plan-cn` 也吞进来（那是另一条卡片语义）。 */
    function sameProvider(a, b) {
      if (typeof a !== "string" || typeof b !== "string" || a === "" || b === "") return false;
      if (a === b) return true;
      return a.length > b.length ? a.endsWith(`-${b}`) : b.endsWith(`-${a}`);
    }

    /** 这张卡是否绑定在当前被观察的路由上（包装层也算命中）。 */
    function bindsCurrent(card, current) {
      if (typeof current !== "string" || current === "") return false;
      return bindOf(card).some(route => sameProvider(route, current));
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
          && entry.providers.some(route => bindOf(card).some(bound => sameProvider(bound, route))))
      ));
    }

    /* ------------------------------------------------------------ 用量统计（spec 006 的整页屏） */

    /** 天数输入与查询的硬边界：与宿主回填上限（365 天）对齐。 */
    const USAGE_DAYS_MIN = 1;
    const USAGE_DAYS_MAX = 365;
    /** 用量请求的本地超时：宿主重启 / 回调丢失时请求可能永不返回，面板不能永远停在骨架。
        超时按错误态处理（本地化文案 + 重试按钮），不把 AbortError 抛给用户。 */
    const USAGE_TIMEOUT_MS = 15000;
    /** 绘图区高度（px）。2D 与 3D 共用同一个 ratio，高度常量只在投影里出现一次。 */
    const PLOT_H = 120;
    /** 缺省柱宽（px）：只给 projectBar3D 直接调用时兜底，图表自己按容器宽度算实际宽度。 */
    const DEFAULT_BAR_W = 14;
    /** 每格宽度（含间隙）的取值范围：窄视口取 STEP_MIN 保住可读性，宽卡片铺满到 STEP_MAX。
        STEP_MAX 取得足够大（120），卡片宽度内 7 天这类少桶区间才能真正铺满，而不是缩成左侧一块。 */
    const STEP_MIN = 26;
    const STEP_MAX = 120;
    const BAR_MIN = 8;
    const BAR_MAX = 64;
    /** 量不到容器宽度时的兜底画布宽（测试与首帧走这一支）。 */
    const FALLBACK_CHART_W = 820;
    /* 顶边留白要容得下最高柱的数值标签（10–11px 字）。16 时 3D 顶面与标签几乎相切，
       26 给足呼吸；2D / 3D 共用同一高度，柱子的数据高度完全不受影响。 */
    const TOP_H = 26;
    const AXIS_H = 18;
    const PAD_X = 6;
    /** 3D 等轴投影的「厚度」：固定值，不随柱高变化（FR-005：无透视、无近大远小）。 */
    const ISO_DEPTH = 7;

    /**
     * 每格宽度：按容器可用宽度铺开，夹在 STEP_MIN..STEP_MAX 之间。
     * 用 floor 而不是 round，保证 n 格一定放得下（富余的几个像素留给两侧 PAD_X）。
     */
    function chartStep(count, available) {
      const total = Math.max(1, Math.round(Number(count) || 0));
      const measured = Number(available);
      const usable = Number.isFinite(measured) && measured > 0 ? measured : FALLBACK_CHART_W;
      const fit = Math.floor((usable - PAD_X * 2) / total);
      return Math.min(STEP_MAX, Math.max(STEP_MIN, fit));
    }

    /** 柱宽：格宽的一半（留出呼吸缝），夹在 BAR_MIN..BAR_MAX。 */
    function barWidthOf(step) {
      return Math.min(BAR_MAX, Math.max(BAR_MIN, Math.round(Number(step) * 0.5)));
    }

    /** x 轴标签的跳格数：MM-DD 在 10px 等宽字体下约 30px 宽，比格宽还大就隔一个标一个。 */
    function tickStepOf(step) {
      return Math.max(1, Math.ceil(32 / Math.max(1, Number(step))));
    }

    /** 计算：整页屏的 layout 服务存在模块作用域里，好让关闭按钮、Esc 监听和 30 秒轮询
     *  拿到同一个入口，并据此判断「本屏是否还在前台」（组件本身拿不到 ctx，见 INTERFACE.md §3）。 */
    let usageLayout = null;

    /**
     * 天数夹取：数字或数字字符串 → 1..365 的整数；不是数返回 null。
     * 返回 null 是「别发请求」的信号（SC-007），不是 0。
     */
    function clampDays(value) {
      const num = typeof value === "number" ? value : Number(String(value ?? "").trim());
      if (!Number.isFinite(num)) return null;
      const rounded = Math.round(num);
      if (rounded < USAGE_DAYS_MIN) return USAGE_DAYS_MIN;
      if (rounded > USAGE_DAYS_MAX) return USAGE_DAYS_MAX;
      return rounded;
    }

    /** 输入框文本 → 天数。空串 / 字母 / 小数 / 负数都不是合法天数（调用方恢复旧值、不发请求）。 */
    function parseDaysInput(raw) {
      if (typeof raw === "number") return clampDays(raw);
      const text = String(raw ?? "").trim();
      if (!/^\d+$/.test(text)) return null;
      return clampDays(Number(text));
    }

    /* ---- 自定义日期区间（spec 007）：日键算术 / 本地校验 / 查询描述 ----
     * 全部是纯函数：不碰 DOM、不读时钟以外的全局状态（today 可注入），UI 与测试共用。
     * 日期只做 UTC 口径加减，避免本地时区夏令时把「闭区间天数」算成 23/25 小时。 */

    const USAGE_DAY_MS = 86400000;
    const USAGE_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

    /** 严格 YYYY-MM-DD → UTC 毫秒（只做日期算术）；格式错或不是真实日历日返回 null。 */
    function usageDayTime(key) {
      if (typeof key !== "string" || USAGE_DAY_PATTERN.test(key) !== true) return null;
      const year = Number(key.slice(0, 4));
      const month = Number(key.slice(5, 7));
      const day = Number(key.slice(8, 10));
      const time = Date.UTC(year, month - 1, day);
      const stamp = new Date(time);
      if (stamp.getUTCFullYear() !== year || stamp.getUTCMonth() !== month - 1 || stamp.getUTCDate() !== day) return null;
      return time;
    }

    /** UTC 毫秒 → YYYY-MM-DD 日键。 */
    function usageDayKeyOf(time) {
      const stamp = new Date(time);
      return stamp.getUTCFullYear() + "-" + String(stamp.getUTCMonth() + 1).padStart(2, "0") + "-" + String(stamp.getUTCDate()).padStart(2, "0");
    }

    /** 本机「今天」的日键：用户眼里的今天，按本机时区算（复用 formatDay 的口径）。 */
    function usageTodayKey() {
      return formatDay(Date.now());
    }

    /** 日键平移 n 天（负数是往前）；非法日键返回 null。 */
    function usageShiftDay(key, delta) {
      const time = usageDayTime(key);
      if (time === null) return null;
      const steps = Number(delta);
      return usageDayKeyOf(time + (Number.isFinite(steps) ? Math.round(steps) : 0) * USAGE_DAY_MS);
    }

    /** 闭区间天数：from/to 都合法且 from<=to 时给 1..N，否则 null。 */
    function usageRangeDays(from, to) {
      const start = usageDayTime(from);
      const end = usageDayTime(to);
      if (start === null || end === null || end < start) return null;
      return Math.round((end - start) / USAGE_DAY_MS) + 1;
    }

    /**
     * 本地即时校验（省一次注定 400 的请求，SC-004）。规则与宿主 1.1 完全同序：
     * 非空 → 格式 / 真实日历日 → from<=to → from<=今天 → 夹 to 到今天 → 闭区间跨度<=365。
     * 成功返回 { ok:true, from, to:夹紧后的真值, days }；失败返回 { ok:false, error:{code,maxDays} }。
     */
    function validateUsageRange(from, to, today) {
      const fromKey = typeof from === "string" ? from.trim() : "";
      const toKey = typeof to === "string" ? to.trim() : "";
      if (fromKey === "" || toKey === "") return { ok: false, error: { code: "usage-bad-range" } };
      const start = usageDayTime(fromKey);
      const end = usageDayTime(toKey);
      if (start === null || end === null) return { ok: false, error: { code: "usage-bad-range" } };
      const todayKey = typeof today === "string" && usageDayTime(today) !== null ? today : usageTodayKey();
      const todayTime = usageDayTime(todayKey);
      if (start > end) return { ok: false, error: { code: "usage-bad-range" } };
      if (start > todayTime) return { ok: false, error: { code: "usage-bad-range" } };
      // to 晚于今天时宿主会夹到今天（响应里的 range.to 是夹紧真值），本地也先夹再算跨度，
      // 否则「今天之前起、选了个未来止」会被本地误判成超上限而少发一次合法请求。
      const clampedTo = end > todayTime ? todayKey : toKey;
      const days = usageRangeDays(fromKey, clampedTo);
      if (days === null) return { ok: false, error: { code: "usage-bad-range" } };
      if (days > USAGE_DAYS_MAX) return { ok: false, error: { code: "usage-range-too-long", maxDays: USAGE_DAYS_MAX } };
      return { ok: true, from: fromKey, to: clampedTo, days: days };
    }

    /** 当前查询的描述（stale 判定与请求构造共用）：days 模式只认天数，custom 只认起止。 */
    function usageQueryOf(rangeMode, days, from, to) {
      if (rangeMode === "custom") return { mode: "custom", from: from, to: to };
      return { mode: "days", days: clampDays(days) };
    }

    /**
     * 快照是否仍在描述「当前查询」：不等就降级卡片（data-stale）。比较的字段按 INTERFACE §3.2：
     * (kind, days, from, to)。快照没给 range（老宿主）时按「无法判断」处理，不误报 stale。
     */
    function usageSnapshotMatchesQuery(snapshot, query) {
      const range = snapshot !== null && typeof snapshot === "object"
        && snapshot.range !== null && typeof snapshot.range === "object" ? snapshot.range : null;
      if (range === null || query === null || typeof query !== "object") return true;
      const kind = typeof range.kind === "string" ? range.kind : "";
      if (query.mode === "custom") return kind === "custom" && range.from === query.from && range.to === query.to;
      if (kind === "custom") return false;
      const snapshotDays = usageSnapshotDays(snapshot);
      if (snapshotDays === null) return true;
      return snapshotDays === query.days;
    }

    /**
     * 切到自定义时的预填：当前快照的 range.from/to；没有快照（或它不合法）用「今天-6 天」至今天。
     * 返回值已按今天夹紧，所以输入框里不会出现一个会被宿主改写的未来日期。
     */
    function usageDefaultCustomRange(snapshot) {
      const range = snapshot !== null && typeof snapshot === "object"
        && snapshot.range !== null && typeof snapshot.range === "object" ? snapshot.range : null;
      if (range !== null) {
        const checked = validateUsageRange(range.from, range.to);
        if (checked.ok === true) return { from: checked.from, to: checked.to };
      }
      const today = usageTodayKey();
      const from = usageShiftDay(today, -6);
      return { from: from !== null ? from : today, to: today };
    }

    /** 从持久化 store 恢复自定义查询：只认当前仍合法的区间（跨天后 365 天窗口可能过期）。 */
    function usageBootCustomRange(state) {
      if (state === null || state === undefined || state.rangeMode !== "custom") return null;
      const checked = validateUsageRange(state.from, state.to);
      if (checked.ok !== true) return null;
      return { from: checked.from, to: checked.to };
    }

    /** 行内错误 / 错误态共用的文案：只用本地模板，不回显宿主原文（C10）。 */
    function usageRangeErrorText(copy, error) {
      const code = error !== null && typeof error === "object" && typeof error.code === "string" ? error.code : "";
      if (code === "usage-range-too-long") {
        const maxDays = error !== null && typeof error === "object" ? Number(error.maxDays) : NaN;
        const limit = Number.isFinite(maxDays) && maxDays >= 1 ? Math.round(maxDays) : USAGE_DAYS_MAX;
        return copy.usageRangeTooLong.replace("{maxDays}", usageCount(limit));
      }
      return copy.usageRangeBad;
    }

    /* ---- 官方账号侧用量（spec 008）：查询描述 / 响应判定 / 差额文案 ----
     * 全部纯函数。官方接口与本机接口共用同一组查询参数，所以请求串只有一个构造函数，
     * 两条路由的「是不是同一次查询」也共用同一个 key —— 这样切区间后官方与本机不会错位。 */

    /** 查询的请求串（"?days=N" / "?from=…&to=…"）；非法查询返回 null（调用方零请求）。 */
    function usageQueryPath(target) {
      if (target !== null && typeof target === "object" && target.mode === "custom") {
        const checked = validateUsageRange(target.from, target.to);
        if (checked.ok !== true) return null;
        return "?from=" + checked.from + "&to=" + checked.to;
      }
      const asked = clampDays(target !== null && typeof target === "object" ? target.days : target);
      if (asked === null) return null;
      return "?days=" + asked;
    }

    /**
     * 查询的身份 key。官方响应的 ready 判定**只认这个 key**，不比对响应里的 range.from：
     * 官方会把它最早能取到的日期当 range.from（更早的区间被夹紧），拿它比对会把一次
     * 本来正确的响应误判成 stale（Lead 008 契约更正第 1 条）。
     */
    function officialQueryKeyOf(query) {
      if (query === null || typeof query !== "object") return null;
      if (query.mode === "custom") {
        const checked = validateUsageRange(query.from, query.to);
        return checked.ok === true ? "custom:" + checked.from + ":" + checked.to : null;
      }
      const asked = clampDays(query.days);
      return asked === null ? null : "days:" + String(asked);
    }

    /**
     * 官方 200 响应分类：ready / error。
     * 成功体的判据 = totals 是对象且 buckets 是数组；失败体是 200 + {error, code, hint}。
     * 形状不对也走 error（official-bad-response），**绝不当成 0 用量**。
     */
    function officialPayloadState(payload) {
      if (payload === null || typeof payload !== "object") {
        return { kind: "error", code: "official-bad-response", hint: "" };
      }
      if (typeof payload.error === "string" && payload.error !== "") {
        return {
          kind: "error",
          code: typeof payload.code === "string" ? payload.code : payload.error,
          hint: typeof payload.hint === "string" ? payload.hint : "",
        };
      }
      if (payload.totals === null || typeof payload.totals !== "object" || !Array.isArray(payload.buckets)) {
        return { kind: "error", code: "official-bad-response", hint: "" };
      }
      return { kind: "ready", code: "", hint: "" };
    }

    /** 「官方这段时间也没有用量」：totals 四项全 0 且每个桶的四项也全 0（缺失按 0 算）。 */
    function officialIsEmpty(payload) {
      if (payload === null || typeof payload !== "object") return false;
      const fields = ["tokens", "input", "cacheRead", "output"];
      const zero = function (row) {
        const obj = row !== null && typeof row === "object" ? row : {};
        return fields.every(function (field) {
          const num = Number(obj[field]);
          return Number.isFinite(num) !== true || num === 0;
        });
      };
      if (zero(payload.totals) !== true) return false;
      const buckets = Array.isArray(payload.buckets) ? payload.buckets : [];
      return buckets.every(zero);
    }

    /**
     * 差额文案（INTERFACE §3.2）：官方 − 本机；正数带 +、负数带 -、0 写 0。
     * 两个数都经 usageCount 同款取整（Math.round），保证与相邻两格的读数严格同源。
     */
    function officialGapText(official, local) {
      const a = Number(official);
      const b = Number(local);
      const diff = (Number.isFinite(a) ? Math.round(a) : 0) - (Number.isFinite(b) ? Math.round(b) : 0);
      if (diff > 0) return "+" + String(diff);
      return String(diff);
    }

    /**
     * 柱子高度比例（0..1）。2D 的矩形高度与 3D 的三个面**共用这一个函数**，
     * 「两种视图同一线性刻度」靠它保证（FR-005 / SC-006）。有值但不满一像素时抬到
     * 1/PLOT_H——否则「1 token 的桶」在图上等于 0，看着像没数据。
     */
    function barRatio(tokens, max) {
      const peak = Number(max);
      const value = Number(tokens);
      if (!Number.isFinite(peak) || peak <= 0) return 0;
      if (!Number.isFinite(value) || value <= 0) return 0;
      const ratio = Math.max(1, Math.round(value / peak * PLOT_H)) / PLOT_H;
      return Math.min(1, ratio);
    }

    /**
     * 3D 柱子的三个面（等轴投影、固定视角、无透视）。
     * 返回的 front 是正面矩形、cap 是顶面平行四边形、side 是左侧面平行四边形；
     * dx / dy 在一张图里对所有柱子恒定（不随高度变化），所以远近观感完全一致。
     * 正面高度 = ratio × plotH，与 2D 的 rect 高度同源 → 视图切换不改变读数。
     */
    function projectBar3D(ratio, layout) {
      const opts = layout ?? {};
      const width = Number(opts.w ?? DEFAULT_BAR_W);
      const plotH = Number(opts.plotH ?? PLOT_H);
      const depth = Number(opts.depth ?? ISO_DEPTH);
      const base = Number(opts.base ?? plotH);
      const x = Number(opts.x ?? 0);
      const safe = Number(ratio);
      const height = Math.max(0, Math.min(1, Number.isFinite(safe) ? safe : 0)) * plotH;
      const dx = -(width / 2);
      const dy = -depth;
      const top = base - height;
      return {
        x, base, top, height, w: width, dx, dy,
        front: `${x},${base} ${x + width},${base} ${x + width},${top} ${x},${top}`,
        cap: `${x},${top} ${x + dx},${top + dy} ${x + dx + width},${top + dy} ${x + width},${top}`,
        side: `${x},${base} ${x + dx},${base + dy} ${x + dx},${top + dy} ${x},${top}`,
      };
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
/* ---- 用量统计整页屏（spec 006）。宿主的 main 座位把整页区域交给我们，没有现成外框，
   所以这里自带排版容器：最宽 920px 居中、卡片化分区。375px 下按钮自然换行；
   图表自己不压缩——超宽时由 .tpq-usage-scroll 横向滚动（横向溢出只发生在这个盒子里）。
   注意：这段在 JS 模板字符串里，注释与规则里都不能出现反引号和美元大括号。 */
.tpq-usage{--tpq-font:"Geist Variable","Noto Sans SC Variable","Aptos","Segoe UI Variable Text","Segoe UI",
  "PingFang SC","Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif;
 --tpq-mono:"Geist Mono Variable","Cascadia Mono","Cascadia Code","SF Mono",Consolas,ui-monospace,SFMono-Regular,monospace;
 box-sizing:border-box;width:100%;max-width:920px;margin:0 auto;padding:24px 20px 32px;
 display:flex;flex-direction:column;gap:16px;min-width:0;
 font-family:var(--tpq-font);font-size:13px;line-height:1.6;
 color:var(--dsw-alias-label-primary,inherit);background:transparent}
.tpq-usage *{box-sizing:border-box}
.tpq-usage-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px 16px;flex-wrap:wrap}
.tpq-usage-heading{display:flex;flex-direction:column;gap:2px;min-width:0}
.tpq-usage-title{margin:0;font-size:20px;font-weight:600;letter-spacing:.01em;line-height:1.3}
.tpq-usage-range{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary,inherit);
 font-variant-numeric:lining-nums,tabular-nums;overflow-wrap:anywhere}
.tpq-usage-sync{color:var(--dsw-alias-brand-primary,#4176e6);white-space:nowrap}
.tpq-usage-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;margin-left:auto}
.tpq-usage-days{display:inline-flex;align-items:center;gap:4px;flex-wrap:wrap;min-width:0}
.tpq-usage-day{height:28px;padding:0 10px;border-radius:8px;flex:none;
 border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.24));background:transparent;
 color:var(--dsw-alias-label-secondary,inherit);font:inherit;font-size:12px;line-height:1;
 cursor:pointer;white-space:nowrap;
 transition:background .15s ease,border-color .15s ease,color .15s ease}
.tpq-usage-day:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}
.tpq-usage-day[data-active="1"]{border-color:var(--dsw-alias-brand-primary,#4176e6);
 color:var(--dsw-alias-brand-primary,#4176e6);background:transparent;font-weight:500}
.tpq-usage-day:focus-visible,.tpq-usage-mode:focus-visible,.tpq-usage-close:focus-visible,
.tpq-usage-days-input:focus-visible,.tpq-usage-retry:focus-visible,.tpq-usage-date:focus-visible,
.tpq-usage-apply:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4176e6);outline-offset:1px}
.tpq-usage-days-input{width:62px;height:28px;padding:0 8px;border-radius:8px;flex:none;
 border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.24));background:transparent;
 color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:12px;
 font-variant-numeric:lining-nums,tabular-nums}
/* 自定义日期区间（spec 007）：整行独立一条，跟在标题区下面；375px 下自然换行，
   两个日期框各自不压缩，错误句单独占一行（不与控件抢宽度）。 */
.tpq-usage-custom{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;
 padding:10px 12px;border-radius:10px;
 background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.08))}
.tpq-usage-custom-field{display:inline-flex;align-items:center;gap:6px;flex:none;min-width:0}
.tpq-usage-custom-label{font-size:11px;color:var(--dsw-alias-label-tertiary,inherit);white-space:nowrap}
.tpq-usage-date{height:28px;padding:0 8px;border-radius:8px;flex:none;
 border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.24));background:transparent;
 color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:12px;
 font-variant-numeric:lining-nums,tabular-nums;color-scheme:light dark}
.tpq-usage-apply{height:28px;padding:0 12px;border-radius:8px;flex:none;cursor:pointer;
 border:1px solid var(--dsw-alias-brand-primary,#4176e6);background:transparent;
 color:var(--dsw-alias-brand-primary,#4176e6);font:inherit;font-size:12px;line-height:1}
.tpq-usage-apply:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}
.tpq-usage-range-error{flex:1 1 100%;min-height:0;font-size:11px;line-height:1.5;
 color:var(--dsw-alias-label-error,#d64545)}
.tpq-usage-range-error:empty{display:none}
.tpq-usage-modes{display:inline-flex;flex:none;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.24));
 border-radius:8px;overflow:hidden}
.tpq-usage-mode{height:26px;padding:0 10px;border:none;background:transparent;cursor:pointer;
 color:var(--dsw-alias-label-secondary,inherit);font:inherit;font-size:12px;line-height:1;white-space:nowrap}
.tpq-usage-mode[data-active="1"]{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.16));
 color:var(--dsw-alias-brand-primary,#4176e6);font-weight:500}
.tpq-usage-close{flex:none;width:28px;height:28px;padding:0;display:inline-flex;align-items:center;
 justify-content:center;border:none;border-radius:8px;background:transparent;cursor:pointer;
 color:var(--dsw-alias-label-tertiary,inherit);font:inherit;font-size:16px;line-height:1;
 transition:background .15s ease,color .15s ease}
.tpq-usage-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16));
 color:var(--dsw-alias-label-primary,inherit)}
.tpq-usage-progress{display:flex;align-items:center;gap:10px;min-width:0}
.tpq-usage-progress-track{position:relative;flex:1 1 auto;min-width:80px;height:3px;border-radius:999px;
 background:var(--dsw-alias-border-l2,rgba(128,128,128,.24));overflow:hidden}
.tpq-usage-progress-bar{position:absolute;inset:0;background:var(--dsw-alias-brand-primary,#4176e6);
 transform-origin:0 0;transition:transform .4s cubic-bezier(.16,1,.3,1)}
.tpq-usage-progress-text{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary,inherit);white-space:nowrap}
.tpq-usage-card{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.22));border-radius:12px;
 padding:14px 16px;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.06));min-width:0;
 transition:opacity .15s ease}
/* 切天后新快照还没回来：标题/图表仍在描述旧区间，用轻微降级提示「这不是你刚选的那段」。 */
.tpq-usage-card[data-stale="1"]{opacity:.55}
.tpq-usage-total-main{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.tpq-usage-big{font-size:30px;font-weight:600;letter-spacing:-.01em;line-height:1.15;
 font-variant-numeric:lining-nums,tabular-nums}
.tpq-usage-unit{font-size:12px;color:var(--dsw-alias-label-tertiary,inherit)}
.tpq-usage-badge{font-size:10px;line-height:16px;padding:0 8px;border-radius:999px;white-space:nowrap;
 border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));color:var(--dsw-alias-label-secondary,inherit)}
.tpq-usage-scale{font-size:11px;color:var(--dsw-alias-label-tertiary,inherit)}
.tpq-usage-splits{display:grid;grid-template-columns:repeat(auto-fit,minmax(118px,1fr));gap:8px;margin-top:10px}
.tpq-usage-split{display:flex;flex-direction:column;gap:1px;padding:7px 10px;border-radius:8px;min-width:0;
 background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.10))}
.tpq-usage-split-label{font-size:11px;color:var(--dsw-alias-label-tertiary,inherit);white-space:nowrap}
.tpq-usage-split-value{font-size:13px;font-weight:500;font-variant-numeric:lining-nums,tabular-nums}
.tpq-usage-chart-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px 12px;
 flex-wrap:wrap;margin-bottom:6px}
.tpq-usage-chart-label{font-size:12px;font-weight:500}
.tpq-usage-weekly{font-size:11px;color:var(--dsw-alias-label-tertiary,inherit)}
.tpq-usage-scroll{overflow-x:auto;overflow-y:hidden;max-width:100%;padding-bottom:2px;
 overscroll-behavior-x:contain;-webkit-overflow-scrolling:touch}
.tpq-usage-svg{display:block;max-width:none;height:auto;margin:0 auto}
.tpq-usage-axis{stroke:var(--dsw-alias-border-l2,rgba(128,128,128,.3));stroke-width:1}
.tpq-usage-tick{fill:var(--dsw-alias-label-tertiary,#8a8a8a);font-size:10px;font-family:var(--tpq-mono)}
.tpq-usage-value{fill:var(--dsw-alias-label-primary,inherit);font-size:10px;font-weight:500;
 font-family:var(--tpq-font);font-variant-numeric:lining-nums,tabular-nums}
/* 2D 与 3D 三个面共用同一个主色变量，只靠两个明度台阶区分——不引入任何配色库，
   也不让两种视图各有一套颜色（切换视图时颜色跟着变会被误读成两组数据）。 */
.tpq-usage-chart{--tpq-usage-bar:var(--dsw-alias-brand-primary,#4176e6);
 --tpq-usage-top:color-mix(in srgb,var(--tpq-usage-bar) 78%,white);
 --tpq-usage-side:color-mix(in srgb,var(--tpq-usage-bar) 78%,black)}
.tpq-usage-rect{fill:var(--tpq-usage-bar);transition:opacity .15s ease}
.tpq-usage-face-front{fill:var(--tpq-usage-bar)}
.tpq-usage-face-cap{fill:var(--tpq-usage-top)}
.tpq-usage-face-side{fill:var(--tpq-usage-side)}
.tpq-usage-bar2d:hover .tpq-usage-rect{opacity:.82}
.tpq-usage-models{display:flex;flex-direction:column}
.tpq-usage-model{display:flex;align-items:baseline;justify-content:space-between;gap:6px 14px;flex-wrap:wrap;
 padding:7px 0;border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.14))}
.tpq-usage-model:first-child{border-top:none}
.tpq-usage-model-id{flex:1 1 180px;min-width:0;font-family:var(--tpq-mono);font-size:12px;
 white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tpq-usage-model-tokens{flex:none;font-size:13px;font-weight:500;font-variant-numeric:lining-nums,tabular-nums}
.tpq-usage-model-splits{flex:1 1 100%;font-size:11px;color:var(--dsw-alias-label-tertiary,inherit);
 font-variant-numeric:lining-nums,tabular-nums;overflow-wrap:anywhere}
.tpq-usage-notes{display:flex;flex-direction:column;gap:2px;font-size:11px;line-height:1.65;
 color:var(--dsw-alias-label-tertiary,inherit)}
.tpq-usage-notes p{margin:0;overflow-wrap:anywhere}
.tpq-usage-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;
 padding-top:10px;border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.16));font-size:11px}
.tpq-usage-updated{color:var(--dsw-alias-label-tertiary,inherit);font-variant-numeric:lining-nums,tabular-nums}
.tpq-usage-retry{height:26px;padding:0 12px;border-radius:8px;cursor:pointer;
 border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.24));background:transparent;
 color:var(--dsw-alias-label-secondary,inherit);font:inherit;font-size:12px}
.tpq-usage-retry:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}
.tpq-usage-state{display:flex;flex-direction:column;align-items:flex-start;gap:6px;min-width:0;
 padding:22px 18px;border:1px dashed var(--dsw-alias-border-l2,rgba(128,128,128,.3));border-radius:12px}
.tpq-usage-state-title{font-size:14px;font-weight:600}
.tpq-usage-state-text{font-size:12px;color:var(--dsw-alias-label-secondary,inherit);overflow-wrap:anywhere}
.tpq-usage-state-hint{font-size:11px;padding:4px 8px;border-radius:6px;font-family:var(--tpq-mono);
 color:var(--dsw-alias-label-tertiary,inherit);background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.12));
 overflow-wrap:anywhere;max-width:100%}
.tpq-usage-skeleton{display:flex;flex-direction:column;gap:10px;padding:18px;border-radius:12px;
 border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18))}
.tpq-usage-skel{height:12px;border-radius:6px;background-size:200% 100%;
 background-image:linear-gradient(90deg,rgba(128,128,128,.14),rgba(128,128,128,.26),rgba(128,128,128,.14));
 animation:tpq-skel 1.4s ease-in-out infinite}
.tpq-usage-skel[data-w="wide"]{width:100%}
.tpq-usage-skel[data-w="mid"]{width:66%}
.tpq-usage-skel[data-w="narrow"]{width:38%}
@keyframes tpq-skel{0%,100%{opacity:.65}50%{opacity:1}}
/* 侧栏 panellist 的小图标：16px 三根柱子，跟随 currentColor，深浅两套主题都读得清。 */
.tpq-panellist-icon{display:inline-flex;align-items:flex-end;gap:2px;height:16px;color:currentColor}
.tpq-panellist-icon>i{display:block;width:3px;border-radius:1px;background:currentColor;opacity:.85}
/* 徽标面板底部的「用量统计」入口：打开整页屏。和 .tpq-updated 同一条底栏节奏，
   主色文字 + 下划线悬停，不用第二个实心按钮（面板里不需要两个同等权重的动作）。 */
.tpq-usage-entry{display:block;width:100%;margin-top:6px;padding:6px 18px 2px 0;background:transparent;
 border:0;text-align:left;font:inherit;font-size:12px;line-height:1.5;cursor:pointer;
 color:var(--dsw-alias-brand-primary,#4176e6)}
.tpq-usage-entry:hover{text-decoration:underline}
.tpq-usage-entry:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4176e6);outline-offset:2px}
/* 008 官方账号侧对照条：独立 section，**刻意不共用 .tpq-usage-card**。
   既有用例按 tpq-usage-card 恰好 3 张来钉「切天 stale / 错误态清场」，共用类会让那些
   计数与 data-stale 数组多出一项；外观靠同一套变量与同一档字号节奏对齐，不复制魔法数。 */
.tpq-usage-official{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.22));border-radius:12px;
 padding:14px 16px;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.06));min-width:0;
 display:flex;flex-direction:column;gap:8px;transition:opacity .15s ease}
.tpq-usage-official[data-stale="1"]{opacity:.55}
.tpq-usage-official-title{margin:0;font-size:12px;font-weight:500;
 color:var(--dsw-alias-label-secondary,inherit)}
.tpq-usage-official-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:8px}
.tpq-usage-official-cell{display:flex;flex-direction:column;gap:1px;padding:7px 10px;border-radius:8px;min-width:0;
 background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.10))}
.tpq-usage-official-label{font-size:11px;color:var(--dsw-alias-label-tertiary,inherit);
 white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tpq-usage-official-value{font-size:18px;font-weight:600;font-variant-numeric:lining-nums,tabular-nums;
 overflow-wrap:anywhere}
.tpq-usage-official-unit{font-size:11px;color:var(--dsw-alias-label-tertiary,inherit)}
.tpq-usage-official-split,.tpq-usage-official-note,.tpq-usage-official-clamped,
.tpq-usage-official-loading,.tpq-usage-official-empty,.tpq-usage-official-error{margin:0;
 font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary,inherit);overflow-wrap:anywhere}
.tpq-usage-official-error{color:var(--dsw-alias-label-secondary,inherit)}
.tpq-usage-official-retry{align-self:flex-start;height:26px;padding:0 12px;border-radius:8px;cursor:pointer;
 border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.24));background:transparent;
 color:var(--dsw-alias-label-secondary,inherit);font:inherit;font-size:12px}
.tpq-usage-official-retry:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}
@media (max-width:520px){
 .tpq-usage{padding:16px 14px 24px;gap:14px}
 /* 三格在窄屏折成两行：官方/本机并排，差额单独一行（差额字更长，挤半行会被截断）。 */
 .tpq-usage-official-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
 .tpq-usage-official-gap{grid-column:1/-1}
 .tpq-usage-title{font-size:18px}
 .tpq-usage-big{font-size:26px}
 .tpq-usage-actions{width:100%;margin-left:0}
 .tpq-usage-splits{grid-template-columns:repeat(2,minmax(0,1fr))}
 /* 5 个拆分格在 2 列里最后会孤一个：让它整行铺开，别留一个尴尬的洞。 */
 .tpq-usage-splits .tpq-usage-split:last-child{grid-column:1/-1}
}
@media (prefers-reduced-motion:reduce){
 .tpq-usage-progress-bar,.tpq-usage-skel{animation:none;transition:none}
}
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
          // 条只有一份算法：徽标、明细主卡、次级窗口行走同一个 remainingPercentOf
          // （它同时认 remainingPercent 与上游直给的 usedPercent）。
          const pct = allowBar ? remainingPercentOf(meter) : null;
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

    function Badge({ copy, watchActive, onOpenUsage }) {
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
      const boundPanel = scoped ? allPanel.filter(card => bindsCurrent(card, provider)) : allPanel;
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
      // "模型未知"而不是"插件坏了"。按已定口径统一成降级：当前路由没有归属卡时只挑**一张有数的**
      // （pickOne，见下），面板则退回全量（scoped 要求 provider 非空），等目录发布后
      // 再由观察订阅切回跟随。
      // 老外壳（拿不到模型）才用全量官方卡 —— 那时连"谁是当前供应商"都没有，无从收敛。

      // 拿不到模型（老外壳）时的选择：官方卡全量（最多三枚）。
      const fullChips = () => official.filter(card => hasNumbers(card) || card.error).slice(0, 3);
      let chips;
      if (watchActive) {
        // 单徽标跟随：只挂当前模型供应商绑定的卡。有数字的官方卡 > 有数字的实测卡
        // > 报错的官方卡（提示去配 Cookie）> 其它实测卡。
        const bound = [...official, ...measured].filter(card => bindsCurrent(card, provider));
        const primary = bound.find(card => card.veracity === "verified" && hasNumbers(card))
          ?? bound.find(card => card.estimated === true && hasNumbers(card))
          ?? bound.find(card => card.veracity === "verified")
          ?? bound.find(card => card.estimated === true)
          ?? null;
        // 匹配不到当前路由时**只挑一张**，而不是并排全量。
        // 历史：早先这种情形会把徽标整个藏成 0×0（"插件又坏了"），改成全量显示修掉了那个问题；
        // 但路由解析不出来时（中转/自定义路由，目录不认它），全量会**并排冒出多枚胶囊**
        // （实机：`Token Plan 93%` + `DeepSeek ¥33.80`，用户口径"只需要显示一个"）。
        // 于是只出一张 —— 但"挑哪张"踩过一次坑：初版用模型名当线索，结果
        // `deepseek-v4.1-flash`（模型家族）把绑 `deepseek` 的余额卡挑了出来，用户看到的是
        // "只剩余额钱数、条状额度不见了"。现在的顺序：① 吞吐行里最近在服务请求的路由；
        // ② 额度/窗口语义的卡；③ 官方卡顺序兜底。
        const pickOne = () => {
          // 候选池与 primary 那一路一致：**官方 + 实测**（实测卡也是本实例的真读数，
          // 只是没有官方分母；在降级路径上把它排除掉，等于把唯一有数的卡扔掉）。
          // 档间先后从上往下，取第一个非空的档：
          //   ① 正在服务请求的那条路由上、有真数字的官方额度卡
          //   ② 同一条路由上、有真数字的官方卡
          //   ③ 同一条路由上、有真数字的实测卡
          //   ④ 任意路由上有真数字的官方额度卡
          //   ⑤ 任意路由上有真数字的官方卡
          //   ⑥ 任意有真数字的卡
          //   ⑦ 只报错的官方卡 —— 没数字时也要把"去配 Cookie"留在脸上，但绝不能挤掉有数的卡
          //   ⑧ 额度/窗口语义的卡（有 meters 的，但没数字）
          //   ⑨ 其余官方卡兜底
          // 两条各自实机踩出来的教训都在这里收口：
          //  · 老写法把"有数字"与"报错"混成一档、并且只看官方卡：路由解析不出来时，报错的控制台卡
          //    按数组顺序先命中 —— 实机症状是徽标只剩「无官方额度数据」，而实测窗口有 3400 万 tokens。
          //  · 候选里不分额度卡与余额卡：绑 deepseek 的余额卡抢了额度卡的位置，实机症状是
          //    "只剩余额的钱数、条状额度不见了"。所以额度卡（有 meters，或 credits 计量）先于余额卡。
          const routeRows = Array.isArray(throughput?.byProvider) ? throughput.byProvider : [];
          const active = routeRows.find(entry => (entry.calls60 ?? entry.calls300 ?? 0) > 0);
          const onActiveRoute = (card) => active !== undefined && bindsCurrent(card, active.provider);
          const isQuotaish = (card) => (Array.isArray(card.meters) && card.meters.length > 0)
            || (card.metric === "credits" && hasNumbers(card));
          const pool = [...official, ...measured];
          const numbered = pool.filter(card => hasNumbers(card));
          const verified = numbered.filter(card => card.veracity === "verified");
          const estimated = numbered.filter(card => card.estimated === true);
          const buckets = [
            verified.filter(card => onActiveRoute(card) && isQuotaish(card)),
            verified.filter(card => onActiveRoute(card)),
            estimated.filter(card => onActiveRoute(card)),
            verified.filter(card => isQuotaish(card)),
            verified,
            numbered,
            // 没数字的窗口卡不能排在报错卡之前：那一档只能显示「无官方额度数据」，而报错卡
            // 带着「去配 Cookie」——降级路径上有数的卡早就被上面几档收走了，留在这里的
            // 必然是没数的，所以可行动的那张优先（第四轮审查第 2 条）。
            official.filter(card => card.error),
            pool.filter(card => Array.isArray(card.meters) && card.meters.length > 0),
            official,
          ];
          for (const bucket of buckets) {
            if (bucket.length > 0) return [bucket[0]];
          }
          return [];
        };
        chips = primary === null ? pickOne() : [primary];
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
            ? rows.find(entry => bindOf(card).some(route => sameProvider(route, entry.provider))) ?? null
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
            // 整页屏入口：只在宿主确实注册了 main 座位、且用量统计没被配置关掉时出现。
            // 点它是「从徽标小窗升级到整页看」，所以先把小窗收起来，避免两层叠着。
            typeof onOpenUsage === "function" && snapshot?.config?.usageStats !== false
              ? React.createElement("button", {
                type: "button",
                className: "tpq-usage-entry",
                onClick: () => {
                  setOpen(false);
                  onOpenUsage();
                },
              }, copy.usageEntry)
              : null,
          // 缩放手柄挂外层（不随内容滚动），锚定/悬浮两态常驻——锚定态直接拖角
          // 会先自动 detach 成悬浮再缩放。
          React.createElement("div", { className: "tpq-resize", title: copy.resizeTip, onPointerDown: beginResize }));
        children.push(canPortal ? createPortal(panelEl, document.body) : panelEl);
      }
      return React.createElement("span", { ref: root, className: "tpq" }, children);
    }

    /* ------------------------------------------------------------ 用量统计屏（spec 006） */

    /**
     * 整页屏的 layout 服务与 store 存在模块作用域：main 座位只把组件注册进槽位，
     * 组件拿不到 ctx（注册参数里 inject 返回空对象），关闭按钮与 Esc 只能走这两个入口。
     * 两个变量都只由 apply 写一次，之后只读。
     * 注意：dsh-client-ui-renderer 的 keyed 分支只渲染 entryKey 匹配项，切走即卸载组件
     * （不是保活）；将来若改成保活渲染，需要订阅 panelInfo 在转前台时补拉一次。
     */
    function openUsagePanel() {
      if (usageLayout !== null && typeof usageLayout.selectPanel === "function") usageLayout.selectPanel(PANEL_ID);
    }

    /** 关掉整页屏：宿主约定 selectPanel(null) 回到会话主视图。 */
    function closeUsagePanel() {
      if (usageLayout !== null && typeof usageLayout.selectPanel === "function") usageLayout.selectPanel(null);
    }

    /**
     * 本屏现在是不是宿主的前台整页屏（layout 的 activePanelId === PANEL_ID）。
     * Esc 与 30 秒轮询都要先问这一句：宿主当前按 keyed 卸载组件（切走即卸载），但若将来
     * 改成保活渲染，监听器不查 active 状态就会在别的页面按 Esc 把用量屏「关掉」——而他根本
     * 没看见这一屏。这里现在就是防串页的那道闸，不随实现变化而删除。
     * panelInfo 拿不到时（老宿主只给了 selectPanel）返回 true，退化成旧行为：
     * 只可能多关一次已经不在前台的页，不会关错别的页。
     */
    function usagePanelActive() {
      if (usageLayout === null) return false;
      const info = usageLayout.panelInfo;
      if (info === null || info === undefined || typeof info.getSnapshot !== "function") return true;
      const snapshot = info.getSnapshot();
      return snapshot !== null && snapshot !== undefined && snapshot.activePanelId === PANEL_ID;
    }

    /** 侧栏 panellist 的小图标：三根柱子，颜色跟 currentColor，深浅主题都不用另配。 */
    function UsagePanelIcon(props) {
      const active = props !== undefined && props !== null && props.active === true;
      return React.createElement("span",
        { className: "tpq-panellist-icon", "aria-hidden": "true", "data-active": active ? "1" : "0" },
        React.createElement("i", { style: { height: "8px" } }),
        React.createElement("i", { style: { height: "13px" } }),
        React.createElement("i", { style: { height: "10px" } }));
    }

    /** 一个小数字格式：调用次数、天数这类整数值，别把 0 显示成破折号。 */
    function usageCount(value) {
      const num = Number(value);
      if (!Number.isFinite(num)) return "0";
      return String(Math.round(num));
    }

    /** 快照自己声明的天数（range.days）；拿不到返回 null。 */
    function usageSnapshotDays(snapshot) {
      const range = snapshot !== null && typeof snapshot === "object" && snapshot.range ? snapshot.range : null;
      const days = range !== null ? Number(range.days) : NaN;
      return Number.isFinite(days) && days >= 1 ? Math.round(days) : null;
    }

    /**
     * 区间副标题：今日只说日期，多天说「近 N 天 · from 至 to」。
     * **{n} 必须与 {from}/{to} 同源**（都取自 snapshot.range）：切天后新响应回来之前，
     * 本地 days 已经是新值而快照还是旧的，用本地 days 会拼出「近 30 天 · 11-06 至 11-12」
     * 配 7 根柱（C1）。参数 days 只在快照没给 range.days 时兜底。
     */
    function usageRangeText(copy, snapshot, days) {
      const range = snapshot !== null && typeof snapshot === "object" && snapshot.range ? snapshot.range : {};
      const from = typeof range.from === "string" ? range.from : "";
      const to = typeof range.to === "string" ? range.to : "";
      const snapshotDays = usageSnapshotDays(snapshot);
      const n = snapshotDays !== null ? snapshotDays : days;
      // 自定义区间（007）：单日与多天分开说，全部字段取自 snapshot.range（标题与数据同源）。
      if (range.kind === "custom") {
        if (from !== "" && from === to) return copy.usageRangeDayOne.replace("{from}", from);
        return copy.usageRangeCustomTitle.replace("{from}", from).replace("{to}", to).replace("{n}", usageCount(n));
      }
      if (n <= 1) return copy.usageRangeToday.replace("{from}", from !== "" ? from : to);
      return copy.usageRange.replace("{n}", usageCount(n)).replace("{from}", from).replace("{to}", to);
    }

    /**
     * 数据源脚注的来源句：**按 source.kind 本地化**，不照抄宿主的 source.label——
     * 宿主的 label 是写死中文（lib/index.js 的 session-index / in-process 两句），
     * 原样塞进英文 COPY 会出现半句中文（lead 第 9 条实测：英文截图里
     * "Source: 本实例实测（来自本地会话记录）, not an official balance."）。
     * session-index → 本地 COPY 的「本实例实测（来自本地会话记录）」；
     * in-process   → 本地 COPY 的「本进程启动以来（实测）」；
     * disabled     → 返回空串，由调用方跳过（关闭态改由 disabled 说明表达）；
     * 其他/未知 kind → 才回落到宿主 label（它是 API 真值兜底文案）；
     * 都没给 → 整句 usageNoteSourceFallback。
     */
    function usageSourceNote(copy, snapshot) {
      const source = snapshot !== null && snapshot !== undefined
        && snapshot.source !== null && typeof snapshot.source === "object" ? snapshot.source : null;
      const kind = source !== null && typeof source.kind === "string" ? source.kind : "";
      if (kind === "disabled") return "";
      let label = "";
      if (kind === "session-index") label = copy.usageSourceSessionIndex;
      else if (kind === "in-process") label = copy.usageSourceLive;
      else if (source !== null && typeof source.label === "string") label = source.label.trim();
      if (label === "") return copy.usageNoteSourceFallback;
      return copy.usageNoteSource.replace("{label}", label);
    }

    /** 一个桶的 tooltip：tokens 总数 + 四类拆分 + 调用数 + 日期范围（2D / 3D 用同一份）。
     * 首行只放完整日期：bucket.label 本身就是 from 的短写（「11-12」），再拼上 from
     * 会变成「11-12 2026-11-12」（周桶更啰嗦），C3 实测就是这么重复的。 */
    function usageBucketTitle(bucket, copy) {
      const totals = bucket !== null && typeof bucket === "object" && bucket.totals ? bucket.totals : {};
      const from = typeof bucket.from === "string" ? bucket.from : "";
      const to = typeof bucket.to === "string" ? bucket.to : "";
      const span = from === to || to === "" ? from : from + " – " + to;
      return [
        span,
        copy.usageSplitTotal + " " + formatTokens(totals.tokens),
        copy.usageSplitInput + " " + formatTokens(totals.input),
        copy.usageSplitOutput + " " + formatTokens(totals.output),
        copy.usageSplitCacheRead + " " + formatTokens(totals.cacheRead),
        copy.usageSplitCacheWrite + " " + formatTokens(totals.cacheWrite),
        copy.usageCalls + " " + formatTokens(totals.calls),
      ].join(" · ");
    }

    /**
     * 图表本体。2D 与 3D 走同一个 barRatio()，柱子的「数据高度」完全一致；
     * 3D 只是把同一根柱子按固定的等轴偏移补两个面（没有透视、没有近大远小）。
     * 几何宽度只取决于桶数，窄视口由 .tpq-usage-scroll 自己横向滚动。
     */
    function UsageChart(props) {
      const data = props.data;
      const copy = props.copy;
      const mode = props.mode === "3d" ? "3d" : "2d";
      const buckets = data !== null && data !== undefined && Array.isArray(data.buckets) ? data.buckets : [];
      /* 图表宽度跟着容器走：宽卡片上 7 根柱铺开成一张真正的图表（不是缩在左上角一小块），
         窄视口上按 STEP_MIN 保住可读性、由 .tpq-usage-scroll 自己横向滚动。
         ResizeObserver 不存在时（测试 / 首帧）走 FALLBACK_CHART_W，渲染结果照样可断言。 */
      /* 首选量容器（ResizeObserver）；量不到时用视口宽度估一个保守值，保证首帧就铺开、
         又不会在 375px 上撑出横向滚动。两者都拿不到才回落到 FALLBACK_CHART_W。 */
      const viewportWidth = typeof window !== "undefined" && window !== null ? Number(window.innerWidth) : 0;
      const seedWidth = Number.isFinite(viewportWidth) && viewportWidth > 0
        // 减掉两侧真实留白（.tpq-usage 14×2 + .tpq-usage-card 16×2）：375px 上量到 ≈315，
        // 首帧就贴近容器，不至于先画窄再被 ResizeObserver 拉宽。
        ? Math.min(FALLBACK_CHART_W, Math.max(240, viewportWidth - 60))
        : FALLBACK_CHART_W;
      const scrollRef = React.useRef(null);
      const [boxWidth, setBoxWidth] = React.useState(seedWidth);
      React.useEffect(() => {
        const element = scrollRef.current;
        if (!element || typeof ResizeObserver === "undefined") return undefined;
        const observer = new ResizeObserver((entries) => {
          const entry = entries[0];
          const measured = entry && entry.contentRect ? Number(entry.contentRect.width) : 0;
          if (Number.isFinite(measured) && measured > 0) {
            setBoxWidth((previous) => (Math.abs(previous - measured) > 0.5 ? measured : previous));
          }
        });
        observer.observe(element);
        return () => observer.disconnect();
      }, []);
      if (buckets.length === 0) return null;
      const threeD = mode === "3d";
      const weekly = data.granularity === "week";
      let peak = 0;
      /* -1 = 还没有「最高的桶」。全零区间（peak 仍是 0）不许给第一根柱标 0 并当最高柱，
         否则一根空柱会冒充区间最高值（口径纪律：没有值就不显示值）。 */
      let tallest = -1;
      for (let index = 0; index < buckets.length; index += 1) {
        const value = Number(buckets[index] !== null && buckets[index] !== undefined && buckets[index].totals ? buckets[index].totals.tokens : 0);
        if (Number.isFinite(value) && value > peak) {
          peak = value;
          tallest = index;
        }
      }
      const step = chartStep(buckets.length, boxWidth);
      const barWidth = barWidthOf(step);
      const width = PAD_X * 2 + buckets.length * step;
      const height = TOP_H + PLOT_H + AXIS_H;
      const base = TOP_H + PLOT_H;
      /* 标签跳格：既让 10px 的 MM-DD 不互相压住，也避免 90 天变成一墙密字。 */
      const labelStep = Math.max(tickStepOf(step), Math.max(1, Math.ceil(buckets.length / 14)));
      const children = [
        React.createElement("line", {
          key: "axis",
          className: "tpq-usage-axis",
          x1: PAD_X - 2,
          y1: base,
          x2: width - PAD_X + 2,
          y2: base,
        }),
      ];
      for (let index = 0; index < buckets.length; index += 1) {
        const bucket = buckets[index] !== null && buckets[index] !== undefined ? buckets[index] : {};
        const tokens = Number(bucket.totals ? bucket.totals.tokens : 0);
        const ratio = barRatio(tokens, peak);
        const x = PAD_X + index * step + (step - barWidth) / 2;
        const title = React.createElement("title", null, usageBucketTitle(bucket, copy));
        if (threeD) {
          const bar = projectBar3D(ratio, { x: x, base: base, w: barWidth, plotH: PLOT_H, depth: ISO_DEPTH });
          children.push(React.createElement("g", { key: "bar-" + index, className: "tpq-usage-bar3d" }, title,
            React.createElement("polygon", { className: "tpq-usage-face-side", points: bar.side }),
            React.createElement("polygon", { className: "tpq-usage-face-front", points: bar.front }),
            React.createElement("polygon", { className: "tpq-usage-face-cap", points: bar.cap })));
        } else {
          children.push(React.createElement("g", { key: "bar-" + index, className: "tpq-usage-bar2d" }, title,
            React.createElement("rect", {
              className: "tpq-usage-rect",
              x: x,
              y: base - ratio * PLOT_H,
              width: barWidth,
              height: ratio * PLOT_H,
              rx: 2,
            })));
        }
        if (index === tallest && peak > 0) {
          /* 3D 顶面比正面高一个 ISO_DEPTH，标签基线再抬 2px，避免与顶边相切。 */
          const lift = threeD ? ISO_DEPTH + 2 : 0;
          children.push(React.createElement("text", {
            key: "value-" + index,
            className: "tpq-usage-value",
            x: x + barWidth / 2,
            y: Math.max(9, base - ratio * PLOT_H - lift - 4),
            textAnchor: "middle",
          }, formatTokens(tokens)));
        }
        if (index % labelStep === 0) {
          children.push(React.createElement("text", {
            key: "tick-" + index,
            className: "tpq-usage-tick",
            x: x + barWidth / 2,
            y: height - 4,
            textAnchor: "middle",
          }, typeof bucket.label === "string" ? bucket.label : ""));
        }
      }
      const chartTitle = weekly ? copy.usageChartWeekTitle : copy.usageChartTitle;
      return React.createElement("div", { className: "tpq-usage-scroll", ref: scrollRef },
        React.createElement("svg", {
          className: "tpq-usage-chart tpq-usage-svg",
          viewBox: "0 0 " + width + " " + height,
          width: width,
          height: height,
          role: "img",
          "aria-label": chartTitle,
        }, children));
    }

    /** 拆分小格（input / output / cacheRead / cacheWrite / calls 共用）。 */
    function usageSplitCell(label, value) {
      return React.createElement("div", { className: "tpq-usage-split" },
        React.createElement("span", { className: "tpq-usage-split-label" }, label),
        React.createElement("span", { className: "tpq-usage-split-value" }, formatTokens(value)));
    }

    /** 空态/错误态/关闭态共用的说明块：标题 + 人话 + 可选的配置提示。 */
    function usageStateBlock(title, text, hint) {
      const children = [
        React.createElement("div", { key: "title", className: "tpq-usage-state-title" }, title),
        React.createElement("div", { key: "text", className: "tpq-usage-state-text" }, text),
      ];
      if (typeof hint === "string" && hint !== "") {
        children.push(React.createElement("div", { key: "hint", className: "tpq-usage-state-hint" }, hint));
      }
      return React.createElement("div", { className: "tpq-usage-state" }, children);
    }

    /**
     * 空态文案按 emptyReason 分档。宿主的 hint 是中文，只有中文界面才拿来当补充提示，
     * 英文界面一律用 COPY 里的英文（否则英文页面会混进一行中文）。
     */
    function usageEmptyCopy(copy, snapshot) {
      const reason = snapshot !== null && snapshot !== undefined ? snapshot.emptyReason : undefined;
      let title = copy.usageEmptyNoUsage;
      let hint = copy.usageEmptyNoUsageHint;
      if (reason === "usage-stats-disabled") {
        title = copy.usageEmptyDisabled;
        hint = copy.usageEmptyDisabledHint;
      } else if (reason === "no-session-persistence") {
        title = copy.usageEmptyNoPersistence;
        hint = copy.usageEmptyNoPersistenceHint;
      } else if (reason === "no-sessions") {
        /* 引导方向完全不同：这里该做的是「去建会话」，不是「去调模型再来」。
           宿主 hint 也是中文，英文界面必须走本地 COPY（C8）。 */
        title = copy.usageEmptyNoSessions;
        hint = copy.usageEmptyNoSessionsHint;
      }
      if (uiEnglish !== true && snapshot !== null && snapshot !== undefined && typeof snapshot.hint === "string" && snapshot.hint !== "") {
        hint = snapshot.hint;
      }
      return { title: title, hint: hint };
    }

    /**
     * 错误态文案：**只有已知错误码**才换成更具体的本地说明（目前只有关闭态值得区分），
     * 其余一律 usageError 通用句。宿主原文（可能是内部 error.message / HTTP 细节）不上屏（C10）。
     */
    function usageErrorCopy(copy, error) {
      const code = error !== null && typeof error === "object" && typeof error.code === "string" ? error.code : "";
      if (code === "usage-stats-disabled") return { title: copy.usageEmptyDisabled, text: copy.usageEmptyDisabledHint };
      // 007：宿主的两个 400 都有本地文案（带重试按钮，重试仍打同一条查询）。
      if (code === "usage-bad-range" || code === "usage-range-too-long") return { title: usageRangeErrorText(copy, error), text: "" };
      return { title: copy.usageError, text: "" };
    }

    /** 模型行：id + tokens + 四类拆分（没有百分比，也没有 Credits）。 */
    function usageModelRow(model, copy) {
      const totals = model.totals !== null && model.totals !== undefined ? model.totals : {};
      return React.createElement("div", { key: String(model.id), className: "tpq-usage-model" },
        React.createElement("span", { className: "tpq-usage-model-id", title: model.id }, model.id),
        React.createElement("span", { className: "tpq-usage-model-tokens" }, formatTokens(totals.tokens)),
        React.createElement("span", { className: "tpq-usage-model-splits" },
          copy.usageSplitInput + " " + formatTokens(totals.input) + " · " +
          copy.usageSplitOutput + " " + formatTokens(totals.output) + " · " +
          copy.usageSplitCacheRead + " " + formatTokens(totals.cacheRead) + " · " +
          copy.usageSplitCacheWrite + " " + formatTokens(totals.cacheWrite)));
    }

    /**
     * 官方账号侧对照条（spec 008 / INTERFACE §3.2）。独立的 section，**不挂 .tpq-usage-card**：
     * 既有用例按「恰好 3 张数据卡」钉 stale 与错误态清场，共用类会改动那些断言。
     *
     * 状态机（由 official.status 驱动）：
     *   idle / loading → 只有一行「正在读取…」；
     *   error          → **零数字**：一行 role=status 的原因 + 重试按钮；
     *   ready          → 官方 / 本机 / 差额三格 + 官方四项细分 + 脚注；官方全 0 时换成空文案。
     * ready 还要求 official.key 等于**当前查询**的 key（请求序号已经防串，这里防的是用户刚改了
     * 区间、本地新快照还没回来的那一小段）：对不上就退回 loading，绝不展示上一个区间的数字。
     * 差额 = 官方 − 本机（正数带 +、负数带 -），与左边两格同源（都取 totals.tokens）。
     */
    function usageOfficialSection(copy, official, queryKey, localTotals, onRetry, stale) {
      const state = official !== null && official !== undefined ? official : { status: "idle" };
      const shell = function (children) {
        return React.createElement("section", {
          key: "official",
          className: "tpq-usage-official",
          "data-usage-official": "1",
          "data-stale": stale === true ? "1" : "0",
        }, [React.createElement("h3", { key: "title", className: "tpq-usage-official-title" }, copy.usageOfficialTitle)].concat(children));
      };
      const loadingNode = function () {
        return shell(React.createElement("p", { key: "loading", className: "tpq-usage-official-loading" }, copy.usageOfficialLoading));
      };
      if (state.status !== "ready" && state.status !== "error") return loadingNode();
      if (state.status === "error") {
        /* 宿主 hint 是中文可操作提示（去配置 / 重新登录），只在中文界面展示；错误码原文永不上屏。 */
        const rawHint = state.error !== null && typeof state.error === "object" && typeof state.error.hint === "string"
          ? state.error.hint : "";
        const hint = uiEnglish !== true ? rawHint : "";
        return shell([
          React.createElement("p", {
            key: "error",
            className: "tpq-usage-official-error",
            "data-usage-official-error": "1",
            role: "status",
          }, copy.usageOfficialError + (hint !== "" ? " · " + hint : "")),
          React.createElement("button", {
            key: "retry",
            type: "button",
            className: "tpq-usage-official-retry",
            "data-usage-official-retry": "1",
            onClick: onRetry,
          }, copy.usageOfficialRetry),
        ]);
      }
      if (state.key !== queryKey) return loadingNode();
      const payload = state.data !== null && typeof state.data === "object" ? state.data : {};
      if (officialIsEmpty(payload)) {
        return shell(React.createElement("p", {
          key: "empty",
          className: "tpq-usage-official-empty",
          "data-usage-official-empty": "1",
        }, copy.usageOfficialEmpty));
      }
      const officialTotals = payload.totals !== null && typeof payload.totals === "object" ? payload.totals : {};
      const local = localTotals !== null && typeof localTotals === "object" ? localTotals : {};
      const officialTokens = officialTotals.tokens;
      const localTokens = local.tokens;
      const gapValue = Number(officialGapText(officialTokens, localTokens)) - 0;
      const gapSign = gapValue > 0 ? "pos" : gapValue < 0 ? "neg" : "zero";
      const cell = function (key, label, value, className, attrs) {
        return React.createElement("div", {
          key: key,
          className: "tpq-usage-official-cell" + (className !== "" ? " " + className : ""),
          ...attrs,
        },
          React.createElement("span", { className: "tpq-usage-official-label", title: label }, label),
          React.createElement("span", { className: "tpq-usage-official-value" }, value),
          React.createElement("span", { className: "tpq-usage-official-unit" }, copy.usageTokensUnit));
      };
      const children = [
        React.createElement("div", { key: "grid", className: "tpq-usage-official-grid" },
          cell("official", copy.usageOfficialOfficial, usageCount(officialTokens),
            "tpq-usage-official-official", { "data-usage-official-official": "1" }),
          cell("local", copy.usageOfficialLocal, usageCount(localTokens),
            "tpq-usage-official-local", { "data-usage-official-local": "1" }),
          cell("gap", copy.usageOfficialGap, officialGapText(officialTokens, localTokens),
            "tpq-usage-official-gap", { "data-usage-official-gap": "1", "data-sign": gapSign })),
        /* 官方四项细分：口径与上方「官方」格同源（都是官方 totals），用整数展示便于核对。 */
        React.createElement("p", {
          key: "split",
          className: "tpq-usage-official-split",
          "data-usage-official-split": "1",
        }, copy.usageSplitInput + " " + usageCount(officialTotals.input) + " · " +
          copy.usageSplitCacheRead + " " + usageCount(officialTotals.cacheRead) + " · " +
          copy.usageSplitOutput + " " + usageCount(officialTotals.output)),
      ];
      /* clampedFrom 是**被夹掉的原始起点**（INTERFACE §1.1）：文案必须写「你查的 X 起，
         官方最早只到 Y 起」，不能把 X 说成夹紧后的值。 */
      const coverage = payload.coverage !== null && typeof payload.coverage === "object" ? payload.coverage : {};
      const clampedFrom = typeof coverage.clampedFrom === "string" ? coverage.clampedFrom : "";
      const officialFrom = payload.range !== null && typeof payload.range === "object"
        && typeof payload.range.from === "string" ? payload.range.from : "";
      if (clampedFrom !== "" && officialFrom !== "") {
        children.push(React.createElement("p", {
          key: "clamped",
          className: "tpq-usage-official-clamped",
          "data-usage-official-clamped": "1",
        }, copy.usageOfficialClamped.replace("{from}", clampedFrom).replace("{officialFrom}", officialFrom)));
      }
      children.push(React.createElement("p", { key: "note", className: "tpq-usage-official-note" }, copy.usageOfficialNote));
      return shell(children);
    }

    /**
     * 整页屏。宿主把注册时的 store 拆成 useStore / actions 两个 prop 注入（已对照
     * app.asar 里 dsh-client-locale / dsh-client-ui-chat 的写法），没有 store 的宿主
     * （本地 harness 或旧宿主）就用组件自己的本地 state。
     *
     * 数据：打开时拉一次，面板可见期间每 30 秒拉一次，切天数立刻拉，错误后重试再拉。
     */
    function UsageScreen(props) {
      const p = props !== null && props !== undefined ? props : {};
      // 文案表由界面语言现取：切语言后宿主会重挂整页，这里不需要订阅。
      const copy = pickLocale();
      // 同一次注册的 props 在一生里不会多出/少掉 useStore，所以这条分支不会改变 hook 数量。
      const storeHook = typeof p.useStore === "function" ? p.useStore : null;
      const storeState = storeHook !== null ? storeHook(function (state) { return state; }) : null;
      const storeActions = p.actions !== null && p.actions !== undefined ? p.actions : null;
      const bootDays = storeState !== null && storeState !== undefined && storeState.days !== undefined ? clampDays(storeState.days) : null;
      const bootMode = storeState !== null && storeState !== undefined && storeState.mode === "3d" ? "3d" : "2d";
      const initialDays = bootDays !== null ? bootDays : 7;
      /* 007：查询模式与图表视图是两个维度。006 已把 store 的 `mode` 用作 2D/3D 视图
         （宿主按它恢复上次视图，测试也钉着初值 "2d"），查询模式因此另存 `rangeMode`，
         其余字段名仍按 INTERFACE §3.1（from / to），恢复语义不变。 */
      const bootCustom = usageBootCustomRange(storeState);
      const initialQueryMode = bootCustom !== null ? "custom" : "days";
      const initialFrom = bootCustom !== null ? bootCustom.from : "";
      const initialTo = bootCustom !== null ? bootCustom.to : "";
      const [days, setDays] = React.useState(initialDays);
      const [mode, setMode] = React.useState(bootMode);
      const [queryMode, setQueryMode] = React.useState(initialQueryMode);
      const [rangeFrom, setRangeFrom] = React.useState(initialFrom);
      const [rangeTo, setRangeTo] = React.useState(initialTo);
      const [draft, setDraft] = React.useState(String(initialDays));
      const [draftFrom, setDraftFrom] = React.useState(initialFrom);
      const [draftTo, setDraftTo] = React.useState(initialTo);
      const [rangeError, setRangeError] = React.useState(null);
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [loading, setLoading] = React.useState(true);
      const daysRef = React.useRef(initialDays);
      const aliveRef = React.useRef(true);
      /* 请求序号：切天数 / 连点预设时只让「最后一次发出的请求」落地（见 fetchUsage）。 */
      const seqRef = React.useRef(0);
      /* 在飞请求的 AbortController：切天 / 重试时立刻作废上一条（C4）。 */
      const abortRef = React.useRef(null);
      /* 008 官方账号侧：独立的状态槽 + 自己的序号 / 中止器。本机 data/error/loading 一概不动，
         所以官方接口失败只影响对照条那一块，本机屏照旧可读（FR-008）。 */
      const [official, setOfficial] = React.useState({ status: "idle", key: "", data: null, error: null });
      const officialKeyRef = React.useRef("");
      const officialSeqRef = React.useRef(0);
      const officialAbortRef = React.useRef(null);
      daysRef.current = days;
      /* 当前查询的 ref：30 秒轮询与重试按钮都读它，拿到的永远是「屏幕上这次查询」。 */
      const queryRef = React.useRef(usageQueryOf(initialQueryMode, initialDays, initialFrom, initialTo));
      queryRef.current = usageQueryOf(queryMode, days, rangeFrom, rangeTo);
      /* 超时可按 props 注入（测试用）；宿主不传，生产恒为 15 秒。 */
      const injectedTimeout = Number(p.timeoutMs);
      const timeoutMs = Number.isFinite(injectedTimeout) && injectedTimeout > 0 ? injectedTimeout : USAGE_TIMEOUT_MS;

      /**
       * 官方账号侧取数（spec 008 / INTERFACE §3.1）。参数与本机查询完全一致 —— 两边都用
       * usageQueryPath 生成请求串，所以不可能一边用 days、另一边用 from/to。
       * fresh=1 只由「重试」与显式刷新带（宿主侧缓存 5 分钟）；序号 + AbortController
       * 保证只让最后一次响应落地。失败体是 200 + {error, code, hint}，不能当成功数据。
       */
      const fetchOfficial = function (target, options) {
        const suffix = usageQueryPath(target);
        const key = officialQueryKeyOf(target);
        if (suffix === null || key === null) return Promise.resolve();
        const fresh = options !== null && options !== undefined && options.fresh === true;
        officialKeyRef.current = key;
        const seq = officialSeqRef.current + 1;
        officialSeqRef.current = seq;
        if (officialAbortRef.current !== null) {
          try { officialAbortRef.current.abort(); } catch { /* 已结束的 signal 再 abort 是空操作 */ }
          officialAbortRef.current = null;
        }
        const controller = typeof AbortController === "function" ? new AbortController() : null;
        officialAbortRef.current = controller;
        setOfficial({ status: "loading", key: key, data: null, error: null });
        let timedOut = false;
        const timer = setTimeout(function () {
          timedOut = true;
          if (controller !== null) controller.abort();
        }, timeoutMs);
        const path = USAGE_OFFICIAL + suffix + (fresh === true ? "&fresh=1" : "");
        return request(path, { signal: controller !== null ? controller.signal : undefined }).then(function (payload) {
          clearTimeout(timer);
          if (aliveRef.current !== true || officialSeqRef.current !== seq) return;
          const judged = officialPayloadState(payload);
          if (judged.kind === "ready") setOfficial({ status: "ready", key: key, data: payload, error: null });
          else setOfficial({ status: "error", key: key, data: null, error: judged });
        }).catch(function (failure) {
          clearTimeout(timer);
          if (aliveRef.current !== true || officialSeqRef.current !== seq) return;
          const code = failure !== null && typeof failure === "object" && typeof failure.code === "string"
            ? failure.code : "official-upstream";
          setOfficial({
            status: "error",
            key: key,
            data: null,
            error: { kind: "error", code: timedOut === true ? "official-timeout" : code, hint: "" },
          });
        });
      };

      const fetchUsage = function (target, options) {
        /* 007：target 从「天数」扩成查询描述 { mode:"days", days } / { mode:"custom", from, to }。
           自定义区间在这里再校验一次：本地校验过了才可能有查询，这里只作最后一道闸
           （恢复的旧状态跨天失效时也走这条路，宁可零请求也不发注定 400 的查询）。 */
        /* 008：请求串由 usageQueryPath 统一构造，官方路由复用同一个函数（参数一字不差）。 */
        const suffix = usageQueryPath(target);
        if (suffix === null) return Promise.resolve();
        const path = USAGE + suffix;
        const first = options !== undefined && options !== null && options.first === true;
        /* 本机重试时顺带让官方也回源：上一次官方失败可能只是凭据/网关抖动，用户点重试
           期待两边都刷新一次（INTERFACE §3.1：只有重试与显式刷新带 fresh=1）。 */
        const officialFresh = options !== undefined && options !== null && options.officialFresh === true;
        /* 切天数 / 连点预设会让请求并发。aliveRef 只挡「组件已卸载」，挡不住同屏乱序：
           慢的旧请求后回来会把旧 days 的快照写进 data，而副标题 / 坐标轴已经用新 days，
           同一屏上混着两个区间。序号只放行最后一次发出的请求。 */
        const seq = seqRef.current + 1;
        seqRef.current = seq;
        if (abortRef.current !== null) {
          try { abortRef.current.abort(); } catch { /* 已结束的 signal 再 abort 是空操作 */ }
          abortRef.current = null;
        }
        const controller = typeof AbortController === "function" ? new AbortController() : null;
        abortRef.current = controller;
        let timedOut = false;
        /* 无超时的请求会让面板永远停在骨架（宿主重启 / 回调丢失），且没有重试入口；
           超时按错误态收口，走本地化文案 + 重试按钮，不把 AbortError 抛给用户。 */
        const timer = setTimeout(function () {
          timedOut = true;
          if (controller !== null) controller.abort();
        }, timeoutMs);
        return request(path, { signal: controller !== null ? controller.signal : undefined }).then(function (payload) {
          clearTimeout(timer);
          if (aliveRef.current !== true || seqRef.current !== seq) return;
          setData(payload);
          setError(null);
          setLoading(false);
          /* 本机快照成功后才问官方（官方接口按同一组查询参数取数）。key 没变且不是显式刷新
             就不重取：30 秒轮询每轮都会成功一次，跟着每轮打官方会绕开宿主 5 分钟缓存。 */
          const targetKey = officialQueryKeyOf(target);
          if (targetKey !== null && (officialFresh === true || officialKeyRef.current !== targetKey)) {
            void fetchOfficial(target, { fresh: officialFresh });
          }
        }).catch(function (failure) {
          clearTimeout(timer);
          if (aliveRef.current !== true || seqRef.current !== seq) return;
          setError(timedOut ? { code: "usage-timeout" } : failure);
          setLoading(false);
          if (first === true) setData(null);
        });
      };

      /* 首拉 / 换查询后重拉：key 覆盖天数与自定义起止；查询模式不同但日期相同也要换 key，
         否则从预填的自定义区间点回同名天数时不会重新取数。 */
      const queryKey = queryMode === "custom"
        ? "custom:" + rangeFrom + ":" + rangeTo
        : "days:" + String(days);
      React.useEffect(function () {
        aliveRef.current = true;
        void fetchUsage(queryRef.current, { first: true });
        return function () {
          aliveRef.current = false;
        };
      }, [queryKey]);

      React.useEffect(function () {
        /* 两个条件缺一不可：窗口在后台（document.hidden）不轮询；本屏已不在前台
           （用户切到别的整页屏）也不轮询——宿主当前按 keyed 卸载组件，这条现在只是兜底；
           若将来改成保活渲染，不查 activePanelId 就会每 30 秒替一屏看不见的页面发请求。 */
        const timer = setInterval(function () {
          if (typeof document !== "undefined" && document !== null && document.hidden === true) return;
          if (usagePanelActive() !== true) return;
          void fetchUsage(queryRef.current);
        }, 30000);
        return function () {
          clearInterval(timer);
        };
      }, []);

      React.useEffect(function () {
        if (typeof document === "undefined" || document === null || typeof document.addEventListener !== "function") return undefined;
        const onKey = function (event) {
          if (event === null || event === undefined) return;
          if (event.key !== "Escape") return;
          /* 只有本屏在宿主前台时才响应：宿主当前按 keyed 卸载（切走即卸载）；若将来改为
             保活渲染，不加这句会在别的页面上按 Esc 也把用量屏关掉（用户没看见这一屏）。 */
          if (usagePanelActive() !== true) return;
          closeUsagePanel();
        };
        document.addEventListener("keydown", onKey);
        return function () {
          if (document !== null && typeof document.removeEventListener === "function") document.removeEventListener("keydown", onKey);
        };
      }, []);

      /** 持久化查询模式（store 缺席时静默跳过，本地 state 仍然工作）。 */
      const rememberRange = function (nextMode, from, to) {
        if (storeActions !== null && typeof storeActions.setRange === "function") {
          storeActions.setRange({ rangeMode: nextMode, from: from, to: to });
        }
      };

      const commitDays = function (raw) {
        const parsed = parseDaysInput(raw);
        if (parsed === null) {
          // 非数字：恢复上一次有效值，不发请求（SC-007）。
          setDraft(String(daysRef.current));
          return;
        }
        const wasCustom = queryMode === "custom";
        /* 同一天数重复提交：Enter 后紧跟 blur 时 daysRef 还没跟上 setDays（状态是异步的），
           旧实现会把同一个值再提交一次、多发一条请求（C5）。输入框已是规范值就直接返回。
           但自定义模式下点预设必须真的切回天数模式，所以那种情况不走这条快捷路。 */
        if (!wasCustom && parsed === daysRef.current && draft === String(days)) return;
        setDraft(String(parsed));
        setRangeError(null);
        if (wasCustom) {
          // 隐藏日期行、把持久化状态改回天数；queryKey 变了，effect 负责取数（不重复发）。
          setQueryMode("days");
          setRangeFrom("");
          setRangeTo("");
          rememberRange("days", "", "");
          setDays(parsed);
          return;
        }
        if (storeActions !== null && typeof storeActions.setDays === "function") storeActions.setDays(parsed);
        rememberRange("days", "", "");
        if (parsed === daysRef.current) void fetchUsage({ mode: "days", days: parsed });
        else setDays(parsed);
      };

      const commitMode = function (next) {
        if (next !== "2d" && next !== "3d") return;
        setMode(next);
        if (storeActions !== null && typeof storeActions.setMode === "function") storeActions.setMode(next);
      };

      /** 切到自定义：预填当前快照区间（无快照用今天-6 天至今天），不校验、不请求；取数交给 effect。 */
      const openCustom = function () {
        if (queryMode === "custom") return;
        const prefill = usageDefaultCustomRange(snapshot);
        setDraftFrom(prefill.from);
        setDraftTo(prefill.to);
        setRangeError(null);
        setQueryMode("custom");
        setRangeFrom(prefill.from);
        setRangeTo(prefill.to);
        rememberRange("custom", prefill.from, prefill.to);
      };

      /** 点「查询」：先本地校验，不通过只出提示、零请求（SC-004）；通过才换查询。 */
      const applyRange = function () {
        const checked = validateUsageRange(draftFrom, draftTo);
        if (checked.ok !== true) {
          setRangeError(checked.error);
          return;
        }
        setRangeError(null);
        setDraftFrom(checked.from);
        setDraftTo(checked.to);
        const unchanged = queryMode === "custom" && rangeFrom === checked.from && rangeTo === checked.to;
        setQueryMode("custom");
        setRangeFrom(checked.from);
        setRangeTo(checked.to);
        rememberRange("custom", checked.from, checked.to);
        // 同一区间重复点「查询」= 用户要重新取数（effect 的 key 没变，不会自己再跑）。
        if (unchanged) void fetchUsage({ mode: "custom", from: checked.from, to: checked.to });
      };

      const snapshot = data;
      /* 切天后新响应还没回来（或失败）时，快照还描述旧区间：标题与数据都从 snapshot 派生，
         本地 days 只决定输入框高亮与下一次请求。stale 只做视觉降级（卡片半透明）。 */
      /* 007：stale 条件从「天数不同」扩成「(kind, days, from, to) 与当前查询不一致」；
         快照没给 range 的老宿主不误报。 */
      const stale = snapshot !== null && usageSnapshotMatchesQuery(snapshot, usageQueryOf(queryMode, days, rangeFrom, rangeTo)) !== true;
      const disabled = snapshot !== null && (snapshot.enabled === false || snapshot.emptyReason === "usage-stats-disabled");
      const coverage = snapshot !== null && snapshot.coverage ? snapshot.coverage : {};
      const sessions = Number(coverage.sessions) || 0;
      const indexed = Number(coverage.indexed) || 0;
      const failed = Number(coverage.failed) || 0;
      /* 009 §3：本轮从日志目录补扫进来的会话数。缺失或 <= 0 时不渲染任何东西，
         既有 4 张用量截图（fixture 里 rescued = 0）的布局与像素必须逐像素不变。 */
      const rescued = Number(coverage.rescued) > 0 ? Math.round(Number(coverage.rescued)) : 0;
      /* refreshing 只是「正在跟宿主同步」——INTERFACE §2 里它是「同步中或距上次同步超过
         60 秒」，空闲时每次轮询都会亮一下，绝不能拿它当回填进度。回填进度条只在确实还有
         未索引会话时出现（sessions > 0 && indexed < sessions）。 */
      const backfilling = snapshot !== null && disabled !== true
        && sessions > 0 && indexed < sessions;
      const syncing = snapshot !== null && disabled !== true && backfilling !== true && snapshot.refreshing === true;
      const empty = snapshot !== null && disabled !== true && snapshot.emptyReason !== undefined
        && snapshot.emptyReason !== null && snapshot.emptyReason !== ""
        && String(snapshot.emptyReason) !== "";
      const totals = snapshot !== null && snapshot.totals ? snapshot.totals : {};
      const models = snapshot !== null && Array.isArray(snapshot.models) ? snapshot.models : [];
      const updatedAt = snapshot !== null && snapshot.generatedAt !== undefined ? snapshot.generatedAt : null;
      const progress = sessions > 0 ? Math.max(0, Math.min(1, indexed / sessions)) : 0;

      const closeButton = React.createElement("button", {
        key: "close",
        type: "button",
        className: "tpq-usage-close",
        "aria-label": copy.usageClose,
        title: copy.usageClose,
        onClick: closeUsagePanel,
      }, "\u00d7");

      const dayButtons = [];
      const presets = [1, 7, 30, 90];
      for (let index = 0; index < presets.length; index += 1) {
        const value = presets[index];
        dayButtons.push(React.createElement("button", {
          key: "day-" + value,
          type: "button",
          className: "tpq-usage-day",
          "data-active": queryMode !== "custom" && days === value ? "1" : "0",
          "aria-pressed": queryMode !== "custom" && days === value ? "true" : "false",
          onClick: function () { commitDays(value); },
        }, value === 1 ? copy.usageToday : String(value)));
      }
      /* 预设之后是「自定义」chip（INTERFACE §3.2）：与预设同一套按钮外观，点开才展开日期行。 */
      dayButtons.push(React.createElement("button", {
        key: "day-custom",
        type: "button",
        className: "tpq-usage-day",
        "data-usage-preset": "custom",
        "data-active": queryMode === "custom" ? "1" : "0",
        "aria-pressed": queryMode === "custom" ? "true" : "false",
        onClick: openCustom,
      }, copy.usageRangeCustom));

      const daysInput = React.createElement("input", {
        key: "days-input",
        type: "number",
        className: "tpq-usage-days-input",
        min: USAGE_DAYS_MIN,
        max: USAGE_DAYS_MAX,
        step: 1,
        value: draft,
        "aria-label": copy.usageDaysLabel,
        title: copy.usageDaysLabel,
        onChange: function (event) {
          setDraft(event !== null && event !== undefined && event.target !== undefined ? String(event.target.value) : "");
        },
        onBlur: function () { commitDays(draft); },
        onKeyDown: function (event) {
          if (event === null || event === undefined || event.key !== "Enter") return;
          if (typeof event.preventDefault === "function") event.preventDefault();
          commitDays(draft);
        },
      });

      const modeButtons = ["2d", "3d"].map(function (value) {
        return React.createElement("button", {
          key: "mode-" + value,
          type: "button",
          className: "tpq-usage-mode",
          "data-active": mode === value ? "1" : "0",
          "aria-pressed": mode === value ? "true" : "false",
          onClick: function () { commitMode(value); },
        }, value === "2d" ? copy.usageMode2d : copy.usageMode3d);
      });

      const blocks = [
        React.createElement("div", { key: "head", className: "tpq-usage-head" },
          React.createElement("div", { className: "tpq-usage-heading" },
            React.createElement("h1", { className: "tpq-usage-title" }, copy.usageTitle),
            React.createElement("p", { className: "tpq-usage-range" },
              /* 首屏就没拿到数据时，错误态下这句「正在读取…」会和「读取失败」自相矛盾（C2 相关）。 */
              snapshot === null ? (error !== null ? "" : copy.usageLoading) : usageRangeText(copy, snapshot, days),
              syncing ? React.createElement("span", { className: "tpq-usage-sync" }, " · " + copy.usageSyncing) : null)),
          React.createElement("div", { className: "tpq-usage-actions" },
            React.createElement("div", { className: "tpq-usage-days" }, dayButtons, daysInput),
            React.createElement("div", { className: "tpq-usage-modes", role: "group", "aria-label": copy.usageModeLabel }, modeButtons),
            closeButton)),
      ];

      /* 自定义区间行（007）：只在自定义模式下展开，与预设 chips 同一行流里换行显示。
         输入不做即时纠正（用户打字中途不该被改写），校验只发生在点「查询」时。 */
      if (queryMode === "custom") {
        const rangeDateInput = function (key, field, value) {
          const label = field === "from" ? copy.usageRangeFrom : copy.usageRangeTo;
          return React.createElement("input", {
            key: key,
            type: "date",
            className: "tpq-usage-date",
            // 写死两个属性名（而不是拼字符串）：静态门禁按字面量 grep data-usage-from/-to。
            "data-usage-from": field === "from" ? "1" : undefined,
            "data-usage-to": field === "to" ? "1" : undefined,
            "aria-label": label,
            value: value,
            onChange: function (event) {
              const next = event !== null && event.target ? String(event.target.value ?? "") : "";
              if (field === "from") setDraftFrom(next);
              else setDraftTo(next);
              setRangeError(null);
            },
            onKeyDown: function (event) {
              if (event !== null && event.key === "Enter") applyRange();
            },
          });
        };
        blocks.push(React.createElement("div", {
          key: "custom",
          className: "tpq-usage-custom",
          "data-usage-custom": "1",
        },
          // 标签与它的输入框包成一组：375px 换行时不会把「结束日期」和它的输入框拆到两行。
          React.createElement("span", { className: "tpq-usage-custom-field" },
            React.createElement("label", { className: "tpq-usage-custom-label" }, copy.usageRangeFrom),
            rangeDateInput("from", "from", draftFrom)),
          React.createElement("span", { className: "tpq-usage-custom-field" },
            React.createElement("label", { className: "tpq-usage-custom-label" }, copy.usageRangeTo),
            rangeDateInput("to", "to", draftTo)),
          React.createElement("button", {
            type: "button",
            className: "tpq-usage-apply",
            "data-usage-apply": "1",
            onClick: applyRange,
          }, copy.usageRangeApply),
          React.createElement("span", {
            className: "tpq-usage-range-error",
            "data-usage-range-error": "1",
            role: "alert",
          }, rangeError === null ? "" : usageRangeErrorText(copy, rangeError))));
      }

      /* 错误态优先且独占：数据区 / 进度 / 备注 / 更新时间全部短路。首屏成功后切天或轮询失败时，
         旧图表 + 旧总分卡与红字并存会让用户无法判断数字可不可信（C2）。 */
      if (error !== null) {
        const failure = usageErrorCopy(copy, error);
        blocks.push(React.createElement("div", { key: "error", className: "tpq-usage-state", role: "alert" },
          React.createElement("div", { className: "tpq-usage-state-title" }, failure.title),
          failure.text !== ""
            ? React.createElement("div", { className: "tpq-usage-state-text" }, failure.text)
            : null,
          React.createElement("button", {
            type: "button",
            className: "tpq-usage-retry",
            // 两边一起重试：本机失败时官方那条多半也没取（含宿主网关抖动），一并回源一次。
            onClick: function () { void fetchUsage(queryRef.current, { first: true, officialFresh: true }); },
          }, copy.usageRetry)));
        return React.createElement("div", { className: "tpq-usage" }, blocks);
      }

      if (backfilling) {
        blocks.push(React.createElement("div", { key: "progress", className: "tpq-usage-progress" },
          React.createElement("div", { className: "tpq-usage-progress-track" },
            React.createElement("div", { className: "tpq-usage-progress-bar", style: { transform: "scaleX(" + progress + ")" } })),
          React.createElement("span", { className: "tpq-usage-progress-text" },
            copy.usageBackfill.replace("{indexed}", usageCount(indexed)).replace("{sessions}", usageCount(sessions))),
          failed > 0
            ? React.createElement("span", { className: "tpq-usage-progress-text" },
              copy.usageBackfillPartial.replace("{failed}", usageCount(failed)))
            : null));
      }

      if (loading && snapshot === null && error === null) {
        blocks.push(React.createElement("div", { key: "skeleton", className: "tpq-usage-skeleton" },
          React.createElement("div", { className: "tpq-usage-skel", "data-w": "mid" }),
          React.createElement("div", { className: "tpq-usage-skel", "data-w": "wide" }),
          React.createElement("div", { className: "tpq-usage-skel", "data-w": "narrow" }),
          React.createElement("div", { className: "tpq-usage-state-text" }, copy.usageLoading)));
      }

      if (disabled) {
        blocks.push(React.createElement("div", { key: "disabled" },
          usageStateBlock(copy.usageEmptyDisabled, copy.usageEmptyDisabledHint, null)));
      } else if (empty) {
        /* 回填还没结束时的「区间内没有用量」是假象（历史还没读完）：进度条已经解释了原因，
           两个同时出现会让用户以为这段真的没用量（C7）。 */
        const emptyCopy = usageEmptyCopy(copy, snapshot);
        if (backfilling !== true) {
          blocks.push(React.createElement("div", { key: "empty" }, usageStateBlock(emptyCopy.title, emptyCopy.hint, null)));
        }
      } else if (snapshot !== null) {
        blocks.push(React.createElement("section", { key: "total", className: "tpq-usage-card", "data-stale": stale ? "1" : "0" },
          React.createElement("div", { className: "tpq-usage-split-label" }, copy.usageTotalLabel),
          React.createElement("div", { className: "tpq-usage-total-main" },
            React.createElement("span", { className: "tpq-usage-big" }, formatTokens(totals.tokens)),
            React.createElement("span", { className: "tpq-usage-unit" }, copy.usageTokensUnit),
            React.createElement("span", { className: "tpq-usage-badge" }, copy.usageMeasuredBadge)),
          React.createElement("div", { className: "tpq-usage-scale" }, copy.usageScaleNote),
          React.createElement("div", { className: "tpq-usage-splits" },
            usageSplitCell(copy.usageSplitInput, totals.input),
            usageSplitCell(copy.usageSplitOutput, totals.output),
            usageSplitCell(copy.usageSplitCacheRead, totals.cacheRead),
            usageSplitCell(copy.usageSplitCacheWrite, totals.cacheWrite),
            usageSplitCell(copy.usageCalls, totals.calls))),
        React.createElement("section", { key: "chart", className: "tpq-usage-card", "data-stale": stale ? "1" : "0" },
          React.createElement("div", { className: "tpq-usage-chart-head" },
            React.createElement("span", { className: "tpq-usage-chart-label" },
              snapshot.granularity === "week" ? copy.usageChartWeekTitle : copy.usageChartTitle),
            snapshot.granularity === "week" ? React.createElement("span", { className: "tpq-usage-weekly" }, copy.usageWeeklyNote) : null),
          React.createElement(UsageChart, { data: snapshot, mode: mode, copy: copy })),
        React.createElement("section", { key: "models", className: "tpq-usage-card", "data-stale": stale ? "1" : "0" },
          React.createElement("div", { className: "tpq-usage-chart-head" },
            React.createElement("span", { className: "tpq-usage-chart-label" }, copy.usageModelsTitle)),
          models.length === 0
            ? React.createElement("div", { className: "tpq-usage-state-text" }, copy.usageNoModels)
            : React.createElement("div", { className: "tpq-usage-models" }, models.map(function (model) {
              return usageModelRow(model, copy);
            }))));
      }

      /* 008：官方账号侧对照条（柱状图卡片之后、脚注之前）。本机错误态已经在上面短路返回，
         所以这块只在本机有数时才出现；反过来官方出错只影响这一块，本机三张卡照旧渲染。
         空区间（empty）与回填进度条期间也保留——本地 0 而官方有量正是对照最有用的时刻。 */
      if (snapshot !== null && disabled !== true) {
        blocks.push(usageOfficialSection(
          copy,
          official,
          queryKey,
          totals,
          function () { void fetchOfficial(queryRef.current, { fresh: true }); },
          stale,
        ));
      }

      /* 数据源脚注必须跟真实来源对齐（原则 I：数字口径 = 官方真值或明确标注的实测窗口）。
         写死一句「来自本地会话记录」在没有持久化的宿主上就是假话；关闭态更没有来源可声明。
         因此只在拿到快照且启用时渲染，label 由宿主的 source 决定。 */
      const noteLines = [];
      if (snapshot !== null && disabled !== true) {
        const sourceNote = usageSourceNote(copy, snapshot);
        if (sourceNote !== "") noteLines.push({ text: sourceNote, attrs: null });
        /* 007 §3.2：会话索引这条来源必须把口说清楚——只统计本机 DSH 发出的调用，
           其他设备/其他客户端的用量不在这份数字里。跟着来源出现，别写死在脚注里。 */
        const sourceKind = snapshot.source !== null && typeof snapshot.source === "object" ? snapshot.source.kind : "";
        if (sourceKind === "session-index") noteLines.push({ text: copy.usageRangeLocalOnly, attrs: null });
        /* 009 §3：宿主的 sessionPersistence.list() 没给的会话被兜底扫描补回来了。
           有才说一行（data-usage-rescued 带上原始数量）；rescued 缺失/为 0 时**不加 DOM**，
           既有 4 张用量截图的布局与像素因此逐像素不变。数量沿用面板既有的数字格式化
           formatTokens（中文界面 1234 → 1,234；英文界面走紧凑量纲，与其它计数一致）。 */
        if (rescued > 0) {
          noteLines.push({
            text: copy.usageScanRescued.replace("{n}", formatTokens(rescued)),
            attrs: { "data-usage-rescued": String(rescued) },
          });
        }
      }
      noteLines.push(
        { text: copy.usageNoteDelay, attrs: null },
        { text: copy.usageNoteCacheWrite, attrs: null },
        { text: copy.usageNoteNoCredits, attrs: null },
      );
      blocks.push(React.createElement("div", { key: "notes", className: "tpq-usage-notes" },
        noteLines.map(function (line, index) {
          const noteProps = { key: "note-" + index };
          if (line.attrs !== null) Object.assign(noteProps, line.attrs);
          return React.createElement("p", noteProps, line.text);
        })));

      if (snapshot !== null && updatedAt !== null) {
        blocks.push(React.createElement("div", { key: "foot", className: "tpq-usage-foot" },
          React.createElement("span", { className: "tpq-usage-updated" },
            copy.usageUpdated + " " + String(formatClock(updatedAt)).slice(0, 5))));
      }

      return React.createElement("div", { className: "tpq-usage" }, blocks);
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
      // 整页「用量统计」屏（spec 006）的三个前置条件，缺一不可：
      // 1) 宿主有 main 整页座位（slots.spec("main")）；2) 有 layout 服务（关页/切页的唯一入口）；
      // 3) 宿主的 client store 提供 defineStore（main 座位的注册契约要求带 store）。
      // 缺任一条就只保留徽标，不因为可选能力缺席而整体降级——但 layout 进了 inject 声明，
      // 宿主没有 layout 服务时整个徽标也不会挂载（代价，见 exports.inject 的注释）。
      const layout = ctx.get("layout");
      usageLayout = layout ?? null;
      const hasMain = layout !== undefined && layout !== null
        && typeof slots.spec === "function" && slots.spec("main") !== undefined
        && defineStore !== null;
      const openUsage = hasMain ? openUsagePanel : undefined;
      const BadgeEntry = () => React.createElement(Badge, { copy: pickLocale(), watchActive, onOpenUsage: openUsage });
      // dock 是一条通栏行（跟输入卡片同宽的最外层），徽标直接挂上去会孤零零贴在视口最左边，
      // 和居中的输入卡片对不上（实机反馈"效果太差"）。所以 dock 态包一层 .tpq-dock，把徽标夹到
      // 卡片那条居中列（max-width = --dsh-composer-card-max-width，左右内边距 = side-clearance），
      // 徽标左缘就正好落在输入卡片左缘上方。工具行座位（老外壳回退）不包这层，直接内联。
      const DockEntry = () => React.createElement("div", { className: "tpq-dock" },
        React.createElement(Badge, { copy: pickLocale(), watchActive, onOpenUsage: openUsage }));
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

      // 整页「用量统计」屏：main 座位 + 侧栏按钮。两个 inject 都以 hasMain 为前提，
      // 老宿主上既不会多注册座位，也不会多出两行日志。
      if (hasMain) {
        // main 座位也要单实例闩锁：宿主重渲染会再次回调工厂，重复注册会让整页屏出现
        // 两份，或让新 store 覆盖旧实例的天数（徽标座位踩过同一个坑，见上面的注释）。
        let mainLive = false;
        ctx.effect(() => slots.inject("main", function* () {
          if (mainLive) return () => {};
          mainLive = true;
          try {
            /* rangeMode 而不是 INTERFACE §3.1 写的 mode：`mode` 已被 006 的图表视图（2d/3d）
               占用，宿主按它恢复上次视图、测试也钉着初值。查询模式必须另起一个键，
               否则切 3D 会把查询模式写成 "3d"（§3 的偏差，已回报 Lead）。 */
            const handle = defineStore({
              init: () => ({ days: 7, mode: "2d", rangeMode: "days", from: "", to: "" }),
              actions: {
                setDays(draft, value) { draft.days = value; },
                setMode(draft, value) { draft.mode = value; },
                setRange(draft, value) {
                  if (value === null || typeof value !== "object") return;
                  draft.rangeMode = value.rangeMode === "custom" ? "custom" : "days";
                  draft.from = typeof value.from === "string" ? value.from : "";
                  draft.to = typeof value.to === "string" ? value.to : "";
                },
              },
            });
            // create() 只跑一次：整页屏每次渲染都从这份实例读快照，重新 create 会换掉
            // 快照身份，正在显示的页面会闪回骨架。
            const instance = handle.create();
            const store = { ...handle, create: () => instance };
            const dispose = yield slots.register({ name: "main", key: PANEL_ID, store, inject: () => ({}) }, UsageScreen);
            const release = typeof dispose === "function" ? dispose : () => {};
            return () => {
              mainLive = false;
              try { release(); } catch { /* 幂等 */ }
            };
          } catch (error) {
            mainLive = false;
            ctx.logger?.warn?.(new Error("token-plan-quota: 注册 main 整页座位失败 —— " + (error instanceof Error ? error.message : String(error))));
            return () => {};
          }
        }), "dsh-token-plan-quota: main");

        // 侧栏按钮：id 必须与 main 座位的 key 完全一致（宿主靠这个 id 把按钮和整页屏对上）。
        ctx.effect(() => slots.inject("sidebar.panellist", () => {
          try {
            return slots.register({ name: "sidebar.panellist", id: PANEL_ID, order: 10, label: () => pickLocale().usageTitle }, UsagePanelIcon);
          } catch (error) {
            ctx.logger?.warn?.(new Error("token-plan-quota: 注册侧栏用量按钮失败 —— " + (error instanceof Error ? error.message : String(error))));
            return () => {};
          }
        }), "dsh-token-plan-quota: sidebar.panellist");
      } else {
        ctx.logger?.warn?.(new Error("token-plan-quota: 宿主无 main 整页座位或 layout 服务，用量统计屏不注册"));
      }
    }

    // 纯函数：给测试与外部自检用，不碰 DOM、不依赖宿主（INTERFACE.md §3 的 __internals）。
    exports.__internals = {
      barRatio, projectBar3D, clampDays, formatTokens, parseDaysInput,
      // 007 自定义区间：日期算术与校验是纯函数，测试直接打这些（不必起 DOM）。
      validateUsageRange, usageRangeDays, usageShiftDay, usageTodayKey,
      usageRangeText, usageSnapshotMatchesQuery, usageDefaultCustomRange,
      // 008 官方账号侧对照：请求串 / 去重键 / 响应判定 / 空判定 / 差额文案都是纯函数。
      usageQueryPath, officialQueryKeyOf, officialPayloadState, officialIsEmpty,
      officialGapText, usageOfficialSection,
    };

    exports.apply = apply;
    // 动态插件的 fiber 只看得见自己声明过的服务。0.1.2 起这条规则是硬的：没声明时
    // ctx.get("slots") 只会返回 undefined（直读 ctx.slots 则抛 "cannot get property
    // \"slots\" without inject"），于是徽标静默不挂载。slots 是徽标的硬依赖，
    // 所以在这里声明。sessions / modelDirectories 也在这一列，不是顺手加的：徽标
    // 「跟随当前模型供应商」和「面板只显示当前模型」（宿主默认 panelScope:"current"）
    // 都依赖这两份服务，缺了 watchActive 恒为 false，面板就退回全量显示。
    // 代价要写明白：fiber 会等这三份服务，任一缺席（例如 profile 停用了模型选择插件）
    // 整个徽标就不出现，而不是退回全量——这是"跟随模型"这个卖点本身的取舍。
    // layout 是整页「用量统计」屏的开关（selectPanel）：main 座位与侧栏按钮都要它。
    // 代价：layout 进了 fiber 依赖，宿主没有 layout 服务时连徽标也不会挂载——这是
    // 「徽标 + 整页屏共用一次 apply」的取舍，与 INTERFACE.md §3 的注册形状一致。
    exports.inject = ["slots", "sessions", "modelDirectories", "layout"];
    return module.exports;
  },
});
