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
const PLUGIN_NAME = '酒馆同步 · TavernSync';
const DEFAULT_API = 'https://api.github.com';
const MAX_BLOB = 100 * 1024 * 1024;
const TREE_CHUNK_BYTES = 12 * 1024 * 1024;

/** 可同步的类别：key -> data/default-user 下的相对路径 */
const CATEGORIES = {
    chats: { label: '聊天', path: 'chats', dir: true },
    characters: { label: '角色卡', path: 'characters', dir: true },
    worlds: { label: '世界书', path: 'worlds', dir: true },
    groups: { label: '群组', path: 'groups', dir: true },
    presets: { label: '预设', path: 'OpenAI Settings', dir: true },
    personas: { label: '人格', path: 'User Avatars', dir: true },
    backgrounds: { label: '背景图', path: 'backgrounds', dir: true },
    themes: { label: '主题', path: 'themes', dir: true },
    settings: { label: '设置 settings.json', path: 'settings.json', dir: false },
    extensions: { label: '扩展清单', path: 'extensions-backup.json', dir: false },
};

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
    await fs.mkdir(CONF_DIR, { recursive: true, mode: 0o700 });
    await fs.writeFile(CONF_FILE, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
    await fs.chmod(CONF_FILE, 0o600).catch(() => {});
    return next;
}

