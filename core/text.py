"""重复检查：切分、归一、去重都在这里，节点执行与前端实时提示共用同一份口径。

规则与前端 js/parser.js 保持一致（splitPrompt / analyzeSegment / normalizeKey），
改任一侧都要同步另一侧，否则节点上显示的重复数会和实际去掉的数量对不上。
"""

import re

# 段与段之间的间隙里只取第一个分隔符本身：段后的空白归下一段自己带（raw 里有前导空白），
# 两边都管就会在删掉中间段时丢掉空格（「standing, sitting」变成「standing,sitting」）。
_GAP_SEPARATOR = re.compile(r"^[ \t]*([,\r\n])")
# 间隙里只有分隔符和空白（比如两个标签之间隔了一个空行）时原样保留，
# 否则说明中间夹着被删掉的段，那点空白是被删段的前导，不能再计入。
_GAP_BLANK = re.compile(r"^[ \t]*[,\r\n][ \t\r\n]*$")
_SPECIAL_SEGMENT = re.compile(r"^<[^>]+>$")
_WEIGHTED = re.compile(r"^\((.+):\s*(-?(?:\d+(?:\.\d*)?|\.\d+))\)$", re.DOTALL)
_WHITESPACE = re.compile(r"\s+")


def strip_emphasis(value):
    current = str(value or "").strip()
    while len(current) >= 2 and _is_pair(current[0], current[-1]):
        current = current[1:-1].strip()
    return current


def _is_pair(open_char, close_char):
    return (
        (open_char == "(" and close_char == ")")
        or (open_char == "[" and close_char == "]")
        or (open_char == "{" and close_char == "}")
    )


def normalize_key(value):
    return _WHITESPACE.sub(" ", str(value or "").strip().lower().replace("_", " "))


def split_prompt(text):
    """按顶层逗号与换行切分；括号里、尖括号里、转义字符后面的分隔符都不算切分点。"""
    value = str(text or "")
    segments = []
    start = 0
    round_depth = 0
    square_depth = 0
    curly_depth = 0
    angle_depth = 0
    escaped = False
    for index, char in enumerate(value):
        if escaped:
            escaped = False
            continue
        if char == "\\":
            escaped = True
            continue
        if char == "<":
            angle_depth += 1
        elif char == ">" and angle_depth > 0:
            angle_depth -= 1
        elif angle_depth == 0:
            if char == "(":
                round_depth += 1
            elif char == ")" and round_depth > 0:
                round_depth -= 1
            elif char == "[":
                square_depth += 1
            elif char == "]" and square_depth > 0:
                square_depth -= 1
            elif char == "{":
                curly_depth += 1
            elif char == "}" and curly_depth > 0:
                curly_depth -= 1
        if (
            round_depth == 0
            and square_depth == 0
            and curly_depth == 0
            and angle_depth == 0
            and char in (",", "\n", "\r")
        ):
            raw = value[start:index]
            if raw.strip():
                segments.append({"raw": raw, "start": start, "end": index})
            start = index + 1
    tail = value[start:]
    if tail.strip():
        segments.append({"raw": tail, "start": start, "end": len(value)})
    return segments


def analyze_segment(raw):
    """剥掉权重与强调括号，得到用来判断重复的词条；纯特殊语法（<lora:...>）原样保留。"""
    display = str(raw or "").strip()
    if not display:
        return None
    if _SPECIAL_SEGMENT.match(display):
        return {"term": display, "syntax": "special"}
    term = display
    weighted = _WEIGHTED.match(display)
    if weighted:
        term = weighted.group(1).strip()
    term = strip_emphasis(term)
    return {
        "term": term,
        "syntax": "operator" if term.upper() in ("BREAK", "AND") else "tag",
    }


def find_duplicates(text):
    """返回重复报告：多余出现几处、重复词条、以及重复段的下标（保留第一次出现）。"""
    value = str(text or "")
    segments = split_prompt(value)
    seen = {}
    order = []
    drop = []
    for index, segment in enumerate(segments):
        info = analyze_segment(segment["raw"])
        if not info or info["syntax"] != "tag":
            continue
        key = normalize_key(info["term"])
        if not key:
            continue
        if key in seen:
            seen[key]["count"] += 1
            drop.append(index)
        else:
            seen[key] = {"term": info["term"], "count": 1}
            order.append(key)
    return {
        "extra": len(drop),
        "terms": [seen[key] for key in order if seen[key]["count"] > 1],
        "drop": drop,
        "segments": segments,
    }


def remove_segments(text, segments, drop):
    """删掉指定段并把剩下的段按原文的连接符接回去，不重写整段提示词的格式。"""
    value = str(text or "")
    doomed = set(drop or ())
    keep = [index for index in range(len(segments)) if index not in doomed]
    if not keep:
        return ""
    parts = []
    previous_end = None
    for index in keep:
        segment = segments[index]
        if previous_end is None:
            parts.append(segment["raw"].strip())
        else:
            gap = value[previous_end:segment["start"]]
            if _GAP_BLANK.match(gap):
                # 只去掉首尾的空格，换行要留着（段落之间的空行是有意义的）
                parts.append(gap.strip(" \t") or ",")
            else:
                matched = _GAP_SEPARATOR.match(gap)
                parts.append(matched.group(1) if matched else ",")
            parts.append(segment["raw"])
        previous_end = segment["end"]
    return "".join(parts)


def dedupe_prompt(text):
    """只保留第一次出现的标签，返回去重后的文本。"""
    value = str(text or "")
    report = find_duplicates(value)
    if not report["drop"]:
        return value
    return remove_segments(value, report["segments"], report["drop"])


def format_duplicates(report):
    """重复项预览：一行一个「词条 ×次数」，没有重复时给空串。"""
    return "\n".join(f"{item['term']} ×{item['count']}" for item in report["terms"])
