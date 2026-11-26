# 酒馆同步 · TavernSync

> 把 SillyTavern 的角色卡、聊天、世界书、预设等数据，同步到你自己的**私有 GitHub 仓库**。
> 不装 git、不装依赖、不挂代理也能跑。

## 简介

SillyTavern 的数据都在 `data/default-user/` 下，换设备、重装、误删都很麻烦。TavernSync 是一个**服务端插件**，通过 GitHub 的 Git Data API 把这些目录同步到仓库里：

- 只用 HTTPS 调 `api.github.com`，**不需要 git 二进制**，**没有任何 npm 依赖**（Node 18+ 自带 fetch）
- 一次推送一个提交，只上传改动过的文件（按 git blob 哈希比对），走不通会自动退避重试
- 默认同步「聊天 / 角色卡 / 世界书」；`settings.json` 常常几十 MB，默认不同步，超过单文件上限的自动跳过
- 拉取前先把要覆盖的文件备份到 `~/.tavernsync/backups/<时间戳>/`，改错了能捞回来
- 内置网页配置面板，也有命令行，酒馆没开也能跑

## 安装（一条命令）

下载 [tavernsync-1.1.0.zip](/sdcard/Download/DSH-Go/tavernsync-1.1.0.zip) 后：

```bash
cd ~/storage/downloads
unzip tavernsync-1.1.0.zip -d ts-install
bash ts-install/install.sh            # 自动找酒馆；找不到就传路径：bash ts-install/install.sh ~/SillyTavern
```

脚本会备份 `config.yaml`、把插件放进 `plugins/`、打开 `enableServerPlugins`。然后重启酒馆即可。
装完可以把 `ts-install/` 删掉。

### 手动安装（等价做法）

#### 1. 启用服务端插件

编辑 `<SillyTavern>/config.yaml`：

```yaml
enableServerPlugins: true
```

### 2. 放插件

```bash
cd ~/SillyTavern/plugins
# 把整个 tavernsync 目录放到这里，最终结构：
# plugins/tavernsync/{package.json,index.mjs,README.md,test/}
```

Termux 里从下载目录拷过去即可：

```bash
cp -r ~/storage/downloads/tavernsync ~/SillyTavern/plugins/
```

### 3. 重启酒馆

重启后打开：`http://127.0.0.1:8000/api/plugins/tavernsync/ui`

## 准备 GitHub

1. 新建一个**私有**仓库（例如 `tavern-data`），**不要**勾选 README / .gitignore，保持空仓库
2. 生成 Personal Access Token：GitHub → Settings → Developer settings → Fine-grained tokens
   - Repository access：Only select repositories → 选上面那个仓库
   - Permissions → Contents：**Read and write**
3. 复制 `github_pat_...` 开头的 Token

## 配置

在网页面板里填：

| 项 | 说明 |
|---|---|
| 所有者 / 仓库名 | 例如 `你的用户名/tavern-data` |
| 分支 | 默认 `main`，空仓库首次推送会自动创建 |
| Token | 上面生成的 PAT，保存在 `~/.tavernsync/config.json`（权限 600） |
| 单文件上限 | 默认 20 MB，超过的文件跳过并在结果里列出来 |
| 自动推送间隔 | 0 = 关；最短 5 分钟 |
| API 地址 | 默认 `https://api.github.com`，直连不通时改反代（见下） |

同步范围默认勾选：聊天、角色卡、世界书。需要连预设/人格/背景/主题一起同步就勾上；`settings.json` 体积大且各设备偏好不同，建议不同步。

## 使用

### 面板

`保存配置` → `测试连接` → `推送` / `拉取`。

### 命令行（不开酒馆也能用）

```bash
cd ~/SillyTavern/plugins/tavernsync
node index.mjs status   # 看本地体积、上次提交
node index.mjs push     # 推送到仓库
node index.mjs pull     # 从仓库拉回
node index.mjs test     # 只验证仓库和 Token
```

配合 Termux 定时任务（`cronie`）可以做到每天自动备份一次。

## 多设备怎么用

插件不会帮你合并冲突，**数据以最后一次推送为准**。建议：

- **只在一台设备开启自动推送**（比如手机），其他设备手动 `pull` → 用 → `push`
- 每次换设备前先拉取，用完推回去；两台设备同时改同一个人物会互相覆盖
- 拉取会先备份，真覆盖错了去 `~/.tavernsync/backups/` 找回

## 没有代理也能用

插件默认直连 `https://api.github.com`，只发标准 HTTPS 请求，不需要 git、npm、镜像站。

- **先测**：面板里点「测试连接」，或 `node index.mjs test`。通了就不用管别的。
- 如果所在网络连 `api.github.com` 不稳，可以在手机上自建一个 5 分钟搞定的 Cloudflare Worker 反代，把 `API 地址` 填成 Worker 域名：

```js
export default {
  async fetch(request) {
    const src = new URL(request.url);
    const res = await fetch('https://api.github.com' + src.pathname + src.search, {
      method: request.method,
      headers: request.headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
    });
    return new Response(res.body, { status: res.status, headers: res.headers });
  },
};
```

这样设备本身**不需要任何代理软件**，只是把请求发到一个你能访问的地址。

- 网络慢时把「单文件上限」调小，先同步聊天和角色卡，其余按需开。

## 常见问题

| 现象 | 处理 |
|---|---|
| 面板 404 | `config.yaml` 没开 `enableServerPlugins`，或插件没放到 `plugins/` 下 |
| 401 Bad credentials | Token 失效或没给 Contents 权限，重新生成 |
| 404 Repository not found | 仓库名写错，或 Token 没授权这个仓库 |
| 409 上一次同步还在进行中 | 等它结束，或重启酒馆清掉卡住的状态 |
| 推上去的文件缺了几个 | 看返回里的 `skipped`，通常是超过单文件上限 |
| 拉取提示「远端没有已选类别的内容」 | 仓库还是空的，或类别勾选和推送时不一致 |

## 安全

- Token 存在 `~/.tavernsync/config.json`（600），在数据目录之外，不会被同步
- 建议只给这一个仓库的 Contents 读写权限，不要用经典的全权限 Token
- 仓库保持私有；聊天记录属于敏感内容

## 目录结构

```
tavernsync/
├── index.mjs          # 插件本体（服务端 + 网页面板 + 命令行）
├── package.json
├── README.md
└── test/              # 离线测试：mock 的 GitHub API + 端到端脚本
```

跑测试：`node test/e2e.mjs`