async function loadState() {
    try {
        const s = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
        return { lastCommit: s.lastCommit || null, files: s.files || {}, hashCache: s.hashCache || {}, at: s.at || null };
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
            lastError = err instanceof GhError ? err : new GhError(`连不上 GitHub：${err.message}`, 0);
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
        if (err.status === 404) return null;
        throw err;
    }
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
        if (err.status !== 404 && err.status !== 422) throw err;
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

/** 能安全地当成 UTF-8 文本提交给 tree API 的才走 inline content，其余走 blob 上传 */
function isText(buf) {
    if (buf.length > 4 * 1024 * 1024) return false;
    if (buf.includes(0)) return false;
    const s = buf.toString('utf8');
    return !s.includes('\uFFFD') && Buffer.from(s, 'utf8').equals(buf);
}

async function collectLocal(cfg, state) {
    const out = new Map();
    const skipped = [];
    const cache = (state && state.hashCache) || {};
    const nextCache = {};
    const limit = Math.min(cfg.maxFileMB * 1024 * 1024, MAX_BLOB);

    for (const key of cfg.categories) {
        const cat = CATEGORIES[key];
        if (!cat) continue;
        const absPath = path.join(DATA_ROOT, cat.path);
        const files = cat.dir
            ? await walk(absPath)
            : await fs
                  .stat(absPath)
                  .then(() => [{ abs: absPath, rel: path.basename(absPath) }])
                  .catch(() => []);
        for (const f of files) {
            const repoPath = cat.dir ? `${key}/${f.rel}` : key;
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
                out.set(repoPath, { abs: f.abs, sha: cached.sha, size: st.size });
                nextCache[repoPath] = cached;
                continue;
            }
            let buf;
            try {
                buf = await fs.readFile(f.abs);
            } catch (err) {
                skipped.push({ path: repoPath, reason: err.message });
                continue;
            }
            const sha = sha1Blob(buf);
            out.set(repoPath, { abs: f.abs, sha, size: st.size });
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
    const state = await loadState();
    const head = await getHead(repo, cfg.branch);
    const remote = head ? await getTree(repo, head.tree) : new Map();
    const { files, skipped, cache } = await collectLocal(cfg, state);

    const adds = [];
    const textEntries = [];
    const binary = [];
    for (const [repoPath, f] of files) {
        const r = remote.get(repoPath);
        if (r && r.sha === f.sha) continue;
        adds.push(repoPath);
        if (dryRun) continue;
        const buf = await fs.readFile(f.abs);
        if (isText(buf)) textEntries.push({ path: repoPath, mode: '100644', type: 'blob', content: buf.toString('utf8') });
        else binary.push({ path: repoPath, buf });
    }

    const deletes = [];
    for (const p of remote.keys()) if (isManaged(p, cfg.categories) && !files.has(p)) deletes.push(p);

    if (!adds.length && !deletes.length) {
        await saveState({ ...state, hashCache: cache });
        log('推送：本地与远端一致，无事可做');
        return { ok: true, changed: 0, deleted: 0, skipped, commit: head?.sha || null, upToDate: true };
    }
    if (dryRun) {
        log(`推送（预演）：${adds.length} 个变更，${deletes.length} 个删除`);
        return { ok: true, dryRun: true, changed: adds.length, deleted: deletes.length, skipped, files: adds, removed: deletes };
    }

    const blobEntries = await mapLimit(binary, 3, async (b) => ({
        path: b.path,
        mode: '100644',
        type: 'blob',
        sha: await createBlob(repo, b.buf),
    }));

    const entries = [
        ...textEntries,
        ...blobEntries,
        ...deletes.map((p) => ({ path: p, mode: '100644', type: 'blob', sha: null })),
    ];

    let baseTree = head?.tree || null;
    for (const chunk of chunkEntries(entries)) baseTree = await createTree(repo, baseTree, chunk);
    const message = `sync(${process.env.TAVERNSYNC_HOSTNAME || 'tavern'}): ${adds.length} changed, ${deletes.length} deleted`;
    const commitSha = await createCommit(repo, message, baseTree, head ? [head.sha] : []);
    await updateRef(repo, cfg.branch, commitSha);

    const fileShas = { ...(state.files || {}) };
    for (const [p, f] of files) fileShas[p] = f.sha;
    for (const p of deletes) delete fileShas[p];
    await saveState({ lastCommit: commitSha, files: fileShas, hashCache: cache, at: new Date().toISOString() });

    log(`推送完成：${adds.length} 个变更，${deletes.length} 个删除 → ${commitSha.slice(0, 7)}`);
    return { ok: true, changed: adds.length, deleted: deletes.length, skipped, files: adds, removed: deletes, commit: commitSha };
}

// ---------------------------------------------------------------- 拉取

async function pull(cfg, { force = false } = {}) {
    requireConfig(cfg);
    const repo = `${cfg.owner}/${cfg.repo}`;
    const head = await getHead(repo, cfg.branch);
    if (!head) throw new Error('远端分支还是空的，没有可拉取的内容');

    const remote = await getTree(repo, head.tree);
    const managed = [...remote.keys()].filter((p) => isManaged(p, cfg.categories));
    if (!managed.length && !force) {
        throw new Error('远端没有已选类别的内容；确认要清空本地对应目录时请带 force');
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const result = { ok: true, updated: [], removed: [], unchanged: 0, commit: head.sha, backup: null };

    for (const repoPath of managed) {
        const [catKey, ...rest] = repoPath.split('/');
        const cat = CATEGORIES[catKey];
        if (!cat) continue;
        const abs = cat.dir ? path.join(DATA_ROOT, cat.path, ...rest) : path.join(DATA_ROOT, cat.path);
        const want = remote.get(repoPath);

        let currentSha = null;
        try {
            const st = await fs.stat(abs);
            if (st.isFile()) currentSha = sha1Blob(await fs.readFile(abs));
        } catch {
            currentSha = null;
        }
        if (currentSha && currentSha === want.sha) {
            result.unchanged++;
            continue;
        }
        if (currentSha) await backupFile(repoPath, abs, stamp);

        const buf = await readBlob(repo, want.sha);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, buf);
        result.updated.push(repoPath);
    }

    for (const key of cfg.categories) {
        const cat = CATEGORIES[key];
        if (!cat || !cat.dir) continue;
        for (const f of await walk(path.join(DATA_ROOT, cat.path))) {
            const repoPath = `${key}/${f.rel}`;
            if (remote.has(repoPath)) continue;
            await backupFile(repoPath, f.abs, stamp);
            await fs.rm(f.abs, { force: true });
            result.removed.push(repoPath);
        }
    }

    const fileShas = {};
    for (const [p, v] of remote) if (isManaged(p, cfg.categories)) fileShas[p] = v.sha;
    await saveState({ lastCommit: head.sha, files: fileShas, hashCache: {}, at: new Date().toISOString() });

    if (result.updated.length || result.removed.length) {
        result.backup = path.join(BACKUP_DIR, stamp);
        log(`拉取完成：${result.updated.length} 个更新，${result.removed.length} 个移除（备份在 ${result.backup}）`);
    } else {
        result.upToDate = true;
        log('拉取：本地已是最新');
    }
    return result;
}

// ---------------------------------------------------------------- 状态

async function status() {
    const cfg = await loadConfig();
    const state = await loadState();
    const { files } = await collectLocal(cfg, state).catch(() => ({ files: new Map() }));
    const bytes = [...files.values()].reduce((s, f) => s + (f.size || 0), 0);
    return {
        plugin: PLUGIN_ID,
        name: PLUGIN_NAME,
        stRoot: ST_ROOT,
        dataRoot: DATA_ROOT,
        configured: Boolean(cfg.owner && cfg.repo && cfg.token),
        owner: cfg.owner,
        repo: cfg.repo,
        branch: cfg.branch,
        apiBase: cfg.apiBase,
        tokenSet: Boolean(cfg.token),
        categories: cfg.categories,
        maxFileMB: cfg.maxFileMB,
        autoPushMinutes: cfg.autoPushMinutes,
        local: { files: files.size, mb: Number((bytes / 1024 / 1024).toFixed(2)) },
        last: { commit: state.lastCommit, at: state.at, files: Object.keys(state.files || {}).length },
        busy: Boolean(running),
        categories_meta: Object.fromEntries(
            Object.entries(CATEGORIES).map(([k, v]) => [k, { label: v.label, path: v.path }]),
        ),
        logs: logs.slice(-40),
    };
}

// ---------------------------------------------------------------- 网页界面

function uiHtml() {
    return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>酒馆同步 · TavernSync</title>
<style>
:root{color-scheme:dark}
body{font:14px/1.55 system-ui,sans-serif;margin:0;padding:16px;background:#151515;color:#ddd;max-width:760px}
h1{font-size:17px;margin:0 0 4px}
h2{font-size:14px;margin:18px 0 8px;color:#9ad}
label{display:block;margin:8px 0 2px;color:#aaa;font-size:12px}
input[type=text],input[type=password],input[type=number]{width:100%;box-sizing:border-box;background:#222;border:1px solid #333;color:#eee;padding:8px;border-radius:6px}
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
</style></head><body>
<h1>酒馆同步 · TavernSync</h1>
<div class="hint">把酒馆数据同步到私有 GitHub 仓库：无需 git、无依赖，默认直连 api.github.com，不装代理也能用。</div>

<h2>仓库</h2>
<div class="row">
<div><label>所有者 / 用户名</label><input id="owner" type="text" placeholder="octocat"></div>
<div><label>仓库名</label><input id="repo" type="text" placeholder="tavern-data"></div>
</div>
<div class="row">
<div><label>分支</label><input id="branch" type="text" value="main"></div>
<div><label>单文件上限 (MB)</label><input id="maxFileMB" type="number" min="1" max="99" value="20"></div>
<div><label>自动推送间隔 (分钟)</label><input id="autoPushMinutes" type="number" min="0" value="0"></div>
</div>
<label>Personal Access Token（Contents: Read and write）</label>
<input id="token" type="password" placeholder="github_pat_...">
<label>API 地址（默认直连，被墙时换成反代）</label>
<input id="apiBase" type="text" value="https://api.github.com">

<h2>同步范围</h2>
<div class="cats" id="cats"></div>
<div class="hint">settings.json 常有几十 MB，默认不同步。</div>

<div>
<button id="save">保存配置</button>
<button id="test" class="ghost">测试连接</button>
<button id="push">推送</button>
<button id="pull" class="ghost">拉取</button>
<button id="refresh" class="ghost">刷新</button>
</div>

<h2>状态</h2>
<pre id="status">读取中…</pre>
<div id="msg" class="hint"></div>
<script>
const el = (id) => document.getElementById(id);
async function api(p, body) {
  const res = await fetch(new URL(p, location.href), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
const say = (t, bad) => { const m = el('msg'); m.textContent = t; m.className = bad ? 'hint bad' : 'hint ok'; };

async function load() {
  const s = await api('status');
  el('owner').value = s.owner || '';
  el('repo').value = s.repo || '';
  el('branch').value = s.branch || 'main';
  el('maxFileMB').value = s.maxFileMB;
  el('autoPushMinutes').value = s.autoPushMinutes;
  el('apiBase').value = s.apiBase;
  el('token').placeholder = s.tokenSet ? '（已保存，留空不改）' : 'github_pat_...';
  if (!el('cats').children.length) {
    for (const [key, info] of Object.entries(s.categories_meta)) {
      const lab = document.createElement('label');
      lab.innerHTML = '<input type="checkbox" value="' + key + '"> ' + info.label;
      el('cats').appendChild(lab);
    }
  }
  for (const box of el('cats').querySelectorAll('input')) box.checked = s.categories.includes(box.value);
  el('status').textContent = JSON.stringify({
    已配置: s.configured,
    本地文件: s.local.files,
    本地体积MB: s.local.mb,
    上次提交: s.last.commit ? s.last.commit.slice(0, 7) : null,
    上次时间: s.last.at,
    分支: s.branch,
  }, null, 2);
}

function form() {
  const body = {
    owner: el('owner').value.trim(),
    repo: el('repo').value.trim(),
    branch: el('branch').value.trim() || 'main',
    apiBase: el('apiBase').value.trim(),
    maxFileMB: Number(el('maxFileMB').value) || 20,
    autoPushMinutes: Number(el('autoPushMinutes').value) || 0,
    categories: [...el('cats').querySelectorAll('input:checked')].map((b) => b.value),
  };
  if (el('token').value.trim()) body.token = el('token').value.trim();
  return body;
}

const act = (btn, fn) => async () => { btn.disabled = true; try { await fn(); } catch (e) { say(e.message, true); } finally { btn.disabled = false; } };
el('save').onclick = act(el('save'), async () => { await api('config', form()); await load(); say('配置已保存'); });
el('test').onclick = act(el('test'), async () => { const r = await api('test'); say('连接正常：' + r.repo + ' @ ' + r.branch); });
el('push').onclick = act(el('push'), async () => { say('推送中…'); const r = await api('push', {}); say(r.upToDate ? '已是最新，无需推送' : '推送完成：' + r.changed + ' 个变更，' + r.deleted + ' 个删除'); });
el('pull').onclick = act(el('pull'), async () => { try { say('拉取中…'); const r = await api('pull', {}); say(r.upToDate ? '已是最新，无需拉取' : '拉取完成：' + r.updated.length + ' 个更新，' + r.removed.length + ' 个移除'); } catch (e) { if (/已选类别/.test(e.message) && confirm('远端没有已选类别的内容，继续会清空本地对应目录。确定？')) { const r = await api('pull', { force: true }); say('拉取完成：' + r.updated.length + ' 个更新，' + r.removed.length + ' 个移除'); } else throw e; } });
el('refresh').onclick = act(el('refresh'), load);
load().catch((e) => say(e.message, true));
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

    router.get('/ui', (req, res) => res.type('html').send(uiHtml()));
    router.get('/status', async (req, res) => {
        try {
            res.json(await status());
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    const doPush = async (body) => push(await loadConfig(), { dryRun: Boolean(body && body.dryRun) });
    const doPull = async (body) => pull(await loadConfig(), { force: Boolean(body && body.force) });

    router.post('/config', async (req, res) => {
        try {
            const body = await readBody(req);
            const patch = {};
            for (const key of ['owner', 'repo', 'branch', 'token', 'apiBase']) {
                if (typeof body[key] === 'string') patch[key] = body[key].trim();
            }
            if (Array.isArray(body.categories)) patch.categories = body.categories.filter((c) => CATEGORIES[c]);
            if (body.maxFileMB !== undefined) patch.maxFileMB = body.maxFileMB;
            if (body.autoPushMinutes !== undefined) patch.autoPushMinutes = body.autoPushMinutes;
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
            res.json({ ok: true, repo: info.full_name, branch: cfg.branch, head: head?.sha || null });
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    router.post('/push', async (req, res) => {
        if (running) return res.status(409).json({ error: '上一次同步还在进行中' });
        running = 'push';
        try {
            res.json(await doPush(await readBody(req)));
        } catch (err) {
            log(String(err.message || err), 'error');
            res.status(400).json({ error: String(err.message) });
        } finally {
            running = null;
        }
    });

    router.post('/pull', async (req, res) => {
        if (running) return res.status(409).json({ error: '上一次同步还在进行中' });
        running = 'pull';
        try {
            res.json(await doPull(await readBody(req)));
        } catch (err) {
            log(String(err.message || err), 'error');
            res.status(400).json({ error: String(err.message) });
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
    description: '把角色卡、聊天、世界书等数据同步到私有 GitHub 仓库（无需 git / 无依赖 / 可无代理直连）',
};

// 命令行：node index.mjs status|push|pull|test （不开酒馆也能用）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const cmd = process.argv[2] || 'status';
    try {
        if (cmd === 'status') console.log(JSON.stringify(await status(), null, 2));
        else if (cmd === 'push') console.log(JSON.stringify(await push(await loadConfig()), null, 2));
        else if (cmd === 'pull') console.log(JSON.stringify(await pull(await loadConfig()), null, 2));
        else if (cmd === 'test') {
            const cfg = await loadConfig();
            requireConfig(cfg);
            const info2 = await gh('GET', `/repos/${cfg.owner}/${cfg.repo}`);
            console.log('OK', info2.full_name);
        } else console.log('用法: node index.mjs status|push|pull|test');
    } catch (err) {
        console.error('失败:', err.message);
        process.exitCode = 1;
    }
}

export { init, exit, info, push, pull, status, loadConfig, saveConfig, CATEGORIES };
export default { init, exit, info };
