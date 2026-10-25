# OfflineComics

一款完全离线运行的本地漫画阅读器。基于 Electron 构建，支持导入漫画文件夹与 ZIP/CBZ 压缩包，提供书架管理、封面与标签、翻页/卷轴双阅读模式、阅读进度与书签记录。所有数据仅保存在本机，不联网、不上传。

- 版本：1.0.1
- 作者：DeepSeek-V4.1-Flash & J1nRay
- 平台：Windows（x64）

---

## 1. 功能特性

### 书库与导入

- 导入漫画目录：递归扫描子目录，含图片的目录自动识别为一本书（最大深度 6 层）
- 导入压缩包：支持 `.zip`、`.cbz`
- 拖拽导入：把文件夹或压缩包拖到窗口即可
- 重新扫描：识别已添加目录中新增/删除的文件，自动清理失效条目
- 移除书目时只从书架移除，不删除磁盘原文件；被移除的路径会被记录，避免再次扫描时自动加回

### 书架

- 视图：全部漫画、最近阅读、书签、自定义文件夹
- 搜索：按书名/标签实时过滤
- 标签筛选与标签统计
- 排序：最近阅读、书名、添加时间、页数
- 封面大小：小/中/大三档
- 封面：自动取第一页生成缩略图，也可手动指定任意页作为封面
- 书籍右键菜单：开始阅读、从头开始、编辑名称与标签、修改封面、移动到文件夹、在资源管理器中显示、标记已读/未读、从书架移除

### 阅读器

- 两种模式：翻页、卷轴
- 翻页方向：从右到左（日漫）/ 从左到右
- 页面适配：适应高度、整页显示、适应宽度、原始尺寸
- 双页模式：宽屏时并排显示两页
- 缩放：`+` / `-` / `0` 重置，支持鼠标位置为中心的缩放
- 书签：任意页添加/取消，书签页可集中查看
- 阅读进度：自动保存当前页与百分比，最近阅读排序自动更新
- 预加载：提前缓存前后页，翻页更流畅
- 外观：4 种阅读背景、亮度调节、页码显示、翻页动画、自动隐藏工具栏
- 全屏阅读

### 其他

- 设置自动保存
- 窗口无边框自定义标题栏，支持最小化/最大化/关闭
- 数据原子写入，异常退出不易损坏
- 自定义 `oc://` 协议提供图片，页面无需开启 `file://` 访问权限

---

## 2. 技术栈

| 层次 | 技术 |
| --- | --- |
| 桌面运行时 | Electron ^45.0.0 |
| 主进程 | Node.js（fs / path / crypto），CommonJS |
| 渲染进程 | 原生 HTML + CSS + ES Module JavaScript（无框架、无打包器） |
| 压缩包读取 | yauzl ^3.2.0（ZIP/CBZ，按需读取单页） |
| 封面生成 | Electron `nativeImage`（缩放并输出 JPEG，宽 360px，质量 82） |
| 样式体系 | CSS 变量 + `data-theme` 主题切换，三份样式表分层 |
| 打包 | electron-builder ^25.1.8，NSIS 安装包 + Portable 便携版 |

项目刻意保持依赖最少：渲染层不使用 React/Vue，也没有构建步骤，修改后直接运行即可。

---

## 3. 系统架构

### 3.1 进程与安全模型

```
┌────────────────────────── 主进程 (main.js) ──────────────────────────┐
│  Library (lib/library.js)                                            │
│    ├─ scanner.js   扫描目录，产出书籍描述                            │
│    ├─ archive.js   ZipSession，ZIP/CBZ 索引与按页读取                │
│    ├─ cover.js     nativeImage 生成封面缩略图                        │
│    └─ media.js     扩展名、MIME、自然排序                            │
│  IPC handlers / 右键菜单 / 文件对话框 / 窗口控制                     │
│  oc:// 协议处理（封面、单页图片）                                    │
└───────────────▲──────────────────────────────┬───────────────────────┘
                │ ipcRenderer.invoke           │ protocol.handle
┌───────────────┴──────────────────────────────▼───────────────────────┐
│ 渲染进程                                                             │
│   preload.js  →  contextBridge 暴露 window.comics（白名单 API）      │
│   src/js/app.js     书架 / 设置 / 弹窗 / 拖拽 / 导航                  │
│   src/js/reader.js  Reader 类：翻页、卷轴、缩放、书签、进度           │
│   src/js/select.js  原生 select 的自定义下拉外观                      │
└──────────────────────────────────────────────────────────────────────┘
```

