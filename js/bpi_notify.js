// 右上角通知弹窗：开关打开时，节点面板里的操作提示改成弹窗显示；关掉就还是原来那条状态文字。
// 动画时间线照抄 deepseek_html_20261028_2e0b65.html（副本存在 .workbuddy/refs/notif-template.html），
// 大号标识内联 assets/translate.svg（见下方 LOGO_SVG），尺寸按卡片高度算。
// 多条通知同时存在时从上往下堆叠（新的插在最上面，把旧的往下挤），最多同时 3 条。
import { element, t } from "./bpi_shared.js";

const STORAGE_KEY = "bpi.notify.v1";
const HOLD_MS = 3000;
// 同一 group 的提示（节点里反复点「唯一」开关这类）停留更久，方便看清内容；
// 期间再来一条同组的就原地换字并把这段时间重新计一遍，不另开卡片
const REFRESH_HOLD_MS = 5000;
const STICKY_MAX_MS = 10000; // 「处理中」最多挂这么久，等不到结果也自己收掉
// 「处理中」至少完整露脸这么久（入场动画本身约 1150ms）：加载太快时结果会瞬间顶掉它，
// 看着就是闪一下，所以结果先扣着，等这一阶段播够了再换
const MIN_BUSY_MS = 1200;
const PADDING_EXTRA = 38; // 卡片上下 padding 36 + 上下 border 2
// 标识尺寸 = 卡片初始高度 × 这个比例（下限/上限见下方 logoSize，防止太小或撑出卡片）
const LOGO_HEIGHT_RATIO = 0.58;
const MAX_CARDS = 3;

let injected = false;
let stack = null;
// 从上到下排列，cards[0] 是最新的那条
const cards = [];

// 开关状态只存本地：这是实验功能，先不惊动后端那套 assistant_settings
export function notifyEnabled() {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch (error) {
    return false;
  }
}

export function setNotifyEnabled(next) {
  try {
    window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
  } catch (error) {
    /* 隐私模式下写不进去就算了，本次会话内仍按传入值生效 */
  }
}

