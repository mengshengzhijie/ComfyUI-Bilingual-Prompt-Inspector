// 问候 / 提醒：右上角一张独立的通知卡，四阶段状态机（入场 → 加载中 → 结果到达 → 退场）。
//
// 结构与时序来自单独调试用的 html 原型；这里把整块塞进 Shadow DOM：
// 类名（.notif / .under / .cover…）都很通用，直接进页面会和 ComfyUI 打架，
// 放进 shadow 就天然隔离，CSS 也能原样保留、方便对照原型继续调。
//
// 对外只有三个口子：
//   greetingEnabled() / setGreetingEnabled(next)   开关（localStorage）
//   startGreeting({ title })                       入场并进入加载态，返回 { finish, dismiss }
//   showGreeting({ title, body })                  有现成文案时用这个：入场 → 直接给结果
import { bpiFetch, button, element, listAssistantModels, runInspectorAssistant } from "./bpi_shared.js";
import { notify } from "./bpi_notify.js";

const STORAGE_KEY = "bpi.greeting.v1";
const MIN_HOLD_MS = 8000;      // 结果展示至少留这么久
const CHARS_PER_SECOND = 5;    // 之后再按 5 字/秒往上加：字多的能读完

// 瀑布 8 色：最后一层紫必须和 --bpi-greet-paper 同色，落下后与紫色区域融为一体
const STREAM_COLORS = ["#f87171", "#fb923c", "#fbbf24", "#a3e635", "#22d3ee", "#38bdf8", "#e879f9", "#a78bfa"];
const STREAM_DUR = 500;
const STREAM_GAP = 150;
const OVERLAP = 250; // 下一轮提前启动，让紫色在落到底之前就被下一轮的红色覆盖

