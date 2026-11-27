/* =========================================================================
 * 激活层 —— 免费范围与激活码
 * -------------------------------------------------------------------------
 * 免费：预置在 FREE_DOMAINS 里的领域，讲义正文、题目、视频全开。
 * 付费：其余领域的内容要激活码；地图、考点清单、考情、易错点标题仍然公开。
 *
 * 码格式 MATH-XXXX-YY，XXXX 是买家编号，YY = (四位数字之和 × 7) 取后两位。
 * 前端只存算法不存码表，所以卖一份编一个，不用改代码。
 *
 * 删掉这个文件，app.js 里的兜底会让整站免费。源码本来就公开，这一点认了。
 * ========================================================================= */
window.Gate = (function () {
  'use strict';

  var KEY = 'gd-math-activated';
  /* 免费开放的领域。
   * prep 必须在这里：集合和复数的第一课都要求先学「数与式的运算」(p1)，
   * 预备层锁着的话，新用户一课都点不亮，整棵树从起点就断了。 */
  var FREE_DOMAINS = ['prep', 'set', 'cplx'];

  function activated() {
    try { return localStorage.getItem(KEY) === '1'; } catch (e) { return false; }
  }

  /* 粘贴常有空格、短横线、小写，统一掉再判 */
  function normalize(raw) {
    return String(raw == null ? '' : raw).toUpperCase().replace(/[\s\-—–_]/g, '');
  }

  function codeOk(raw) {
    var m = normalize(raw).match(/^MATH(\d{4})(\d{2})$/);
    if (!m) return false;
    var sum = 0;
    for (var i = 0; i < 4; i++) sum += Number(m[1].charAt(i));
    var yy = String((sum * 7) % 100);
    if (yy.length < 2) yy = '0' + yy;
    return yy === m[2];
  }

  function canUse(domId) {
    if (activated()) return true;
    return FREE_DOMAINS.indexOf(domId) >= 0;
  }

  function canSkill(sid) {
    var s = (typeof byId !== 'undefined' && byId) ? byId[sid] : null;
    if (!s) return false;
    return canUse(s.d);
  }

  function lockCard(opts) {
    opts = opts || {};
    var title = opts.title || '这一块要激活码';
    var note = opts.note || '激活码找群主拿，输一次就记住了。换手机或清缓存要重新输，同一个码，不用重新买。';
    return '<div class="gate-card">' +
      '<div class="gate-h">' + title + '</div>' +
      '<div class="gate-n">' + note + '</div>' +
      '<div class="gate-row">' +
        '<input class="gate-in" type="text" inputmode="text" autocomplete="off" spellcheck="false" ' +
          'placeholder="MATH-0000-00" aria-label="激活码">' +
        '<button class="btn primary gate-go" type="button">激活</button>' +
      '</div>' +
      '<div class="gate-msg" role="status" aria-live="polite"></div>' +
    '</div>';
  }

  function submit(input) {
    var card = input.closest('.gate-card');
    if (!card) return;
    var msg = card.querySelector('.gate-msg');
    var val = input.value;
    if (!normalize(val)) {
      if (msg) { msg.className = 'gate-msg bad'; msg.textContent = '先把码填上。'; }
      input.focus();
      return;
    }
    if (!codeOk(val)) {
      if (msg) {
        msg.className = 'gate-msg bad';
        msg.textContent = '码不对。照群公告里那串原样粘，注意是 MATH 开头。';
      }
      return;
    }
    try { localStorage.setItem(KEY, '1'); } catch (e) {
      if (msg) {
        msg.className = 'gate-msg bad';
        msg.textContent = '这个浏览器不让存东西（无痕模式？），换普通窗口再试。';
      }
      return;
    }
    if (msg) { msg.className = 'gate-msg ok'; msg.textContent = '激活了，正在打开…'; }
    if (typeof render === 'function') render();
  }

  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('.gate-go');
    if (!btn) return;
    var card = btn.closest('.gate-card');
    if (card) submit(card.querySelector('.gate-in'));
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    if (!e.target.classList || !e.target.classList.contains('gate-in')) return;
    e.preventDefault();
    submit(e.target);
  });

  return {
    KEY: KEY,
    FREE_DOMAINS: FREE_DOMAINS,
    activated: activated,
    normalize: normalize,
    codeOk: codeOk,
    canUse: canUse,
    canSkill: canSkill,
    lockCard: lockCard
  };
})();
