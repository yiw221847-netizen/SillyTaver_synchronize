/**
 * TavernSync — 酒馆同步
 *
 * 把 SillyTavern 的角色卡 / 聊天 / 世界书 / 预设等数据同步到私有 GitHub 仓库。
 * 特点：
 *  - 不需要 git 二进制，不需要任何 npm 依赖（Node 18+ 自带 fetch）
 *  - 直接走 GitHub Git Data API，不装代理也能用（默认直连 api.github.com）
 *  - 首屏不碰 settings.json，单文件超过上限自动跳过
 *  - 增量：只传改动过的文件；失败自动重试；拉取前先备份
 *
 * 安装：本目录放进 <SillyTavern>/plugins/，config.yaml 里设置 enableServerPlugins: true
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ST_ROOT = process.env.TAVERNSYNC_ROOT
    ? path.resolve(process.env.TAVERNSYNC_ROOT)
    : path.resolve(__dirname, '..', '..');
const DATA_ROOT = path.join(ST_ROOT, 'data', 'default-user');
const HOME = process.env.HOME || process.env.USERPROFILE || __dirname;
const CONF_DIR = path.join(HOME, '.tavernsync');
const CONF_FILE = path.join(CONF_DIR, 'config.json');
const STATE_FILE = path.join(CONF_DIR, 'state.json');
const BACKUP_DIR = path.join(CONF_DIR, 'backups');

const PLUGIN_ID = 'tavernsync';
const PLUGIN_NAME = '酒馆多端同步';
const VERSION = '1.4.1';
const DEFAULT_API = 'https://api.github.com';
/** 上游仓库：用于检查远端版本（公开仓库，查版本不需要 token） */
const UPSTREAM = { owner: 'yiw221847-netizen', repo: 'SillyTaver_synchronize', branch: 'main' };
/** 直连不通时的反代（已实测可读私有仓库、可 POST 写 blob） */
const MIRROR_API = 'https://gh-proxy.com/https://api.github.com';
const MAX_BLOB = 100 * 1024 * 1024;
const TREE_CHUNK_BYTES = 12 * 1024 * 1024;

/** 可同步的类别：key -> data/default-user 下的相对路径 */
const CATEGORIES = {
    chats: { label: '聊天记录', path: 'chats', dir: true, encrypt: true },
    characters: { label: '角色卡', path: 'characters', dir: true },
    worlds: { label: '世界书', path: 'worlds', dir: true },
    groups: { label: '群组', path: 'groups', dir: true },
    presets: { label: '预设', path: 'OpenAI Settings', dir: true },
    personas: { label: 'user', path: 'User Avatars', dir: true },
    backgrounds: { label: '背景图', path: 'backgrounds', dir: true },
    themes: { label: '美化', path: 'themes', dir: true },
    settings: { label: '设置 settings.json', path: 'settings.json', dir: false },
    // 酒馆插件（第三方扩展代码）：注意它在 ST 根目录下的 public/，不在 data/ 里
    extensions: {
        label: '酒馆插件',
        path: 'public/scripts/extensions/third-party',
        dir: true,
        base: 'st',
        skipGitDirs: true,
        hint: '同步的是扩展代码本身；拉取后需要重启酒馆才会生效',
    },
};

/** 类别对应的根目录：data/default-user 或 酒馆根目录 */
function baseDirOf(cat) {
    return cat.base === 'st' ? ST_ROOT : DATA_ROOT;
}

const DEFAULT_CATEGORIES = ['chats', 'characters', 'worlds'];

// ---------------------------------------------------------------- 日志

const LOG_LIMIT = 200;
const logs = [];

function log(message, level = 'info') {
    const line = { at: new Date().toISOString(), level, message: String(message) };
    logs.push(line);
    if (logs.length > LOG_LIMIT) logs.shift();
    console.log(`${level === 'error' ? '[TavernSync][x]' : '[TavernSync]'} ${line.message}`);
    return line;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 进度

/** 前端轮询用的同步进度（单实例，够用） */
const progress = {
    running: false,
    phase: 'idle',
    message: '',
    done: 0,
    total: 0,
    bytesDone: 0,
    bytesTotal: 0,
    startedAt: null,
    finishedAt: null,
    error: null,
};

function progressStart(phase, message) {
    Object.assign(progress, {
        running: true, phase, message,
        done: 0, total: 0, bytesDone: 0, bytesTotal: 0,
        startedAt: Date.now(), finishedAt: null, error: null,
    });
}

function progressSet(patch) {
    Object.assign(progress, patch);
}

function progressDone(message, error = null) {
    Object.assign(progress, {
        running: false, message, error,
        finishedAt: Date.now(),
    });
}

function progressSnapshot() {
    const pct = progress.bytesTotal > 0
        ? Math.min(100, Math.round((progress.bytesDone / progress.bytesTotal) * 100))
        : (progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0);
    return {
        ...progress,
        percent: progress.running || progress.finishedAt || progress.error ? pct : 0,
        elapsedMs: progress.startedAt ? (Date.now() - progress.startedAt) : 0,
        mbDone: Number((progress.bytesDone / 1024 / 1024).toFixed(2)),
        mbTotal: Number((progress.bytesTotal / 1024 / 1024).toFixed(2)),
        // 单个大文件上传时进度数字不动，靠这两个字段让面板显示“还在动”
        currentElapsedMs: progress.current && progress.currentSince ? Date.now() - progress.currentSince : 0,
    };
}

// ---------------------------------------------------------------- 错误说明

/** 把 Node/undici 的网络异常翻译成可读原因 */
function describeNetworkError(err) {
    const raw = String((err && err.message) || err || '');
    const code = (err && err.cause && err.cause.code) || (err && err.code) || '';
    const table = {
        ENOTFOUND: '域名解析失败（DNS）',
        EAI_AGAIN: 'DNS 暂时解析失败',
        ECONNREFUSED: '连接被拒绝',
        ECONNRESET: '连接被对端重置',
        ETIMEDOUT: '连接超时',
        EPIPE: '连接已断开',
        UND_ERR_CONNECT_TIMEOUT: '建立连接超时',
        UND_ERR_HEADERS_TIMEOUT: '等待响应超时',
        UND_ERR_BODY_TIMEOUT: '读取响应超时',
        UND_ERR_SOCKET: '连接中途断开',
        UND_ERR_CLOSED: '连接已关闭',
    };
    if (table[code]) return `${table[code]}（${code}）`;
    if (/terminated/i.test(raw)) return '连接被中断（terminated）';
    if (/fetch failed/i.test(raw)) return '请求未能发出（fetch failed）';
    if (/abort/i.test(raw)) return '请求超时被中止';
    if (/socket hang up/i.test(raw)) return '连接被对端挂断';
    return raw || '未知网络错误';
}

/** 把 GitHub 的状态码翻译成「下一步该干什么」，避免只甩一个 404 */
function explain(err, cfg) {
    const status = err && err.status;
    const repo = cfg && cfg.owner ? `${cfg.owner}/${cfg.repo}` : '你配置的仓库';
    const base = String((err && err.message) || err || '');
    const hint = (() => {
        if (status === 401) {
            return 'Token 无效：可能被删除、已过期，或复制时少了字符。请到 GitHub → Settings → Developer settings → Tokens 重新生成，整段粘贴再保存。';
        }
        if (status === 403) {
            return 'Token 权限不够或被限流：确认它对该仓库有 Contents: Read and write；如果权限没问题，通常是请求太频繁，等几分钟再试。';
        }
        if (status === 404) {
            return `看不到仓库 ${repo}：① 仓库名写错（区分大小写、别带 .git）② 仓库还没创建 ③ token 没被授权访问它（细粒度 token 必须在 Only select repositories 里勾选这个仓库，否则 GitHub 一律回 404）。`;
        }
        if (status === 409) {
            return '仓库是空的（没有任何提交）：到 GitHub 页面上给它加一个 README 文件再试。';
        }
        if (status === 422) {
            return 'GitHub 拒绝了这次提交：通常是远端分支已被别的设备改动，先「拉取」一次再推。';
        }
        if (status === 429) {
            return '请求太频繁被限流：等几分钟再试。';
        }
        if (status === 0) {
            const why = describeNetworkError(err && err.cause ? err.cause : err);
            return `连不上 api.github.com（${why}）：已自动重试 3 次仍失败。检查手机网络/是否切换了 WiFi，或稍等重试；如果直连长期不通，把 API 地址换成「镜像」。同步到一半断网不会损坏数据，重试即可。`;
        }
        if (status === undefined && /fetch failed|terminated|socket|ECONN|ENOTFOUND|timeout/i.test(base)) {
            return `网络中断（${describeNetworkError(err)}）：数据没有写入远端（或只写了临时对象，不会出现在分支上），恢复网络后重新推送/拉取即可。`;
        }
        return '';
    })();
    return hint ? `${base}｜${hint}` : base;
}

// ---------------------------------------------------------------- 版本与更新

function cmpVersion(a, b) {
    const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i] || 0;
        const y = pb[i] || 0;
        if (x !== y) return x - y;
    }
    return 0;
}

/** 运行时推导上游仓库：优先 package.json 的 repository，其次 git remote，最后放弃检查 */
let upstreamRepo = null;

