# 酒馆多端同步 · TavernSync v1.4.1

> 把 SillyTavern 的聊天、角色卡、世界书等数据，同步到你自己账号下的**私有 GitHub 仓库**。
> 不装 git、不装依赖、不挂代理也能跑；手机会员和电脑端共用一份数据。

## 这是什么

SillyTavern 的数据都在 `data/default-user/` 下，换设备、重装、误删都很麻烦。本插件是一个**服务端插件**，通过 GitHub 的 Git Data API 把选定目录同步到仓库：

- 只用 HTTPS 调 `api.github.com`，**不需要 git 二进制**，**没有任何 npm 依赖**（Node 18+ 自带 fetch）
- 一次推送一个提交，只上传改动过的文件（按 git blob 哈希比对），失败自动退避重试
- **推送前会检查目标仓库是不是 Private**，公开仓库直接拒绝，避免聊天记录泄露
- 拉取前先备份到 `~/.tavernsync/backups/<时间戳>/`，并且会校验远端路径，拒绝 `../` 之类的越界写入
- 网页面板有实时进度条（百分比 / 文件数 / 已传 MB），装好前端入口后可从酒馆「扩展程序」一键跳转
- 报错会说明下一步该做什么（401 是 token 失效、404 是仓库名或授权问题、断网会说明是哪一类网络错误……），不再只甩一个状态码
- 拉取完成后自动刷新页面，新数据立即生效

## 安装

### 方式一：git clone（推荐）

```bash
cd ~/SillyTavern
git clone https://github.com/yiw221847-netizen/SillyTaver_synchronize.git plugins/tavernsync
bash plugins/tavernsync/install.sh .
```

### 方式二：压缩包

```bash
cd ~/storage/downloads
unzip tavernsync-1.4.1.zip -d ts-install
bash ts-install/install.sh            # 自动找酒馆；找不到就传路径：bash ts-install/install.sh ~/SillyTavern
```

install.sh 会做四件事：备份 `config.yaml`、把插件放进 `plugins/`、打开 `enableServerPlugins`、把前端入口装到 `public/scripts/extensions/third-party/tavernsync/`。

> 1.2.1 起，插件启动时会**自己补装**这个前端入口，所以用 git clone + ST 自带的「服务端插件自动更新」也能保持同步，不必再手动跑 install.sh。

装完**重启酒馆**，然后二选一进入面板：

1. 酒馆 → 扩展程序 → **酒馆多端同步** → 「打开同步面板」
2. 浏览器打开 `http://127.0.0.1:8000/api/plugins/tavernsync/ui`

> TavernSync 是**服务端插件**，不是前端扩展。在「安装扩展程序」里填这个仓库会提示缺少 `manifest.json`，那是正常的——请按上面两种方式装。

## 准备 GitHub

1. 新建一个仓库（例如 `My-SillyTavern-Backup`），**必须选 Private**
2. 建议勾 **Add a README file**：让仓库有一个初始提交，`main` 分支才会存在（不勾也行，v1.2.0 能自动建分支）
3. 生成 Token：GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate new token
   - Repository access：**Only select repositories** → 只选这个数据仓库
   - Permissions → Repository permissions → **Contents: Read and write**（其余全部 No access）
   - 复制 `github_pat_...` 开头的值。**整段复制**，少一个字符就会 401/404
   - 经典 token 也行，但要 `repo` 权限，等于对全部私有仓库开放，不推荐

## 配置项

| 项 | 说明 |
|---|---|
| 所有者 / 用户名 | 你的 GitHub 用户名，不带 `@` |
| 仓库名 | 数据仓库名，区分大小写，不带 `.git` |
| 分支 | 默认 `main`；空仓库首次推送会自动创建 |
| 单文件上限 | 下拉选择：5 / 10 / **20（推荐）** / 50 / 99 MB，超限文件跳过并列出 |
| 自动推送 | 下拉选择：关闭 / 15 / 30 / 60 分钟 |
| Token | 保存在 `~/.tavernsync/config.json`（0600），面板不会回显 |
| API 地址 | 下拉选择：**直连** api.github.com / **镜像**（gh-proxy 反代，直连打不开时选） |

面板顶部会显示 `当前 v1.2.2`，并自动查询 GitHub 上的最新版本：有新版就出现「**一键更新**」按钮（内部执行 `git pull --ff-only`），更新完重启酒馆生效。

同步范围默认「聊天记录 / 角色卡 / 世界书」。建议先只勾这三类跑通，再逐类加。

