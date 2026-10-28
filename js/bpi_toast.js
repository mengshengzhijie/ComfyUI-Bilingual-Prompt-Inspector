// 右下角贴边堆叠 Toast（临时提示）
// 模板原件：.workbuddy/refs/toast-template.html —— 动画、贴边造型、堆叠与防卡死写法照搬。
// 和右上角那套 js/bpi_notify.js 是两套，互不干扰：那边是双层纸 + 从上往下 + 展开正文，
// 这边是贴着右下角长出来、强调色遮罩从左往右刷过、整条向右滑走。

import { t } from "./i18n.js";

const STYLE_ID = "bpi-toast-style";
// 和右上角那套一样，开关只存本地：这是表现层的事，不进后端 assistant_settings
const STORAGE_KEY = "bpi.toast.v1";

// 默认开：逐条提示本来就在用，关掉才会退回状态栏
export function toastEnabled() {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== "0";
  } catch (error) {
    return true;
  }
}

export function setToastEnabled(next) {
  try {
    window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
  } catch (error) {
    /* 隐私模式下写不进去就算了，本次会话内仍按传入值生效 */
  }
}

// JS 与 CSS 必须同步：COVER_DURATION 是 .bpi-toast-cover 的时长，SLIDE_DURATION 是 .is-out 的时长
const MAX_VISIBLE = 5;
const AUTO_DISMISS = 3000;
const COVER_DURATION = 180;
const SLIDE_DURATION = 320;
const REMOVE_DELAY = SLIDE_DURATION + 40;

// 同一车道（lane）最多同时挂几条：满了就顶掉最旧的一条。
// 车道是给「一批同类消息排队」准备的（试过给批量翻译用，已撤），目前没人传 lane
const LANE_MAX = 3;
// 被顶掉之前至少要显示这么久，免得结果来得太快、字还没看清就被刷走
const LANE_MIN_HOLD = 1200;

// 橙 = 开关重复（右下角），蓝 = 节点的增删改移 / 隐藏；
// 紫 = 翻译、红 = 被拒是备着的，暂时没人调用
export const TOAST_ACCENTS = {
  edit: "#60a5fa",
  duplicate: "#fbbf24",
  translate: "#a78bfa",
  rejected: "#e06c75",
};

// 图标是塞进 24×24 viewBox 的内联 SVG 片段，颜色靠 currentColor 吃 --bpi-toast-accent
const ICONS = {
  duplicate:
    '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  translate:
    '<path d="M5 8L10 13M4 14L10 8L12 5M2 5H14M7 2H8M12.913 17H20.087M12.913 17L11 21M12.913 17L15.7783 11.009C16.0092 10.5263 16.1246 10.2849 16.2826 10.2086C16.4199 10.1423 16.5801 10.1423 16.7174 10.2086C16.8754 10.2849 16.9908 10.5263 17.2217 11.009L20.087 17M20.087 17L22 21"/>',
  notice: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>',
  rejected: '<circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>',
};

const CLOSE_SVG =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

