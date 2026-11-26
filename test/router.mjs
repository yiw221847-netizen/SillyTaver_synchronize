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
assert.match(ui.payload, /TavernSync/);

// 没配 token 时 push 应返回 400 而不是崩
await plugin.saveConfig({ token: '' });
const bad = await call('POST', '/push', {});
assert.equal(bad.status, 400);
assert.match(bad.payload.error, /Token/);

await fs.rm(tmp, { recursive: true, force: true });
console.log('✓ 路由测试通过');
