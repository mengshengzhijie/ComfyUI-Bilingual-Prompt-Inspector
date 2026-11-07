// 标签卡片 / 明细表行的拖拽：落点计算 + 实时预览（浮层跟手、其余项让位）。
// 这里只算出「插到第几个 token」，文本改动一律交给 parser 的 movePromptToken。
import { movePromptToken } from "./parser.js";
import { dragPreviewNodeEnabled } from "./bpi_drag_preview.js";

export function createChipDrag({ store, englishTokenView, clickGuard }) {
  // 依赖统一从 store 取：state / textWidget 是稳定引用，回调走 store.hooks
  const { state } = store;
  const hooks = store.hooks;
  const bindDragTrackers = (onMove, finish) => {
    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("pointerup", finish, true);
    document.addEventListener("pointercancel", finish, true);
  };
  const unbindDragTrackers = (onMove, finish) => {
    document.removeEventListener("pointermove", onMove, true);
    document.removeEventListener("pointerup", finish, true);
    document.removeEventListener("pointercancel", finish, true);
  };

  // 拖动实时预览（设置里两个开关，默认关）：把被拖的那一项复制成浮层跟着光标走，
  // 原位留一个等大的空位，其余标签用 FLIP 动画平移让位——手感接近手机桌面拖图标。
  // 全程只动 DOM，文本不动；松手才由 moveTokenTo 统一改文本，只留一条撤销记录。
  //
  // 落点 targetIndex 是 state.tokens 的下标（movePromptToken 的「先摘出来再插进去」语义），
  // 实际要插到哪个 DOM 元素前面由 data-token-id 反查；那一项被筛掉了就往后找最近的可见项。
  // 注意：一旦动了 DOM，它的顺序就不再等于 state.tokens，落点下标必须一直按拖动前
  // 那份快照算（这两个拖拽的实现都已经在 pointerdown 时把候选列表存好了）。
  // options.raise：默认抬起（浮层跟光标走，原位留空位）；明细表传 false —— 不要抬起效果，
  // 行自己留在原位，只在换位时跟着大家一起滑过去（像列表重排，不像手机挪图标）。
  // FLIP_MS：让位动画时长，同时充当落点更新的节流窗口（动画播完才判下一次）。
  // 拖着划过一长串标签时，落点会在相邻两个槽位之间反复抖动；窗口太短就会
  // 不断打断重启动画，看上去就是疯狂左右闪。
  const FLIP_MS = 160;
  // 落点滞回：指针从上一次生效的位置挪出这么多像素才重新判定
  const MOVE_EPSILON = 10;
  const createDragPreview = (dragged, candidates, enabled, options = {}) => {
    const homeParent = dragged.parentNode;
    const homeNext = dragged.nextSibling;
    const tracked = candidates.slice();
    if (!tracked.includes(dragged)) tracked.push(dragged);
    const byTokenId = new Map();
    for (const item of candidates) {
      const id = Number(item.dataset?.tokenId);
      if (Number.isFinite(id)) byTokenId.set(id, item);
    }
    const candidateSet = new Set(candidates);
    // 下一个「同类」兄弟：中间的分隔符、换行块、落点提示线一律跳过
    const nextCandidate = (from) => {
      let node = from?.nextElementSibling ?? null;
      while (node && !candidateSet.has(node)) node = node.nextElementSibling;
      return node;
    };
    // FLIP：改 DOM 前先量一遍「看起来的位置」，改完把每个动过的元素用 transform
    // 拉回旧位，下一帧把 transform 清成空，浏览器自己去补这段位移 —— 平滑滑过去。
    // 量「改完之后的位置」之前必须先清掉上一次动画留下的 transform —— 否则量到的是
    // 动画中途的坐标，算出来的补偿位移是错的，下一次判定又会往回翻，来回振荡 = 疯狂闪。
    let animating = false;
    // 让位动画还没落地时攒着的落点，落地那一刻接着挪：最后一次移动不会被丢掉
    let wanted = null;
    let unlockTimer = null;
    // 指针位置：每次 track 更新，run 真正执行时才拿它算落点
    let pendingX = 0;
    let pendingY = 0;
    let appliedX = null;
    let appliedY = null;
    // 这次落点是不是「上一行末尾（换行块前面）」：拖拽层算好传进来，预览层不自己猜
    let pendingBreak = false;
    // 调试用（localStorage bpi.debug=1）：落点每次变化打一行，方便看它到底算到哪张卡
    let debugLastKey = "";
    const flip = (mutate) => {
      // 被拖的那张（透明空位）不参与 FLIP：它要「啪」地挪到落点，
      // 只有旁边的元素需要平滑让开。要是连空位一起做过渡，眼睛就会看到
      // 原位还留着一块、落点又多出一块，像是「原位凭空挤出一个空间」。
      const before = tracked
        .filter((el) => el !== dragged)
        .map((el) => [el, el.getBoundingClientRect()]);
      mutate();
      const shifted = [];
      for (const [el, first] of before) {
        if (!el.isConnected) continue;
        el.style.transition = "none";
        el.style.transform = "";
        const last = el.getBoundingClientRect();
        const dx = first.left - last.left;
        const dy = first.top - last.top;
        if (!dx && !dy) {
          // 它压根没动：临时关掉的 transition 要还回去，否则后面就不再有动画了
          el.style.transition = "";
          continue;
        }
        el.style.transform = `translate(${dx}px,${dy}px)`;
        shifted.push(el);
      }
      if (!shifted.length) return;
      void dragged.offsetWidth;
      for (const el of shifted) el.style.transition = `transform ${FLIP_MS}ms cubic-bezier(.2,.8,.2,1)`;
      animating = true;
      requestAnimationFrame(() => {
        for (const el of shifted) el.style.transform = "";
        // 关键：等让位动画真正播完再解锁。早于一帧解除的话，动画还在半路，
        // 下一次 pointermove 量到的是中间坐标 → 落点算错 → 又挪回去 → 来回闪
        if (unlockTimer) clearTimeout(unlockTimer);
        unlockTimer = setTimeout(() => {
          unlockTimer = null;
          animating = false;
          // 动画期间攒下的新落点，这一刻再挪
          run();
        }, FLIP_MS);
      });
    };
    // 让位：把攒着的落点真正落到 DOM 上，其余标签用 FLIP 滑过去
    const run = (force = false) => {
      if (wanted === null || !dragged.isConnected) return;
      // 让位动画还在半路就只攒着：这时候 getBoundingClientRect / elementFromPoint
      // 拿到的都是「半路坐标」，拿它判定会立刻往回翻，来回振荡 = 疯狂闪。
      // force 是松手那一下的强制收口，此时必须把最后一次落点落实。
      if (animating && !force) return;
      // 指针停在两个槽位的分界线上时，一两像素的抖动也会让落点反复横跳，
      // 所以要求它从上一次生效的位置挪出 MOVE_EPSILON 才重新判定（滞回）。
      if (!force && appliedX !== null
        && Math.hypot(pendingX - appliedX, pendingY - appliedY) < MOVE_EPSILON) return;
      appliedX = pendingX;
      appliedY = pendingY;
      // 落点在这里才算：此刻让位动画已播完，量到的是稳定的最终排版位置，
      // 不会像「边挪边量」那样读到半路坐标、判定完立刻翻回去
      const targetIndex = typeof wanted === "function" ? wanted() : wanted;
      wanted = null;
      let ref = null;
      for (let i = targetIndex; i < state.tokens.length && !ref; i += 1) {
        const found = byTokenId.get(state.tokens[i].id);
        if (found && found !== dragged) ref = found;
      }
      if (window.localStorage.getItem("bpi.debug") === "1") {
        const key = `${targetIndex}|${ref?.textContent ?? "null"}`;
        if (key !== debugLastKey) {
          debugLastKey = key;
          console.log("[bpi] run", {
            targetIndex,
            ref: ref?.textContent?.slice(0, 24) ?? null,
            dragged: dragged.textContent?.slice(0, 24),
          });
        }
      }
      // 落点其实是「上一行末尾」时，浮层要停到那一行的 ↵ 前面：
      // 每行是独立的 .bpi-token-line，↵ 挂在上一行末尾，不是下一张卡的兄弟
      if (ref && pendingBreak) {
        const prevLine = ref.parentElement?.previousElementSibling;
        const prevLast = prevLine?.lastElementChild;
        if (prevLast?.classList?.contains("bpi-break-chip")) ref = prevLast;
      }
      const tail = candidates[candidates.length - 1];
      const parent = ref ? ref.parentNode : tail?.parentNode;
      if (!parent?.isConnected) return;
      // 幂等检查：已经在目标位置就别再挪。这条同时也是防抖的关键，
      // 少了它相邻两个槽位会来回跳。
      // 注意别再补「落点等于原位就 return」那种判断——DOM 可能已经被前面几次
      // 移动挪走了，这时恰恰需要真的移回原位，预览才会挤开。
      if (dragged.parentNode === parent
        && (dragged.nextElementSibling === ref || nextCandidate(dragged) === ref)) return;
      flip(() => parent.insertBefore(dragged, ref));
    };

    let clone = null;
    let grabX = 0;
    let grabY = 0;
    let baseLeft = 0;
    let baseTop = 0;
    // 抬起：复制一份当浮层跟着光标走，原元素留在原位当空位（透明但仍参与命中测试）。
    // options.raise===false（明细表）：根本不复制 —— 行自己在原地，换位置的时候跟着
    // 大家一起滑过去就行，不需要「拿起来」这回事。
    const lift = (pointerX, pointerY) => {
      if (!enabled || options.raise === false || clone) return;
      const rect = dragged.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      grabX = pointerX - rect.left;
      grabY = pointerY - rect.top;
      baseLeft = rect.left;
      baseTop = rect.top;
      clone = dragged.cloneNode(true);
      clone.classList.add("bpi-drag-float");
      clone.removeAttribute("id");
      // 拖起来的这份要看着就跟原物一模一样：原元素身上的「拖拽中」半透明状态（.bpi-dragging）
      // 不能带到浮层上，否则整块发灰，像隔着一层毛玻璃
      clone.classList.remove("bpi-dragging");
      clone.style.position = "fixed";
      clone.style.left = `${rect.left}px`;
      clone.style.top = `${rect.top}px`;
      // 必须按 border-box 算：行/卡片自带 padding 和边框，rect 是含这些的总尺寸，
      // 用默认的 content-box 会把浮层撑大一圈，看着像被放大了
      clone.style.boxSizing = "border-box";
      clone.style.width = `${rect.width}px`;
      clone.style.height = `${rect.height}px`;
      clone.style.margin = "0";
      clone.style.zIndex = "10050";
      clone.style.pointerEvents = "none";
      document.body.appendChild(clone);
      dragged.classList.add("bpi-drag-source");
      follow(pointerX, pointerY);
    };
    // 节点里：浮层跟着光标二维移动（抬起感）。不放大的，跟原物一样大，
    // 抬起感全靠 .bpi-drag-float 的投影；明细表传了 raise:false，这一步直接空转
    const follow = (pointerX, pointerY) => {
      if (!clone) return;
      clone.style.transform = `translate3d(${pointerX - grabX - baseLeft}px,${pointerY - grabY - baseTop}px,0)`;
    };
    // 只清 FLIP 留在被跟踪元素上的内联样式（transition / transform）
    const clearInline = () => {
      for (const el of tracked) {
        el.style.transition = "";
        el.style.transform = "";
      }
    };
    return {
      lift,
      // 跟手 + 让位：让位动画播到一半时只攒着落点，等落地那刻再判。
      // 这样最后一次移动不会被丢，也不会因为读到半路坐标而来回翻
      track(pointerX, pointerY, resolveIndex, beforeBreak = false) {
        if (!enabled) return;
        follow(pointerX, pointerY);
        pendingX = pointerX;
        pendingY = pointerY;
        pendingBreak = Boolean(beforeBreak);
        wanted = resolveIndex;
        run();
      },
      // 松手前收口：把攒着的那一步**强制**补上（不受让位动画节流限制），
      // 让「眼前的顺序」正好等于「马上要写进文本的顺序」，再清掉动画残留
      // （内联 transition / transform）。少了这一步，松手后排队中的重渲染
      // 会把「拖动前的旧顺序」画出来一帧 —— 那正是闪回起点
      settle() {
        run(true);
        clearInline();
      },
      // 浮层落地：对准传进来的落点（松手前量好的最终位置）飞过去，落地那一刻才消失。
      // 期间真实那一张一直是透明的空位，所以中间不会看到两张。
      // 落点量不到就直接删掉浮层 —— 无论如何不留残影
      land() {
        const dying = clone;
        clone = null;
        clearInline();
        // 排队中的重渲染先撤掉：它会马上重建 DOM，把落点上那一张提前显示出来（重影），
        // 等浮层落地再补刷一次
        const pending = Boolean(state.renderTimer);
        if (pending) {
          clearTimeout(state.renderTimer);
          state.renderTimer = null;
        }
        const reveal = () => {
          dragged.classList.remove("bpi-drag-source");
          if (pending) hooks.render();
        };
        if (!dying) {
          reveal();
          return;
        }
        // 上面 clearInline() 已经把让位动画的 transform 清掉了，
        // 所以此刻量到的就是真正的排版位置 —— 浮层该去的落点
        const rect = dragged.isConnected ? dragged.getBoundingClientRect() : null;
        if (rect && (rect.width || rect.height)) {
          dying.style.transition = "transform .18s cubic-bezier(.2,.8,.2,1)";
          dying.style.transform = `translate3d(${rect.left - baseLeft}px,${rect.top - baseTop}px,0) scale(1)`;
          window.setTimeout(() => {
            dying.remove();
            reveal();
          }, 200);
          return;
        }
        dying.remove();
        reveal();
      },
      // 放回原位：移动没生效时（原地放下 / 目标被筛掉了）把预览挪出来的错位收回去
      restore() {
        if (!dragged.isConnected || !homeParent?.isConnected) return;
        // 原来的下一个节点可能已经被重渲染换掉了，那就直接放到父节点末尾
        const before = homeNext && homeNext.parentNode === homeParent ? homeNext : null;
        if (dragged.parentNode === homeParent && dragged.nextSibling === before) return;
        homeParent.insertBefore(dragged, before);
      },
    };
  };

  // Drag-to-reorder on the English token chips: pointerdown arms a possible
  // drag, moving past a small threshold activates it (so plain clicks and
  // double-clicks keep working), and releasing applies a structured move
  // through the shared undo stack.
  // view / selector 让英文标签区与中文对照区可以共用这套拖拽逻辑：
  // 两处 chip 一一对应同一批 token，拖动任何一个都是重排同一份文本。
  // selector 必须指到整张卡片（.bpi-token-card）而不是里面的英文行：卡片上
  // 半是英文、下半是中文小块，只认英文行的话，指针落在中文小块上就判定不到
  // 目标，插入提示不出现、落点还会被几何兜底算到列表末尾去。
  const attachChipDrag = (chip, token, view = englishTokenView, selector = ".bpi-token-card") => {
    chip.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !hooks.canReorderTokens()) return;
      const startX = event.clientX;
      const startY = event.clientY;
      // 实时预览打开后卡片会被挪走，DOM 顺序就不等于 token 顺序了；
      // 落点下标一律按拖动前这份顺序算（关掉预览时两者本来就是一样的）
      const homeList = [...view.querySelectorAll(selector)];
      const previewEnabled = dragPreviewNodeEnabled();
      const preview = createDragPreview(chip, homeList, previewEnabled);
      let active = false;
      let targetIndex = null;
      // 落点是不是「上一行末尾」（换行块前面）：被拖的标签本身就在行首时
      // token 顺序不会变，得靠这个标记把前面的换行挪到它后面
      let beforeBreak = false;
      let hoverChip = null;
      const clearHover = () => {
        if (hoverChip) hoverChip.classList.remove("bpi-drop-before", "bpi-drop-after");
        hoverChip = null;
      };
      const onMove = (moveEvent) => {
        if (!chip.isConnected) {
          finish();
          return;
        }
        if (!active) {
          // 阈值调高一点：手抖 / 点着不动不会误触发拖动（顺带也让「让位」
          // 不会在起手那一瞬间来回跳）
          if (Math.abs(moveEvent.clientX - startX) < 7 && Math.abs(moveEvent.clientY - startY) < 7) return;
          active = true;
          clickGuard.suppressed = true;
          chip.classList.add("bpi-dragging");
          preview.lift(moveEvent.clientX, moveEvent.clientY);
        }
        moveEvent.preventDefault();
        clearHover();
        targetIndex = null;
        const hit = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
        const hitChip = hit?.closest?.(selector);
        // 拖拽元素现在可能是整张卡片：命中它内部的 chip 也算「拖到自己身上」，跳过
        const onSelf = Boolean(hitChip) && (hitChip === chip || chip.contains(hitChip));
        // 界面上真正排在后面的那张（跳过被拖的这张——它就是要插进来的那个）
        const live = [...view.querySelectorAll(selector)];
        const nextVisible = (from) => {
          const start = live.indexOf(from);
          for (let i = start + 1; i < live.length; i += 1) {
            if (live[i] !== chip) return live[i];
          }
          return null;
        };
        // 落点一律换算成「插到哪张卡前面」，再变回 state.tokens 的下标；
        // 这样即使预览已经把卡片挪过的位置串了，结果也跟 movePromptToken 一致
        const resolve = (anchor) => {
          const index = anchor ? homeList.indexOf(anchor) : -1;
          return index >= 0 ? index : state.tokens.length;
        };
        // 这张卡是不是「某行第一个、上一行以换行块结尾、而且指针确实在上一行的高度里」。
        // 最后那条不能少：光看结构的话，在同一行里往左拖一点、落点正好是行首那张卡，
        // 就会被当成要跨行，浮层一下子飞到上一行的回车前面去
        const landsBeforeBreak = (card, clientY) => {
          if (!card) return false;
          const prevLine = card.parentElement?.previousElementSibling;
          if (!prevLine?.lastElementChild?.classList?.contains("bpi-break-chip")) return false;
          // 用上一行容器的矩形来判：卡片自己带着 FLIP 的 transform，量出来不准
          const box = prevLine.getBoundingClientRect();
          return clientY >= box.top && clientY <= box.bottom;
        };
        if (hitChip && !onSelf) {
          const rect = hitChip.getBoundingClientRect();
          const before = moveEvent.clientX < rect.left + rect.width / 2;
          const anchorCard = before ? hitChip : nextVisible(hitChip);
          targetIndex = resolve(anchorCard);
          beforeBreak = !before && landsBeforeBreak(anchorCard, moveEvent.clientY);
          hoverChip = hitChip;
          hoverChip.classList.add(before ? "bpi-drop-before" : "bpi-drop-after");
        } else {
          // 空白处、或光标停在自己浮起来的那份身上：按当前画出来的顺序做几何兜底。
          // 少了后半句，卡片一旦挪到指针下面就再也算不出新落点，拖着就不让位了
          let lastCard = null;
          for (const other of live) {
            if (other === chip) continue;
            const rect = other.getBoundingClientRect();
            if (rect.bottom <= moveEvent.clientY) lastCard = other;
            else if (moveEvent.clientY >= rect.top && moveEvent.clientX >= rect.right) lastCard = other;
          }
          const anchor = lastCard ? nextVisible(lastCard) : live.find((item) => item !== chip) || null;
          targetIndex = resolve(anchor);
          beforeBreak = landsBeforeBreak(anchor, moveEvent.clientY);
        }
        preview.track(moveEvent.clientX, moveEvent.clientY, targetIndex, beforeBreak);
      };
      const finish = () => {
        unbindDragTrackers(onMove, finish);
        chip.classList.remove("bpi-dragging");
        clearHover();
        if (active) {
          setTimeout(() => { clickGuard.suppressed = false; }, 0);
          // 先收口：把攒着的那一步落到 DOM 上，让「眼前的顺序」正好等于
          // 「马上要写进文本的顺序」，再清掉让位动画残留
          preview.settle();
          // 落点正好是自己后面那一格、而自己后面就是换行：这是「下移一行」，
          // token 顺序没变，得让 parser 把换行挪到前面
          const afterBreak = !beforeBreak && targetIndex === token.id + 1
            && token.id + 1 < state.tokens.length
            && hooks.gapHasBreak(token.id);
          const committed = targetIndex !== null
            ? hooks.moveTokenTo(token, targetIndex, { beforeBreak, afterBreak })
            : false;
          // 没搬动（原地放下 / 目标被筛掉了）：把预览挪出来的错位收回去
          if (!committed) preview.restore();
          // 有浮层时 land() 会等它落地再刷 DOM（提前刷会把落点上那一张显示出来，看着是重影）
          preview.land();
          if (committed) requestAnimationFrame(() => view.focus({ preventScroll: true }));
        }
      };
      bindDragTrackers(onMove, finish);
    });
  };

  return { attachChipDrag, createDragPreview, bindDragTrackers, unbindDragTrackers };
}
