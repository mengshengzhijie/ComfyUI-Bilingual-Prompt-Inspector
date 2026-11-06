// 删除标签时的消失动画：X 从四角向心长出 → 颜色从中心铺满整块 → 上下压两条灰边 → 整块从右往左擦掉。
// 关掉就是原来的样子：卡片直接消失。这个开关同时管添加动画（见 bpi_insert_anim.js），
// 设置里显示为「标签增删动画（节点标签区）」，默认关。
const KEY = "bpi.deleteAnim.node.v1";

// 四拍各自的时长，加起来就是删掉一张卡要等的时间（≈0.9 秒）
const TIMING = { grow: 160, spread: 400, wipe: 350 };

export function deleteAnimNodeEnabled() {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch (error) {
    return false;
  }
}

export function setDeleteAnimNodeEnabled(next) {
  try {
    window.localStorage.setItem(KEY, next ? "1" : "0");
  } catch (error) {
    /* 隐私模式下写不进去，本次会话内仍按传入值生效 */
  }
}

// 卡片尺寸跟着中英文长度变，所以每次删之前都量一遍：对角线角度、半对角线长度、
// 铺满整块需要的宽度、上下灰边的高度，全按当前宽高算（和 demo 里 measure() 一个算法）。
// onDone 在擦除结束时调用，真正的删除动作在那时才执行。
export function playDeleteAnim(card, onDone) {
  if (!card || card.classList.contains("bpi-deleting")) {
    onDone?.();
    return;
  }
  const width = card.clientWidth;
  const height = card.clientHeight;
  const diagonal = Math.hypot(width, height);
  card.style.setProperty("--bpi-del-angle", `${(Math.atan2(height, width) * 180) / Math.PI}deg`);
  card.style.setProperty("--bpi-del-len", `${diagonal / 2}px`);
  card.style.setProperty("--bpi-del-fill", `${((width * height) / diagonal) * 1.35}px`);
  card.style.setProperty("--bpi-del-bar-h", `${Math.max(6, Math.min(14, Math.round(height * 0.16)))}px`);

  const stage = document.createElement("div");
  stage.className = "bpi-del-stage";
  for (const corner of ["a1", "a2", "b1", "b2"]) {
    const half = document.createElement("i");
    half.className = `bpi-del-half bpi-del-half-${corner}`;
    stage.appendChild(half);
  }
  const cover = document.createElement("i");
  cover.className = "bpi-del-cover";
  const topBar = document.createElement("i");
  topBar.className = "bpi-del-bar bpi-del-bar-top";
  const bottomBar = document.createElement("i");
  bottomBar.className = "bpi-del-bar bpi-del-bar-bottom";
  stage.append(cover, topBar, bottomBar);
  card.appendChild(stage);

  card.classList.add("bpi-deleting");
  // 先让初始状态落一帧，否则浏览器会把 transition 一起跳过（X 会直接是满的）
  requestAnimationFrame(() => card.classList.add("bpi-del-grow"));
  window.setTimeout(() => card.classList.add("bpi-del-spread"), TIMING.grow);
  window.setTimeout(() => card.classList.add("bpi-del-wipe"), TIMING.grow + TIMING.spread);
  window.setTimeout(() => {
    // 删除失败时卡片要能回到原样，所以先把动画痕迹全撤掉再交回去
    card.classList.remove("bpi-deleting", "bpi-del-grow", "bpi-del-spread", "bpi-del-wipe");
    stage.remove();
    onDone?.();
  }, TIMING.grow + TIMING.spread + TIMING.wipe);
}