const CSS = `
/* 原型里有一条全局 * { box-sizing: border-box }，漏了它所有尺寸都会多出 padding+border */
:host, :host * { box-sizing: border-box; }

/* ── 主题变量：宿主要能覆盖，所以放在 :host 上 ── */
:host {
  --slow: 1;
  --bpi-greet-front: #38bdf8;        /* 蓝：第一层扫层、思考点、聚焦轮廓 */
  --bpi-greet-front-rgb: 56, 189, 248;
  --bpi-greet-paper: #a78bfa;        /* 紫：第二层扫层、主遮罩、回收遮罩、底部亮线、紫色区域、结果层 */
  --bpi-greet-paper-rgb: 167, 139, 250;
  --bpi-greet-accent: #22d3ee;       /* 青：左侧竖条 */
  --bpi-greet-accent-rgb: 34, 211, 238;
  --bpi-greet-back: #f31199;         /* 玫红：第一层背板 */
  --bpi-greet-back-rgb: 243, 17, 153;
  --bpi-greet-back2: #a3e635;        /* 黄绿：第二层背板 */
  --bpi-greet-back2-rgb: 163, 230, 53;
  /* 底色跟随插件主题：外部有 --bpi-* 就用外部的，没有才退回深色 */
  --bg: var(--comfy-menu-bg, #1a1d23);
  --fg: var(--bpi-text, #e6edf7);
  --muted: var(--bpi-text-muted, #aab5c5);
  --panel: var(--bpi-surface-modal, #20252d);
  --border: var(--bpi-border, #3a4250);
}

.notif-wrap {
  position: fixed;
  top: 30px;
  right: 0;
  width: min(340px, calc(100vw - 40px));
  z-index: 10;
}

.under {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: -6px;
  background: var(--bpi-greet-accent);
  border: 1px solid rgba(var(--bpi-greet-accent-rgb), .35);
  border-right: 0;
  z-index: 0;
  pointer-events: none;
  opacity: 0;
  transform: translateY(calc(-100% - 40px));
  transition:
    transform calc(.5s * var(--slow)) cubic-bezier(.16, 1, .3, 1),
    opacity calc(.4s * var(--slow)) ease;
}
.under.show { opacity: 1; transform: translateY(0); }
.under.wipe {
  transform: translateX(125%);
  transition: transform calc(.435s * var(--slow)) cubic-bezier(.55, 0, .8, .4);
}

.behind {
  position: absolute;
  inset: 1px;
  background: var(--bpi-greet-back);
  z-index: 1;
  pointer-events: none;
  opacity: 0;
  transform: translateY(calc(-100% - 40px));
  transition:
    transform calc(.5s * var(--slow)) cubic-bezier(.16, 1, .3, 1),
    opacity calc(.4s * var(--slow)) ease;
}
.behind.show { opacity: 1; transform: translateY(0); }
.behind.wipe {
  animation: swipeRight calc(.6s * var(--slow)) cubic-bezier(.35, 0, .25, 1) forwards;
}
@keyframes swipeRight {
  0%   { clip-path: inset(0 0 0 0); transform: translateX(0) skewX(0deg); opacity: 1; }
  70%  { opacity: 1; }
  100% { clip-path: inset(0 0 0 100%); transform: translateX(24%) skewX(-12deg); opacity: 0; }
}

.behind2 {
  position: absolute;
  inset: 1px;
  background: var(--bpi-greet-back2);
  z-index: 0;
  pointer-events: none;
  opacity: 0;
  transform: translateY(calc(-100% - 40px));
  transition:
    transform calc(.5s * var(--slow)) cubic-bezier(.16, 1, .3, 1),
    opacity calc(.4s * var(--slow)) ease;
}
.behind2.show { opacity: 1; transform: translateY(0); }
.behind2.wipe {
  animation: swipeRight calc(.6s * var(--slow)) cubic-bezier(.35, 0, .25, 1) forwards;
}

.notif {
  position: relative;
  z-index: 2;
  width: 100%;
  padding: 18px 20px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 0;
  box-shadow: 0 20px 50px rgba(0, 0, 0, .55);
  overflow: hidden;
  /* 高度直接走 height：正文是 AI 回来才填的，靠 max-height 撑不开卡片 */
  height: auto;

  opacity: 0;
  transform: translateY(calc(-100% - 40px));
  transition:
    transform calc(.5s * var(--slow)) cubic-bezier(.16, 1, .3, 1),
    opacity calc(.4s * var(--slow)) ease,
    height calc(.45s * var(--slow)) cubic-bezier(.3, .8, .3, 1);
  will-change: transform, opacity, height;
}
.notif.play { opacity: 1; transform: translateY(0); }

.notif::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 3px;
  background: var(--bpi-greet-paper);
  box-shadow:
    0 0 12px rgba(var(--bpi-greet-paper-rgb), .6),
    0 0 4px rgba(var(--bpi-greet-paper-rgb), .85);
  z-index: 1;
  pointer-events: none;
}
.notif.covering::after {
  height: 100%;
  transition: height calc(.52s * var(--slow)) cubic-bezier(.45, 0, .2, 1);
}

.notif.out {
  pointer-events: none;
  animation: exitSlide calc(.5s * var(--slow)) cubic-bezier(.55, 0, .8, .4) forwards;
}
@keyframes exitSlide {
  0%   { transform: translateX(0); }
  100% { transform: translateX(125%); }
}

.close {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 9;
  width: 20px;
  height: 20px;
  line-height: 18px;
  text-align: center;
  font-size: 16px;
  color: var(--muted);
  background: transparent;
  border: 0;
  border-radius: 4px;
  cursor: pointer;
  transition: color calc(.15s * var(--slow)) ease, background calc(.15s * var(--slow)) ease;
}
.close:hover {
  color: var(--fg);
  background: rgba(127, 127, 127, .18);
}

.content {
  display: flex;
  flex-direction: column;
  gap: 10px;
  position: relative;
  z-index: 1;
}
.head {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-right: 24px;
}
.title {
  font-size: 15px;
  font-weight: 600;
  color: var(--fg);
  letter-spacing: .3px;
  line-height: 1.35;
}

.thinking {
  display: inline-flex;
  gap: 3px;
  align-items: center;
  margin-left: 8px;
  vertical-align: middle;
  opacity: 0;
  transition: opacity calc(.2s * var(--slow)) ease;
}
.notif.fetching .thinking { opacity: 1; }
.thinking i {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--bpi-greet-front);
  animation: think calc(.48s * var(--slow)) infinite ease-in-out;
}
.thinking i:nth-child(2) { animation-delay: calc(.08s * var(--slow)); }
.thinking i:nth-child(3) { animation-delay: calc(.16s * var(--slow)); }
@keyframes think {
  0%, 70%, 100% { opacity: .25; transform: translateY(0); }
  35%            { opacity: 1;   transform: translateY(-3px); }
}

.extra {
  font-size: 13px;
  color: var(--muted);
  line-height: 1.75;
  letter-spacing: .2px;
  opacity: 0;
  transition: opacity calc(.4s * var(--slow)) ease calc(.1s * var(--slow));
  padding-bottom: 6px;
  white-space: pre-line;
}
.notif.expand .extra { opacity: 1; }

.purple-area {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: var(--purple-h, 0);
  background: var(--bpi-greet-paper);
  z-index: 2;
  pointer-events: none;
  overflow: hidden;
  transition: height calc(.45s * var(--slow)) cubic-bezier(.3, .8, .3, 1);
}
.purple-area.no-anim { transition: none !important; }

/* 每一轮动态创建的瀑布层，z-index 由 JS 递增设置 */
.stream {
  position: absolute;
  inset: 0;
  transform: translateY(-100%);
  will-change: transform;
  pointer-events: none;
}
@keyframes streamDrop {
  to { transform: translateY(0); }
}

/* 结果紫色层 z-index 最高，覆盖所有轮次的瀑布 */
.result-purple {
  position: absolute;
  inset: 0;
  background: var(--bpi-greet-paper);
  transform: translateY(-100%);
  z-index: 99999;
  pointer-events: none;
  will-change: transform;
}
@keyframes resultDrop {
  to { transform: translateY(0); }
}

.mask {
  position: absolute;
  inset: 0;
  background: var(--bpi-greet-paper);
  z-index: 7;
  pointer-events: none;
  transform: translateY(0);
}
.notif.play .mask {
  animation: maskSweep calc(.42s * var(--slow)) cubic-bezier(.55, 0, .2, 1) calc(.62s * var(--slow)) forwards;
}
@keyframes maskSweep {
  from { transform: translateY(0); }
  to   { transform: translateY(112%); }
}

.seq {
  position: absolute;
  inset: 0;
  transform: translateY(-100%);
  will-change: transform;
}
.seq:nth-child(1) { background: var(--bpi-greet-front); z-index: 1; }
.seq:nth-child(2) { background: var(--bpi-greet-paper); z-index: 2; }

.notif.play .seq:nth-child(1) {
  animation: seqDrop calc(.28s * var(--slow)) cubic-bezier(.3, .7, .3, 1) 0s forwards;
}
.notif.play .seq:nth-child(2) {
  animation: seqDrop calc(.28s * var(--slow)) cubic-bezier(.3, .7, .3, 1) calc(.14s * var(--slow)) forwards;
}
@keyframes seqDrop {
  from { transform: translateY(-100%); }
  to   { transform: translateY(0); }
}

.cover {
  position: absolute;
  inset: 0;
  background: var(--bpi-greet-paper);
  z-index: 8;
  pointer-events: none;
  transform: translateY(calc(100% + 3px));
  transition: transform calc(.52s * var(--slow)) cubic-bezier(.45, 0, .2, 1);
  will-change: transform;
}
.notif.covering .cover { transform: translateY(0); }

.close {
  position: absolute;
  top: 6px;
  right: 6px;
  z-index: 10;
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  transition: background .15s ease, color .15s ease;
}
.close:hover { background: rgba(127, 127, 127, .15); color: var(--fg); }
.close:active { background: rgba(127, 127, 127, .25); }
.close:focus-visible { outline: 2px solid var(--bpi-greet-front); outline-offset: -2px; }

.controls {
  position: fixed;
  left: 50%;
  bottom: 40px;
  transform: translateX(-50%);
  display: flex;
  gap: 10px;
  z-index: 20;
}
.controls button {
  appearance: none;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--fg);
  font: inherit;
  font-size: 13px;
  padding: 10px 24px;
  border-radius: 0;
  cursor: pointer;
  transition: background .15s ease, border-color .15s ease, color .15s ease;
}
.controls button:hover { border-color: var(--bpi-greet-front); }
.controls button:active { background: var(--bpi-greet-front); border-color: var(--bpi-greet-front); color: #0a0c0f; }
.controls button:focus-visible { outline: 2px solid var(--bpi-greet-front); outline-offset: 2px; }

@media (prefers-reduced-motion: reduce) {
  .notif, .extra, .notif.out, .cover, .seq, .under, .behind, .behind2, .purple-area, .stream, .result-purple, .notif::after,
  .notif.play .mask {
    animation-duration: .01ms !important;
    animation-delay: 0s !important;
    transition-duration: .01ms !important;
  }
  .thinking i { animation: none !important; }
}

`;