const STYLE_ID = "bpi-notify-style";
const CSS = `
.bpi-notif-stack{position:fixed;top:30px;right:0;width:min(320px,calc(100vw - 40px));z-index:9999;display:flex;flex-direction:column;gap:10px}
/* 投影只有暗色下才需要那么重，亮色下换成淡的；其余颜色都跟着插件的 --bpi-* 主题变量走 */
[data-bpi-theme="light"] .bpi-notif-stack{--bpi-notif-shadow:0 14px 34px rgba(0,0,0,.16);--bpi-notif-logo-shadow:0 2px 10px rgba(0,0,0,.22)}
.bpi-notif-slot{position:relative;width:100%;flex:none}
/* 出错的提示整体转成红色：只改这一个变量，左侧条、遮罩、入场层、离场层跟着变 */
.bpi-notif-slot.bpi-notif-error{--bpm-accent:#e06c75}
/* 双层纸的下面那张：只在卡片左侧露出 6px，用插件主题色，充当卡片左侧的色条 */
.bpi-notif-under{position:absolute;top:0;right:0;bottom:0;left:-6px;background:var(--bpm-accent,#45926f);border:0;z-index:0;pointer-events:none;opacity:0;transform:translateY(-120%);transition:transform .5s cubic-bezier(.16,1,.3,1),opacity .4s ease}
.bpi-notif-under.bpi-show{opacity:1;transform:translateY(0)}
.bpi-notif-under.bpi-wipe{transform:translateX(125%);transition:transform .32s cubic-bezier(.55,0,.8,.4)}
.bpi-notif{position:relative;z-index:1;width:100%;padding:18px 20px;background:var(--bpi-surface-modal,#20252d);border:1px solid var(--bpi-border,#3a4250);border-radius:0;box-shadow:var(--bpi-notif-shadow,0 20px 50px rgba(0,0,0,.65));overflow:hidden;max-height:90px;opacity:0;transform:translateY(-120%);transition:transform .5s cubic-bezier(.16,1,.3,1),opacity .4s ease,max-height .32s cubic-bezier(.3,.8,.3,1);will-change:transform,opacity,max-height}
.bpi-notif.bpi-play{opacity:1;transform:translateY(0)}
/* 底边亮线跟离场那层同色：固定蓝 #0b8ce9（不是左侧竖条，那条才是主题绿） */
.bpi-notif::after{content:"";position:absolute;left:0;right:0;bottom:0;height:3px;background:#0b8ce9;box-shadow:0 0 12px rgba(11,140,233,.55),0 0 4px rgba(11,140,233,.8);z-index:1;pointer-events:none}
.bpi-notif.bpi-out{pointer-events:none;animation:bpiExitSlide .36s cubic-bezier(.55,0,.8,.4) forwards}
@keyframes bpiExitSlide{from{transform:translateX(0)}to{transform:translateX(125%)}}
.bpi-notif-content{display:flex;flex-direction:column;gap:10px;position:relative;z-index:0}
.bpi-notif-head{padding-right:24px}
.bpi-notif-title{font-size:15px;font-weight:600;color:var(--bpi-text,#e6edf7);letter-spacing:.3px;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bpi-notif-extra{font-size:13px;color:var(--bpi-text-muted,#aab5c5);line-height:1.65;letter-spacing:.2px;opacity:0;transition:opacity .4s ease .1s;padding-bottom:6px;word-break:break-word}
.bpi-notif.bpi-expand .bpi-notif-extra{opacity:1}
.bpi-notif-logo{position:absolute;left:22px;top:50%;transform:translateY(-50%);line-height:0;color:#fff;pointer-events:none;user-select:none;filter:drop-shadow(var(--bpi-notif-logo-shadow,0 2px 14px rgba(0,0,0,.55)))}
.bpi-notif-logo svg{display:block;height:var(--bpi-notif-logo-size,36px);width:auto}
.bpi-notif-logo-standalone{z-index:9;opacity:0;transition:opacity .22s ease}
.bpi-notif.bpi-logo-visible .bpi-notif-logo-standalone{opacity:1}
/* 入场：先整块是蓝（mask 底色），再从上方落下绿色那层盖住 → 620ms 向右扫出去的瞬间是绿的 */
.bpi-notif-mask{position:absolute;inset:0;background:#0b8ce9;z-index:7;pointer-events:none;transform:translateX(0)}
.bpi-notif.bpi-play .bpi-notif-mask{animation:bpiMaskSweep .34s cubic-bezier(.55,0,.2,1) .48s forwards}
@keyframes bpiMaskSweep{from{transform:translateX(0)}to{transform:translateX(112%)}}
.bpi-notif-seq{position:absolute;inset:0;transform:translateY(-100%);will-change:transform}
.bpi-notif-seq:first-child{background:#0b8ce9;z-index:1}
/* 入场最后落下的那层：主题绿，扫出去露出内容前看到的颜色 */
.bpi-notif-seq:nth-child(2){background:var(--bpm-accent,#45926f);z-index:2}
.bpi-notif.bpi-play .bpi-notif-seq:first-child{animation:bpiSeqDrop .22s cubic-bezier(.3,.7,.3,1) 0s forwards}
.bpi-notif.bpi-play .bpi-notif-seq:nth-child(2){animation:bpiSeqDrop .22s cubic-bezier(.3,.7,.3,1) .08s forwards}
@keyframes bpiSeqDrop{from{transform:translateY(-100%)}to{transform:translateY(0)}}
.bpi-notif-logo-in-mask{z-index:3}
/* 离场时从卡片下方往上抹满整张卡片的那层：固定蓝 #0b8ce9，不跟主题绿 */
.bpi-notif-cover{position:absolute;inset:0;background:#0b8ce9;z-index:8;pointer-events:none;transform:translateY(calc(100% + 3px));transition:transform .38s cubic-bezier(.45,0,.2,1);will-change:transform}
.bpi-notif.bpi-covering .bpi-notif-cover{transform:translateY(0)}
.bpi-notif-close{position:absolute;top:6px;right:6px;z-index:10;width:28px;height:28px;display:grid;place-items:center;padding:0;border:0;border-radius:0;background:transparent;color:var(--bpi-text-muted,#aab5c5);cursor:pointer;transition:background .15s ease,color .15s ease}
.bpi-notif-close:hover{background:var(--bpi-handle-hover-bg,#2b3a4d);color:var(--bpi-text,#e6edf7)}
.bpi-notif-close:active{background:var(--bpi-mini-hover-bg,#3c4b60)}
@media (prefers-reduced-motion: reduce){
  .bpi-notif,.bpi-notif-extra,.bpi-notif.bpi-out,.bpi-notif-cover,.bpi-notif-logo-standalone,.bpi-notif-seq,.bpi-notif-under,.bpi-notif.bpi-play .bpi-notif-mask{animation-duration:.01ms !important;animation-delay:0s !important;transition-duration:.01ms !important}
}
`;

