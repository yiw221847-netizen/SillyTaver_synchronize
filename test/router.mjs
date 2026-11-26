/** 模拟 express router，验证插件注册的路由能正常工作 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ts-router-'));
process.env.TAVERNSYNC_ROOT = path.join(tmp, 'st');
process.env.HOME = path.join(tmp, 'home');
await fs.mkdir(path.join(process.env.TAVERNSYNC_ROOT, 'data', 'default-user', 'chats'), { recursive: true });
await fs.mkdir(process.env.HOME, { recursive: true });
await fs.writeFile(path.join(process.env.TAVERNSYNC_ROOT, 'data', 'default-user', 'chats', 'a.jsonl'), 'hi\n');

const plugin = await import('../index.mjs');

const routes = new Map();
const router = {
    get: (p, h) => routes.set(`GET ${p}`, h),
    post: (p, h) => routes.set(`POST ${p}`, h),
};
await plugin.init(router);

async function call(method, p, body) {
    const h = routes.get(`${method} ${p}`);
    assert.ok(h, `route ${method} ${p} 未注册`);
    let payload = null;
    let status = 200;
    const res = {
        json(d) { payload = d; return this; },
        status(c) { status = c; return this; },
        type() { return this; },
        send(d) { payload = d; return this; },
    };
    await h({ body, method }, res);
    return { status, payload };
}

const s = await call('GET', '/status');
assert.equal(s.status, 200);
assert.equal(s.payload.plugin, 'tavernsync');
assert.equal(s.payload.local.files, 1);

const cfg = await call('POST', '/config', { owner: 'me', repo: 'r', token: 't', categories: ['chats'], apiBase: 'http://127.0.0.1:1' });
assert.equal(cfg.status, 200);
assert.equal(cfg.payload.ok, true);

const st2 = await call('GET', '/status');
assert.equal(st2.payload.owner, 'me');
assert.equal(st2.payload.configured, true);

const ui = await call('GET', '/ui');
assert.equal(ui.status, 200);
assert.match(ui.payload, /酒馆多端同步/);
assert.match(ui.payload, /v1\.2\.2/);
assert.match(ui.payload, /<select id="maxFileMB"/);

// 进度接口
const prog = await call('GET', '/progress');
assert.equal(prog.status, 200);
assert.equal(prog.payload.running, false);

// 版本接口（离线时也要能返回本地版本）
const ver = await call('GET', '/version');
assert.equal(ver.status, 200);
assert.equal(ver.payload.current, '1.2.2');

// 轻量存活探测
const ping = await call('GET', '/ping');
assert.equal(ping.status, 200);
assert.equal(ping.payload.ok, true);
assert.ok(ping.payload.version);

// status 应该是轻量的（不哈希文件），并且带上耗时字段
assert.equal(typeof s.payload.tookMs, 'number');

// init 时应自动补装前端入口
const extManifest = path.join(process.env.TAVERNSYNC_ROOT, 'public/scripts/extensions/third-party/tavernsync/manifest.json');
await fs.stat(extManifest);

// 没配 token 时 push 应返回 400 而不是崩
await plugin.saveConfig({ token: '' });
const bad = await call('POST', '/push', {});
assert.equal(bad.status, 400);
assert.match(bad.payload.error, /Token/);

await fs.rm(tmp, { recursive: true, force: true });
console.log('✓ 路由测试通过');