function ensureStyle() {
  const host = document.querySelector(".bpi-greet-host");
  if (host) return host;
  const node = document.createElement("div");
  node.className = "bpi-greet-host";
  // 宿主本身不占位、不吃事件，真正的位置交给 shadow 里的 .notif-wrap
  node.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:9997";
  const shadow = node.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = CSS;
  shadow.appendChild(style);
  const wrap = document.createElement("div");
  wrap.className = "notif-wrap";
  wrap.style.pointerEvents = "auto";
  shadow.appendChild(wrap);
  document.body.appendChild(node);
  return node;
}

function buildCard(shadow, title) {
  const wrap = shadow.querySelector(".notif-wrap");
  wrap.replaceChildren();

  const under = document.createElement("div");
  under.className = "under";
  const behind = document.createElement("div");
  behind.className = "behind";
  const behind2 = document.createElement("div");
  behind2.className = "behind2";

  const notif = document.createElement("div");
  notif.className = "notif";
  notif.style.pointerEvents = "auto";

  const purple = document.createElement("div");
  purple.className = "purple-area";
  const result = document.createElement("div");
  result.className = "result-purple";
  purple.appendChild(result);

  const content = document.createElement("div");
  content.className = "content";
  const head = document.createElement("div");
  head.className = "head";
  const titleEl = document.createElement("div");
  titleEl.className = "title";
  // 三个跳动点塞在标题里面，跟在文字右边（head 是 column，放外面会掉到下一行）
  const thinking = document.createElement("span");
  thinking.className = "thinking";
  thinking.append(document.createElement("i"), document.createElement("i"), document.createElement("i"));
  titleEl.append(document.createTextNode(String(title ?? "")), thinking);
  const extra = document.createElement("div");
  extra.className = "extra";
  head.append(titleEl);
  content.append(head, extra);

  const mask = document.createElement("div");
  mask.className = "mask";
  const seq1 = document.createElement("div");
  seq1.className = "seq";
  const seq2 = document.createElement("div");
  seq2.className = "seq";
  const cover = document.createElement("div");
  cover.className = "cover";

  const closeBtn = document.createElement("div");
  closeBtn.className = "close";
  closeBtn.textContent = "\u00d7";
  closeBtn.title = "关闭";

  notif.append(purple, content, mask, seq1, seq2, cover, closeBtn);
  wrap.append(under, behind, behind2, notif);

  return { wrap, under, behind, behind2, notif, purple, result, content, head, titleEl, extra, mask, seq1, seq2, cover, closeBtn };
}

