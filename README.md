# dsh-conversation-find

在 DSH 主界面里查找：像浏览器 `Ctrl+F` 一样搜文本、高亮、逐条跳转。

- **会话页**：只搜当前会话的消息流（含代码块、diff、工具输出），计数干净，不带侧栏噪声。
- **其他页面**（设置、插件、插件市场、画布…）：搜整页，等同浏览器自带查找。

## 用法

| 操作 | 键 |
| --- | --- |
| 打开 / 关闭查找条 | `Ctrl+F`（macOS：`Cmd+F`）；「自动」模式同时监听 `Ctrl+Shift+F` 与 `Alt+F` |
| 下一个命中 | `Enter`、`F3` 或 ⌄ |
| 上一个命中 | `Shift+Enter`、`Shift+F3` 或 ⌃ |
| 关闭 | `Esc` |

会话头部右侧还有一个放大镜按钮，效果相同（快捷键被宿主菜单截走时用它）。

### 快捷键可改

设置 → 通用 → **页面查找快捷键**，可选：

- **自动**（默认）：`Ctrl+F`、`Ctrl+Shift+F`、`Alt+F` 三个组合同时监听。宿主菜单若抢走 `Ctrl+F`，页面根本收不到这个按键，另外两个仍然生效 —— 这就是自动降级。
- 固定某一个：`Ctrl+F` / `Ctrl+Shift+F` / `Alt+F` / `F3`。

选择存在 `localStorage`（`dsh-conversation-find:shortcut`），刷新后仍在。


## 行为

- 输入即搜（120ms 防抖），命中全部包一层 `<mark>`，计数显示 `当前/总数`。
- 回车 / Shift+回车在命中之间循环跳转，并滚动到视野中央。
- 查找条位置按当前作用域自动测量：落在头部标签栏分割线下方，窗口缩放会重算。
- 会话流式输出、路由切换、重新渲染后高亮自动重贴（MutationObserver + 400ms 抑制窗口）。
- 查找条本身不参与搜索。

## 已知限制

- 只搜**当前已挂载到 DOM** 的文本。历史被分页/虚拟化、或页面里未渲染的部分不会被计入。
- 搜的是渲染后的文本，不是原始 markdown 源码。
- 不做正则、大小写敏感、整词匹配（当前固定不区分大小写、子串匹配）。

## 安装（本机 profile）

```bash
dsh plugin --profile desktop add file:D:/path/to/dsh-conversation-find
```

或直接在插件管理里安装本地目录。目录结构：

```
package.json        # dsh.bundle.patch + dsh.client{inject,platform} + exports["./client"]
cordis.patch.yml    # 只有一条 - insert 行
lib/index.js        # 宿主半边：空实现，只是让 bundle 行能挂载
lib/client.js       # 全部逻辑：查找条 + DOM 高亮 + 跳转
```

## License

MIT