安全配置（`main.js` 中 BrowserWindow）：

- `contextIsolation: true`：渲染层拿不到 Node 能力
- `nodeIntegration: false`：页面里没有 `require`
- `sandbox: false`：仅为允许 preload 使用 Node 模块（`webUtils` 等）
- 页面 CSP 限制为 `'self'`，图片额外允许 `oc:` / `data:` / `blob:`
- 外部链接与 `window.open` 一律拦截

### 3.2 渲染层与主进程通信

渲染层不直接读磁盘，所有文件操作都通过 IPC 交由主进程：

```
app.js / reader.js
   └─ window.comics.xxx(...)
        └─ preload.js: ipcRenderer.invoke('channel', ...)
             └─ main.js: ipcMain.handle('channel', ...)
                  └─ Library 方法
```

主要通道（定义见 `main.js` 的 `registerIpc()`）：

| 通道 | 作用 |
| --- | --- |
| `library:snapshot` | 获取书库、进度、书签、设置快照 |
| `library:addFolder` / `library:addFiles` | 打开系统对话框选择目录/压缩包 |
| `library:addPaths` | 按路径批量导入（拖拽使用） |
| `library:refresh` | 重新扫描书库 |
| `folder:create` / `folder:rename` / `folder:delete` | 文件夹管理 |
| `book:update` / `book:setCover` | 修改书名、标签、分组、封面页 |
| `book:pages` | 获取某本书的页列表 |
| `book:reveal` / `book:markRead` / `book:contextMenu` | 资源管理器定位、标记已读、右键菜单 |
| `progress:set` / `progress:clear` / `progress:clearAll` | 阅读进度 |
| `bookmark:toggle` / `bookmark:remove` | 书签 |
| `settings:update` | 保存设置 |
| `window:*` | 最小化/最大化/关闭 |

### 3.3 图片加载：oc:// 自定义协议

在 `app.whenReady()` 之前注册为 privileged scheme（standard + secure + fetch + stream）：

- `oc://cover/<bookId>` → `userData/covers/<bookId>.jpg`
- `oc://page/<bookId>/<index>` → 对应页图片，`Content-Type` 由 `lib/media.js` 的 `mimeFor()` 推断

这样页面仍可保持严格 CSP，同时避免把整个磁盘暴露给 `file://`。

### 3.4 压缩包读取策略

- 打开时用 yauzl 懒加载遍历条目，只索引图片文件，并按自然顺序排序（`Intl.Collator`，数字感知）
- 跳过 `__MACOSX/`、隐藏文件、非图片条目
- 同一压缩包同时只服务一个读取流，内部用 Promise 队列串行化
- 最多同时打开 3 个压缩包（LRU），超出后关闭最久未使用的会话

### 3.5 数据持久化

数据目录为 Electron 的 `userData`（Windows 默认 `%APPDATA%\OfflineComics`），可用环境变量 `OC_DATA_DIR` 覆盖：

```
<userData>/
├─ library.json    书库：roots、files、folders、books、ignored
├─ state.json      阅读状态：progress、bookmarks、recent
├─ settings.json   用户设置
└─ covers/         封面缩略图 <bookId>.jpg
```

- 写入采用“临时文件 + rename”的原子方式
- 阅读状态变更做 250ms 防抖批量落盘
- 书名最长 120 字符，标签最多 20 个（单个 24 字符），最近阅读最多 60 条
- 书籍 id 由 `sha1(规范化绝对路径)` 取前 16 位，路径不变则 id 稳定

---

## 4. 目录结构