function injectStyles() {
  if (injected || document.getElementById(STYLE_ID)) {
    injected = true;
    return;
  }
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
  injected = true;
}

// 标识内联 assets/translate.svg 的那条 path：插件的 /extensions 静态根只到 js/，
// assets/ 在插件根取不到（请求会 404），内联省得再搬一份文件，也不受静态服务影响。
// 原图 stroke 是黑的，这里改 currentColor 交给 CSS 上色。
const LOGO_SVG = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">'
  + '<path d="M5 8L10 13M4 14L10 8L12 5M2 5H14M7 2H8M12.913 17H20.087M12.913 17L11 21M12.913 17L15.7783 11.009C16.0092 10.5263 16.1246 10.2849 16.2826 10.2086C16.4199 10.1423 16.5801 10.1423 16.7174 10.2086C16.8754 10.2849 16.9908 10.5263 17.2217 11.009L20.087 17M20.087 17L22 21" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
  + "</svg>";

function buildLogo(extraClass) {
  const logo = element("div", `bpi-notif-logo ${extraClass}`);
  logo.innerHTML = LOGO_SVG;
  return logo;
}

function ensureStack() {
  if (stack) return;
  stack = element("div", "bpi-notif-stack");
  document.body.appendChild(stack);
}

function createCard() {
  const slot = element("div", "bpi-notif-slot");
  const under = element("div", "bpi-notif-under");
  const notif = element("div", "bpi-notif");

  const logoStandalone = buildLogo("bpi-notif-logo-standalone");

  const content = element("div", "bpi-notif-content");
  const head = element("div", "bpi-notif-head");
  // 折叠时只显示标题那一行，消息正文放在展开后才淡入的 extra 里，不再重复一遍
  const titleEl = element("div", "bpi-notif-title");
  const extraEl = element("div", "bpi-notif-extra");
  head.appendChild(titleEl);
  content.append(head, extraEl);

  const mask = element("div", "bpi-notif-mask");
  mask.append(element("div", "bpi-notif-seq"), element("div", "bpi-notif-seq"));
  mask.appendChild(buildLogo("bpi-notif-logo-in-mask"));

  const cover = element("div", "bpi-notif-cover");

  const close = element("button", "bpi-notif-close", "✕");
  close.type = "button";

  notif.append(logoStandalone, content, mask, cover, close);
  slot.append(under, notif);

  const card = {
    slot, notif, under, content, head, titleEl, extraEl,
    item: null,
    sticky: false,
    shownAt: 0,
    pendingItem: null,
    pendingTimer: null,
    timers: [],
    closed: false,
    leaving: false,
  };
  close.addEventListener("click", () => dismissCard(card));
  return card;
}

function clearCardTimers(card) {
  card.timers.forEach((id) => clearTimeout(id));
  card.timers = [];
}

// 状态词当标题，消息本身放正文：标题一行放不下的长句，展开后能看全
function titleFor(kind) {
  if (kind === "ok") return "Done";
  if (kind === "error") return "Something went wrong";
  if (kind === "busy") return "Working...";
  return "Notice";
}

function sameItem(a, b) {
  return !!a && !!b && a.message === b.message && a.kind === b.kind;
}

// 「处理中」一直挂着，等下一条结果把它顶掉；真等不到结果，兜底这么多毫秒后自己收掉
function armDismiss(card) {
  card.sticky = card.item.kind === "busy";
  if (card.sticky) {
    card.shownAt = Date.now();
    card.timers.push(setTimeout(() => dismissCard(card), STICKY_MAX_MS));
    return;
  }
  const hold = Number(card.item.hold) > 0 ? Number(card.item.hold) : HOLD_MS;
  card.timers.push(setTimeout(() => dismissCard(card), hold));
}

