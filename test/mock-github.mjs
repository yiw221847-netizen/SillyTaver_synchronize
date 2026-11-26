/** 本地 mock 的 GitHub API：只实现 TavernSync 用到的端点，语义与真实 API 一致 */
import http from 'node:http';
import crypto from 'node:crypto';

const blobSha = (buf) => crypto.createHash('sha1').update(`blob ${buf.length}\u0000`).update(buf).digest('hex');
const rand = () => crypto.randomBytes(20).toString('hex');

export function createMockGitHub() {
    const blobs = new Map();
    const trees = new Map();
    const commits = new Map();
    const refs = new Map();
    const calls = [];

    const flatten = (treeSha) => {
        const out = new Map();
        for (const e of trees.get(treeSha) || []) out.set(e.path, { ...e });
        return out;
    };

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://x');
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const raw = Buffer.concat(chunks).toString();
        const body = raw ? JSON.parse(raw) : {};
        const send = (code, data) => {
            res.writeHead(code, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
        };
        calls.push(`${req.method} ${url.pathname}${url.search}`);
        const p = url.pathname;
        let m;

        if (req.method === 'GET' && (m = p.match(/^\/repos\/([^/]+)\/([^/]+)$/))) {
            return send(200, { full_name: `${m[1]}/${m[2]}`, private: true, default_branch: 'main' });
        }
        if (req.method === 'POST' && p.endsWith('/git/blobs')) {
            const buf = Buffer.from(body.content, 'base64');
            const sha = blobSha(buf);
            blobs.set(sha, buf);
            return send(201, { sha });
        }
        if (req.method === 'GET' && (m = p.match(/\/git\/blobs\/([0-9a-f]+)$/))) {
            const buf = blobs.get(m[1]);
            if (!buf) return send(404, { message: 'Not Found' });
            return send(200, { sha: m[1], content: buf.toString('base64'), encoding: 'base64', size: buf.length });
        }
        if (req.method === 'POST' && p.endsWith('/git/trees')) {
            const map = body.base_tree ? flatten(body.base_tree) : new Map();
            for (const e of body.tree || []) {
                if (e.sha === null) {
                    map.delete(e.path);
                    continue;
                }
                let sha = e.sha;
                if (!sha && e.content !== undefined) {
                    const buf = Buffer.from(e.content, 'utf8');
                    sha = blobSha(buf);
                    blobs.set(sha, buf);
                }
                map.set(e.path, { path: e.path, mode: e.mode || '100644', type: 'blob', sha });
            }
            const entries = [...map.values()];
            const sha = crypto.createHash('sha1').update(JSON.stringify(entries)).digest('hex');
            trees.set(sha, entries);
            return send(201, { sha, tree: entries });
        }
        if (req.method === 'GET' && (m = p.match(/\/git\/trees\/([0-9a-f]+)$/))) {
            const t = trees.get(m[1]);
            if (!t) return send(404, { message: 'Not Found' });
            return send(200, { sha: m[1], tree: t.map((e) => ({ ...e, size: blobs.get(e.sha)?.length ?? 0 })), truncated: false });
        }
        if (req.method === 'POST' && p.endsWith('/git/commits')) {
            if (!trees.has(body.tree)) return send(422, { message: 'bad tree' });
            for (const parent of body.parents || []) if (!commits.has(parent)) return send(422, { message: 'bad parent' });
            const sha = rand();
            commits.set(sha, { sha, tree: body.tree, parents: body.parents || [], message: body.message });
            return send(201, { sha, tree: { sha: body.tree }, parents: (body.parents || []).map((s) => ({ sha: s })) });
        }
        if (req.method === 'GET' && (m = p.match(/\/git\/commits\/([0-9a-f]+)$/))) {
            const c = commits.get(m[1]);
            if (!c) return send(404, { message: 'Not Found' });
            return send(200, { sha: c.sha, tree: { sha: c.tree }, parents: c.parents.map((s) => ({ sha: s })) });
        }
        if (req.method === 'GET' && (m = p.match(/\/git\/ref\/heads\/(.+)$/))) {
            const sha = refs.get(decodeURIComponent(m[1]));
            if (!sha) return send(404, { message: 'Not Found' });
            return send(200, { ref: `refs/heads/${m[1]}`, object: { sha, type: 'commit' } });
        }
        if (req.method === 'PATCH' && (m = p.match(/\/git\/refs\/heads\/(.+)$/))) {
            const b = decodeURIComponent(m[1]);
            if (!refs.has(b)) return send(422, { message: 'ref not found' });
            refs.set(b, body.sha);
            return send(200, { ref: `refs/heads/${b}`, object: { sha: body.sha } });
        }
        if (req.method === 'POST' && p.endsWith('/git/refs')) {
            const b = String(body.ref).replace('refs/heads/', '');
            if (refs.has(b)) return send(422, { message: 'already exists' });
            refs.set(b, body.sha);
            return send(201, { ref: body.ref, object: { sha: body.sha } });
        }
        return send(404, { message: `mock: no route ${req.method} ${p}` });
    });

    return {
        server,
        calls,
        listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))),
        close: () => new Promise((r) => server.close(r)),
        headFiles(branch = 'main') {
            const sha = refs.get(branch);
            if (!sha) return null;
            return flatten(commits.get(sha).tree);
        },
    };
}