```
OfflineComics/
├─ main.js                 主进程入口：窗口、协议、IPC、菜单
├─ preload.js              contextBridge 暴露 window.comics
├─ package.json            依赖、脚本、electron-builder 配置
├─ package-lock.json
├─ build/
│  └─ icon.ico             应用/安装包图标（256×256，多尺寸）
├─ src/                    渲染进程（无构建步骤）
│  ├─ index.html           页面骨架、SVG 图标精灵、阅读器 DOM
│  ├─ css/
│  │  ├─ base.css          变量、主题、通用控件、设置行
│  │  ├─ library.css       侧栏、书架、卡片、设置页
│  │  └─ reader.css        阅读器、工具栏、阅读设置面板
│  └─ js/
│     ├─ app.js            书架/设置/弹窗/拖拽/导入/导航
│     ├─ reader.js         Reader 类：阅读核心与快捷键
│     └─ select.js         自定义下拉框
├─ lib/                    主进程业务模块
│  ├─ library.js           书库核心与持久化
│  ├─ scanner.js           目录递归扫描
│  ├─ archive.js           ZIP/CBZ 会话
│  ├─ cover.js             封面缩略图
│  └─ media.js             格式常量、MIME、自然排序
├─ dist/                   打包产物（生成，勿提交）
│  ├─ win-unpacked/
│  ├─ OfflineComics-Setup-<version>.exe
│  └─ OfflineComics-<version>-portable.exe
└─ node_modules/
```

---

## 5. 快速开始

### 5.1 环境要求

- Windows 10/11 x64
- Node.js 18+（开发时使用 v22）
- npm 9+

### 5.2 安装与开发运行

```powershell
npm install
npm start
```

`npm start` 等价于 `electron .`，直接以窗口形式启动，改完 `src/` 下的文件重启即可。

### 5.3 打包 exe

```powershell
npm run dist
```

产物：