async function resolveUpstream() {
    const parse = (raw) => {
        const m = String(raw || '').match(/github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?(?:\s|$)/i);
        return m ? { owner: m[1], repo: m[2].replace(/\.git$/, ''), branch: 'main' } : null;
    };
    try {
        const pkg = JSON.parse(await fs.readFile(path.join(__dirname, 'package.json'), 'utf8'));
        const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository && pkg.repository.url;
        const parsed = parse(url);
        if (parsed) return parsed;
    } catch {
        // 忽略，继续尝试 git remote
    }
    try {
        const url = await new Promise((resolve, reject) => {
            execFile('git', ['-C', __dirname, 'remote', 'get-url', 'origin'], { timeout: 10_000 }, (err, stdout) => {
                if (err) reject(err);
                else resolve(String(stdout || '').trim());
            });
        });
        const parsed = parse(url);
        if (parsed) return parsed;
    } catch {
        // 不是 git 仓库或没有 remote
    }
    return null;
}

/** 读取 GitHub 上最新发布的版本号（raw CDN，公开仓库，无需 token） */
async function checkRemoteVersion() {
    if (!upstreamRepo) {
        return { current: VERSION, latest: null, hasUpdate: false, error: '无法确定上游仓库（插件不是 git 安装且未声明 repository），已跳过版本检查', repo: null };
    }
    const url = `https://raw.githubusercontent.com/${upstreamRepo.owner}/${upstreamRepo.repo}/${upstreamRepo.branch}/package.json`;
    let latest = null;
    let error = null;
    try {
        const res = await fetch(url, {
            headers: { 'User-Agent': 'tavernsync', 'Cache-Control': 'no-cache' },
            signal: AbortSignal.timeout(8_000),
        });
        if (!res.ok) throw new Error(`GitHub 返回 ${res.status}`);
        latest = (await res.json()).version || null;
    } catch (err) {
        error = `查不到远端版本：${err.message}`;
    }
    return {
        current: VERSION,
        latest,
        hasUpdate: latest ? cmpVersion(latest, VERSION) > 0 : false,
        error,
        repo: `${upstreamRepo.owner}/${upstreamRepo.repo}`,
    };
}

/** 对插件目录执行 git pull（只在用户点「一键更新」时触发，参数写死，不接受外部输入） */
function gitPull() {
    return new Promise((resolve, reject) => {
        execFile(
            'git',
            ['-C', __dirname, 'pull', '--ff-only'],
            { timeout: 180_000, windowsHide: true },
            (err, stdout, stderr) => {
                const out = `${stdout || ''}${stderr || ''}`.trim().slice(-600);
                if (err) {
                    if (/not a git repository/i.test(out)) {
                        return reject(new Error('这个插件目录不是 git 仓库（可能是解压安装的），没法自动更新。请重新用 git clone 安装，或手动覆盖文件。'));
                    }
                    if (/could not resolve host|unable to access|timed out/i.test(out)) {
                        return reject(new Error(`连不上 GitHub，更新失败：${out}`));
                    }
                    return reject(new Error(`更新失败：${out || err.message}`));
                }
                resolve(out || '已经是最新');
            },
        );
    });
}

/**
 * 保证前端入口存在：把插件自带的 st-extension 复制到酒馆的 third-party 扩展目录。
 * 这样 git pull 之后重启酒馆，扩展列表里就能看到入口，不用再跑 install.sh。
 */
async function ensureFrontendExtension() {
    const src = path.join(__dirname, 'st-extension');
    const dest = path.join(ST_ROOT, 'public', 'scripts', 'extensions', 'third-party', PLUGIN_ID);
    try {
        await fs.access(path.join(src, 'manifest.json'));
    } catch {
        return { installed: false, reason: '插件里没有 st-extension 目录' };
    }
    try {
        await fs.access(path.join(dest, 'manifest.json'));
        return { installed: false, reason: '已存在', path: dest };
    } catch {
        // 不存在，往下装
    }
    try {
        await fs.mkdir(dest, { recursive: true });
        for (const name of await fs.readdir(src)) {
            await fs.copyFile(path.join(src, name), path.join(dest, name));
        }
        log(`已安装前端入口：扩展程序 → 酒馆多端同步（${dest}）`);
        return { installed: true, path: dest };
    } catch (err) {
        log(`前端入口安装失败：${err.message}`, 'error');
        return { installed: false, error: err.message };
    }
}


function normalizeApiBase(value) {
    let base = String(value || '').trim() || DEFAULT_API;
    if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
    return base.replace(/\/+$/, '');
}

// ---------------------------------------------------------------- 配置

function defaults() {
    return {
        owner: '',
        repo: '',
        branch: 'main',
        token: '',
        apiBase: DEFAULT_API,
        categories: [...DEFAULT_CATEGORIES],
        maxFileMB: 20,
        autoPushMinutes: 0,
        backupKeep: 3,           // 保留几份拉取前备份
        allowNewExtensions: false, // 是否允许从远端新建本地不存在的扩展
        encryptChats: false,     // 聊天记录上传前加密
        passphrase: '',          // 加密口令
    };
}

async function loadConfig() {
    try {
        const cfg = { ...defaults(), ...JSON.parse(await fs.readFile(CONF_FILE, 'utf8')) };
        if (!Array.isArray(cfg.categories) || !cfg.categories.length) cfg.categories = [...DEFAULT_CATEGORIES];
        cfg.categories = cfg.categories.filter((c) => CATEGORIES[c]);
        cfg.apiBase = normalizeApiBase(cfg.apiBase);
        return cfg;
    } catch {
        return defaults();
    }
}

