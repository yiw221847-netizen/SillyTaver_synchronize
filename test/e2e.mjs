/** 端到端：对着 mock GitHub 跑 push / pull 全流程 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createMockGitHub } from './mock-github.mjs';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tavernsync-'));
const stRoot = path.join(tmp, 'SillyTavern');
const home = path.join(tmp, 'home');
const data = path.join(stRoot, 'data', 'default-user');

await fs.mkdir(path.join(data, 'chats'), { recursive: true });
await fs.mkdir(path.join(data, 'characters'), { recursive: true });
await fs.mkdir(path.join(data, 'worlds'), { recursive: true });
await fs.mkdir(home, { recursive: true });

await fs.writeFile(path.join(data, 'chats', 'c1.jsonl'), '{"mes":"hi"}\n');
await fs.writeFile(path.join(data, 'characters', 'hero.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
await fs.writeFile(path.join(data, 'worlds', 'w.json'), JSON.stringify({ entries: {} }));
await fs.writeFile(path.join(data, 'settings.json'), 'x'.repeat(2000));

process.env.TAVERNSYNC_ROOT = stRoot;
process.env.HOME = home;

const mock = createMockGitHub();
const port = await mock.listen();
const apiBase = `http://127.0.0.1:${port}`;

const plugin = await import('../index.mjs');

await plugin.saveConfig({ owner: 'me', repo: 'r', branch: 'main', token: 't', apiBase, categories: ['chats', 'characters', 'worlds'], maxFileMB: 20 });

// 1. 首次推送（空仓库，需要建分支）
let r = await plugin.push(await plugin.loadConfig());
assert.equal(r.changed, 3, 'should push 3 files');
let files = mock.headFiles();
assert.ok(files.has('chats/c1.jsonl'));
assert.ok(files.has('characters/hero.png'));
assert.ok(files.has('worlds/w.json'));
assert.ok(!files.has('settings/settings.json') , 'settings 未选中不应上传');
console.log('✓ 首次推送', r.changed, '个文件');

// 2. 再次推送：应为 up-to-date
r = await plugin.push(await plugin.loadConfig());
assert.equal(r.upToDate, true);
console.log('✓ 第二次推送无需变更');

// 3. 修改 + 新增 + 删除
await fs.writeFile(path.join(data, 'chats', 'c1.jsonl'), '{"mes":"hi"}\n{"mes":"yo"}\n');
await fs.writeFile(path.join(data, 'worlds', 'new.json'), '{"a":1}');
await fs.rm(path.join(data, 'characters', 'hero.png'));
r = await plugin.push(await plugin.loadConfig());
assert.equal(r.changed, 2);
assert.equal(r.deleted, 1);
files = mock.headFiles();
assert.ok(!files.has('characters/hero.png'), 'deleted file should be removed');
assert.ok(files.has('worlds/new.json'));
console.log('✓ 增量推送：2 改 1 删');

// 4. 本地回滚后再拉取，应恢复
await fs.rm(path.join(data, 'chats', 'c1.jsonl'));
await fs.writeFile(path.join(data, 'worlds', 'w.json'), 'garbage');
r = await plugin.pull(await plugin.loadConfig());
assert.ok(r.updated.includes('chats/c1.jsonl'));
assert.ok(r.updated.includes('worlds/w.json'));
const restored = await fs.readFile(path.join(data, 'chats', 'c1.jsonl'), 'utf8');
assert.equal(restored, '{"mes":"hi"}\n{"mes":"yo"}\n');
const w = JSON.parse(await fs.readFile(path.join(data, 'worlds', 'w.json'), 'utf8'));
assert.deepEqual(w, { entries: {} });
console.log('✓ 拉取恢复', r.updated.length, '个文件，备份在', path.basename(r.backup));

// 5. 拉取后无需再改
r = await plugin.pull(await plugin.loadConfig());
assert.equal(r.upToDate, true);
console.log('✓ 二次拉取无变化');

// 6. 大文件按上限跳过
await fs.writeFile(path.join(data, 'chats', 'big.jsonl'), 'y'.repeat(3 * 1024 * 1024));
const cfgSmall = await plugin.saveConfig({ maxFileMB: 1 });
r = await plugin.push(await plugin.loadConfig());
assert.ok(r.skipped.some((s) => s.path.includes('big.jsonl')), 'big file should be skipped');
console.log('✓ 超过上限的文件被跳过');

// 7. 状态接口
const st = await plugin.status();
assert.equal(st.configured, true);
assert.equal(st.branch, 'main');
assert.ok(st.local.files >= 3);
console.log('✓ status 正常：', st.local.files, '个文件', st.local.mb, 'MB');

// 8. 空仓库 pull 保护
const mock2 = createMockGitHub();
const port2 = await mock2.listen();
await plugin.saveConfig({ apiBase: `http://127.0.0.1:${port2}` });
const cfg2 = await plugin.loadConfig();
await assert.rejects(() => plugin.pull(cfg2), /空的/);
await mock2.close();
console.log('✓ 空仓库拉取被拦下');

// 9. 空仓库（GitHub 会返回 409 Git Repository is empty）也能直接推送
const mockEmpty = createMockGitHub({ emptyRepo: true });
const portEmpty = await mockEmpty.listen();
await plugin.saveConfig({ apiBase: `http://127.0.0.1:${portEmpty}` });
r = await plugin.push(await plugin.loadConfig());
assert.ok(r.changed >= 1, '空仓库应能直接建分支并推送');
assert.ok(mockEmpty.headFiles().has('worlds/new.json'));
await mockEmpty.close();
console.log('✓ 空仓库（409）可直接推送，自动建分支');

// 10. 公开仓库拒绝推送（避免聊天记录公开）
const mockPublic = createMockGitHub({ privateRepo: false });
const portPublic = await mockPublic.listen();
await plugin.saveConfig({ apiBase: `http://127.0.0.1:${portPublic}` });
const cfgPublic = await plugin.loadConfig();
await assert.rejects(() => plugin.push(cfgPublic), /公开/);
assert.equal(mockPublic.calls.filter((c) => c.includes('/git/blobs')).length, 0, '公开仓库不应上传任何文件');
await mockPublic.close();
console.log('✓ 公开仓库被拒绝推送，且没有上传任何数据');

// 11. 远端路径穿越必须被拦下
const outside = path.join(tmp, 'ESCAPED.txt');
const mockEvil = createMockGitHub();
const portEvil = await mockEvil.listen();
mockEvil.seed({ 'chats/../../ESCAPED.txt': 'should never be written' });
await plugin.saveConfig({ apiBase: `http://127.0.0.1:${portEvil}` });
const cfgEvil = await plugin.loadConfig();
await assert.rejects(() => plugin.pull(cfgEvil), /不安全|越界/);
let escaped = false;
try { await fs.stat(outside); escaped = true; } catch { escaped = false; }
assert.equal(escaped, false, '文件绝不能写到 data 目录之外');
await mockEvil.close();
console.log('✓ ../ 路径穿越被拦下，没有写到目录外');

// 12. 错误说明：状态码要能翻译成下一步动作
assert.match(plugin.explain({ status: 401, message: 'GitHub 401: Bad credentials' }, null), /Token 无效/);
assert.match(plugin.explain({ status: 404, message: 'GitHub 404: Not Found' }, { owner: 'me', repo: 'r' }), /Only select repositories/);
assert.match(plugin.explain({ status: 403, message: 'GitHub 403: Forbidden' }, null), /Contents: Read and write/);
assert.match(plugin.explain({ status: 409, message: 'GitHub 409: Git Repository is empty' }, null), /README/);
console.log('✓ 401/403/404/409 都有可执行的提示');

// 13. 进度对象收尾正确
const pg = plugin.progressSnapshot();
assert.equal(pg.running, false);
assert.ok(pg.finishedAt, '同步结束后应有 finishedAt');
console.log('✓ 进度快照正常：', pg.mbTotal, 'MB /', pg.percent + '%');

await mock.close();
await fs.rm(tmp, { recursive: true, force: true });
console.log('\n全部通过');
