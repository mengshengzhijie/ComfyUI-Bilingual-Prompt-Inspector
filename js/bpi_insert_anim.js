// 添加标签时的出现动画：新卡片从左往右展开，
// 其余卡片同时滑开让位。开关跟删除共用一个（设置里那个「标签增删动画」），
// 所以这个文件只管播，不管开关。
// 时长比删除短一些，但留足 0.42 秒：太快会看着像「啪」一下跳出来的。
export const INSERT_MS = 420;

export function playInsertAnim(cards) {
  for (const card of cards) {
    card.classList.add("bpi-inserting");
    window.setTimeout(() => card.classList.remove("bpi-inserting"), INSERT_MS + 60);
  }
}