export function greetingEnabled() {
  try {
    return localStorage.getItem(STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

export function setGreetingEnabled(next) {
  try {
    localStorage.setItem(STORAGE_KEY, next ? "on" : "off");
  } catch {
    // 存不了就只影响本次会话
  }
}

// 进入时的问候：固定文案、按时段挑一段，不走 AI，所以没有可编辑的内容
const WELCOME_KEY = "bpi.greeting.welcome.v1";
let welcomeShown = false;

export function welcomeEnabled() {
  try {
    // 默认开：第一次进来就打个招呼
    return localStorage.getItem(WELCOME_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setWelcomeEnabled(next) {
  try {
    localStorage.setItem(WELCOME_KEY, next ? "on" : "off");
  } catch {
    // 同上
  }
}

function welcomeSlot(hour) {
  if (hour >= 5 && hour < 11) return "morning";
  if (hour >= 11 && hour < 14) return "noon";
  if (hour >= 14 && hour < 18) return "afternoon";
  if (hour >= 18 && hour < 23) return "evening";
  return "night";
}

// 给设置面板用：读一次配置，回填各开关的初始状态
export function loadGreetingConfig() {
  return fetchGreetingConfig();
}

// 给设置面板用：只改某一条规则的开关，别的字段不动
export async function setGreetingRule(rule, enabled) {
  await saveGreetingConfig({ [rule]: { enabled } });
}

export function maybeShowWelcome() {
  if (welcomeShown || !welcomeEnabled()) return;
  welcomeShown = true;
  const slot = welcomeSlot(new Date().getHours());
  fetchGreetingConfig()
    .then(async (config) => {
      try {
        const { title, body } = await generateGreeting("welcome");
        if (title) {
          showGreeting({ title, body });
          return;
        }
        throw new Error("empty");
      } catch {
        // AI 不可用（没配、超时）：退回内置的固定文案，至少能打声招呼
        const item = config.welcome?.[slot];
        if (item?.title) showGreeting({ title: item.title, body: item.body ?? "" });
      }
    })
    .catch(() => {
      // 连配置都读不到就当没这回事
    });
}

// 运行提示（bpi_notify）占着右上角时先排队，等那边清空再入场，免得两张卡挤在一起。
// 只在「这次问候要出来」的时候看一眼；忙就挂一个 MutationObserver 等它变空，
// 入场后立刻断开 —— 不弹问候的时候这里一次检测都不做。
function whenNotifyIdle(run) {
  const stack = document.querySelector(".bpi-notif-stack");
  const stackBusy = () => Boolean(stack && stack.childElementCount > 0);
  if (!stackBusy()) {
    run();
    return;
  }
  const observer = new MutationObserver(() => {
    if (stackBusy()) return;
    observer.disconnect();
    run();
  });
  observer.observe(stack, { childList: true });
}

// 入场 + 加载态。返回的 finish(body) 用来把结果填进去并展开；dismiss() 直接收起。
export function startGreeting({ title = "提醒" } = {}) {
  const host = ensureStyle();
  const shadow = host.shadowRoot;
  const dom = buildCard(shadow, title);

  let timers = [];
  let streamTimer = null;
  let roundCount = 0;
  let layerSets = [];
  let initialH = 60;
  let finished = false;

  // 结果展示阶段的自动收起草稿：单独管，方便鼠标悬停时暂停（不占用 timers 数组）
  let holdTimer = null;
  let holdDeadline = 0;
  let holdRemaining = 0;
  const armHold = (ms) => {
    clearTimeout(holdTimer);
    holdRemaining = ms;
    holdDeadline = Date.now() + ms;
    holdTimer = setTimeout(dismiss, ms);
  };
  const pauseHold = () => {
    if (!holdTimer) return;
    clearTimeout(holdTimer);
    holdTimer = null;
    holdRemaining = Math.max(0, holdDeadline - Date.now());
  };
  const resumeHold = () => {
    if (holdTimer || holdRemaining <= 0) return;
    armHold(holdRemaining);
  };

  const later = (fn, ms) => {
    const id = setTimeout(fn, ms);
    timers.push(id);
    return id;
  };
  const clearTimers = () => {
    timers.forEach(clearTimeout);
    timers = [];
  };
  const stopStream = () => {
    if (streamTimer) {
      clearTimeout(streamTimer);
      streamTimer = null;
    }
  };
  const clearStreams = () => {
    dom.purple.querySelectorAll(".stream").forEach((el) => el.remove());
    layerSets = [];
    roundCount = 0;
  };
  const setPurple = (height, instant) => {
    if (instant) {
      dom.purple.classList.add("no-anim");
      dom.notif.style.setProperty("--purple-h", height);
      void dom.purple.offsetWidth;
      dom.purple.classList.remove("no-anim");
    } else {
      dom.notif.style.setProperty("--purple-h", height);
    }
  };

  // 每轮 8 层、z-index 逐轮递增：新轮次整体盖住旧轮次，而不是复用同一批 DOM
  const startStreamLoop = () => {
    roundCount = 0;
    layerSets = [];
    const createRound = () => {
      roundCount += 1;
      const baseZ = roundCount * 100;
      const layers = [];
      STREAM_COLORS.forEach((color, index) => {
        const el = document.createElement("div");
        el.className = "stream";
        el.style.background = color;
        el.style.zIndex = String(baseZ + index);
        el.style.animation = "none";
        el.style.transform = "translateY(-100%)";
        dom.purple.insertBefore(el, dom.result);
        layers.push(el);
      });
      void dom.purple.offsetWidth;
      layers.forEach((el, index) => {
        el.style.animation = `streamDrop ${STREAM_DUR}ms cubic-bezier(.4,0,.2,1) ${index * STREAM_GAP}ms forwards`;
      });
      layerSets.push(layers);
      while (layerSets.length > 2) {
        layerSets.shift().forEach((el) => el.remove());
      }
      const cycle = (STREAM_COLORS.length - 1) * STREAM_GAP + STREAM_DUR;
      streamTimer = setTimeout(createRound, Math.max(cycle - OVERLAP, STREAM_GAP * 2));
    };
    createRound();
  };

  const finishLoading = (fullH) => {
    stopStream();
    dom.notif.classList.remove("fetching");
    dom.result.style.animation = "none";
    void dom.result.offsetWidth;
    dom.result.style.animation = `resultDrop ${STREAM_DUR}ms cubic-bezier(.4,0,.2,1) forwards`;
    later(() => {
      dom.notif.classList.add("expand");
      setPurple("3px", false);
      dom.notif.style.height = `${fullH + 3}px`;
    }, STREAM_DUR);
  };

  const dismiss = () => {
    if (!begun) {
      host.remove();
      return;
    }
    clearTimeout(holdTimer);
    holdTimer = null;
    clearTimers();
    stopStream();
    if (dom.notif.classList.contains("out")) return;
    dom.notif.classList.remove("expand", "fetching");
    dom.notif.classList.add("covering");
    dom.notif.style.height = `${initialH}px`;
    setPurple("0px", true);
    dom.result.style.animation = "none";
    later(() => {
      dom.notif.classList.add("out");
      later(() => {
        dom.behind.classList.add("wipe");
        later(() => {
          dom.behind2.classList.add("wipe");
          later(() => {
            dom.under.classList.add("wipe");
            later(() => {
              // 静默复位：先关过渡再摘类，否则元素会从右侧飞回去
              dom.under.style.transition = "none";
              dom.behind.style.transition = "none";
              dom.behind2.style.transition = "none";
              dom.under.classList.remove("show", "wipe");
              dom.behind.classList.remove("show", "wipe");
              dom.behind2.classList.remove("show", "wipe");
              void dom.under.offsetWidth;
              dom.under.style.transition = "";
              dom.behind.style.transition = "";
              dom.behind2.style.transition = "";
              host.remove();
            }, 505);
          }, 110);
        }, 160);
      }, 160);
    }, 620);
  };

  // ── 阶段 1 入场 + 阶段 2 加载（排队等到才跑）──
  let begun = false;
  let begunAt = 0;
  let pendingBody = null;
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });

  const begin = () => {
    begun = true;
    begunAt = Date.now();
    clearTimers();
    stopStream();
    clearStreams();
    dom.notif.classList.remove("play", "out", "expand", "covering", "fetching");
    dom.under.classList.remove("show", "wipe");
    dom.behind.classList.remove("show", "wipe");
    dom.behind2.classList.remove("show", "wipe");
    dom.result.style.animation = "none";
    setPurple("0px", true);

    dom.notif.style.transition = "none";
    dom.notif.style.height = "auto";
    void dom.notif.offsetWidth;
    // 只用标题那一行的高度：head 里还挂着思考点（透明但占位），算进去会多出一截
    initialH = dom.titleEl.offsetHeight + 38;
    const loadedH = initialH * 2;
    dom.notif.style.height = `${initialH}px`;
    void dom.notif.offsetWidth;
    dom.notif.style.transition = "";
    void dom.notif.offsetWidth;

    dom.notif.classList.add("play");
    void dom.under.offsetWidth;
    void dom.behind.offsetWidth;
    void dom.behind2.offsetWidth;
    dom.under.classList.add("show");
    dom.behind.classList.add("show");
    dom.behind2.classList.add("show");

    later(() => {
      dom.notif.classList.add("fetching");
      setPurple(`${initialH}px`, false);
      dom.notif.style.height = `${loadedH}px`;
      startStreamLoop();
    }, 1150);

    resolveReady();
    if (pendingBody !== null) {
      const body = pendingBody;
      pendingBody = null;
      finish(body);
    }
  };
  whenNotifyIdle(begin);

  const finish = (body) => {
    if (finished) return;
    if (!begun) {
      // 还在排队：先把结果存着，入场那一刻立刻填进去
      pendingBody = body;
      return;
    }
    finished = true;
    // AI 可能在入场动画还没走完时就返回：等加载阶段开始再落结果，否则紫色层没处长
    const wait = Math.max(0, 1150 - (Date.now() - begunAt));
    if (wait > 0) {
      later(() => finishLoadingNow(body), wait);
      return;
    }
    finishLoadingNow(body);
  };

  const finishLoadingNow = (body) => {
    dom.extra.textContent = String(body ?? "");
    // 量真实高度：先放开，量完压回当前高度，再让 finishLoading 做展开
    dom.notif.style.transition = "none";
    dom.notif.style.height = "auto";
    void dom.notif.offsetWidth;
    const grownH = dom.notif.offsetHeight;
    dom.notif.style.height = `${initialH * 2}px`;
    void dom.notif.offsetWidth;
    dom.notif.style.transition = "";
    finishLoading(grownH);
    // 结果到了才开始计时：按字数给阅读时间，最少 MIN_HOLD_MS
    const plain = String(body ?? "").replace(/\s+/g, "").length;
    const holdMs = Math.max(MIN_HOLD_MS, Math.ceil(plain / CHARS_PER_SECOND) * 1000);
    armHold(STREAM_DUR + holdMs);
  };

  // 鼠标停在卡片上就不收：移开后按剩余时间继续数
  dom.notif.addEventListener("mouseenter", pauseHold);
  dom.notif.addEventListener("mouseleave", resumeHold);

  dom.closeBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    dismiss();
  });
  // 点卡片正文也能收起（方便测试）
  dom.notif.addEventListener("click", dismiss);

  // AI 返回后才知道标题，这里只换标题文字，三个跳动点保留
  const setTitle = (text) => {
    const textNode = Array.from(dom.titleEl.childNodes).find((node) => node.nodeType === 3);
    if (textNode) textNode.nodeValue = String(text ?? "");
    else dom.titleEl.insertBefore(document.createTextNode(String(text ?? "")), dom.titleEl.firstChild);
  };

  return { finish, dismiss, ready, setTitle, notif: dom.notif };
}

// 已有文案时用这个：入场 → 加载 → 直接给结果
export function showGreeting({ title = "提醒", body = "" } = {}) {
  const card = startGreeting({ title });
  card.ready.then(() => {
    setTimeout(() => card.finish(body), 1150);
  });
  return card;
}

// ── 统计：只给问候当上下文用，不上传、不写日志文件 ────────────────────────
const STATS_KEY = "bpi.greeting.stats.v1";
const SESSION_START = Date.now();

function todayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
}

function readStats() {
  try {
    const data = JSON.parse(localStorage.getItem(STATS_KEY) || "{}");
    if (!data || data.date !== todayKey()) return { date: todayKey(), images: 0 };
    return { date: data.date, images: Number(data.images) || 0 };
  } catch {
    return { date: todayKey(), images: 0 };
  }
}

function addImages(count) {
  if (!count) return;
  const stats = readStats();
  stats.images += count;
  try {
    localStorage.setItem(STATS_KEY, JSON.stringify(stats));
  } catch {
    // 存不了就只影响本次统计
  }
}

// 每次节点执行完，把这次产出的图片数累加到今天
// 每次节点执行完：累计今天的张数，顺便看看有没有跨过「夸一夸」的门槛
function watchExecutions() {
  const api = window.api || window.comfyAPI?.api;
  if (!api?.addEventListener) return;
  api.addEventListener("executed", (event) => {
    const images = event?.detail?.output?.images;
    if (!Array.isArray(images) || !images.length) return;
    addImages(images.length);
    handleImageRule(images.length);
  });
}
watchExecutions();

function sessionMinutes() {
  return Math.max(1, Math.round((Date.now() - SESSION_START) / 60000));
}

// ── 问候的设置：一句话描述「希望 AI 怎么跟我说」 ──────────────────────────
async function fetchGreetingConfig() {
  const response = await bpiFetch("/bpi/greeting/config");
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.success) throw new Error(payload?.error || "读取问候设置失败");
  return payload.data ?? {};
}