// 强调线（::before）、图标、抹开遮罩三处共用这一个变量
const CSS = `
.bpi-toast-stack{position:fixed;right:0;bottom:0;width:340px;max-width:calc(100vw - 28px);display:flex;flex-direction:column-reverse;gap:10px;z-index:9999;pointer-events:none}
/* 亮色下不用那么重的黑影 */
[data-bpi-theme="light"] .bpi-toast-stack{--bpi-toast-shadow:0 10px 26px rgba(0,0,0,.14),0 2px 6px rgba(0,0,0,.10)}
.bpi-toast{position:relative;display:flex;align-items:center;gap:10px;padding:13px 16px;background:var(--bpi-surface-modal,#20252d);border:1px solid var(--bpi-border,#3a4250);border-right:0;border-radius:8px 0 0 8px;box-shadow:var(--bpi-toast-shadow,0 10px 30px rgba(0,0,0,.5),0 2px 6px rgba(0,0,0,.3));font-size:13px;line-height:1.45;color:var(--bpi-text,#e6edf7);pointer-events:auto;overflow:hidden;opacity:0;transform:translateX(100%);transition:transform .45s cubic-bezier(.16,1,.3,1),opacity .35s ease;will-change:transform,opacity}
.bpi-toast.is-in{opacity:1;transform:translateX(0)}
/* 位置被上下顶动时的平滑位移；必须写在 .is-out 之前，退场那条要能盖过它 */
.bpi-toast.bpi-flip{transition:transform .35s cubic-bezier(.16,1,.3,1)}
/* 退场全程不透明：淡出会让人觉得是「直接消失」 */
.bpi-toast.is-out{opacity:1;transform:translateX(100%);transition:transform .32s cubic-bezier(.55,0,.8,.4)}
.bpi-toast::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;border-radius:8px 0 0 8px;background:var(--bpi-toast-accent,#fbbf24);z-index:1}
.bpi-toast-cover{position:absolute;inset:0;border-radius:8px 0 0 8px;background:var(--bpi-toast-accent,#fbbf24);transform:translateX(-101%);transition:transform .18s cubic-bezier(.45,0,.2,1);z-index:5;pointer-events:none;will-change:transform}
.bpi-toast.is-covering .bpi-toast-cover{transform:translateX(0)}
.bpi-toast-icon{flex:0 0 20px;width:20px;height:20px;display:grid;place-items:center;color:var(--bpi-toast-accent,#fbbf24);position:relative;z-index:2}
.bpi-toast-text{flex:1;min-width:0;word-break:break-word;position:relative;z-index:2}
.bpi-toast-close{flex:0 0 20px;width:20px;height:20px;display:grid;place-items:center;padding:0;border:0;border-radius:4px;background:transparent;color:var(--bpi-text-muted,#aab5c5);cursor:pointer;position:relative;z-index:6;transition:background .15s ease,color .15s ease}
.bpi-toast-close:hover{background:var(--bpi-handle-hover-bg,#2b3a4d);color:var(--bpi-text,#e6edf7)}
@media (prefers-reduced-motion: reduce){
  .bpi-toast,.bpi-toast-cover{transition-duration:.01ms !important}
}
`;

let stack = null;

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

function ensureStack() {
  if (stack && stack.isConnected) return stack;
  injectStyle();
  stack = document.createElement("div");
  stack.className = "bpi-toast-stack";
  document.body.appendChild(stack);
  return stack;
}

// FLIP：记下每条当前的位置，等布局变了再让它们从旧位置滑到新位置，避免「闪现」
function snapshotTops(host, skip) {
  const tops = new Map();
  Array.from(host.children).forEach((el) => {
    if (el !== skip) tops.set(el, el.getBoundingClientRect().top);
  });
  return tops;
}

function reflow(host, tops) {
  tops.forEach((top, el) => {
    // 只挪已经入场、又没在退场的：正在入场/退场的动自己的动画，别插手
    if (!el.isConnected || el._dismissed || !el.classList.contains("is-in")) return;
    const delta = top - el.getBoundingClientRect().top;
    if (!delta) return;
    el.style.transition = "none";
    el.style.transform = `translateY(${delta}px)`;
    void el.offsetWidth;
    // 关键：必须把内联的 transition:none 交回 CSS，否则它一直压着 .is-out 的过渡，
    // 这条之后退场就会「动画没播完直接消失」
    el.style.transition = "";
    el.classList.add("bpi-flip");
    el.style.transform = "";
    setTimeout(() => el.classList.remove("bpi-flip"), 380);
  });
}

// 移除一条时让剩下的平滑补位
function dropEl(host, el) {
  const tops = snapshotTops(host, el);
  el.remove();
  reflow(host, tops);
}