- `dist\OfflineComics-Setup-1.0.0.exe`：NSIS 安装版，可选安装目录，创建桌面/开始菜单快捷方式
- `dist\OfflineComics-1.0.0-portable.exe`：免安装便携版
- `dist\win-unpacked\`：未压缩目录版，便于排查

其他脚本：

```powershell
npm run pack            # 只生成 win-unpacked 目录，不打安装包
npm run dist:portable   # 只生成便携版
```

国内网络下载 Electron / NSIS 较慢时，可先设置镜像：

```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
npm run dist
```

---

## 6. 操作指引

### 6.1 导入漫画

1. 点击左下角“添加漫画”，选择“添加文件夹”或“添加压缩包”
2. 也可以直接把文件夹/`.zip`/`.cbz` 拖进窗口
3. 一个目录内只要有图片就会被识别为一本书；目录下的子目录会继续扫描
4. 添加后若磁盘上有新增文件，到“设置 → 书架 → 立即扫描”刷新

### 6.2 管理书架

- 右键书籍卡片可编辑名称/标签、更换封面页、移动到文件夹、标记已读、移除
- 左侧可新建文件夹；书签页汇总所有书签
- 顶部搜索框按书名或标签过滤

### 6.3 阅读快捷键

| 按键 | 功能 |
| --- | --- |
| `Esc` | 退出全屏 / 重置缩放 / 关闭面板 / 退出阅读 |
| `←` `→` | 上一页 / 下一页（受翻页方向设置影响） |
| `↑` `↓` | 翻页模式下翻页；卷轴模式下滚动一屏 |
| `PageUp` `PageDown` | 同上 |
| `Home` `End` | 跳到首页 / 末页 |
| `空格` | 下一页（卷轴模式滚动一屏）；`Shift+空格` 上一页 |
| `F` | 切换全屏 |
| `M` | 切换翻页/卷轴模式 |
| `B` | 当前页添加/取消书签 |
| `+` `-` | 放大/缩小 |
| `0` | 重置缩放 |
| `/` | 打开/关闭阅读设置面板 |

### 6.4 设置项

- 外观：主题（深色/浅色/跟随系统）、封面大小
- 阅读：默认模式、翻页方向、页面适配、双页、页间距、工具栏自动隐藏、翻页动画、预加载页数、背景、亮度、页码
- 书架：默认排序、重新扫描
- 数据：清空全部阅读进度（书签保留）
- 关于：项目名、简介、作者

所有设置保存到 `settings.json`，下次启动自动恢复。

---

## 7. 二次开发

### 7.1 增加一项功能（推荐路径）

以“新增一个设置项”为例：

1. `lib/library.js` 的 `DEFAULT_SETTINGS` 增加默认值与校验（`updateSettings` 中按需 clamp）
2. `src/js/app.js` 的 `settingsViewHtml()` 增加对应控件，使用 `data-setting="key"` 或 `data-action`
3. 若阅读器也需要该设置，在 `src/index.html` 的阅读设置面板加 `data-rsetting="key"`，并在 `src/js/reader.js` 中读取
4. 业务逻辑优先放在 `Library`，渲染层只做展示

新增一个需要读写磁盘的功能时，按四层顺序改：

1. `lib/library.js`：实现方法
2. `main.js`：`ipcMain.handle('xxx:yyy', ...)`
3. `preload.js`：`contextBridge` 中暴露 `ipcRenderer.invoke('xxx:yyy', ...)`
4. `src/js/*.js`：调用 `window.comics.yyy(...)`

注意：不要在渲染层直接 `require`/读文件；不要在页面中放宽 CSP 或开启 `nodeIntegration`。

### 7.2 扩展支持的图片/压缩包格式

- 图片格式：`lib/media.js` 的 `IMAGE_EXTS` 与 `mimeFor()`
- 压缩包格式：`ARCHIVE_EXTS`、`UNSUPPORTED_ARCHIVE_EXTS`，以及 `lib/archive.js` 的读取实现
- 若引入 RAR/CBR，需要新增解压引擎（如 `node-unrar-js`），并把对应扩展名从“不支持”列表移出；注意它是原生/WebAssembly 依赖，打包时需确认 electron-builder 能正确收集
- 扫描规则（目录深度、忽略目录）在 `lib/scanner.js` 的 `MAX_DEPTH` 与 `lib/media.js` 的 `JUNK_DIRS`

### 7.3 定制界面

- 颜色、圆角、字体：`src/css/base.css` 顶部 `:root` 与 `[data-theme="light"]` 变量
- 书架布局：`src/css/library.css`
- 阅读器：`src/css/reader.css`
- 图标：`src/index.html` 顶部 `<symbol>` 精灵，新增后以 `<use href="#i-xxx"/>` 引用

### 7.4 品牌与打包配置

- 应用名/版本：`package.json` 的 `productName`、`version`
- 图标：替换 `build/icon.ico`（必须是正方形，至少 256×256；多尺寸更佳）
- 安装包行为：`package.json` 的 `build.nsis`（是否一键安装、安装目录、快捷方式）
- 输出目录：`build.directories.output`，默认 `dist`
- 只打包运行时需要的文件：`build.files`（当前为 `main.js`、`preload.js`、`src/**/*`、`lib/**/*`、`package.json`）

升级版本时建议同步修改 `version`，可避免 Windows 图标缓存与升级识别问题。

### 7.5 调试建议

- 主进程日志直接输出到启动终端
- 渲染层可用 `Ctrl+Shift+I` 打开开发者工具（Electron 默认快捷键）
- 需要隔离数据时设置环境变量启动：

```powershell
$env:OC_DATA_DIR="$PWD\.devdata"
npm start
```

---

## 8. 已知限制

- 压缩包仅支持 ZIP/CBZ；RAR/CBR/7z/CB7/TAR 会被跳过并在导入结果中提示
- 图片格式受 Chromium 支持范围限制（JPG/PNG/WebP/GIF/BMP/AVIF）
- 不支持 PDF、EPUB 等文档格式
- 无云同步、无在线书源，设计上就是纯离线
- 安装包未做代码签名，Windows SmartScreen 可能出现“未知发布者”提示

---

## 9. 常见问题

**桌面图标还是旧的？**

exe 图标已更新但资源管理器缓存未刷新。可重建桌面快捷方式，或清理 `%LOCALAPPDATA%\Microsoft\Windows\Explorer\iconcache_*.db` 与 `%LOCALAPPDATA%\IconCache.db` 后重启 explorer.exe。升级时修改版本号能减少此类问题。

**打包时下载 Electron 很慢或失败？**

设置 `ELECTRON_MIRROR` 与 `ELECTRON_BUILDER_BINARIES_MIRROR` 为 npmmirror 镜像后重试。

**数据存在哪里？想重置怎么办？**

默认在 `%APPDATA%\OfflineComics`。退出应用后删除该目录即可恢复初始状态（会丢失书架、进度、书签与设置，不影响磁盘上的漫画文件）。

**移动了漫画文件后书籍消失？**

书籍 id 依赖路径。移动文件后旧条目会在“立即扫描”时清理，把新位置重新导入即可。

---

## 10. 作者

DeepSeek-V4.1-Flash & J1nRay
