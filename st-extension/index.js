/**
 * 酒馆多端同步 · 前端扩展
 *
 * 作用只有一个：在酒馆（手机 App / 网页）的「扩展程序」里放一个入口，
 * 点一下就能跳到服务端插件的配置面板，不用自己拼 /api/plugins/tavernsync/ui 这个地址。
 *
 * 真正的同步逻辑全部在服务端插件（plugins/tavernsync/index.mjs）里。
 * 本文件不碰数据、不读 token。
 */
(function () {
    'use strict';

    var UI_URL = new URL('/api/plugins/tavernsync/ui', window.location.origin).href;
    var STATUS_URL = new URL('/api/plugins/tavernsync/status', window.location.origin).href;

    function mount() {
        if (document.getElementById('tavernsync-jump')) return true;
        var host = document.getElementById('extensions_settings')
            || document.getElementById('extensions_settings2');
        if (!host) return false;

        var panel = document.createElement('div');
        panel.id = 'tavernsync-jump';
        panel.className = 'extension_container';
        panel.innerHTML = [
            '<div class="inline-drawer">',
            '  <div class="inline-drawer-toggle inline-drawer-header">',
            '    <b>酒馆多端同步</b>',
            '    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>',
            '  </div>',
            '  <div class="inline-drawer-content">',
            '    <div class="tavernsync-desc">把聊天 / 角色卡 / 世界书等同步到自己的私有 GitHub 仓库，手机和电脑共用一份数据。</div>',
            '    <button id="tavernsync-open" class="menu_button">打开同步面板</button>',
            '    <div id="tavernsync-status" class="tavernsync-status"></div>',
            '  </div>',
            '</div>',
        ].join('');

        host.appendChild(panel);

        panel.querySelector('#tavernsync-open').addEventListener('click', function () {
            window.open(UI_URL, '_blank');
        });

        fetch(STATUS_URL, { credentials: 'same-origin' })
            .then(function (r) { return r.json(); })
            .then(function (s) {
                var box = panel.querySelector('#tavernsync-status');
                if (!s || !s.version) return;
                var text = 'v' + s.version + ' · ' + (s.configured ? '已配置' : '未配置');
                if (s.busy) text += ' · 正在同步…';
                else if (s.last && s.last.commit) text += ' · 上次提交 ' + String(s.last.commit).slice(0, 7);
                box.textContent = text;
            })
            .catch(function () { /* 服务端插件没装上时忽略 */ });

        return true;
    }

    // ST 的扩展面板是异步渲染的，轮询几次等它出现
    var tries = 0;
    var timer = setInterval(function () {
        tries += 1;
        if (mount() || tries > 60) clearInterval(timer);
    }, 500);
})();