function dismiss(el, immediate = false) {
  if (!el) return;

  // 被顶走的分支必须排在最前面并无条件移除：
  // 先判 _dismissed 的话，正在等动画的那条会一直留在 DOM 里，while 循环反复拿到它 → 卡死
  if (immediate) {
    el._dismissed = true;
    clearTimeout(el._timer);
    dropEl(el.parentNode, el);
    return;
  }

  if (el._dismissed) return;
  el._dismissed = true;
  clearTimeout(el._timer);
  // 补位动画可能还挂着，退场前先摘掉，别让它抢 .is-out 的过渡
  el.classList.remove("bpi-flip");
  el.style.transform = "";
  el.style.transition = "";

  el.classList.add("is-covering");

  setTimeout(() => {
    if (!el.isConnected) return;
    el.classList.add("is-out");
    setTimeout(() => {
      if (el.isConnected) dropEl(el.parentNode, el);
    }, REMOVE_DELAY);
  }, COVER_DURATION);
}

// 车道内还活着（没被标记退场）的条目，顺序是 新 → 旧
function laneAlive(host, lane) {
  return Array.from(host.children).filter((el) => el._lane === lane && !el._dismissed);
}

// 只多一条时给足停留时间；积压多了就立刻收，不然会越堆越高
function trimLane(host, lane) {
  const alive = laneAlive(host, lane);
  const excess = alive.length - LANE_MAX;
  for (let i = 0; i < excess; i += 1) {
    const victim = alive[alive.length - 1 - i];
    if (!victim) break;
    const wait = Math.max(0, LANE_MIN_HOLD - (Date.now() - victim._shownAt));
    if (!wait || i > 0) {
      dismiss(victim);
      continue;
    }
    setTimeout(() => {
      if (victim.isConnected && !victim._dismissed) dismiss(victim);
    }, wait);
  }
}

// message 走 t()；type 决定强调色与图标，也可以直接传 accent / icon 覆盖。
// lane 相同的一批会共用 3 个位置：新的从最下面长出来，最旧的从上面被顶走。
export function showToast(message, options = {}) {
  // 关掉时直接不建 DOM：调用方自己退回状态栏（返回 false 就是告诉它「我没显示」）
  if (!toastEnabled()) return false;
  const host = ensureStack();
  const type = options.type || "";
  const accent = options.accent || TOAST_ACCENTS[type] || TOAST_ACCENTS.duplicate;
  const markup = options.icon || ICONS[type] || ICONS.notice;

  const el = document.createElement("div");
  el.className = "bpi-toast";
  el.style.setProperty("--bpi-toast-accent", accent);

  const cover = document.createElement("div");
  cover.className = "bpi-toast-cover";

  const icon = document.createElement("span");
  icon.className = "bpi-toast-icon";
  icon.innerHTML =
    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"` +
    ` stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${markup}</svg>`;

  const text = document.createElement("span");
  text.className = "bpi-toast-text";
  text.textContent = t(message);

  const close = document.createElement("button");
  close.className = "bpi-toast-close";
  close.type = "button";
  close.title = t("Close");
  close.setAttribute("aria-label", t("Close"));
  close.innerHTML = CLOSE_SVG;

  el.append(cover, icon, text, close);

  el._lane = options.lane || "";
  el._shownAt = Date.now();

  // column-reverse 的主轴起点在下方，插到最前面 = 视觉最下面；旧的自然往上顶
  const before = snapshotTops(host, null);
  host.insertBefore(el, host.firstChild);

  // 全局上限：超了取 DOM 最后一条（视觉最上面、最旧的那条）直接移除，不播动画
  while (host.children.length > MAX_VISIBLE) {
    dismiss(host.lastElementChild, true);
  }
  if (el._lane) trimLane(host, el._lane);
  reflow(host, before);

  // 双 rAF：确保初始样式（translateX(100%)）已经渲染过一帧，否则过渡不会触发
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (el.isConnected) el.classList.add("is-in");
  }));

  close.addEventListener("click", () => dismiss(el));
  el._timer = setTimeout(() => dismiss(el), AUTO_DISMISS);
  return el;
}