| 类别 | 内容 |
|---|---|
| 聊天记录 / 角色卡 / 世界书 / 群组 / 预设 / user / 背景图 / 美化 | `data/default-user/` 下对应的数据 |
| 设置 settings.json | 含模型配置、扩展开关等，几十 MB，默认不同步 |
| **酒馆插件** | `public/scripts/extensions/third-party/` 下的扩展代码；含 `.git` 的目录（酒馆自己管理的）会跳过；拉取后需重启酒馆 |

> 拉取完成后页面会自动刷新一次，让新拉下来的数据立刻生效；酒馆主界面也会由前端入口自动刷新。

## 使用

1. **测试连接** → 应显示 `连接正常：用户名/仓库 @ main`
2. **推送** → 进度条会显示上传了多少文件、多少 MB，完成后给出去向
3. 到 GitHub 仓库确认 `chats/`、`characters/`、`worlds/` 出现
4. 另一台设备上：同样装插件 → 填同样的配置 → **拉取**

**单写多读**：多台设备不要同时点推送，否则后推的会覆盖先推的。约定一台设备负责写，其余只拉取。

### 拉取前预览与备份

- 点「拉取」会先算出「覆盖 / 新增 / 删除」各多少个文件，确认后才执行
- 每次拉取前自动备份，默认保留最近 **3 份**（可在面板改成 1/3/5/10），面板下方列出可恢复的备份，点「恢复」即可回滚；恢复前会先把当前状态再备份一份

### 酒馆插件（扩展代码）的安全约束

- 该类别默认不勾选；勾选等于允许远端代码在你的酒馆里执行，请确认仓库只有你自己能写
- 默认**只更新本地已有的扩展**，不会凭空新建；需要新建时显式勾选「允许从远端新建本地没有的扩展」
- 含 `.git` 的扩展目录会被跳过（那是酒馆自己管理的，避免两边互相覆盖）
- 推送和拉取都要求仓库是 **Private**，公开仓库直接拒绝

## 命令行

不开酒馆也能用（读取的是同一份配置）：

```bash
node plugins/tavernsync/index.mjs status    # 查看本地文件数与配置
node plugins/tavernsync/index.mjs test      # 测连接（会提示仓库是否私有）
node plugins/tavernsync/index.mjs push
node plugins/tavernsync/index.mjs pull
```

## 接口

| 路由 | 说明 |
|---|---|
| `GET /api/plugins/tavernsync/ui` | 配置面板 |
| `GET /status` | 状态（不含 token） |
| `GET /progress` | 当前推送/拉取进度 |
| `GET /ping` | 极轻量存活探测（面板异常时先试它） |
| `GET /version` | 本地版本 vs GitHub 最新版本 |
| `POST /update` | 一键 `git pull` |
| `POST /config` | 保存配置 |
| `GET /test` | 测试连接 |
| `POST /push` | 推送 |
| `POST /pull` | 拉取（`{force:true}` 允许清空本地已选目录） |
| `POST /pull-preview` | 预览本次拉取会改动什么，不写文件 |
| `GET /backups` | 备份列表与占用 |
| `POST /restore` | 从某份备份恢复（`{stamp}`） |

所有 `POST` 都会校验来源，跨站请求一律拒绝。

## 安全

- Token 明文存在 `~/.tavernsync/config.json`，目录 0700、文件 0600；**不会回传到浏览器**
- 面板没有独立口令，靠酒馆的白名单 IP 限制访问。开在 `0.0.0.0` 时请只把可信设备加入白名单，并用 Tailscale ACL 收紧
- 数据仓库必须私有；插件推送前会检查，公开仓库直接拒绝
- 拉取会校验远端路径，`../`、绝对路径、非法字符一律拒绝
- 日志不打印 token；错误信息只包含状态码与 GitHub 返回的 message

## 常见报错

| 报错 | 含义与处理 |
|---|---|
| `401 Bad credentials` | Token 无效：删除/过期/复制不完整 → 重新生成并整段粘贴 |
| `404 Not Found` | 看不到仓库：名字错了、仓库没建、或 token 没勾选这个仓库（细粒度 token 必须显式勾选） |
| `403 Forbidden` | 权限不够或缺 `Contents: Read and write`；也可能是请求太频繁 |
| `409 Git Repository is empty` | 空仓库：v1.2.0 已自动兼容；老版本请先加一个 README |
| 提示「仓库是公开的，已拒绝推送」 | 到仓库 Settings → Danger Zone → Change visibility 改 Private |

## 许可

自用项目，未附许可证。使用前请自行评估：数据会以明文形式存放在 GitHub 的私有仓库里。
