# Contributing

Issues and focused pull requests are welcome.

Before submitting a change:

1. Do not commit API keys, assistant settings, personal dictionaries, converted
   databases, generated archives, logs, or model files.
2. Keep optional third-party datasets outside the repository.
3. Preserve the rule that only the English prompt output is sent to downstream nodes.
4. Add or update tests for parsing, synchronization, dictionary, or server behavior.
5. Run both test suites from the repository root:

   ```powershell
   npm test
   python -m unittest discover -s tests -p "test_*.py"
   ```

6. Review staged files with `git diff --cached` before committing.

Bug reports should include the ComfyUI version, frontend version, installation type,
browser or Desktop environment, reproduction steps, and a sanitized error log. Never
include credentials or private prompt content.

---

# 版本号与发布（改版本前必读）

## 需要同步修改的 5 个文件

升版本号时**这 5 处必须一起改**，漏一处就会出现"上架版本是 1.2.1、关于框还显示 1.2.0"这类不一致。

| # | 文件 | 位置 | 当前写法 | 说明 |
|---|------|------|----------|------|
| 1 | `pyproject.toml` | 第 3 行 | `version = "1.2.0"` | **Comfy Registry 读取的就是这里**。发布后不可覆盖，改东西必须升版本再发 |
| 2 | `package.json` | 第 3 行 | `"version": "1.2.0"` | 前端包版本，与上一项保持一致 |
| 3 | `js/bilingual_prompt.js` | 第 53 行 | `const EXTENSION_VERSION = "v1.2.0";` | 节点「关于插件」里显示的版本，**带 `v` 前缀** |
| 4 | `README.md` | 第 1 行 | `# ComfyUI 双语提示词管理器 v1.2.0` | 标题里的版本号 |
| 5 | `CHANGELOG.md` | 新增章节 | `## v1.2.0（2026-09-23）` | 在文件顶部新增一节，日期写当天 |

改完后再打 git 标签：`git tag -a v1.2.0 -m "v1.2.0"`（标签不在上表里，但每次发布都要打）。

## 看起来像版本号，但**不要动**

这些是数据格式版本或工具脚本自己的版本，跟发布版本号无关，改了会造成用户数据无法读取：

- `dictionary_store.py` → `SCHEMA_VERSION = 1`、`PACK_SCHEMA_VERSION = 1`：个人词库 / 词包的文件格式版本。只有**数据结构变了**才 +1
- `saved_prompt_store.py` → `BUNDLE_VERSION = 1`：收藏导出文件的格式版本，同理
- `tools/expand_curated_dictionary_v1.py` → `VERSION = "1.1.0"`：构建工具自己的版本，与插件发布无关
- `CHANGELOG.md` 正文里提到的版本号（如说明文字中的 `1.2.0`）：是叙述内容，不是版本号

## 发布顺序

```bash
git push origin main
git tag -a v1.2.0 -m "v1.2.0"      # 版本号换成当次版本
git push origin v1.2.0
```

然后在 GitHub 上基于该标签建 Release（内容取自 CHANGELOG 对应章节），最后：

```bash
comfy node publish     # 需要 registry.comfy.org 生成的 API key
```

## 发布前必须确认（不可撤销）

- `pyproject.toml` 的 **`name`（`prompt-translator-manager`）发布后永久不可改**，且全局唯一
- **`version` 发布后不可覆盖**：1.2.0 发出去后，哪怕只改一个标点也只能发 1.2.1
- 确认 `.comfyignore` 没有误伤 `data/`（内置词库）、`assets/`（README 截图）、`locales/`（中文节点名）——排除了插件会直接跑不起来

## 自动发布（可选）

仓库里目前只有 `.github/workflows/tests.yml`，没有发布 workflow。想实现"升版本号 → 推 main → 自动发布"，可加
`.github/workflows/publish_action.yml`（用 `Comfy-Org/publish-node-action@main`），并把 registry 的 API key
存为仓库 secret `REGISTRY_ACCESS_TOKEN`。该 workflow 只在 `pyproject.toml` 变动时触发。