async function saveConfig(patch) {
    const next = { ...(await loadConfig()), ...patch };
    next.categories = (next.categories || []).filter((c) => CATEGORIES[c]);
    next.branch = String(next.branch || 'main').trim() || 'main';
    next.apiBase = normalizeApiBase(next.apiBase);
    next.maxFileMB = Number(next.maxFileMB);
    if (!(next.maxFileMB > 0)) next.maxFileMB = 20;
    next.autoPushMinutes = Number(next.autoPushMinutes);
    if (!(next.autoPushMinutes >= 0)) next.autoPushMinutes = 0;
    next.backupKeep = Math.min(10, Math.max(1, Number(next.backupKeep) || 3));
    next.allowNewExtensions = Boolean(next.allowNewExtensions);
    next.encryptChats = Boolean(next.encryptChats);
    next.passphrase = String(next.passphrase || '');
    await fs.mkdir(CONF_DIR, { recursive: true, mode: 0o700 });
    await fs.writeFile(CONF_FILE, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
    await fs.chmod(CONF_FILE, 0o600).catch(() => {});
    return next;
}

async function loadState() {
    try {
        const s = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
        return {
            lastCommit: s.lastCommit || null,
            files: s.files || {},
            hashCache: s.hashCache || {},
            at: s.at || null,
            pullAt: s.pullAt || null,
        };
    } catch {
        return { lastCommit: null, files: {}, hashCache: {}, at: null };
    }
}

async function saveState(state) {
    await fs.mkdir(CONF_DIR, { recursive: true, mode: 0o700 });
    await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function requireConfig(cfg) {
    if (!cfg.owner || !cfg.repo) throw new Error('还没配置 GitHub 仓库（所有者 / 仓库名）');
    if (!cfg.token) throw new Error('还没配置 Personal Access Token');
}

// ---------------------------------------------------------------- GitHub

class GhError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}

async function gh(method, route, body, { tries = 3 } = {}) {
    const cfg = await loadConfig();
    const url = `${cfg.apiBase}${route}`;
    const headers = {
        Authorization: `Bearer ${cfg.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'tavernsync',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let lastError = null;
    for (let attempt = 1; attempt <= tries; attempt++) {
        try {
            const res = await fetch(url, {
                method,
                headers,
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: AbortSignal.timeout(120_000),
            });
            if (res.status === 204) return null;
            const text = await res.text();
            let data = null;
            try {
                data = text ? JSON.parse(text) : null;
            } catch {
                data = text;
            }
            if (res.ok) return data;
            const msg = (data && data.message) || String(text).slice(0, 160) || res.statusText;
            const err = new GhError(`GitHub ${res.status}: ${msg}`, res.status);
            const retriable = res.status === 429 || res.status >= 500;
            if (!retriable || attempt === tries) throw err;
            lastError = err;
        } catch (err) {
            if (err instanceof GhError && !(err.status === 429 || err.status >= 500)) throw err;
            if (err instanceof GhError) {
                lastError = err;
            } else {
                const why = describeNetworkError(err);
                lastError = new GhError(`连不上 GitHub：${why}`, 0);
                lastError.cause = err;
            }
            if (attempt === tries) throw lastError;
        }
        await sleep(800 * 2 ** (attempt - 1));
    }
    throw lastError;
}

async function getHead(repo, branch) {
    try {
        const ref = await gh('GET', `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
        const commit = await gh('GET', `/repos/${repo}/git/commits/${ref.object.sha}`);
        return { sha: ref.object.sha, tree: commit.tree.sha };
    } catch (err) {
        // 404：分支不存在；409：仓库还没有任何提交（GitHub 对空仓库返回 Git Repository is empty）
        if (err.status === 404 || err.status === 409) return null;
        throw err;
    }
}

/** 推送前强制校验：仓库必须是私有的，否则聊天记录会公开 */
async function assertPrivateRepo(repo) {
    const info = await gh('GET', `/repos/${repo}`);
    if (info && info.private === false) {
        const err = new Error(
            `仓库 ${repo} 是公开的（public），为了不把聊天记录公开，已拒绝推送。`
            + '｜到 GitHub → Settings → General → 最下方 Danger Zone → Change visibility 改成 Private，再调用一次。',
        );
        err.code = 'PUBLIC_REPO';
        throw err;
    }
    return info;
}

async function getTree(repo, treeSha) {
    const data = await gh('GET', `/repos/${repo}/git/trees/${treeSha}?recursive=1`);
    const map = new Map();
    for (const e of data.tree || []) if (e.type === 'blob') map.set(e.path, { sha: e.sha, size: e.size });
    return map;
}

const createBlob = async (repo, buffer) =>
    (await gh('POST', `/repos/${repo}/git/blobs`, { content: buffer.toString('base64'), encoding: 'base64' })).sha;

async function readBlob(repo, sha) {
    const data = await gh('GET', `/repos/${repo}/git/blobs/${sha}`);
    return Buffer.from(String(data.content).replace(/\n/g, ''), 'base64');
}

const createTree = async (repo, baseTree, entries) => {
    const body = { tree: entries };
    if (baseTree) body.base_tree = baseTree;
    return (await gh('POST', `/repos/${repo}/git/trees`, body)).sha;
};

const createCommit = async (repo, message, tree, parents) =>
    (await gh('POST', `/repos/${repo}/git/commits`, { message, tree, parents })).sha;

async function updateRef(repo, branch, sha) {
    try {
        await gh('PATCH', `/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, { sha, force: true });
    } catch (err) {
        if (err.status !== 404 && err.status !== 422 && err.status !== 409) throw err;
        await gh('POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha });
    }
}

// ---------------------------------------------------------------- 本地文件

const sha1Blob = (buf) =>
    crypto.createHash('sha1').update(`blob ${buf.length}\u0000`).update(buf).digest('hex');

async function walk(dir, base = dir, out = []) {
    let entries;
    try {
        entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const e of entries) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (e.name === '.git' || e.name === 'node_modules') continue;
            await walk(abs, base, out);
        } else if (e.isFile()) {
            out.push({ abs, rel: path.relative(base, abs).split(path.sep).join('/') });
        }
    }
    return out;
}

const isManaged = (repoPath, categories) => categories.includes(repoPath.split('/')[0]);

/**
 * 把「仓库里的相对路径」安全地拼到 data 目录下。
 * 拒绝 .. / 绝对路径 / 反斜杠 / 空段 / 控制字符，并再次确认结果仍在 baseDir 内，
 * 防止有人往数据仓库塞 chats/../../../xxx 这种路径把文件写到酒馆目录外面。
 */
function safeLocalPath(baseDir, segments, label) {
    const segs = segments.map(String);
    for (const seg of segs) {
        if (!seg || seg === '.' || seg === '..' || seg.includes('\\') || seg.includes('\0')) {
            throw new Error(`远端路径不安全，已拒绝写入：${label}`);
        }
        if (seg !== seg.trim() || /[\u0000-\u001f]/.test(seg)) {
            throw new Error(`远端路径包含非法字符，已拒绝写入：${label}`);
        }
        if (path.isAbsolute(seg)) throw new Error(`远端路径是绝对路径，已拒绝写入：${label}`);
    }
    const root = path.resolve(baseDir);
    const abs = path.resolve(root, ...segs);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
        throw new Error(`远端路径越界到 ${abs}，已拒绝写入：${label}`);
    }
    return abs;
}

/** 能安全地当成 UTF-8 文本提交给 tree API 的才走 inline content，其余走 blob 上传 */
function isText(buf) {
    if (buf.length > 4 * 1024 * 1024) return false;
    if (buf.includes(0)) return false;
    const s = buf.toString('utf8');
    return !s.includes('\uFFFD') && Buffer.from(s, 'utf8').equals(buf);
}

// ---------------------------------------------------------------- 聊天记录加密
// 可选：把聊天记录用口令加密后再上传。AES-256-GCM，密钥由 scrypt 派生；
// 每个文件的 IV 由 HMAC(明文) 算出（SIV 思路），同一明文加密结果稳定，
// 这样增量推送依然有效，不会每次都把全部聊天重传一遍。
const ENC_MAGIC = Buffer.from('TSENC1');
const ENC_RE = /\.enc$/;
const stripEnc = (p) => (ENC_RE.test(p) ? p.slice(0, -4) : p);
let encCache = { pass: null, enc: null, ivk: null };

function encKeys(cfg) {
    const pass = String(process.env.TAVERNSYNC_PASSPHRASE || (cfg && cfg.passphrase) || '').trim();
    if (!pass) throw new Error('已开启聊天记录加密，但没有设置口令');
    if (encCache.pass === pass) return encCache;
    const root = crypto.scryptSync(pass, 'tavernsync:chat:v1', 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    encCache = {
        pass,
        enc: Buffer.from(crypto.hkdfSync('sha256', root, Buffer.alloc(0), 'tavernsync-enc', 32)),
        ivk: Buffer.from(crypto.hkdfSync('sha256', root, Buffer.alloc(0), 'tavernsync-iv', 32)),
    };
    return encCache;
}

/** 明文 -> TSENC1|iv(12)|tag(16)|密文 */
function sealChat(buf, cfg) {
    const k = encKeys(cfg);
    const iv = crypto.createHmac('sha256', k.ivk).update(buf).digest().subarray(0, 12);
    const c = crypto.createCipheriv('aes-256-gcm', k.enc, iv);
    const body = Buffer.concat([c.update(buf), c.final()]);
    return Buffer.concat([ENC_MAGIC, iv, c.getAuthTag(), body]);
}

/** 密文 -> 明文；口令不对或格式不符时抛错 */
function openChat(buf, cfg) {
    if (buf.length < 28 || !buf.subarray(0, 6).equals(ENC_MAGIC)) {
        throw new Error('这个文件不是本插件加密的格式（可能并未加密，或口令不对）');
    }
    const iv = buf.subarray(6, 18);
    const tag = buf.subarray(18, 34);
    const body = buf.subarray(34);
    const k = encKeys(cfg);
    const d = crypto.createDecipheriv('aes-256-gcm', k.enc, iv);
    d.setAuthTag(tag);
    try {
        return Buffer.concat([d.update(body), d.final()]);
    } catch {
        throw new Error('解密失败：口令不对，或者文件在仓库里被改过');
    }
}

/**
 * 列出一个类别的文件。
 * 对「酒馆插件」：跳过含 .git 的扩展目录（那是酒馆自己 git 管理的，两个写入方会互相覆盖）。
 */
async function collectCategoryFiles(cat, absPath, key, skipped) {
    if (!cat.skipGitDirs) return walk(absPath);
    const out = [];
    let entries = [];
    try {
        entries = await fs.readdir(absPath, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const e of entries) {
        if (!e.isDirectory()) continue;
        const dirAbs = path.join(absPath, e.name);
        const managedByGit = await fs
            .access(path.join(dirAbs, '.git'))
            .then(() => true)
            .catch(() => false);
        if (managedByGit) {
            skipped.push({
                path: `${key}/${e.name}`,
                reason: '这个扩展由酒馆自己管理（目录含 .git），已跳过，请在另一端自行安装',
            });
            continue;
        }
        for (const f of await walk(dirAbs)) out.push({ abs: f.abs, rel: `${e.name}/${f.rel}` });
    }
    return out;
}

async function collectLocal(cfg, state, { hash = true } = {}) {
    const out = new Map();
    const skipped = [];
    const cache = (state && state.hashCache) || {};
    const nextCache = {};
    const limit = Math.min(cfg.maxFileMB * 1024 * 1024, MAX_BLOB);

    for (const key of cfg.categories) {
        const cat = CATEGORIES[key];
        if (!cat) continue;
        const absPath = path.join(baseDirOf(cat), cat.path);
        const files = cat.dir
            ? await collectCategoryFiles(cat, absPath, key, skipped)
            : await fs
                  .stat(absPath)
                  .then(() => [{ abs: absPath, rel: path.basename(absPath) }])
                  .catch(() => []);
        for (const f of files) {
            const encrypted = Boolean(cat.encrypt && cfg.encryptChats);
            const repoPath = (cat.dir ? `${key}/${f.rel}` : key) + (encrypted ? '.enc' : '');
            let st;
            try {
                st = await fs.stat(f.abs);
            } catch {
                continue;
            }
            if (st.size > limit) {
                skipped.push({ path: repoPath, size: st.size, reason: `超过 ${cfg.maxFileMB}MB 上限` });
                continue;
            }
            const cached = cache[repoPath];
            if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
                out.set(repoPath, { abs: f.abs, sha: cached.sha, size: st.size, enc: encrypted });
                nextCache[repoPath] = cached;
                continue;
            }
            // 只统计体积时（面板打开）不读文件内容，避免每次都把所有文件哈希一遍
            if (!hash) {
                out.set(repoPath, { abs: f.abs, sha: cached ? cached.sha : null, size: st.size, enc: encrypted });
                continue;
            }
            let buf;
            try {
                buf = await fs.readFile(f.abs);
            } catch (err) {
                skipped.push({ path: repoPath, reason: err.message });
                continue;
            }
            if (encrypted) buf = sealChat(buf, cfg);
            const sha = sha1Blob(buf);
            out.set(repoPath, { abs: f.abs, sha, size: buf.length, enc: encrypted });
            nextCache[repoPath] = { size: st.size, mtimeMs: st.mtimeMs, sha };
        }
    }
    return { files: out, skipped, cache: nextCache };
}

async function backupFile(repoPath, abs, stamp) {
    const dest = path.join(BACKUP_DIR, stamp, repoPath);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(abs, dest).catch(() => {});
}

/** 备份目录总大小与份数（用于面板显示） */
async function backupUsage() {
    let dirs = [];
    try {
        dirs = await fs.readdir(BACKUP_DIR);
    } catch {
        return { count: 0, bytes: 0 };
    }
    let bytes = 0;
    let count = 0;
    for (const name of dirs) {
        const abs = path.join(BACKUP_DIR, name);
        let st;
        try {
            st = await fs.stat(abs);
        } catch {
            continue;
        }
        if (!st.isDirectory()) continue;
        count++;
        for (const f of await walk(abs)) {
            const fs2 = await fs.stat(f.abs).catch(() => null);
            if (fs2) bytes += fs2.size;
        }
    }
    return { count, bytes };
}

/** 只保留最近 keep 份，另加 1GB 总量上限 */
async function pruneBackups(keep = 3) {
    let dirs = [];
    try {
        dirs = (await fs.readdir(BACKUP_DIR)).sort().reverse(); // 时间戳命名，倒序即最新在前
    } catch {
        return { removed: 0 };
    }
    const limitBytes = 1024 * 1024 * 1024;
    let removed = 0;
    let total = 0;
    for (let i = 0; i < dirs.length; i++) {
        const abs = path.join(BACKUP_DIR, dirs[i]);
        let size = 0;
        for (const f of await walk(abs)) {
            const st = await fs.stat(f.abs).catch(() => null);
            if (st) size += st.size;
        }
        const overCount = i >= keep;
        const overSize = total + size > limitBytes;
        if (overCount || overSize) {
            await fs.rm(abs, { recursive: true, force: true }).catch(() => {});
            removed++;
        } else {
            total += size;
        }
    }
    if (removed) log(`已清理 ${removed} 份旧备份（保留最近 ${keep} 份）`);
    return { removed };
}

/** 列出可恢复的备份 */
async function listBackups() {
    let dirs = [];
    try {
        dirs = (await fs.readdir(BACKUP_DIR)).sort().reverse();
    } catch {
        return [];
    }
    const out = [];
    for (const name of dirs) {
        const abs = path.join(BACKUP_DIR, name);
        let st;
        try {
            st = await fs.stat(abs);
        } catch {
            continue;
        }
        if (!st.isDirectory()) continue;
        const files = await walk(abs);
        let bytes = 0;
        for (const f of files) {
            const s2 = await fs.stat(f.abs).catch(() => null);
            if (s2) bytes += s2.size;
        }
        out.push({
            stamp: name,
            at: st.mtime.toISOString(),
            files: files.length,
            mb: Number((bytes / 1024 / 1024).toFixed(2)),
        });
    }
    return out;
}

/** 备份里的相对路径 → 本地绝对路径（复用类别映射与越界校验） */
function backupRelToLocal(rel) {
    const repoPath = rel.split(path.sep).join('/');
    const [catKey, ...rest] = repoPath.split('/');
    const cat = CATEGORIES[catKey];
    if (!cat) throw new Error(`备份里有未知类别：${repoPath}`);
    return cat.dir
        ? safeLocalPath(baseDirOf(cat), [cat.path, ...rest], repoPath)
        : safeLocalPath(baseDirOf(cat), [cat.path], repoPath);
}

/** 从某份备份恢复；恢复前先把「当前状态」再备份一份，避免误操作 */
async function restoreBackup(stamp) {
    if (!/^[0-9A-Za-z:.\-]+$/.test(String(stamp || ''))) throw new Error('备份名不合法');
    const dir = path.resolve(BACKUP_DIR, stamp);
    if (!dir.startsWith(path.resolve(BACKUP_DIR) + path.sep)) throw new Error('备份路径越界');
    let st;
    try {
        st = await fs.stat(dir);
    } catch {
        throw new Error(`找不到这份备份：${stamp}`);
    }
    if (!st.isDirectory()) throw new Error('这不是一份备份目录');

    const files = await walk(dir);
    if (!files.length) throw new Error('这份备份是空的');

    const safety = new Date().toISOString().replace(/[:.]/g, '-') + '-before-restore';
    let restored = 0;
    const failed = [];
    for (const f of files) {
        const rel = path.relative(dir, f.abs);
        try {
            const abs = backupRelToLocal(rel);
            try {
                const cur = await fs.stat(abs);
                if (cur.isFile()) await backupFile(rel.split(path.sep).join('/'), abs, safety);
            } catch {
                // 当前不存在，无需安全备份
            }
            await fs.mkdir(path.dirname(abs), { recursive: true });
            await fs.copyFile(f.abs, abs);
            restored++;
        } catch (err) {
            failed.push({ path: rel.split(path.sep).join('/'), reason: err.message });
        }
    }
    const cfg = await loadConfig();
    await pruneBackups(cfg.backupKeep);
    log(`已从备份 ${stamp} 恢复 ${restored} 个文件${failed.length ? `，${failed.length} 个失败` : ''}`);
    return { ok: true, stamp, restored, failed, safety };
}

async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (cursor < items.length) {
            const i = cursor++;
            results[i] = await fn(items[i], i);
        }
    });
    await Promise.all(workers);
    return results;
}

function chunkEntries(entries, maxBytes = TREE_CHUNK_BYTES) {
    const chunks = [];
    let cur = [];
    let size = 0;
    for (const e of entries) {
        const n = e.content ? Buffer.byteLength(e.content) : 0;
        if (cur.length && size + n > maxBytes) {
            chunks.push(cur);
            cur = [];
            size = 0;
        }
        cur.push(e);
        size += n;
    }
    if (cur.length) chunks.push(cur);
    return chunks;
}

// ---------------------------------------------------------------- 推送

let running = null;

async function push(cfg, { dryRun = false } = {}) {
    requireConfig(cfg);
    const repo = `${cfg.owner}/${cfg.repo}`;
    progressStart('push', '检查仓库权限…');
    try {
        // 先确认仓库存在且是私有的，避免把聊天记录推进公开仓库
        await assertPrivateRepo(repo);

        progressSet({ message: '读取远端状态…' });
        const state = await loadState();
        const head = await getHead(repo, cfg.branch);
        const remote = head ? await getTree(repo, head.tree) : new Map();

        progressSet({ message: '扫描本地文件…' });
        const { files, skipped, cache } = await collectLocal(cfg, state);

        const adds = [];
        const textEntries = [];
        const binary = [];
        for (const [repoPath, f] of files) {
            const r = remote.get(repoPath);
            if (r && r.sha === f.sha) continue;
            adds.push(repoPath);
            if (dryRun) continue;
            const raw = await fs.readFile(f.abs);
            const buf = f.enc ? sealChat(raw, cfg) : raw;
            if (isText(buf)) textEntries.push({ path: repoPath, mode: '100644', type: 'blob', content: buf.toString('utf8'), size: buf.length });
            else binary.push({ path: repoPath, buf, size: buf.length });
        }

        const deletes = [];
        for (const p of remote.keys()) if (isManaged(p, cfg.categories) && !files.has(p)) deletes.push(p);

        if (!adds.length && !deletes.length) {
            await saveState({ ...state, hashCache: cache });
            log('推送：本地与远端一致，无事可做');
            progressDone('本地与远端一致，无需推送');
            return { ok: true, changed: 0, deleted: 0, skipped, commit: head?.sha || null, upToDate: true };
        }
        if (dryRun) {
            log(`推送（预演）：${adds.length} 个变更，${deletes.length} 个删除`);
            progressDone(`预演：${adds.length} 个变更，${deletes.length} 个删除`);
            return { ok: true, dryRun: true, changed: adds.length, deleted: deletes.length, skipped, files: adds, removed: deletes };
        }

        const bytesTotal = [...textEntries, ...binary].reduce((s, e) => s + e.size, 0);
        progressSet({
            total: adds.length + deletes.length,
            bytesTotal,
            message: `上传 ${adds.length} 个文件（${(bytesTotal / 1024 / 1024).toFixed(1)} MB）…`,
        });

        // 先传大文件：否则最后只剩一个几十 MB 的长尾，进度会长时间不动
        binary.sort((a, b) => b.size - a.size);
        const blobEntries = await mapLimit(binary, 3, async (b) => {
            const mb = (b.size / 1024 / 1024).toFixed(1);
            progressSet({ current: b.path, currentMB: Number(mb), currentSince: Date.now(), message: `正在上传 ${b.path}（${mb} MB）…` });
            const sha = await createBlob(repo, b.buf);
            progressSet({
                done: progress.done + 1,
                bytesDone: progress.bytesDone + b.size,
                current: null,
                currentSince: null,
                message: `已传 ${progress.done + 1}/${progress.total} 个文件`,
            });
            return { path: b.path, mode: '100644', type: 'blob', sha };
        });

        const newPaths = [...textEntries, ...blobEntries].map((e) => e.path);

        // 旧文件和新目录同名时（例如以前推的是纯文件 extensions，现在是 extensions/<插件名>/...），
        // Git 不允许同一个名字既是文件又是目录，所以先把这些旧文件单独删掉再写新内容。
        const conflictingDeletes = deletes.filter((d) => newPaths.some((p) => p.startsWith(`${d}/`)));

        progressSet({ message: '写入提交…' });
        let baseTree = head?.tree || null;
        let parentSha = head?.sha || null;

        if (conflictingDeletes.length) {
            let cleanTree = baseTree;
            for (const chunk of chunkEntries(conflictingDeletes.map((q) => ({ path: q, mode: '100644', type: 'blob', sha: null })))) {
                cleanTree = await createTree(repo, cleanTree, chunk);
            }
            parentSha = await createCommit(repo, `chore: 清理被目录替换的旧文件（${conflictingDeletes.join(', ')}）`, cleanTree, parentSha ? [parentSha] : []);
            await updateRef(repo, cfg.branch, parentSha);
            baseTree = cleanTree;
            log(`已先清理 ${conflictingDeletes.length} 个与新目录同名的旧文件`);
        }

        const remainingDeletes = deletes.filter((q) => !conflictingDeletes.includes(q));
        const entries = [
            ...textEntries.map(({ size, ...e }) => e),
            ...blobEntries,
            ...remainingDeletes.map((p) => ({ path: p, mode: '100644', type: 'blob', sha: null })),
        ];

        for (const chunk of chunkEntries(entries)) {
            progressSet({
                current: `写入 ${chunk.length} 个文件`,
                currentSince: Date.now(),
                message: `写入目录树（${(chunk.reduce((s, e) => s + (e.content ? Buffer.byteLength(e.content) : 0), 0) / 1024 / 1024).toFixed(1)} MB）…`,
            });
            baseTree = await createTree(repo, baseTree, chunk);
            const chunkBytes = chunk.reduce((s, e) => s + (e.content ? Buffer.byteLength(e.content) : 0), 0);
            progressSet({
                bytesDone: progress.bytesDone + chunkBytes,
                done: Math.min(progress.total, progress.done + chunk.filter((e) => !e.sha).length),
            });
        }
        const message = `sync(${process.env.TAVERNSYNC_HOSTNAME || 'tavern'}): ${adds.length} changed, ${deletes.length} deleted`;
        const commitSha = await createCommit(repo, message, baseTree, parentSha ? [parentSha] : []);
        await updateRef(repo, cfg.branch, commitSha);

        const fileShas = { ...(state.files || {}) };
        for (const [p, f] of files) fileShas[p] = f.sha;
        for (const p of deletes) delete fileShas[p];
        await saveState({
            lastCommit: commitSha,
            files: fileShas,
            hashCache: cache,
            at: new Date().toISOString(),
            pullAt: state.pullAt || null,
        });

        log(`推送完成：${adds.length} 个变更，${deletes.length} 个删除 → ${commitSha.slice(0, 7)}`);
        progressDone(`推送完成：${adds.length} 个变更，${deletes.length} 个删除`);
        return { ok: true, changed: adds.length, deleted: deletes.length, skipped, files: adds, removed: deletes, commit: commitSha, bytes: bytesTotal };
    } catch (err) {
        const msg = explain(err, cfg);
        progressDone(msg.split('｜')[0], msg);
        throw err;
    }
}

// ---------------------------------------------------------------- 拉取

async function pull(cfg, { force = false } = {}) {
    requireConfig(cfg);
    const repo = `${cfg.owner}/${cfg.repo}`;
    progressStart('pull', '读取远端…');
    try {
        // 拉取同样要求仓库私有：拉下来的可能是会被酒馆执行的扩展代码
        await assertPrivateRepo(repo);
        const head = await getHead(repo, cfg.branch);
        if (!head) throw new Error('远端分支还是空的，没有可拉取的内容');

        const remote = await getTree(repo, head.tree);
        const managed = [...remote.keys()].filter((p) => isManaged(p, cfg.categories));
        if (!managed.length && !force) {
            throw new Error('远端没有已选类别的内容；确认要清空本地对应目录时请带 force');
        }

        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const result = { ok: true, updated: [], removed: [], unchanged: 0, commit: head.sha, backup: null };

        progressSet({
            total: managed.length,
            bytesTotal: managed.reduce((s, p) => s + (remote.get(p)?.size || 0), 0),
            message: `下载 ${managed.length} 个文件…`,
        });

        for (const repoPath of managed) {
            const isEnc = ENC_RE.test(repoPath);
            const localPath = stripEnc(repoPath);
            const [catKey, ...rest] = localPath.split('/');
            const cat = CATEGORIES[catKey];
            if (!cat) continue;
            // 路径安全：拒绝 .. / 绝对路径，确保只落在 data/default-user 下
            const abs = cat.dir
                ? safeLocalPath(baseDirOf(cat), [cat.path, ...rest], localPath)
                : safeLocalPath(baseDirOf(cat), [cat.path], localPath);
            const want = remote.get(repoPath);

            let currentSha = null;
            try {
                const st = await fs.stat(abs);
                if (st.isFile()) {
                    const localBuf = await fs.readFile(abs);
                    currentSha = sha1Blob(isEnc ? sealChat(localBuf, cfg) : localBuf);
                }
            } catch {
                currentSha = null;
            }
            if (currentSha && currentSha === want.sha) {
                result.unchanged++;
                progressSet({ done: progress.done + 1, bytesDone: progress.bytesDone + (want.size || 0) });
                continue;
            }

            // 插件类别：只更新已有的扩展，除非配置里允许新增
            if (catKey === 'extensions' && !cfg.allowNewExtensions && rest.length) {
                const dirAbs = safeLocalPath(baseDirOf(cat), [cat.path, rest[0]], repoPath);
                const exists = await fs.stat(dirAbs).then((st2) => st2.isDirectory()).catch(() => false);
                if (!exists) {
                    (result.skippedNew = result.skippedNew || []).push(`${repoPath}`);
                    progressSet({ done: progress.done + 1, bytesDone: progress.bytesDone + (want.size || 0) });
                    continue;
                }
            }
            if (currentSha) await backupFile(localPath, abs, stamp);

            const raw = await readBlob(repo, want.sha);
            const buf = isEnc ? openChat(raw, cfg) : raw;
            await fs.mkdir(path.dirname(abs), { recursive: true });
            await fs.writeFile(abs, buf);
            result.updated.push(localPath);
            progressSet({
                done: progress.done + 1,
                bytesDone: progress.bytesDone + (want.size || 0),
                message: `下载中… ${progress.done + 1}/${progress.total}`,
            });
        }

        const remoteLocalPaths = new Set([...remote.keys()].filter((p) => isManaged(p, cfg.categories)).map(stripEnc));
        for (const key of cfg.categories) {
            const cat = CATEGORIES[key];
            if (!cat || !cat.dir) continue;
            for (const f of await walk(path.join(baseDirOf(cat), cat.path))) {
                // 扩展目录里的 .git 是酒馆自己管的，永远不算“远端没有”
                if (f.rel.split('/').includes('.git')) continue;
                const repoPath = `${key}/${f.rel}`;
                if (remoteLocalPaths.has(repoPath)) continue;
                await backupFile(repoPath, f.abs, stamp);
                await fs.rm(f.abs, { force: true });
                result.removed.push(repoPath);
            }
        }

        const fileShas = {};
        for (const [p, v] of remote) if (isManaged(p, cfg.categories)) fileShas[p] = v.sha;
        await saveState({
            lastCommit: head.sha,
            files: fileShas,
            hashCache: {},
            at: new Date().toISOString(),
            pullAt: new Date().toISOString(),
        });

        if (result.updated.length || result.removed.length) {
            result.backup = path.join(BACKUP_DIR, stamp);
            await pruneBackups(cfg.backupKeep);
            log(`拉取完成：${result.updated.length} 个更新，${result.removed.length} 个移除（备份在 ${result.backup}）`);
            progressDone(`拉取完成：${result.updated.length} 个更新，${result.removed.length} 个移除`);
        } else {
            result.upToDate = true;
            log('拉取：本地已是最新');
            progressDone('本地已是最新');
        }
        return result;
    } catch (err) {
        const msg = explain(err, cfg);
        progressDone(msg.split('｜')[0], msg);
        throw err;
    }
}

/** 只计算「拉取会发生什么」，不写任何文件（面板在真正拉取前先问一次） */
async function pullPreview(cfg) {
    requireConfig(cfg);
    const repo = `${cfg.owner}/${cfg.repo}`;
    await assertPrivateRepo(repo);
    const head = await getHead(repo, cfg.branch);
    if (!head) return { branchEmpty: true, adds: 0, updates: 0, deletes: 0, newExtensionDirs: [] };

    const remote = await getTree(repo, head.tree);
    const adds = [];
    const updates = [];
    for (const [repoPath, info] of remote) {
        if (!isManaged(repoPath, cfg.categories)) continue;
        const isEnc = ENC_RE.test(repoPath);
        const localPath = stripEnc(repoPath);
        const [catKey, ...rest] = localPath.split('/');
        const cat = CATEGORIES[catKey];
        if (!cat) continue;
        const abs = cat.dir
            ? safeLocalPath(baseDirOf(cat), [cat.path, ...rest], localPath)
            : safeLocalPath(baseDirOf(cat), [cat.path], localPath);
        const st = await fs.stat(abs).catch(() => null);
        if (!st || !st.isFile()) {
            adds.push(localPath);
            continue;
        }
        const buf = await fs.readFile(abs).catch(() => null);
        if (!buf) continue;
        const sha = sha1Blob(isEnc ? sealChat(buf, cfg) : buf);
        if (sha !== info.sha) updates.push(localPath);
    }

    const remoteLocalPaths = new Set([...remote.keys()].filter((p) => isManaged(p, cfg.categories)).map(stripEnc));
    const deletes = [];
    for (const key of cfg.categories) {
        const cat = CATEGORIES[key];
        if (!cat || !cat.dir) continue;
        for (const f of await walk(path.join(baseDirOf(cat), cat.path))) {
            if (f.rel.split('/').includes('.git')) continue;
            const repoPath = `${key}/${f.rel}`;
            if (!remoteLocalPaths.has(repoPath)) deletes.push(repoPath);
        }
    }

    const newExtensionDirs = [...new Set(
        adds.filter((p) => p.startsWith('extensions/')).map((p) => p.split('/')[1]).filter(Boolean),
    )];

    return {
        adds: adds.length,
        updates: updates.length,
        deletes: deletes.length,
        newExtensionDirs,
        allowNewExtensions: Boolean(cfg.allowNewExtensions),
        encryptChats: Boolean(cfg.encryptChats),
        hasPassphrase: Boolean(cfg.passphrase) || Boolean(process.env.TAVERNSYNC_PASSPHRASE),
        files: [...adds, ...updates].slice(0, 60),
    };
}

// ---------------------------------------------------------------- 状态

async function status() {
    const startedAt = Date.now();
    const cfg = await loadConfig();
    const state = await loadState();
    const { files } = await collectLocal(cfg, state, { hash: false }).catch(() => ({ files: new Map() }));
    const bytes = [...files.values()].reduce((s, f) => s + (f.size || 0), 0);
    return {
        plugin: PLUGIN_ID,
        name: PLUGIN_NAME,
        version: VERSION,
        stRoot: ST_ROOT,
        dataRoot: DATA_ROOT,
        configured: Boolean(cfg.owner && cfg.repo && cfg.token),
        owner: cfg.owner,
        repo: cfg.repo,
        branch: cfg.branch,
        apiBase: cfg.apiBase,
        apiMirror: MIRROR_API,
        tokenSet: Boolean(cfg.token),
        categories: cfg.categories,
        maxFileMB: cfg.maxFileMB,
        autoPushMinutes: cfg.autoPushMinutes,
        backupKeep: cfg.backupKeep,
        allowNewExtensions: cfg.allowNewExtensions,
        local: { files: files.size, mb: Number((bytes / 1024 / 1024).toFixed(2)) },
        tookMs: Date.now() - startedAt,
        last: { commit: state.lastCommit, at: state.at, pullAt: state.pullAt, files: Object.keys(state.files || {}).length },
        busy: Boolean(running),
        progress: progressSnapshot(),
        categories_meta: Object.fromEntries(
            Object.entries(CATEGORIES).map(([k, v]) => [k, { label: v.label, path: v.path, hint: v.hint || '' }]),
        ),
        logs: logs.slice(-40),
    };
}

// ---------------------------------------------------------------- 网页界面

function uiHtml() {
    return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>酒馆多端同步 v${VERSION}</title>
<style>
:root{color-scheme:dark}
body{font:14px/1.55 system-ui,sans-serif;margin:0;padding:16px;background:#151515;color:#ddd;max-width:760px}
h1{font-size:17px;margin:0 0 4px}
h2{font-size:14px;margin:18px 0 8px;color:#9ad}
label{display:block;margin:8px 0 2px;color:#aaa;font-size:12px}
input[type=text],input[type=password],input[type=number],select{width:100%;box-sizing:border-box;background:#222;border:1px solid #333;color:#eee;padding:8px;border-radius:6px}
select{appearance:none}
.row{display:flex;gap:8px;flex-wrap:wrap}
.row>div{flex:1 1 130px}
.cats{display:grid;grid-template-columns:1fr 1fr;gap:4px}
.cats label{display:flex;align-items:center;gap:6px;color:#ccc;margin:0;font-size:13px}
button{background:#2d6cdf;color:#fff;border:0;border-radius:6px;padding:9px 14px;margin:10px 6px 0 0;font-size:14px}
button.ghost{background:#333}
button:disabled{opacity:.5}
pre{background:#111;border:1px solid #222;border-radius:6px;padding:10px;white-space:pre-wrap;word-break:break-all;max-height:200px;overflow:auto;font-size:12px}
.hint{color:#888;font-size:12px;margin-top:4px}
.ok{color:#5c5}.bad{color:#e66}
.bar{height:10px;background:#222;border:1px solid #333;border-radius:6px;overflow:hidden;margin:10px 0 4px}
.bar>i{display:block;height:100%;width:0;background:linear-gradient(90deg,#2d6cdf,#5c9cff);transition:width .3s}
.prog{display:none;margin:10px 0}
.prog.on{display:block}
.progtxt{font-size:12px;color:#9ad}
</style></head><body>
<h1>酒馆多端同步 <span style="color:#666;font-size:13px;font-weight:400">v${VERSION}</span></h1>
<div class="hint" id="verline">正在检查远端版本…</div>
<div class="hint">把酒馆数据同步到私有 GitHub 仓库：无需 git、无依赖，默认直连 api.github.com，不装代理也能用。</div>

<h2>仓库</h2>
<div class="row">
<div><label>所有者 / 用户名</label><input id="owner" type="text" placeholder="octocat"></div>
<div><label>仓库名</label><input id="repo" type="text" placeholder="tavern-data"></div>
</div>
<div class="row">
<div><label>分支</label><input id="branch" type="text" value="main" placeholder="main"></div>
<div><label>单文件上限</label>
<select id="maxFileMB">
<option value="5">5 MB（保守）</option>
<option value="10">10 MB</option>
<option value="20" selected>20 MB（推荐）</option>
<option value="50">50 MB（大背景图）</option>
<option value="99">99 MB（GitHub 上限附近，慢）</option>
</select></div>
<div><label>自动推送</label>
<select id="autoPushMinutes">
<option value="0" selected>关闭（手动推送）</option>
<option value="15">每 15 分钟</option>
<option value="30">每 30 分钟</option>
<option value="60">每小时</option>
</select></div>
</div>
<label>Personal Access Token（需要 Contents: Read and write）</label>
<input id="token" type="password" placeholder="github_pat_...">
<label>API 地址</label>
<select id="apiBase">
<option value="default" selected>直连 api.github.com（推荐）</option>
<option value="mirror">镜像（gh-proxy 反代，直连打不开时选）</option>
</select>
<div class="hint">先确认仓库是 <b>Private</b>：推送前插件会检查，公开仓库会被拒绝，避免聊天记录泄露。</div>

<h2>同步范围</h2>
<div class="cats" id="cats"></div>
<div class="hint">settings.json 常有几十 MB，默认不同步。</div>
<label style="display:flex;align-items:center;gap:8px;margin-top:10px">
  <input type="checkbox" id="allowNew" style="width:auto">
  <span>允许从远端新建本地没有的扩展（等于允许远端在你的酒馆里执行代码，谨慎开启）</span>
</label>
<label style="display:flex;gap:8px;align-items:flex-start;margin-top:8px">
  <input type="checkbox" id="encChats" style="width:auto">
  <span>加密聊天记录后再上传（AES-256-GCM；仓库里看到的是密文，换设备要输同样的口令才能读）</span>
</label>
<div class="row" style="margin-top:10px">
  <div><label>加密口令（开启后才用得到）</label>
  <input type="password" id="pass" placeholder="留空表示不设置 / 不修改"></div>
</div>
<div class="row" style="margin-top:10px">
  <div><label>拉取前备份保留份数</label>
  <select id="backupKeep">
    <option value="1">1 份</option>
    <option value="3" selected>3 份（推荐）</option>
    <option value="5">5 份</option>
    <option value="10">10 份</option>
  </select></div>
</div>

<div>
<button id="save">保存配置</button>
<button id="test" class="ghost">测试连接</button>
<button id="push">推送</button>
<button id="pull" class="ghost">拉取</button>
<button id="refresh" class="ghost">刷新</button>
<button id="check" class="ghost">检查更新</button>
<button id="upd" class="ghost" style="display:none">一键更新</button>
</div>

<div class="prog" id="prog">
  <div class="bar"><i id="bar"></i></div>
  <div class="progtxt" id="progtxt">准备中…</div>
</div>

<h2>状态</h2>
<pre id="status">读取中…</pre>
<div id="msg" class="hint"></div>

<h2>备份与恢复</h2>
<div class="hint" id="backupHint">读取中…</div>
<div id="backupList"></div>
<script>
const el = (id) => document.getElementById(id);
async function api(p, body, ms) {
  const timeout = ms || 20000;
  const res = await fetch(new URL(p, location.href), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
const say = (t, bad) => { const m = el('msg'); m.textContent = t; m.className = bad ? 'hint bad' : 'hint ok'; };

let mirrorUrl = '';
let pollTimer = null;
function renderProgress(p) {
  el('prog').className = 'prog on';
  el('bar').style.width = (p.running ? p.percent : (p.error ? p.percent : 100)) + '%';
  el('bar').style.background = p.error ? '#c33' : 'linear-gradient(90deg,#2d6cdf,#5c9cff)';
  const parts = [];
  parts.push(p.phase === 'push' ? '推送' : p.phase === 'pull' ? '拉取' : '同步');
  if (p.total) parts.push(p.done + '/' + p.total + ' 个文件');
  if (p.bytesTotal) parts.push(p.mbDone + ' / ' + p.mbTotal + ' MB');
  if (p.percent && p.running) parts.push(p.percent + '%');
  if (p.running && p.current) parts.push(p.current + ' · 已 ' + Math.round((p.currentElapsedMs || 0) / 1000) + 's');
  const txt = (p.message || '') + (parts.length ? '　·　' + parts.join(' · ') : '');
  el('progtxt').textContent = txt;
  el('progtxt').style.color = p.error ? '#e66' : '#9ad';
}
async function poll() {
  try {
    const p = await api('progress');
    renderProgress(p);
    if (p.running) return true;
    return false;
  } catch { return false; }
}
function startPoll() {
  if (pollTimer) clearInterval(pollTimer);
  el('prog').className = 'prog on';
  pollTimer = setInterval(async () => { if (!(await poll())) { clearInterval(pollTimer); pollTimer = null; } }, 700);
  poll();
}
async function runSync(kind) {
  const btn = el(kind === 'push' ? 'push' : 'pull');
  btn.disabled = true;
  startPoll();
  try {
    const body = {};
    if (kind === 'pull') { try { await api('pull', body); } catch (e) { if (/已选类别/.test(e.message) && confirm('远端没有已选类别的内容，继续会清空本地对应目录。确定？')) { body.force = true; await api('pull', body); } else throw e; } }
    else await api('push', body);
    await poll();
    const p = await api('progress');
    say(p.error ? p.error : p.message, Boolean(p.error));
    if (kind === 'pull' && !p.error) {
      say('拉取完成，正在刷新页面让改动生效…');
      setTimeout(() => location.reload(), 1500);
      return;
    }
  } catch (e) {
    await poll();
    say(e.message, true);
  } finally {
    btn.disabled = false;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    setTimeout(() => { if (!pollTimer) el('prog').className = 'prog'; }, 4000);
    load().catch(() => {});
  }
}

async function load() {
  let s;
  try {
    s = await api('status', undefined, 25000);
  } catch (e) {
    el('status').textContent = '读取失败：' + e.message + String.fromCharCode(10, 10) + '（可以点「刷新」重试；如果一直失败，打开 /api/plugins/tavernsync/ping 看服务端是否响应）';
    throw e;
  }
  el('owner').value = s.owner || '';
  el('repo').value = s.repo || '';
  el('branch').value = s.branch || 'main';
  el('maxFileMB').value = String(s.maxFileMB || 20);
  el('autoPushMinutes').value = String(s.autoPushMinutes || 0);
  el('allowNew').checked = Boolean(s.allowNewExtensions);
  el('encChats').checked = Boolean(s.encryptChats);
  el('pass').placeholder = s.hasPassphrase ? '已设置口令，留空表示不修改' : '还没有设置口令';
  el('backupKeep').value = String(s.backupKeep || 3);
  mirrorUrl = s.apiMirror || '';
  el('apiBase').value = (s.apiBase && s.apiBase !== 'https://api.github.com') ? 'mirror' : 'default';
  el('token').placeholder = s.tokenSet ? '（已保存，留空不改）' : 'github_pat_...';
  if (!el('cats').children.length) {
    for (const [key, info] of Object.entries(s.categories_meta)) {
      const lab = document.createElement('label');
      lab.innerHTML = '<input type="checkbox" value="' + key + '"> ' + info.label;
      if (info.hint) lab.title = info.hint;
      el('cats').appendChild(lab);
    }
  }
  for (const box of el('cats').querySelectorAll('input')) box.checked = s.categories.includes(box.value);
  el('status').textContent = JSON.stringify({
    插件: '酒馆多端同步 v' + s.version,
    读取耗时: (s.tookMs || 0) + ' ms',
    已配置: s.configured,
    本地文件: s.local.files,
    本地体积MB: s.local.mb,
    上次提交: s.last.commit ? s.last.commit.slice(0, 7) : null,
    上次时间: s.last.at,
    分支: s.branch,
  }, null, 2);
  loadBackups().catch(() => {});
}

function form() {
  const body = {
    owner: el('owner').value.trim(),
    repo: el('repo').value.trim(),
    branch: el('branch').value.trim() || 'main',
    apiBase: el('apiBase').value === 'mirror' ? mirrorUrl : 'https://api.github.com',
    maxFileMB: Number(el('maxFileMB').value) || 20,
    autoPushMinutes: Number(el('autoPushMinutes').value) || 0,
    allowNewExtensions: el('allowNew').checked,
    encryptChats: el('encChats').checked,
    backupKeep: Number(el('backupKeep').value) || 3,
    categories: [...el('cats').querySelectorAll('input:checked')].map((b) => b.value),
  };
  if (el('token').value.trim()) body.token = el('token').value.trim();
  if (el('pass').value.trim()) body.passphrase = el('pass').value.trim();
  return body;
}

const act = (btn, fn) => async () => { btn.disabled = true; try { await fn(); } catch (e) { say(e.message, true); } finally { btn.disabled = false; } };
async function checkVersion() {
  const v = await api('version');
  const line = el('verline');
  if (v.error) { line.textContent = v.error; line.className = 'hint'; el('upd').style.display = 'none'; return; }
  if (v.hasUpdate) {
    line.innerHTML = '当前 <b>v' + v.current + '</b> · 远端已有 <b style="color:#5c9cff">v' + v.latest + '</b>，可以更新';
    line.className = 'hint ok';
    el('upd').style.display = 'inline-block';
  } else {
    line.textContent = '当前 v' + v.current + ' · 已是最新';
    line.className = 'hint';
    el('upd').style.display = 'none';
  }
}

el('check').onclick = act(el('check'), checkVersion);
el('upd').onclick = act(el('upd'), async () => {
  say('正在执行 git pull…');
  try {
    const r = await api('update', {});
    say(r.note + (r.output ? '（' + String(r.output).split(String.fromCharCode(10)).filter(Boolean).slice(-2).join(' / ') + '）' : ''), true);
  } finally { checkVersion().catch(() => {}); }
});

el('save').onclick = act(el('save'), async () => {
  if (!form().categories.length) { say('至少选一个同步范围', true); return; }
  await api('config', form()); await load(); say('配置已保存');
});
el('test').onclick = act(el('test'), async () => {
  const r = await api('test');
  say('连接正常：' + r.repo + ' @ ' + r.branch + (r.head ? '（最新提交 ' + String(r.head).slice(0, 7) + '）' : '（仓库还是空的，推送会自动建分支）'));
});
el('push').onclick = () => runSync('push');
el('pull').onclick = async () => {
  const btn = el('pull');
  btn.disabled = true;
  try {
    const p = await api('pull-preview', {}, 25000);
    const lines = [];
    lines.push('本次拉取会：覆盖 ' + p.updates + ' 个、新增 ' + p.adds + ' 个、删除 ' + p.deletes + ' 个文件。');
    if (p.newExtensionDirs && p.newExtensionDirs.length) {
      lines.push(p.allowNewExtensions
        ? '将新建扩展：' + p.newExtensionDirs.join('、')
        : '以下扩展本地没有，会被跳过（需要「允许从远端新建扩展」才会拉下来）：' + p.newExtensionDirs.join('、'));
    }
    lines.push('');
    lines.push('继续吗？');
    if (!confirm(lines.join(String.fromCharCode(10)))) return;
  } catch (e) {
    say(e.message, true);
    return;
  } finally {
    btn.disabled = false;
  }
  runSync('pull');
};

async function loadBackups() {
  try {
    const r = await api('backups', undefined, 20000);
    const box = el('backupList');
    const hint = el('backupHint');
    hint.textContent = '共 ' + r.backups.length + ' 份，占用 ' + (r.usage.bytes / 1024 / 1024).toFixed(1) + ' MB；保留最近 ' + r.keep + ' 份（超出自动清理最旧的）。';
    if (!r.backups.length) { box.textContent = '还没有备份（每次拉取前会自动创建一份）。'; return; }
    box.innerHTML = r.backups.map(function (b) {
      return '<div class="hint" style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #222">'
        + '<span>' + b.at.replace('T', ' ').slice(0, 19) + ' · ' + b.files + ' 个文件 · ' + b.mb + ' MB</span>'
        + '<button class="ghost" data-stamp="' + b.stamp + '" style="margin:0;padding:6px 10px">恢复</button>'
        + '</div>';
    }).join('');
  } catch (e) {
    el('backupHint').textContent = '读取备份失败：' + e.message;
  }
}

el('backupList').addEventListener('click', async (ev) => {
  const stamp = ev.target && ev.target.getAttribute && ev.target.getAttribute('data-stamp');
  if (!stamp) return;
  if (!confirm('从这份备份恢复？恢复前会先把当前状态再备份一份，避免误操作。')) return;
  try {
    const r = await api('restore', { stamp }, 120000);
    say('已恢复 ' + r.restored + ' 个文件' + (r.failed && r.failed.length ? '，' + r.failed.length + ' 个失败' : '') + '，页面即将刷新…');
    await loadBackups();
    setTimeout(() => location.reload(), 1600);
  } catch (e) {
    say(e.message, true);
  }
});
el('refresh').onclick = act(el('refresh'), load);
poll().then((running) => { if (running) startPoll(); });
load().catch((e) => say(e.message, true));
checkVersion().catch(() => { el('verline').textContent = '（版本检查失败，可点「检查更新」重试）'; });
</script></body></html>`;
}

// ---------------------------------------------------------------- 入口

let autoTimer = null;

function scheduleAutoPush(minutes) {
    if (autoTimer) clearInterval(autoTimer);
    autoTimer = null;
    if (!minutes || minutes <= 0) return;
    const ms = Math.max(5, minutes) * 60 * 1000;
    autoTimer = setInterval(async () => {
        if (running) return;
        try {
            await push(await loadConfig());
        } catch (err) {
            log(`自动推送失败：${err.message}`, 'error');
        }
    }, ms);
    autoTimer.unref?.();
    log(`自动推送已开启：每 ${Math.max(5, minutes)} 分钟`);
}

async function readBody(req) {
    if (req.body && typeof req.body === 'object') return req.body;
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw) return {};
    try {
        return JSON.parse(raw);
    } catch {
        return {};
    }
}

/** 拒绝跨站表单提交：只接受来源与面板同源的 POST */
function originGuard(req, res, next) {
    const headers = (req && req.headers) || {};
    const host = String(headers.host || '').toLowerCase();
    const src = String(headers.origin || headers.referer || '');
    if (src && host) {
        let srcHost = '';
        try {
            srcHost = new URL(src).host.toLowerCase();
        } catch {
            srcHost = '';
        }
        if (srcHost && srcHost !== host) {
            log(`拒绝跨站请求：来源 ${srcHost} ≠ 面板 ${host}`, 'error');
            return res.status(403).json({ error: '已拒绝：请求不是从本机面板发起的（防跨站伪造）' });
        }
    }
    return next();
}

const guard = (fn) => async (req, res) => {
    if (running) return res.status(409).json({ error: '上一次同步还在进行中' });
    running = fn.name || 'sync';
    try {
        res.json(await fn(await readBody(req)));
    } catch (err) {
        log(String(err.message || err), 'error');
        res.status(400).json({ error: String(err.message || err) });
    } finally {
        running = null;
    }
};

/** @param {import('express').Router} router */
async function init(router) {
    const cfg = await loadConfig();
    scheduleAutoPush(cfg.autoPushMinutes);

    // 自动补装前端入口（扩展可能因为手动安装/更新而缺失）
    await ensureFrontendExtension();

    // 版本检查用的上游仓库：别人 fork / 自建仓库时自动跟随，不再写死某个账号
    upstreamRepo = await resolveUpstream();
    if (!upstreamRepo) log('没有找到上游仓库地址，面板里的「检查更新」将不可用', 'error');

    router.get('/ui', (req, res) => res.type('html').send(uiHtml()));
    router.get('/status', async (req, res) => {
        try {
            res.json(await status());
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // 推送/拉取的实时进度，前端每 700ms 轮询一次
    router.get('/progress', (req, res) => res.json(progressSnapshot()));

    // 备份列表与恢复
    router.get('/backups', async (req, res) => {
        try {
            res.json({ backups: await listBackups(), usage: await backupUsage(), keep: (await loadConfig()).backupKeep });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/restore', originGuard, async (req, res) => {
        if (running) return res.status(409).json({ error: '上一次同步还在进行中，等它结束再恢复' });
        running = 'restore';
        try {
            const body = await readBody(req);
            const result = await restoreBackup(body.stamp);
            res.json(result);
        } catch (err) {
            res.status(400).json({ error: err.message });
        } finally {
            running = null;
        }
    });

    // 拉取前预览：会发生什么，先看再决定
    router.post('/pull-preview', originGuard, async (req, res) => {
        try {
            res.json(await pullPreview(await loadConfig()));
        } catch (err) {
            res.status(400).json({ error: explain(err, await loadConfig()) });
        }
    });

    // 极轻量的存活探测：用来区分「服务端没响应」和「status 太慢」
    router.get('/ping', (req, res) => res.json({ ok: true, plugin: PLUGIN_ID, version: VERSION, uptimeSec: Math.round(process.uptime()) }));

    // 当前版本 vs GitHub 上的最新版本
    router.get('/version', async (req, res) => {
        const remote = await checkRemoteVersion();
        res.json(remote);
    });

    // 一键更新：git pull --ff-only（目录与参数都写死，不接受外部输入）
    router.post('/update', originGuard, async (req, res) => {
        if (running) return res.status(409).json({ error: '上一次同步还在进行中，等它结束再更新' });
        running = 'update';
        try {
            const output = await gitPull();
            const remote = await checkRemoteVersion().catch(() => null);
            log('插件已更新，重启酒馆后生效');
            res.json({
                ok: true,
                output,
                restarted: false,
                note: '代码已更新，重启酒馆（Ctrl+C 后重新启动）才会生效',
                latest: remote && remote.latest,
            });
        } catch (err) {
            res.status(400).json({ error: err.message });
        } finally {
            running = null;
        }
    });

    const doPush = async (body) => push(await loadConfig(), { dryRun: Boolean(body && body.dryRun) });
    const doPull = async (body) => pull(await loadConfig(), { force: Boolean(body && body.force) });

    router.post('/config', originGuard, async (req, res) => {
        try {
            const body = await readBody(req);
            const patch = {};
            for (const key of ['owner', 'repo', 'branch', 'token', 'apiBase']) {
                if (typeof body[key] === 'string') patch[key] = body[key].trim();
            }
            if (Array.isArray(body.categories)) patch.categories = body.categories.filter((c) => CATEGORIES[c]);
            if (body.maxFileMB !== undefined) patch.maxFileMB = body.maxFileMB;
            if (body.autoPushMinutes !== undefined) patch.autoPushMinutes = body.autoPushMinutes;
            // 这两个曾经漏在白名单外，导致「允许新建扩展」「备份保留份数」保存不生效
            if (body.allowNewExtensions !== undefined) patch.allowNewExtensions = Boolean(body.allowNewExtensions);
            if (body.backupKeep !== undefined) patch.backupKeep = body.backupKeep;
            if (body.encryptChats !== undefined) patch.encryptChats = Boolean(body.encryptChats);
            if (typeof body.passphrase === 'string') patch.passphrase = body.passphrase;
            const saved = await saveConfig(patch);
            scheduleAutoPush(saved.autoPushMinutes);
            log('配置已更新');
            res.json({ ok: true });
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    router.get('/test', async (req, res) => {
        try {
            const cfg = await loadConfig();
            requireConfig(cfg);
            const info = await gh('GET', `/repos/${cfg.owner}/${cfg.repo}`);
            const head = await getHead(`${cfg.owner}/${cfg.repo}`, cfg.branch);
            log(`连接正常：${info.full_name}`);
            res.json({
                ok: true,
                repo: info.full_name,
                branch: cfg.branch,
                head: head?.sha || null,
                private: info.private !== false,
            });
        } catch (err) {
            res.status(400).json({ error: explain(err, await loadConfig()) });
        }
    });

    router.post('/push', originGuard, async (req, res) => {
        if (running) return res.status(409).json({ error: '上一次同步还在进行中' });
        running = 'push';
        try {
            res.json(await doPush(await readBody(req)));
        } catch (err) {
            const msg = explain(err, await loadConfig());
            log(msg, 'error');
            res.status(400).json({ error: msg });
        } finally {
            running = null;
        }
    });

    router.post('/pull', originGuard, async (req, res) => {
        if (running) return res.status(409).json({ error: '上一次同步还在进行中' });
        running = 'pull';
        try {
            res.json(await doPull(await readBody(req)));
        } catch (err) {
            const msg = explain(err, await loadConfig());
            log(msg, 'error');
            res.status(400).json({ error: msg });
        } finally {
            running = null;
        }
    });

    console.log(`[TavernSync] 已加载，界面: /api/plugins/${PLUGIN_ID}/ui`);
    return Promise.resolve();
}

async function exit() {
    if (autoTimer) clearInterval(autoTimer);
    autoTimer = null;
}

const info = {
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    version: VERSION,
    description: '酒馆多端同步：把角色卡、聊天、世界书等数据同步到私有 GitHub 仓库（无需 git / 无依赖 / 可无代理直连）',
};

// 命令行：node index.mjs status|push|pull|test （不开酒馆也能用）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const cmd = process.argv[2] || 'status';
    try {
        if (cmd === 'status') console.log(JSON.stringify(await status(), null, 2));
        else if (cmd === 'progress') console.log(JSON.stringify(progressSnapshot(), null, 2));
        else if (cmd === 'push') console.log(JSON.stringify(await push(await loadConfig()), null, 2));
        else if (cmd === 'pull') console.log(JSON.stringify(await pull(await loadConfig()), null, 2));
        else if (cmd === 'test') {
            const cfg = await loadConfig();
            requireConfig(cfg);
            const info2 = await gh('GET', `/repos/${cfg.owner}/${cfg.repo}`);
            console.log('OK', info2.full_name, info2.private === false ? '（警告：这是公开仓库）' : '（私有 ✓）');
        } else console.log('用法: node index.mjs status|progress|push|pull|test');
    } catch (err) {
        console.error('失败:', explain(err, await loadConfig().catch(() => null)));
        process.exitCode = 1;
    }
}

export { init, exit, info, push, pull, status, loadConfig, saveConfig, CATEGORIES, progressSnapshot, explain, listBackups, restoreBackup, pruneBackups, backupUsage, pullPreview };
export default { init, exit, info };

export { sealChat, openChat, stripEnc };
