// 拖动实时预览的开关：打开后，拖动标签时被拖的那一项会浮起来跟着光标走，
// 原位留一个等大的空位，其余标签用动画平滑让位；松手才真正改写文本，只留一条撤销记录。
// 关掉就是原来的样子：拖动过程中只有落点提示线，松手才见效。
// 平滑动效每次拖动都要量两遍布局，提示词很长时会多花一点 CPU，所以默认关。
// 节点标签区和明细表各一个开关，分开存，互不影响。
const NODE_KEY = "bpi.dragPreview.node.v1";
const TABLE_KEY = "bpi.dragPreview.table.v1";

const readFlag = (key) => {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch (error) {
    return false;
  }
};

const writeFlag = (key, next) => {
  try {
    window.localStorage.setItem(key, next ? "1" : "0");
  } catch (error) {
    /* 隐私模式下写不进去就算了，本次会话内仍按传入值生效 */
  }
};

export function dragPreviewNodeEnabled() {
  return readFlag(NODE_KEY);
}

export function setDragPreviewNodeEnabled(next) {
  writeFlag(NODE_KEY, next);
}

export function dragPreviewTableEnabled() {
  return readFlag(TABLE_KEY);
}

export function setDragPreviewTableEnabled(next) {
  writeFlag(TABLE_KEY, next);
}
