"""一键跑全部测试（JS + Python）。

用法（在插件目录下，或者任何地方都行）：
    X:\\webui\\comfyui\\ComfyUI\\.venv\\Scripts\\python.exe tools\\main_test.py

会跑两轮：
    1. tests\\*.mjs      —— JS 测试
    2. tests\\test_*.py  —— Python 测试（PYTHONPATH 自己设好，不用手动加）

两轮都会实时输出，能看着它一条条走完。最后给一个汇总，
有失败的会单独列出来。全部通过退出码 0，有失败 1。

注意：必须用 ComfyUI 的 venv 跑（server.py 要 aiohttp），
用别的 Python 会出现 "No module named 'aiohttp'" 且用例数偏少。
"""

import os
import pathlib
import subprocess
import sys

# 这个脚本放在 tools/ 下（该目录被 .comfyignore 排除，不进发布包），
# 所以插件根目录在上一级。放根目录时也能用，这里两种位置都认。
ROOT = pathlib.Path(__file__).resolve().parent
if not (ROOT / "tests").is_dir():
    ROOT = ROOT.parent
TESTS = ROOT / "tests"

# 不设成行缓冲的话，接管道（python main_test.py | tail）时我们自己的输出会被攒到最后，
# 跟子进程的实时输出插在一起，看起来顺序全乱。
sys.stdout.reconfigure(line_buffering=True)


def find_node():
    """找 node 可执行文件。

    managed node 的目录号会随环境升级变（22.22.2-3 → 22.22.2-6），
    写死路径会某天突然全部 FAIL，所以这里动态取最新的那个。
    """
    versions = pathlib.Path.home() / ".workbuddy" / "binaries" / "node" / "versions"
    if versions.is_dir():
        candidates = [p for p in versions.iterdir() if p.is_dir() and p.name[:1].isdigit()]
        for candidate in sorted(candidates, reverse=True):
            exe = candidate / ("node.exe" if os.name == "nt" else "node")
            if exe.exists():
                return str(exe)
    return "node"


def run_js():
    files = sorted(TESTS.glob("*.mjs"))
    if not files:
        print("[js] 没有找到 tests/*.mjs，跳过")
        return []
    node = find_node()
    print(f"\n=== JS 测试（{len(files)} 个）用 {node} ===")
    failed = []
    for path in files:
        result = subprocess.run([node, str(path)], cwd=ROOT)
        if result.returncode == 0:
            print(f"  PASS {path.name}")
        else:
            print(f"  FAIL {path.name}")
            failed.append(path.name)
    return failed


def run_python():
    print(f"\n=== Python 测试 用 {sys.executable} ===")
    env = dict(os.environ, PYTHONPATH=str(ROOT))
    result = subprocess.run(
        [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"],
        cwd=ROOT,
        env=env,
    )
    return [] if result.returncode == 0 else ["python 测试（见上面的输出）"]


def main():
    if not TESTS.is_dir():
        sys.exit(f"[test] 找不到 {TESTS}")

    failed = run_js() + run_python()

    print("\n" + "=" * 46)
    if failed:
        print(f"有 {len(failed)} 项失败：")
        for name in failed:
            print(f"  - {name}")
        sys.exit(1)
    print("全部通过")


if __name__ == "__main__":
    main()
