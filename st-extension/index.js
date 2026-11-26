/**
 * 酒馆多端同步 · 前端扩展
 *
 * 两个作用：
 *  1. 在「扩展程序」里放一个入口，点一下打开同步面板
 *  2. 监听同步状态：只要检测到「刚刚拉取过」，就自动刷新页面，
 *     让拉取下来的聊天记录 / 角色卡 / 扩展代码立刻生效
 *
 * 真正的同步逻辑全在服务端插件（plugins/tavernsync/index.mjs）里，
 * 本文件不碰数据、不读 token。
 */
(function () {
    'use strict';

    var UI_URL = new URL('/api/plugins/tavernsync/ui', window.location.origin).href;
    var STATUS_URL = new URL('/api/plugins/tavernsync/status', window.location.origin).href;
    var POLL_MS = 4000;

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
            '    <div class="tavernsync-desc">把聊天记录 / 角色卡 / 世界书等同步到自己的私有 GitHub 仓库，多台设备共用一份数据。</div>',
            '    <button id="tavernsync-open" class="menu_button">打开同步面板</button>',
            '    <div id="tavernsync-status" class="tavernsync-status"></div>',
            '  </div>',
            '</div>',
        ].join('');

        host.appendChild(panel);

        panel.querySelector('#tavernsync-open').addEventListener('click', function () {
            window.open(UI_URL, '_blank');
        });

        return true;
    }

    function describe(s) {
        if (!s || !s.version) return '';
        var text = 'v' + s.version + ' · ' + (s.configured ? '已配置' : '未配置');
        if (s.busy) text += ' · 正在同步…';
        else if (s.last && s.last.commit) text += ' · 上次提交 ' + String(s.last.commit).slice(0, 7);
        return text;
    }

    var baselinePullAt = null;
    var reloading = false;

    function watchPull() {
        fetch(STATUS_URL, { credentials: 'same-origin' })
            .then(function (r) { return r.json(); })
            .then(function (s) {
                var box = document.getElementById('tavernsync-status');
                if (box) box.textContent = describe(s);

                var pullAt = (s && s.last && s.last.pullAt) || null;
                if (baselinePullAt === null) {
                    baselinePullAt = pullAt;   // 首次只记录基线，不刷新
                    return;
                }
                if (pullAt && pullAt !== baselinePullAt && !reloading) {
                    // 同步面板刚拉取过 → 刷新本页，让新数据生效
                    reloading = true;
                    baselinePullAt = pullAt;
                    if (box) box.textContent = '同步已完成，正在刷新页面…';
                    setTimeout(function () { window.location.reload(); }, 800);
                }
            })
            .catch(function () { /* 服务端插件没装上时忽略 */ });
    }

    // ST 的扩展面板是异步渲染的，轮询几次等它出现
    var tries = 0;
    var timer = setInterval(function () {
        tries += 1;
        if (mount() || tries > 60) clearInterval(timer);
    }, 500);

    // 状态 / 拉取监听
    watchPull();
    setInterval(watchPull, POLL_MS);
})();