async function saveGreetingConfig(payload) {
  const body = typeof payload === "string" ? { prompt: payload } : payload;
  const response = await bpiFetch("/bpi/greeting/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.success) throw new Error(result?.error || "保存失败");
  return result.data ?? {};
}

// 内联在设置面板里展开：弹窗会被 ComfyUI 的设置面板压住，点不动输入框
export function createGreetingSettingsPanel() {
  const wrap = element("div", "bpi-greet-settings");
  wrap.style.gridColumn = "1 / -1";
  wrap.hidden = true;

  const hint = element("div", "bpi-config-note", "希望 AI 怎么跟我说（这段作为系统提示词；返回的第一行当标题）：");
  const area = element("textarea", "bpi-greet-prompt");
  area.rows = 6;
  // 随机提醒：每分钟一次机会，概率用「几分之一」表示
  const randomLine = element("div", "bpi-switch-line");
  const randomRow = element("label", "bpi-switch-row bpi-switch-accent");
  const randomToggle = element("input", "bpi-switch");
  randomToggle.type = "checkbox";
  const randomTrack = element("span", "bpi-switch-track");
  randomTrack.appendChild(element("span", "bpi-switch-thumb"));
  randomRow.append(randomToggle, randomTrack, element("span", "bpi-switch-text", "随机提醒"));
  const randomChanceInput = element("input");
  randomChanceInput.type = "number";
  randomChanceInput.min = "2";
  randomChanceInput.max = "1440";
  randomChanceInput.step = "1";
  randomChanceInput.style.maxWidth = "72px";
  randomLine.append(
    randomRow,
    element("span", "bpi-switch-text", "每分钟 1/"),
    randomChanceInput,
    element("span", "bpi-switch-text", "的概率说一句（用上面这段文案）"),
  );
  const randomHelp = element("span", "bpi-help", "?");
  randomHelp.appendChild(element("span", "bpi-help-pop",
    "每分钟掷一次骰子，填 10 就是 1/10 的概率；填 5 更常出现，填 60 大约一小时一次。用的是上面这段通用文案，提示词文件：data/greeting_defaults.json（prompt 段）。"));
  randomLine.appendChild(randomHelp);

  const actions = element("div", "bpi-modal-actions");
  const status = element("span", "bpi-config-note");
  const resetButton = button("恢复默认", async () => {
    try {
      const config = await fetchGreetingConfig();
      area.value = config.default_prompt ?? "";
      status.textContent = "";
    } catch (failure) {
      status.textContent = failure.message;
    }
  });
  const saveButton = button("保存", async () => {
    saveButton.disabled = true;
    try {
      await saveGreetingConfig({
        prompt: area.value,
        random_rule: {
          enabled: randomToggle.checked,
          chance: Number(randomChanceInput.value) || 10,
        },
      });
      restartGreetingAutoTimer();
      status.textContent = "已保存";
    } catch (failure) {
      status.textContent = failure.message;
    } finally {
      saveButton.disabled = false;
    }
  }, "bpi-primary");
  actions.append(resetButton, saveButton, status);
  wrap.append(hint, area, randomLine, actions);

  fetchGreetingConfig()
    .then((config) => {
      area.value = config.prompt ?? "";
      area.placeholder = config.default_prompt ?? "";
      randomToggle.checked = config.random_rule?.enabled === true;
      randomChanceInput.value = String(config.random_rule?.chance ?? 10);
    })
    .catch((failure) => {
      status.textContent = failure.message;
    });
  return wrap;
}

export async function generateGreeting(scene = "") {
  const info = scene === "time"
    ? `本次已连续使用 ${sessionMinutes()} 分钟`
    : scene === "images"
      ? `今天已经累计生成 ${readStats().images} 张图`
      : scene === "welcome"
        ? `现在是 ${new Date().getHours()} 点`
        : "";
  const instruction = info ? `当前情况：${info}。请把这一点自然带进提醒里。` : "";
  const output = await runInspectorAssistant("greeting", "现在写一条提醒", instruction, scene);
  const text = String(output).trim();
  // 运行时间 / 图片生成的标题是固定的，AI 只负责正文；其余场景连标题一起给
  const fixedTitleScenes = scene === "time" || scene === "images";
  if (fixedTitleScenes) return { title: "", body: text };
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  let firstLine = lines[0] ?? "";
  while (firstLine.startsWith("#")) firstLine = firstLine.slice(1);
  const title = firstLine.trim().slice(0, 24) || "今日提醒";
  const body = lines.slice(1).join("\n") || lines[0] || "";
  return { title, body };
}

// ── 自动提示：两种触发，各有各的间隔和提示词 ──────────────────────────────
let autoTimer = null;
let imageRuleEnabled = false;
let imageRuleCount = 0;
let imagesSinceLastPraise = 0;

// 标题由 AI 给的场景：先用个占位标题占住位置，回来再换
async function showAiGreeting(scene) {
  const card = startGreeting({ title: "……" });
  try {
    const { title, body } = await generateGreeting(scene);
    card.setTitle(title || "提示");
    card.finish(body);
  } catch {
    card.dismiss();
  }
}

async function showSceneGreeting(scene, { reportErrors = false } = {}) {
  // 标题是确定的（在线多久 / 生成多少张），先出卡进入加载态，等 AI 回来再填正文
  const title = scene === "time"
    ? `当前在线 ${sessionMinutes()} 分钟`
    : `已经生成 ${readStats().images} 张`;
  const card = startGreeting({ title });
  try {
    const { body } = await generateGreeting(scene);
    card.finish(body);
  } catch (failure) {
    card.dismiss();
    // 自动触发失败不打扰；手动点「测试」要把原因说出来
    if (reportErrors) notify(failure.message || "生成失败", "error");
  }
}

function handleImageRule(gained) {
  if (!imageRuleEnabled || imageRuleCount <= 0) return;
  if (!greetingEnabled()) return;
  imagesSinceLastPraise += gained;
  if (imagesSinceLastPraise < imageRuleCount) return;
  imagesSinceLastPraise = 0;
  showSceneGreeting("images");
}

// 生成失败：只告诉 AI「刚才失败了」，不带任何报错细节；1/5 概率才安慰
let comfortOnError = false;
let nudgeWhenIdle = false;
const ERROR_CHANCE = 0.2; // 1/5 的失败才会被安慰一次
const IDLE_MINUTES = 1;

function onGenerationFailure() {
  if (!comfortOnError || !greetingEnabled()) return;
  if (Math.random() >= ERROR_CHANCE) return;
  showAiGreeting("error");
}

function watchFailures() {
  const api = window.api || window.comfyAPI?.api;
  if (!api) return;
  // 执行中途失败（采样崩了、节点抛异常）
  api.addEventListener?.("execution_error", onGenerationFailure);
  // 提交阶段就被拒（缺模型、参数不合法）不会发 execution_error，
  // 只能拦 /prompt 的响应：非 2xx 就算一次失败
  if (typeof api.fetchApi === "function" && !api.__bpiGreetingWrapped) {
    const original = api.fetchApi.bind(api);
    api.fetchApi = async (route, options) => {
      const isPrompt = String(route).includes("/prompt");
      let response;
      try {
        response = await original(route, options);
      } catch (error) {
        if (isPrompt) onGenerationFailure();
        throw error;
      }
      if (!response.ok && isPrompt) onGenerationFailure();
      return response;
    };
    api.__bpiGreetingWrapped = true;
  }
}

// 随机提醒：每分钟掷一次骰子，1/chance 命中就说一句（用通用提示词）
let randomEnabled = false;
let randomChance = 10;

function watchRandom() {
  setInterval(() => {
    if (!randomEnabled || !greetingEnabled()) return;
    if (Math.random() >= 1 / randomChance) return;
    showAiGreeting("");
  }, 60 * 1000);
}

let lastActivityAt = Date.now();
let idleNotified = false;

function watchIdle() {
  const bump = () => {
    lastActivityAt = Date.now();
    idleNotified = false;
  };
  // 只挂键盘 / 点击 / 滚轮：鼠标单纯移动太频繁，不算「在动手」
  for (const type of ["keydown", "pointerdown", "wheel"]) {
    document.addEventListener(type, bump, { capture: true, passive: true });
  }
  setInterval(() => {
    if (!nudgeWhenIdle || idleNotified || !greetingEnabled()) return;
    if (Date.now() - lastActivityAt < IDLE_MINUTES * 60 * 1000) return;
    idleNotified = true;
    showAiGreeting("idle");
  }, 15000);
}

watchFailures();
watchIdle();
watchRandom();

export function restartGreetingAutoTimer() {
  if (autoTimer) {
    clearInterval(autoTimer);
    autoTimer = null;
  }
  fetchGreetingConfig()
    .then((config) => {
      const timeRule = config.time_rule ?? {};
      const imageRule = config.image_rule ?? {};
      comfortOnError = config.error_rule?.enabled === true;
      randomEnabled = config.random_rule?.enabled === true;
      randomChance = Number(config.random_rule?.chance) || 10;
      nudgeWhenIdle = config.idle_rule?.enabled === true;
      imageRuleEnabled = imageRule.enabled === true;
      imageRuleCount = Number(imageRule.count) || 0;
      imagesSinceLastPraise = 0;
      const minutes = Number(timeRule.minutes) || 0;
      if (timeRule.enabled !== true || minutes <= 0) return;
      autoTimer = setInterval(() => {
        if (!greetingEnabled()) return;
        showSceneGreeting("time");
      }, minutes * 60 * 1000);
    })
    .catch(() => {});
}

// 问候自己的 AI（可选）：不打开「使用助手设置里的 AI」时才用这套
export function createGreetingAiPanel() {
  const fold = element("details", "bpi-fold");
  fold.style.gridColumn = "1 / -1";
  const body = element("div", "bpi-fold-body");

  const useRow = element("label", "bpi-switch-row bpi-switch-accent");
  const useSwitch = element("input", "bpi-switch");
  useSwitch.type = "checkbox";
  const useTrack = element("span", "bpi-switch-track");
  useTrack.appendChild(element("span", "bpi-switch-thumb"));
  useRow.append(useSwitch, useTrack, element("span", "bpi-switch-text", "使用助手设置里的 AI"));

  // 温度一直显示：即使借用助手的 AI，问候也用自己这一份温度，不动翻译那套
  const tempLine = element("div", "bpi-switch-line");
  tempLine.append(element("span", "bpi-switch-text", "温度"));
  const tempInput = element("input");
  tempInput.type = "number";
  tempInput.min = "0";
  tempInput.max = "2";
  tempInput.step = "0.05";
  tempInput.style.maxWidth = "96px";
  tempLine.append(tempInput);

  const fields = element("div", "bpi-greet-settings");
  const baseLabel = element("label", "", "API 地址");
  const baseInput = element("input");
  baseInput.placeholder = "https://api.example.com/v1";
  const modelLabel = element("label", "", "模型名称");
  const modelLine = element("div", "bpi-model-line");
  const modelInput = element("input");
  modelInput.placeholder = "gpt-4o-mini";
  // 不用 datalist：设置面板里那种原生下拉点不动，改成横跨整行的候选按钮（和助手的模型行一致）
  const picks = element("div", "bpi-model-picks bpi-hidden");
  const fetchModels = button("获取模型", async () => {
    fetchModels.disabled = true;
    try {
      const models = await listAssistantModels({
        backend: "openai",
        base_url: baseInput.value.trim(),
        api_key: keyInput.value.trim(),
      });
      picks.replaceChildren();
      for (const name of models) {
        const item = button(name, () => {
          modelInput.value = name;
          picks.classList.add("bpi-hidden");
        }, "bpi-model-pick");
        item.type = "button";
        picks.appendChild(item);
      }
      picks.classList.toggle("bpi-hidden", models.length === 0);
      status.textContent = models.length ? `拿到 ${models.length} 个模型，点一个填入` : "服务端没有返回模型";
    } catch (failure) {
      picks.replaceChildren();
      picks.classList.add("bpi-hidden");
      status.textContent = failure.message;
    } finally {
      fetchModels.disabled = false;
    }
  }, "bpi-mini");
  modelLine.append(modelInput, fetchModels);

  const keyLabel = element("label", "", "密钥");
  const keyInput = element("input");
  keyInput.type = "password";
  keyInput.placeholder = "留空表示沿用已保存的那份";
  const clearRow = element("label", "bpi-switch-row");
  const clearSwitch = element("input", "bpi-switch");
  clearSwitch.type = "checkbox";
  const clearTrack = element("span", "bpi-switch-track");
  clearTrack.appendChild(element("span", "bpi-switch-thumb"));
  clearRow.append(
    clearSwitch,
    clearTrack,
    element("span", "bpi-switch-text", "删除已保存的密钥"),
    element("span", "bpi-switch-hint", "保存后生效"),
  );

  const actions = element("div", "bpi-modal-actions");
  const status = element("span", "bpi-config-note");
  const saveButton = button("保存", async () => {
    saveButton.disabled = true;
    try {
      await saveGreetingConfig({
        use_assistant_ai: useSwitch.checked,
        api_base_url: baseInput.value.trim(),
        model: modelInput.value.trim(),
        api_key: keyInput.value.trim(),
        clear_api_key: clearSwitch.checked,
        temperature: Number(tempInput.value),
      });
      keyInput.value = "";
      clearSwitch.checked = false;
      status.textContent = "已保存";
    } catch (failure) {
      status.textContent = failure.message;
    } finally {
      saveButton.disabled = false;
    }
  }, "bpi-primary");
  actions.append(saveButton, status);

  // 先填地址和密钥，才拿得到模型列表，所以密钥排在模型前面
  fields.append(baseLabel, baseInput, keyLabel, keyInput, clearRow, modelLabel, modelLine, picks);
  const syncVisibility = () => {
    fields.hidden = useSwitch.checked;
  };
  useSwitch.addEventListener("change", syncVisibility);
  body.append(useRow, tempLine, fields, actions);
  fold.append(element("summary", "", "问候的 AI"), body);

  fetchGreetingConfig()
    .then((config) => {
      useSwitch.checked = config.use_assistant_ai !== false;
      baseInput.value = config.api_base_url ?? "";
      modelInput.value = config.model ?? "";
      keyInput.placeholder = config.api_key_configured ? "已保存；留空表示不改" : "必填";
      tempInput.value = String(config.temperature ?? 0.8);
      syncVisibility();
    })
    .catch((failure) => {
      status.textContent = failure.message;
    });
  return fold;
}

// 自动提示：久坐提醒 + 生成夸夸，两个场景各自独立配置
export function createGreetingAutoPanel() {
  const fold = element("details", "bpi-fold");
  fold.style.gridColumn = "1 / -1";
  const body = element("div", "bpi-fold-body");

  const makeSwitchRow = (labelText, extraNodes = []) => {
    const row = element("div", "bpi-switch-line");
    const label = element("label", "bpi-switch-row bpi-switch-accent");
    const input = element("input", "bpi-switch");
    input.type = "checkbox";
    const track = element("span", "bpi-switch-track");
    track.appendChild(element("span", "bpi-switch-thumb"));
    label.append(input, track, element("span", "bpi-switch-text", labelText));
    row.append(label, ...extraNodes);
    return { row, input };
  };

  const makeNumber = (value, min, max, step, width = "84px") => {
    const input = element("input");
    input.type = "number";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.style.maxWidth = width;
    return input;
  };

  const makePrompt = (placeholder) => {
    const area = element("textarea", "bpi-greet-prompt");
    area.rows = 3;
    area.placeholder = placeholder;
    return area;
  };

  // ── 久坐提醒 ──
  const timeMinutes = makeNumber(30, 1, 480, 5);
  const timeHelp = element("span", "bpi-help", "?");
  timeHelp.appendChild(element("span", "bpi-help-pop", "久坐提醒：坐太久就提醒你起来活动、喝水或歇歇眼睛"));
  const timeTest = button("测试", () => showSceneGreeting("time", { reportErrors: true }), "bpi-mini");
  const timeRow = makeSwitchRow("运行时间　每隔", [
    timeMinutes,
    element("span", "bpi-switch-text", "分钟"),
    timeHelp,
    timeTest,
  ]);
  const timePrompt = makePrompt("留空则用内置文案（提醒起来活动、喝水）");
  const timeBlock = element("div", "bpi-greet-settings");
  timeBlock.append(timeRow.row, timePrompt);

  // ── 生成夸夸 ──
  const imageCount = makeNumber(10, 1, 500, 1);
  const imageHelp = element("span", "bpi-help", "?");
  imageHelp.appendChild(element("span", "bpi-help-pop", "图片生成：每攒够这么多张就夸你一句，夸完重新计数"));
  const imageTest = button("测试", () => showSceneGreeting("images", { reportErrors: true }), "bpi-mini");
  const imageRow = makeSwitchRow("图片生成　每", [
    imageCount,
    element("span", "bpi-switch-text", "张"),
    imageHelp,
    imageTest,
  ]);
  const imagePrompt = makePrompt("留空则用内置文案（夸一夸，可以提到数量）");
  const imageBlock = element("div", "bpi-greet-settings");
  imageBlock.append(imageRow.row, imagePrompt);

  const note = element("div", "bpi-config-note", "两个场景的提示词各写各的，互不影响；「请求」按钮用的是「设置」里那句通用文案。");
  // 后端下发的默认文案，点「默认」时填回来
  const defaults = { time: "", image: "" };
  const actions = element("div", "bpi-modal-actions");
  const status = element("span", "bpi-config-note");
  const resetButton = button("默认", () => {
    timePrompt.value = defaults.time;
    imagePrompt.value = defaults.image;
    status.textContent = "已填入默认文案，记得保存";
  }, "bpi-mini");
  const saveButton = button("保存", async () => {
    saveButton.disabled = true;
    try {
      await saveGreetingConfig({
        time_rule: {
          enabled: timeRow.input.checked,
          minutes: Number(timeMinutes.value) || 30,
          prompt: timePrompt.value.trim(),
        },
        image_rule: {
          enabled: imageRow.input.checked,
          count: Number(imageCount.value) || 10,
          prompt: imagePrompt.value.trim(),
        },
      });
      status.textContent = "已保存";
      restartGreetingAutoTimer();
    } catch (failure) {
      status.textContent = failure.message;
    } finally {
      saveButton.disabled = false;
    }
  }, "bpi-primary");
  actions.append(resetButton, saveButton, status);
  body.append(timeBlock, imageBlock, note, actions);
  fold.append(element("summary", "", "自动提示"), body);

  fetchGreetingConfig()
    .then((config) => {
      const timeRule = config.time_rule ?? {};
      const imageRule = config.image_rule ?? {};
      timeRow.input.checked = timeRule.enabled === true;
      timeMinutes.value = String(timeRule.minutes ?? 30);
      timePrompt.value = timeRule.prompt ?? "";
      imageRow.input.checked = imageRule.enabled === true;
      imageCount.value = String(imageRule.count ?? 10);
      imagePrompt.value = imageRule.prompt ?? "";
      defaults.time = config.default_time_prompt ?? "";
      defaults.image = config.default_image_prompt ?? "";
    })
    .catch((failure) => {
      status.textContent = failure.message;
    });
  return fold;
}

// 让 AI 现写一条：拿不到（没配 AI / 请求失败）就抛错，由调用方决定怎么兜底

if (typeof window !== "undefined") {
  // 等会话令牌和设置面板就绪再弹，太早会碰上初始化
  setTimeout(() => {
    maybeShowWelcome();
    // 这里先读一次配置：失败安慰 / 静默招呼的开关状态靠它，
    // 不能等用户打开设置面板才生效
    restartGreetingAutoTimer();
  }, 2000);
}