function measure(card) {
  const notif = card.notif;
  notif.style.transition = "none";
  notif.style.maxHeight = "none";
  void notif.offsetWidth;

  const fullH = card.content.scrollHeight + PADDING_EXTRA;
  const initialH = card.head.offsetHeight + PADDING_EXTRA;

  // 标识跟着卡片大小走，再多也不许超过卡片宽度的四分之一，免得顶到外面被裁掉
  const logoSize = Math.max(28, Math.min(Math.round(initialH * LOGO_HEIGHT_RATIO), Math.round(notif.offsetWidth * 0.24)));
  notif.style.setProperty("--bpi-notif-logo-size", `${logoSize}px`);
  return { fullH, initialH };
}

function playCard(card) {
  clearCardTimers(card);
  card.item = card.item || { message: "", kind: "" };
  card.slot.classList.toggle("bpi-notif-error", card.item.kind === "error");

  // 摘类之前先关掉过渡：卡片此刻停在屏幕右侧（上一次退场的位置），
  // 带着过渡摘类会让它斜着飞回入场起点，看着就是「结束后往上一跳」
  card.notif.style.transition = "none";
  card.under.style.transition = "none";
  card.notif.classList.remove("bpi-play", "bpi-out", "bpi-expand", "bpi-covering", "bpi-logo-visible");
  card.under.classList.remove("bpi-show", "bpi-wipe");
  void card.notif.offsetWidth;
  void card.under.offsetWidth;

  card.extraEl.textContent = t(card.item.message);
  card.titleEl.textContent = t(titleFor(card.item.kind));

  // 先放开量完整高度，再压回只够显示标题的高度，最后才恢复过渡
  const { fullH, initialH } = measure(card);
  card.initialH = initialH;
  card.notif.style.maxHeight = `${initialH}px`;
  void card.notif.offsetWidth;

  card.notif.style.transition = "";
  void card.notif.offsetWidth;

  card.notif.classList.add("bpi-play");
  card.under.style.transition = ""; // 归位已无过渡完成，这里恢复后才能滑入
  void card.under.offsetWidth;
  card.under.classList.add("bpi-show");

  card.timers.push(setTimeout(() => {
    card.notif.classList.add("bpi-expand");
    card.notif.style.maxHeight = `${fullH}px`;
  }, 880));

  armDismiss(card);
}

// 结果到了：不重播入场动画，直接换掉卡片里的文字，展开高度跟着新内容重算
function updateCardContent(card, item) {
  clearCardTimers(card);
  card.item = item;
  card.slot.classList.toggle("bpi-notif-error", item.kind === "error");
  card.extraEl.textContent = t(item.message);
  card.titleEl.textContent = t(titleFor(item.kind));

  card.notif.style.transition = "none";
  card.notif.style.maxHeight = "none";
  void card.notif.offsetWidth;
  card.notif.style.maxHeight = `${card.content.scrollHeight + PADDING_EXTRA}px`;
  void card.notif.offsetWidth;
  card.notif.style.transition = "";
  card.notif.classList.add("bpi-expand");

  armDismiss(card);
}

// 结果来得太快时先扣着，等「处理中」播够时间再顶上去
function flushPending(card) {
  card.pendingTimer = null;
  const item = card.pendingItem;
  card.pendingItem = null;
  if (item && !card.closed) updateCardContent(card, item);
}

function dismissCard(card) {
  // leaving 挡住重复调用：退场要跑 0.9 秒才真正从 cards 里摘掉，
  // 期间 trimCards 可能又点到同一张卡，没有这个标记就会反复触发、甚至死循环
  if (card.closed || card.leaving) return;
  card.leaving = true;
  clearCardTimers(card);
  if (card.pendingTimer) {
    clearTimeout(card.pendingTimer);
    card.pendingTimer = null;
  }
  card.pendingItem = null;

  card.notif.classList.remove("bpi-expand");
  card.notif.classList.add("bpi-covering", "bpi-logo-visible");
  card.notif.style.maxHeight = `${card.initialH}px`;

  // 退场：先收高度 + 蓝色刷上来，420ms 后卡片右移，走一会儿底纸跟着滑走
  card.timers.push(setTimeout(() => {
    card.notif.classList.add("bpi-out");
    card.timers.push(setTimeout(() => {
      card.under.classList.add("bpi-wipe");
      card.timers.push(setTimeout(() => {
        // 复位必须先关过渡：底纸此刻停在屏幕右侧，直接摘类会让它一路斜着飞回入场起点
        card.under.style.transition = "none";
        card.under.classList.remove("bpi-show", "bpi-wipe");
        void card.under.offsetWidth;
        card.under.style.transition = "";
        card.notif.classList.remove("bpi-logo-visible");
        removeCard(card);
      }, 330));
    }, 170));
  }, 420));
}

