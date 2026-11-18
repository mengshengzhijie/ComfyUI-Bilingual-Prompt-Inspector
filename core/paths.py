"""插件里的路径都从这里取，别再用 Path(__file__) 各自算。

挪动文件位置时只改这一处，避免 data 目录被算到别的地方。
"""

from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = PLUGIN_ROOT / "data"
