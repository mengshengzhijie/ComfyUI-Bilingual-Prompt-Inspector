// 收藏弹窗里「适合模型」的补全匹配：纯函数、不碰 DOM，方便单测。
// 排序规则：出现位置越靠前越优先（所以前缀匹配天然排在前面），位置相同短名优先，
// 再一样就按字典序，保证同样的输入每次给出同样的顺序。

export function matchModelNames(items, query, limit = 8) {
  const needle = String(query ?? "").trim().toLowerCase();
  if (!needle) return [];
  const scored = [];
  for (const item of Array.isArray(items) ? items : []) {
    const name = String(item?.name ?? "");
    const at = name.toLowerCase().indexOf(needle);
    if (at < 0) continue;
    scored.push({ item, at, name });
  }
  scored.sort((left, right) => (
    left.at - right.at
    || left.name.length - right.name.length
    || left.name.localeCompare(right.name)
  ));
  return scored.slice(0, limit).map((entry) => entry.item);
}