// 让位动画（FLIP）：插入/移除卡片会让下面的卡片瞬间跳位，这里先把它们按原位置偏回去，
// 再过渡到新位置，看着就是平滑地被挤下去 / 收上来
function snapshotTops() {
  const tops = new Map();
  cards.forEach((card) => tops.set(card, card.slot.getBoundingClientRect().top));
  return tops;
}

function nudgeStack(before) {
  before.forEach((top, card) => {
    if (card.leaving || card.closed) return;
    const delta = top - card.slot.getBoundingClientRect().top;
    if (!delta) return;
    card.slot.style.transition = "none";
    card.slot.style.transform = `translateY(${delta}px)`;
    void card.slot.offsetWidth;
    card.slot.style.transition = "transform .35s cubic-bezier(.16,1,.3,1)";
    card.slot.style.transform = "";
  });
}

function removeCard(card) {
  if (card.closed) return;
  card.closed = true;
  clearCardTimers(card);
  const index = cards.indexOf(card);
  const before = snapshotTops();
  if (index >= 0) cards.splice(index, 1);
  card.slot.remove();
  nudgeStack(before);
}

// 超过上限就把最旧的那条（在最下面）挤掉。正在退场的卡片不算数，也别重复点它
function trimCards() {
  for (let index = cards.length - 1; index >= 0; index -= 1) {
    const alive = cards.filter((card) => !card.leaving).length;
    if (alive <= MAX_CARDS) return;
    dismissCard(cards[index]);
  }
}

export function notify(message, kind = "", options = null) {
  if (!notifyEnabled() || !message) return false;
  injectStyles();
  ensureStack();
  const opts = options || {};
  const group = typeof opts.group === "string" ? opts.group : "";
  const hold = Number(opts.hold) > 0 ? Number(opts.hold) : 0;
  const fresh = opts.fresh === true;
  const item = { message, kind, group, hold: hold || (group ? REFRESH_HOLD_MS : 0) };
  // 正在退场的不算；fresh 会先让旧卡退场，所以每次都重新取一遍
  const alive = () => cards.filter((card) => !card.leaving);

  // fresh：让同组的旧卡（批量翻译那张「处理中」进度卡）先退场，再开一张全新的报结果，
  // 避免「进度卡 + 汇总卡」并排挂着。没给 group 时退掉所有「处理中」卡。
  if (fresh) {
    alive()
      .filter((card) => (group ? card.item && card.item.group === group : card.sticky))
      .forEach((card) => dismissCard(card));
  }

  // 有 group 的提示（连点重复胶囊等）：复用那张卡，换掉文字并把停留时间重新计一遍。
  // 没有 group 时才走「一模一样就忽略」的旧逻辑；fresh 一律另开新卡。
  if (!fresh) {
    if (group) {
      const groupCard = alive().find((card) => card.item && card.item.group === group && !card.sticky);
      if (groupCard) {
        updateCardContent(groupCard, item);
        return true;
      }
    } else if (alive().some((card) => sameItem(card.item, item))) {
      return true;
    }

    // 有「处理中」挂着：结果去顶掉它，不另开一张卡
    const busyCard = alive().find((card) => card.sticky);
    if (busyCard) {
      const waited = Date.now() - busyCard.shownAt;
      if (waited < MIN_BUSY_MS) {
        busyCard.pendingItem = item;
        if (busyCard.pendingTimer) clearTimeout(busyCard.pendingTimer);
        busyCard.pendingTimer = setTimeout(() => flushPending(busyCard), MIN_BUSY_MS - waited);
        return true;
      }
      updateCardContent(busyCard, item);
      return true;
    }
  }

  const card = createCard();
  card.item = item;
  const before = snapshotTops();
  cards.unshift(card);
  // 插在最上面，已有的往下挤
  stack.insertBefore(card.slot, stack.firstChild);
  trimCards();
  // 先播（内部会量出真实高度并压回折叠高度），再让下面的卡片平滑让位：
  // 顺序反过来会因为「插入时的默认高度 → 量完的真实高度」抖两次
  playCard(card);
  nudgeStack(before);
  return true;
}
