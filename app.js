/* =======================================================================
 *  基础索引与图算法
 * ======================================================================= */
const byId = Object.fromEntries(SKILLS.map(s => [s.id, s]));
const domById = Object.fromEntries(DOMAINS.map(d => [d.id, d]));
const LV_ORDER = { A: 0, B: 1, C: 2, D: 3 };

/* 数据里到处是不等号和大于号（−1<x<4、0<a<1），直接塞进 innerHTML 会被
 * 浏览器当成标签起始吞掉。比如「写出 −1<x<4」会变成「写出 −1」。
 * 所以在进页面之前先把正文类字段转义一遍。技能名不含符号，不用动。 */
const escHtml = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
SKILLS.forEach(s => {
  s.how = escHtml(s.how);
  if (s.tip) s.tip = escHtml(s.tip);
  if (s.unsure) s.unsure = escHtml(s.unsure);
  s.pts = (s.pts || []).map(escHtml);
});
DOMAINS.forEach(d => {
  d.desc = escHtml(d.desc);
  d.score = escHtml(d.score);
  if (d.unsure) d.unsure = escHtml(d.unsure);
});

const STEP_TEXT = ['', '第一步 · 零门槛', '第二步', '第三步', '第四步', '第五步', '第六步', '第七步', '第八步'];

function softOf(id){ return SOFT_PRE[id] || []; }
function isSoft(child, parent){ return softOf(child).includes(parent); }
function hardPre(id){ return (byId[id].pre || []).filter(p => !isSoft(id, p)); }
function allPre(id){ return byId[id].pre || []; }

/* 最长前置链深度 = 这一步排在第几步 */
const _stepMemo = {};
function stepOf(id, guard){
  if (_stepMemo[id]) return _stepMemo[id];
  guard = guard || new Set();
  if (guard.has(id)) return 1;              // 理论上无环，防御一下
  guard.add(id);
  const hard = hardPre(id);
  const v = hard.length ? 1 + Math.max(...hard.map(p => stepOf(p, guard))) : 1;
  guard.delete(id);
  _stepMemo[id] = v;
  return v;
}

/* 所有祖先（含软前置），用于"整条前置链亮起来" */
function ancestry(id){
  const out = new Set();
  (function walk(x){
    allPre(x).forEach(p => { if (!out.has(p)) { out.add(p); walk(p); } });
  })(id);
  return out;
}

/* 下游：谁把当前技能当必须前置 */
function downstream(id){
  return SKILLS.filter(s => hardPre(s.id).includes(id)).map(s => s.id);
}

/* =======================================================================
 *  状态
 * ======================================================================= */
const KEY = 'gd-math-skill-tree-v2';
const OLD_KEY = 'gd-math-skill-tree-v1';   // 老版本只存了点亮状态，读一次做迁移
const state = {
  view: 'home',
  domainId: null,
  selected: null,
  goal: null,
  query: '',
  qFilter: '',
  showSkippable: false,
  lit: new Set(),
  quiz: null,        // 正在答的：{ sid, i, answers: [] }
  wrong: [],         // 错题本：[{ sid, qi, stage, due, ts }]
  progress: {}       // { sid: { tries, best } }
};

function save(){
  try{
    localStorage.setItem(KEY, JSON.stringify({
      lit: [...state.lit], goal: state.goal, showSkippable: state.showSkippable,
      wrong: state.wrong, progress: state.progress
    }));
  }catch(e){ /* file:// 下个别浏览器禁写，忽略，进度仍存在内存里 */ }
}
function load(){
  try{
    const raw = localStorage.getItem(KEY) || localStorage.getItem(OLD_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    (d.lit || []).forEach(x => byId[x] && state.lit.add(x));
    state.goal = d.goal && byId[d.goal] ? d.goal : null;
    state.showSkippable = !!d.showSkippable;
    state.wrong = (d.wrong || []).filter(w => byId[w.sid] && QUIZ[w.sid] && QUIZ[w.sid][w.qi]);
    state.progress = d.progress || {};
  }catch(e){}
}

function visibleSkills(){
  return SKILLS.filter(s => state.showSkippable || s.lv !== 'D');
}
function isUnlocked(id){
  return hardPre(id).every(p => state.lit.has(p));
}
function missingPre(id){
  return hardPre(id).filter(p => !state.lit.has(p));
}

/* =======================================================================
 *  刷题 / 点亮规则
 *  有题的技能：结业挑战正确率 ≥ 80% 才点亮，不能自己打勾。
 *  没配题的技能：退回到手动点亮（否则那 18 个技能永远点不了）。
 * ======================================================================= */
const QUIT_PASS = 0.8;                       // 结业挑战及格线
const REVIEW_GAP = [1, 3, 7, 15];            // 错题复习间隔（天）

const hasQuiz = id => !!(QUIZ[id] && QUIZ[id].length);
const bestRate = id => (state.progress[id] && state.progress[id].best) || 0;
const quizCount = () => Object.keys(QUIZ).reduce((a, k) => a + QUIZ[k].length, 0);

/* 错题按遗忘曲线排期：答错回第 0 档、1 天后复习；答对往后一档；4 档全过就移出错题本 */
function scheduleWrong(sid, qi, correct){
  const i = state.wrong.findIndex(w => w.sid === sid && w.qi === qi);
  if (correct){
    if (i < 0) return;
    const w = state.wrong[i];
    w.stage = (w.stage || 0) + 1;
    if (w.stage >= REVIEW_GAP.length){
      state.wrong.splice(i, 1);              // 出师
    } else {
      w.due = Date.now() + REVIEW_GAP[w.stage] * 864e5;
    }
  } else {
    if (i >= 0){
      state.wrong[i].stage = 0;
      state.wrong[i].due = Date.now() + REVIEW_GAP[0] * 864e5;
      state.wrong[i].ts = Date.now();
    } else {
      state.wrong.push({ sid, qi, stage: 0, due: Date.now() + REVIEW_GAP[0] * 864e5, ts: Date.now() });
    }
  }
}
const dueWrong = () => state.wrong.filter(w => w.due <= Date.now());

/* 这个技能该看哪些视频：技能级优先，没有就用领域级兜底 */
function videoList(id){
  const bvs = SKILL_VIDEO[id] || DOMAIN_VIDEO[byId[id].d] || [];
  return bvs.map(bv => VIDEO_INFO[bv] ? { bv, ...VIDEO_INFO[bv] } : null).filter(Boolean);
}

/* =======================================================================
 *  进度
 * ======================================================================= */
function renderProgress(){
  const vis = visibleSkills();
  const done = vis.filter(s => state.lit.has(s.id)).length;
  const pct = vis.length ? Math.round(done / vis.length * 100) : 0;
  document.getElementById('pbar-fill').style.width = pct + '%';
  document.getElementById('pbar-text').textContent =
    `已点亮 ${done} / ${vis.length} 个技能 · ${pct}%`;
}

/* =======================================================================
 *  视图：领域总览
 * ======================================================================= */
function renderHome(){
  const vis = visibleSkills();
  const cards = DOMAINS.map(d => {
    const ds = vis.filter(s => s.d === d.id);
    const total = SKILLS.filter(s => s.d === d.id).length;
    const litN = ds.filter(s => state.lit.has(s.id)).length;
    const pct = total ? Math.round(litN / total * 100) : 0;
    const hidden = total - ds.length;
    // 跨领域前置数量：线越粗=依赖越多，这里落成一个数字
    const ext = new Set();
    SKILLS.filter(s => s.d === d.id).forEach(s =>
      allPre(s.id).forEach(p => { if (byId[p].d !== d.id) ext.add(p); }));
    return `
      <div class="dom-card" data-dom="${d.id}" style="--dc:${d.color}">
        <h3>${d.name}</h3>
        <div class="meta">
          <span class="rank-badge lv-${d.lv}">${d.lv}</span>
          <span>${d.score}</span>
        </div>
        <div class="desc">${d.desc}</div>
        <div class="foot">
          <span>${litN}/${total} 已点亮${hidden ? ` · 含 ${hidden} 个可跳过` : ''}</span>
          <span class="mini-bar"><i style="width:${pct}%"></i></span>
          <span>${ext.size ? `外部前置 ${ext.size}` : '入口'}</span>
        </div>
      </div>`;
  }).join('');

  document.getElementById('main').innerHTML = `
    <div class="sec-title">
      <h2>${DOMAINS.length} 个领域</h2>
      <span>从地基排到末题，不是按教材章节顺序</span>
    </div>
    <div class="dom-grid">${cards}</div>
    <div style="margin-top:26px;font-size:12px;color:#5f7085;line-height:1.9">
      卡上的 <b style="color:#93a3b8">A/B/C/D</b> 是这块在往年卷面里的分量，不是教材要求。<br>
      想看"每一分该花在哪"，去上面的 <b style="color:#93a3b8">重要度排行</b>。
    </div>`;
}

/* =======================================================================
 *  视图：领域地图
 * ======================================================================= */
function renderDomain(domId){
  const d = domById[domId];
  const vis = visibleSkills().filter(s => s.d === domId);
  const hiddenCount = SKILLS.filter(s => s.d === domId).length - vis.length;

  if (!vis.length){
    document.getElementById('main').innerHTML = `<div class="empty">这个领域目前没有可显示的技能</div>`;
    return;
  }

  // 按步分列
  const byStep = {};
  vis.forEach(s => { const st = stepOf(s.id); (byStep[st] = byStep[st] || []).push(s); });
  const steps = Object.keys(byStep).map(Number).sort((a, b) => a - b);

  const COLW = 198, ROWH = 96, PADX = 24, PADY = 48, W = 174, H = 68;
  const pos = {};
  const maxRows = Math.max(...steps.map(st => byStep[st].length));

  // 同一列里按"父节点平均高度"排序，线就不容易交叉
  const parentY = s => {
    const ys = allPre(s.id).filter(p => pos[p]).map(p => pos[p].y);
    return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : -1;
  };
  steps.forEach((st, ci) => {
    const items = byStep[st];
    if (ci > 0) items.sort((a, b) => parentY(a) - parentY(b));
    items.forEach((s, ri) => {
      pos[s.id] = { x: PADX + ci * COLW, y: PADY + ri * ROWH };
    });
  });
  const width = PADX * 2 + (steps.length - 1) * COLW + W;
  const height = PADY + maxRows * ROWH + 20;

  const sel = state.selected;
  const ancSet = sel ? ancestry(sel) : new Set();
  const kids = sel ? new Set(downstream(sel)) : new Set();

  // 连线（只画本领域内部的边）
  let edges = '';
  vis.forEach(s => {
    allPre(s.id).forEach(p => {
      if (!pos[p]) return;                 // 跨领域前置不在地图里
      const a = pos[p], b = pos[s.id];
      const soft = isSoft(s.id, p);
      let cls = 'edge' + (soft ? ' soft' : '');
      if (sel){
        const onChain = (s.id === sel || ancSet.has(s.id)) && (p === sel || ancSet.has(p));
        const direct = (s.id === sel) || (p === sel);
        if (onChain || direct) cls += soft ? ' hl-soft' : ' hl-hard';
      }
      edges += `<path class="${cls}" d="M${a.x + W} ${a.y + H / 2} C${a.x + W + 60} ${a.y + H / 2}, ${b.x - 60} ${b.y + H / 2}, ${b.x} ${b.y + H / 2}"/>`;
    });
  });

  // 节点
  const nodes = vis.map(s => {
    const p0 = pos[s.id];
    const lit = state.lit.has(s.id);
    const unlocked = isUnlocked(s.id);
    const extPre = allPre(s.id).filter(p => !pos[p]);
    let cls = 'node';
    if (s.lv === 'D') cls += ' skippable';
    if (lit) cls += ' lit'; else if (!unlocked) cls += ' locked';
    if (s.id === sel) cls += ' sel';
    else if (sel && (ancSet.has(s.id) || kids.has(s.id))) cls += ' hl';
    else if (sel) cls += ' dimmed';
    const q = (s.q || []).length ? s.q.join('·') : '可不学';
    return `
      <div class="${cls}" data-skill="${s.id}"
           style="left:${p0.x}px;top:${p0.y}px;width:${W}px;height:${H}px;--nc:${d.color}">
        <span class="dot"></span>
        <div class="nm">${s.n}</div>
        <div class="sub"><span class="rank-badge lv-${s.lv}" style="height:15px;min-width:15px;font-size:9px">${s.lv}</span><span>${q}</span></div>
      </div>`;
  }).join('');

  const heads = steps.map((st, ci) => {
    const label = STEP_TEXT[st] || `第${st}步`;
    return `<div class="step-head" style="left:${PADX + ci * COLW}px;top:14px"><b>${label}</b></div>`;
  }).join('');

  document.getElementById('main').innerHTML = `
    <div class="crumbs"><a data-go="home">领域总览</a> / <span>${d.name}</span></div>
    <div class="sec-title">
      <h2 style="color:${d.color}">${d.name}</h2>
      <span>${vis.filter(s => state.lit.has(s.id)).length}/${SKILLS.filter(s => s.d === d.id).length} 已点亮 · 最远到第 ${Math.max(...vis.map(s => stepOf(s.id)))} 步${hiddenCount ? ` · 已折叠 ${hiddenCount} 个可跳过项` : ''}</span>
    </div>
    <div class="legend">
      <span><i></i>必须前置（不点亮就锁着）</span>
      <span><i class="dash"></i>推荐前置（没有也能学，会更吃力）</span>
      <span><span class="kbd">点节点</span> 亮出整条前置链</span>
    </div>
    <div class="legend" style="margin-top:-8px">
      <span>步数按整棵树算 —— 某个技能的第一课可能落在别的领域，所以这里的起点不一定是第一步。</span>
    </div>
    ${domId === 'prep' ? `<div class="unsure" style="margin:0 0 14px">这一层不出独立考题，所以重要度对这里没有意义 —— 九条全都得会，缺哪条后面都会塌。</div>` : ''}
    <div class="map-wrap" style="height:${height + 40}px">
      <div class="map-inner" style="width:${width}px;height:${height}px">
        <svg class="edges" width="${width}" height="${height}">${edges}</svg>
        ${heads}
        ${nodes}
      </div>
    </div>`;
}

/* =======================================================================
 *  视图：重要度排行
 * ======================================================================= */
function renderRank(){
  const qf = state.qFilter;
  let vis = visibleSkills().slice();
  if (qf) vis = vis.filter(s => (s.q || []).includes(qf));
  vis.sort((a, b) => {
    const d = LV_ORDER[a.lv] - LV_ORDER[b.lv];
    if (d) return d;
    return DOMAINS.findIndex(x => x.id === a.d) - DOMAINS.findIndex(x => x.id === b.d);
  });

  const groupName = { A: 'A · 主力，每年必考', B: 'B · 常考，每年 1~2 题', C: 'C · 边缘，隔年出现', D: 'D · 可跳过，别花时间' };
  const qfBtn = (v, label) =>
    `<button class="btn ${state.qFilter === v ? 'primary' : ''}" data-qf="${v || ''}">${label}</button>`;

  let html = `<div class="crumbs"><a data-go="home">领域总览</a> / <span>重要度排行</span></div>
    <div class="sec-title"><h2>按往年卷面分量排的</h2><span>共 ${vis.length} 个技能${qf ? `（只看${qf}题）` : ''} · 点一行看详情</span></div>
    <div class="legend" style="align-items:center;gap:10px">
      ${qfBtn('', '全部')} ${qfBtn('选择', '选择题')} ${qfBtn('填空', '填空题')} ${qfBtn('解答', '解答题')}
      <span style="margin-left:8px">分值口径：2014~2024 各板块平均分值 + 近年真题逐题评述，不是考纲的"了解/理解/掌握"</span>
    </div>`;

  let cur = null;
  vis.forEach(s => {
    if (s.lv !== cur){
      cur = s.lv;
      html += `<div class="rank-group"><span class="rank-badge lv-${cur}">${cur}</span>${groupName[cur]}</div>`;
    }
    const d = domById[s.d];
    const q = (s.q || []).length ? s.q.map(x => `<span class="tag q">${x}</span>`).join(' ') : '<span class="tag">不考</span>';
    html += `<div class="rank-row" data-skill="${s.id}">
      <span class="rank-badge lv-${s.lv}">${s.lv}</span>
      <span class="nm">${s.n}</span>
      <span class="dom" style="color:${d.color}88">${d.short}</span>
      <span class="how">${s.how}</span>
      <span style="display:flex;gap:4px">${q}</span>
    </div>`;
  });

  document.getElementById('main').innerHTML = html;
}

/* =======================================================================
 *  视图：搜索结果
 * ======================================================================= */
function renderSearch(){
  const q = state.query.trim().toLowerCase();
  const hits = visibleSkills().filter(s => {
    const hay = [s.n, s.how, s.tip, domById[s.d].name, ...(s.pts || [])].join(' ').toLowerCase();
    return hay.includes(q);
  });
  if (!hits.length){
    document.getElementById('main').innerHTML =
      `<div class="empty">没搜到「${state.query}」<br><span>换个说法试试，比如只搜两个字</span></div>`;
    return;
  }
  const rows = hits.map(s => {
    const d = domById[s.d];
    return `<div class="rank-row" data-skill="${s.id}">
      <span class="rank-badge lv-${s.lv}">${s.lv}</span>
      <span class="nm">${s.n}</span>
      <span class="dom" style="color:${d.color}88">${d.short}</span>
      <span class="how">${s.how}</span>
    </div>`;
  }).join('');
  document.getElementById('main').innerHTML =
    `<div class="sec-title"><h2>「${state.query}」的 ${hits.length} 个结果</h2></div>${rows}`;
}

/* =======================================================================
 *  视图：学习清单（目标模式）
 * ======================================================================= */
function renderPlan(){
  if (!state.goal || !byId[state.goal]){
    document.getElementById('main').innerHTML =
      `<div class="empty">还没设目标<br><span>点开任意技能，按「设为目标」，这里会排出学习顺序</span></div>`;
    return;
  }
  const g = byId[state.goal];
  const need = new Set([g.id, ...ancestry(g.id)]);
  const list = [...need].sort((a, b) => {
    const d = stepOf(a) - stepOf(b);
    return d || (LV_ORDER[byId[a].lv] - LV_ORDER[byId[b].lv]);
  });
  const done = list.filter(id => state.lit.has(id)).length;
  const aCount = list.filter(id => byId[id].lv === 'A').length;

  const items = list.map((id, i) => {
    const s = byId[id];
    const d = domById[s.d];
    const lit = state.lit.has(id);
    return `<div class="plan-item ${lit ? 'done' : ''}" data-skill="${id}">
      <div class="no">${lit ? '✓' : i + 1}</div>
      <div class="body">
        <div class="t">${s.n} <span class="rank-badge lv-${s.lv}" style="height:15px;min-width:15px;font-size:9px">${s.lv}</span></div>
        <div class="d">${d.name} · 第 ${stepOf(id)} 步 · ${(s.q || []).join('/') || '可不学'}</div>
      </div>
    </div>`;
  }).join('');

  document.getElementById('main').innerHTML = `
    <div class="crumbs"><a data-go="home">领域总览</a> / <span>学习清单</span></div>
    <div class="sec-title">
      <h2>目标：${g.n}</h2>
      <span>要 ${list.length} 个技能，已完成 ${done} 个，其中 A 级 ${aCount} 个</span>
    </div>
    <div class="legend"><span>顺序是自动排的：永远先排前置，同一层里 A 级优先</span></div>
    <div class="plan-list">${items}</div>`;
}

/* =======================================================================
 *  详情面板
 * ======================================================================= */
function renderPanel(){
  const panel = document.getElementById('panel');
  const id = state.selected;
  if (!id || !byId[id]){
    panel.innerHTML = `<div class="empty">左边点一个技能<br><span>看它的前置、知识点、掌握标准和常见坑</span></div>`;
    return;
  }
  const s = byId[id];
  const d = domById[s.d];
  const lit = state.lit.has(id);
  const unlocked = isUnlocked(id);
  const miss = missingPre(id);
  const softs = softOf(id);
  const kids = downstream(id);
  const q = hasQuiz(id);
  const best = bestRate(id);
  const vids = videoList(id);

  const pts = (s.pts || []).map(p => `<li>${p}</li>`).join('');
  const qTags = (s.q || []).map(x => `<span class="tag q">${x}题</span>`).join(' ') || '<span class="tag">不考</span>';

  const preChips = (s.pre || []).length
    ? s.pre.map(p => {
        const soft = softs.includes(p);
        const ok = state.lit.has(p);
        return `<span class="chip ${ok ? 'ok' : 'miss'} ${soft ? 'soft' : ''}" data-skill="${p}"
          title="${soft ? '推荐前置' : '必须前置'}">${state.lit.has(p) ? '✓' : '·'} ${byId[p].n}${soft ? ' (推荐)' : ''}</span>`;
      }).join('')
    : '<span style="font-size:12px;color:#5f7085">无前置，这是起点</span>';

  const kidChips = kids.length
    ? kids.map(k => `<span class="chip" data-skill="${k}">${byId[k].n}</span>`).join('')
    : '<span style="font-size:12px;color:#5f7085">没有必修它的下游</span>';

  panel.innerHTML = `
    <div class="p-head">${s.n}</div>
    <div class="p-domain" style="color:${d.color}">${d.name} · 第 ${stepOf(id)} 步</div>
    <div class="p-row">
      <span class="rank-badge lv-${s.lv}">${s.lv}</span>
      <span style="font-size:11.5px;color:#93a3b8">${({A:'主力，必考',B:'常考',C:'边缘',D:'可跳过'})[s.lv]}</span>
      ${qTags}
    </div>

    <div class="p-sec">知识点</div>
    <ul class="pts" style="--nc:${d.color}">${pts || '<li>（无）</li>'}</ul>

    <div class="p-sec">掌握到什么程度</div>
    <div class="p-how">${s.how}</div>

    ${s.tip ? `<div class="p-sec">坑在哪</div><div class="tip">${s.tip}</div>` : ''}

    ${s.unsure ? `<div class="unsure">⚠ ${s.unsure}</div>` : ''}

    <div class="p-sec">怎么学 · 视频</div>
    ${vids.length ? vids.map(v => `
      <div class="vcard">
        <div class="vtitle">${escHtml(v.t)}</div>
        <div class="vmeta">${escHtml(v.up)} · ${v.dur}${v.play ? ' · ' + v.play + '播放' : ''}</div>
        <div class="vbtns">
          <button class="btn mini" data-play="${v.bv}">在本页看</button>
          <a class="btn mini" href="https://www.bilibili.com/video/${v.bv}" target="_blank" rel="noopener noreferrer">去 B站</a>
        </div>
      </div>`).join('') : '<div style="font-size:12px;color:#5f7085">这一课还没找到合适的视频</div>'}
    <div id="player-slot"></div>

    <div class="p-sec">前置</div>
    <div class="pre-chips">${preChips}</div>
    ${miss.length ? `<div style="font-size:11.5px;color:#d69a8a;margin-top:8px">还差 ${miss.map(m => byId[m].n).join('、')} 没点亮，这个技能现在是锁着的。</div>` : ''}

    <div class="p-sec">点亮它能解锁</div>
    <div class="pre-chips">${kidChips}</div>

    <div class="p-actions">
      ${lit
        ? `<button class="btn lit" data-act="toggle">已点亮 · 点此取消</button>`
        : !unlocked
          ? `<button class="btn" disabled>前置没齐，先别点</button>`
          : q
            ? `<button class="btn primary" data-act="quiz">开始结业挑战（${QUIZ[id].length} 题）</button>`
            : `<button class="btn primary" data-act="toggle">点亮它（这课没配题）</button>`}
      <button class="btn" data-act="goal">设为目标</button>
    </div>
    ${q ? `<div class="p-hint">${lit ? '已通过结业挑战' : `结业挑战要答对 80% 才能点亮${best ? ` · 你目前最好成绩 ${Math.round(best * 100)}%` : ''}`}</div>` : ''}
    ${state.goal === id ? `<div style="font-size:11.5px;color:#7ed4a3;margin-top:6px">当前目标就是它</div>` : ''}
  `;
}

/* =======================================================================
 *  刷题：结业挑战
 * ======================================================================= */
function startQuiz(sid){
  if (!hasQuiz(sid)) return;
  const s = byId[sid];
  if (!isUnlocked(sid)){
    alert(`前置还没点亮：${missingPre(sid).map(m => byId[m].n).join('、')}`);
    return;
  }
  state.quiz = { sid, i: 0, answers: new Array(QUIZ[sid].length).fill(null), done: false };
  state.view = 'quiz';
  state.selected = sid;
  render();
}

function answerQuiz(oi){
  const z = state.quiz;
  if (!z || z.done) return;
  if (z.answers[z.i] !== null) return;         // 已答过就别覆盖
  z.answers[z.i] = oi;
  const q = QUIZ[z.sid][z.i];
  scheduleWrong(z.sid, z.i, oi === q.a);
  save();
  render();
}

function nextQuestion(){
  const z = state.quiz;
  if (!z) return;
  if (z.i < QUIZ[z.sid].length - 1){ z.i++; render(); return; }
  finishQuiz();
}

function finishQuiz(){
  const z = state.quiz;
  const qs = QUIZ[z.sid];
  const right = z.answers.filter((a, i) => a === qs[i].a).length;
  const rate = right / qs.length;
  const p = state.progress[z.sid] || { tries: 0, best: 0 };
  p.tries += 1;
  p.best = Math.max(p.best, rate);
  if (rate >= QUIT_PASS) state.lit.add(z.sid);
  state.progress[z.sid] = p;
  z.done = true;
  z.rate = rate;
  z.right = right;
  save();
  render();
}

function renderQuiz(){
  const z = state.quiz;
  const main = document.getElementById('main');
  if (!z){ main.innerHTML = `<div class="empty">没有正在进行的挑战</div>`; return; }
  const s = byId[z.sid];
  const qs = QUIZ[z.sid];

  if (z.done){
    const pass = z.rate >= QUIT_PASS;
    main.innerHTML = `
      <div class="crumbs"><a data-go="home">领域总览</a> / <span>结业挑战</span></div>
      <div class="quiz-result">
        <div class="qr-score ${pass ? 'ok' : 'no'}">${Math.round(z.rate * 100)}%</div>
        <div class="qr-line">答对 ${z.right} / ${qs.length} 题</div>
        <div class="qr-msg">${pass
          ? `过了。${s.n} 已经点亮。`
          : `差一点。这次要答对 ${Math.ceil(qs.length * QUIT_PASS)} / ${qs.length} 题（≥80%）才算过。没过不扣任何东西，错题已经进错题本了。`}</div>
        <div class="qr-actions">
          <button class="btn primary" data-quiz-retry>再来一次</button>
          ${state.wrong.length ? `<button class="btn" data-go="wrong">看错题本</button>` : ''}
          <button class="btn" data-go="home">回总览</button>
        </div>
      </div>`;
    return;
  }

  const i = z.i;
  const solo = !!z.solo;      // 从错题本进来单练一道，不参与点亮
  const q = qs[i];
  const picked = z.answers[i];
  const answered = picked !== null;
  const ok = answered && picked === q.a;

  const opts = q.o.map((o, oi) => {
    let cls = 'opt';
    if (answered){
      if (oi === q.a) cls += ' right';
      else if (oi === picked) cls += ' wrong';
      else cls += ' dim';
    }
    return `<button class="${cls}" data-quiz-opt="${oi}" ${answered ? 'disabled' : ''}>
      <span class="ol">${'ABCD'[oi]}</span><span class="ot">${o}</span></button>`;
  }).join('');

  const bar = qs.map((_, qi) => {
    const a = z.answers[qi];
    let c = 'seg';
    if (a === null) c += '';
    else c += (a === qs[qi].a) ? ' seg-ok' : ' seg-no';
    if (qi === i) c += ' seg-cur';
    return `<span class="${c}"></span>`;
  }).join('');

  main.innerHTML = `
    <div class="crumbs"><a data-go="home">领域总览</a> / <span>${s.n}</span> / <span>结业挑战</span></div>
    <div class="quiz-head">
      <div class="quiz-title">${s.n}</div>
      <div class="quiz-sub">${solo ? '复习错题 · 答对一次往后推一档' : `第 ${i + 1} / ${qs.length} 题 · ${s.lv} 级 · 答错不扣分，只记进错题本`}</div>
      ${solo ? '' : `<div class="quiz-bar">${bar}</div>`}
    </div>

    <div class="qbox">
      <div class="qtext">${q.q}</div>
      <div class="opts">${opts}</div>
      ${answered ? `
        <div class="fb ${ok ? 'fb-ok' : 'fb-no'}">
          <b>${ok ? '对了' : '错了'}</b> · 正确答案是 ${'ABCD'[q.a]}（${q.o[q.a]}）
          <div class="fb-why">${q.why}</div>
        </div>
        <div class="qnav">
          ${solo
            ? `<button class="btn primary" data-quiz-quit>返回错题本</button>`
            : `<button class="btn primary" data-quiz-next>${i === qs.length - 1 ? '看结果' : '下一题'}</button>`}
        </div>` : ''}
    </div>

    ${solo ? '' : `<div style="margin-top:18px"><button class="btn" data-quiz-quit>先不做了</button></div>`}
  `;
}

/* =======================================================================
 *  错题本 + 遗忘曲线复习
 * ======================================================================= */
function renderWrong(){
  const main = document.getElementById('main');
  if (!state.wrong.length){
    main.innerHTML = `
      <div class="crumbs"><a data-go="home">领域总览</a> / <span>错题本</span></div>
      <div class="empty">错题本是空的<br><span>答错的题会自动进来，按 1 / 3 / 7 / 15 天的间隔提醒你复习</span></div>`;
    return;
  }
  const now = Date.now();
  const list = state.wrong.slice().sort((a, b) => a.due - b.due);
  const due = list.filter(w => w.due <= now);

  const rows = list.map(w => {
    const s = byId[w.sid];
    const q = QUIZ[w.sid][w.qi];
    const late = w.due <= now;
    const days = Math.ceil((w.due - now) / 864e5);
    const when = late ? '现在就该复习' : `${days} 天后复习`;
    return `<div class="wcard ${late ? 'late' : ''}">
      <div class="wt">
        <span class="wsid">${s.n}</span>
        <span class="wtag ${late ? 'late' : ''}">${when} · 第 ${(w.stage || 0) + 1} 轮复习</span>
      </div>
      <div class="wq">${q.q}</div>
      <div class="wa">答案：${'ABCD'[q.a]}（${q.o[q.a]}）</div>
      <details class="wd"><summary>看解析</summary><div>${q.why}</div></details>
      <div class="wb"><button class="btn mini" data-redo="${w.sid}:${w.qi}">重做这道</button></div>
    </div>`;
  }).join('');

  main.innerHTML = `
    <div class="crumbs"><a data-go="home">领域总览</a> / <span>错题本</span></div>
    <div class="sec-title">
      <h2>错题本</h2>
      <span>${list.length} 道 · ${due.length ? `${due.length} 道到期该复习了` : '暂时都还没到复习时间'}</span>
    </div>
    <div class="legend"><span>规则：答错的题 1 天后回来，答对一次往后推一档（3 天 → 7 天 → 15 天），走完全部四档就移出去</span></div>
    <div class="wlist">${rows}</div>`;
}

/* =======================================================================
 *  真题讲解
 * ======================================================================= */
function renderPapers(){
  const main = document.getElementById('main');
  const rows = PAPERS.map(p => {
    const v = VIDEO_INFO[p.bv];
    if (!v) return '';
    return `<div class="pcard">
      <div class="pyear">${p.year}</div>
      <div class="pinfo">
        <div class="vtitle">${escHtml(v.t)}</div>
        <div class="vmeta">${escHtml(v.up)} · ${v.dur}${p.note ? ' · ' + p.note : ''}</div>
      </div>
      <div class="vbtns">
        <button class="btn mini" data-play="${p.bv}">在本页看</button>
        <a class="btn mini" href="https://www.bilibili.com/video/${p.bv}" target="_blank" rel="noopener noreferrer">去 B站</a>
      </div>
    </div>`;
  }).join('');

  main.innerHTML = `
    <div class="crumbs"><a data-go="home">领域总览</a> / <span>真题</span></div>
    <div class="sec-title"><h2>历年真题讲解</h2><span>先看老师怎么拆整张卷子，再回头补自己缺的那块</span></div>
    <div class="legend"><span>这里只放 B站 上的公开讲解视频，题目本身我没拿到原卷，页面上不摆「真题」。想自己刷，看完视频去搜当年原卷。</span></div>
    <div class="plist">${rows}</div>
    <div id="player-slot"></div>`;
}

/* 点「在本页看」才插 iframe，避免一进页面就加载一堆播放器 */
function playVideo(bv){
  const slot = document.getElementById('player-slot');
  if (!slot) return;
  slot.innerHTML = `
    <div class="player">
      <iframe src="https://player.bilibili.com/player.html?bvid=${bv}&autoplay=0&danmaku=0&high_quality=1"
        scrolling="no" frameborder="0" allowfullscreen="true"></iframe>
      <div class="phint">播不出来就是 UP 主关了外嵌，点上面「去 B站」。</div>
    </div>`;
  slot.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/* =======================================================================
 *  渲染总入口
 * ======================================================================= */
function renderMain(){
  if (state.view === 'quiz') return renderQuiz();
  if (state.query.trim()) { renderSearch(); return; }
  if (state.view === 'domain') return renderDomain(state.domainId);
  if (state.view === 'rank') return renderRank();
  if (state.view === 'plan') return renderPlan();
  if (state.view === 'wrong') return renderWrong();
  if (state.view === 'papers') return renderPapers();
  return renderHome();
}
function render(){
  document.body.classList.toggle('quiz-mode', state.view === 'quiz');
  renderMain();
  renderPanel();
  renderProgress();
  syncHash();
  renderWrongBadge();
}

/* 顶栏错题本角标：有几道到期了 */
function renderWrongBadge(){
  const el = document.getElementById('wrong-badge');
  if (!el) return;
  const n = dueWrong().length;
  el.textContent = n ? n : '';
}

/* 让某个领域/视图可以直接用链接打开（也方便分享给同学） */
function syncHash(){
  let h = '';
  if (!state.query.trim()){
    if (state.view === 'domain' && state.domainId) h = '#' + state.domainId;
    else if (state.view === 'rank') h = '#rank';
    else if (state.view === 'plan') h = '#plan';
    else if (state.view === 'wrong') h = '#wrong';
    else if (state.view === 'papers') h = '#papers';
  }
  if (location.hash === h) return;
  try{ history.replaceState(null, '', location.pathname + location.search + h); }
  catch(e){ location.hash = h; }
}

/* =======================================================================
 *  事件
 * ======================================================================= */
document.getElementById('main').addEventListener('click', e => {
  const go = e.target.closest('[data-go]');
  if (go){
    goTo(go.dataset.go);
    return;
  }
  const play = e.target.closest('[data-play]');
  if (play){ playVideo(play.dataset.play); return; }

  const opt = e.target.closest('[data-quiz-opt]');
  if (opt){ answerQuiz(+opt.dataset.quizOpt); return; }
  if (e.target.closest('[data-quiz-next]')){ nextQuestion(); return; }
  if (e.target.closest('[data-quiz-quit]')){ quitQuiz(); return; }
  if (e.target.closest('[data-quiz-retry]')){ startQuiz(state.quiz.sid); return; }

  const redo = e.target.closest('[data-redo]');
  if (redo){
    const [sid, qi] = redo.dataset.redo.split(':');
    state.quiz = { sid, i: +qi, answers: new Array(QUIZ[sid].length).fill(null), done: false, solo: true };
    state.view = 'quiz'; state.selected = sid;
    render(); return;
  }

  const qf = e.target.closest('[data-qf]');
  if (qf){
    state.qFilter = qf.dataset.qf || '';
    state.view = 'rank';
    render(); return;
  }
  const dom = e.target.closest('[data-dom]');
  if (dom){
    state.view = 'domain'; state.domainId = dom.dataset.dom;
    state.selected = null; render();
    window.scrollTo({ top: 0 });
    return;
  }
  const sk = e.target.closest('[data-skill]');
  if (sk){ selectSkill(sk.dataset.skill); }
});

function goTo(view){
  state.view = view;
  state.query = '';
  document.getElementById('search').value = '';
  if (view !== 'domain') state.selected = null;
  if (view !== 'quiz') state.quiz = null;
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function quitQuiz(){
  const z = state.quiz;
  const solo = z && z.solo;
  const sid = z && z.sid;
  state.quiz = null;
  if (solo){ state.view = 'wrong'; render(); return; }
  if (sid){
    state.view = 'domain';
    state.domainId = byId[sid].d;
    state.selected = sid;
  } else {
    state.view = 'home';
  }
  render();
}

document.getElementById('panel').addEventListener('click', e => {
  const play = e.target.closest('[data-play]');
  if (play){ playVideo(play.dataset.play); return; }

  const chip = e.target.closest('[data-skill]');
  if (chip && !e.target.closest('[data-act]')){ selectSkill(chip.dataset.skill); return; }

  const act = e.target.closest('[data-act]');
  if (!act) return;
  const id = state.selected;
  if (act.dataset.act === 'quiz'){ startQuiz(id); return; }
  if (act.dataset.act === 'toggle'){
    if (state.lit.has(id)) {
      // 取消点亮时，把依赖它的下游一起收回去，否则会出现"锁着的技能却亮着"
      const lost = [];
      const stack = [id];
      while (stack.length){
        const cur = stack.pop();
        if (state.lit.delete(cur)) lost.push(cur);
        downstream(cur).forEach(k => { if (state.lit.has(k)) stack.push(k); });
      }
      const extra = lost.filter(x => x !== id);
      if (extra.length){
        setTimeout(() => alert(`已经连同 ${extra.length} 个下游技能一起收回了：\n${extra.map(x => byId[x].n).join('、')}`), 30);
      }
    } else if (isUnlocked(id)) {
      state.lit.add(id);
    }
    save(); render();
  }
  if (act.dataset.act === 'goal'){
    state.goal = id; state.view = 'plan'; state.selected = null;
    save(); render();
  }
});

function selectSkill(id){
  state.selected = id;
  // 选中跨领域前置时，把地图切到它的领域，不然节点不在图上
  if (state.view === 'domain' && state.domainId !== byId[id].d){
    state.view = 'domain';
  }
  if (state.view === 'domain') state.domainId = byId[id].d;
  render();
}

document.getElementById('btn-home').onclick = () => goTo('home');
document.getElementById('btn-rank').onclick = () => goTo('rank');
document.getElementById('btn-wrong').onclick = () => goTo('wrong');
document.getElementById('btn-papers').onclick = () => goTo('papers');

/* 分享给同学：手机上走系统分享，桌面复制链接 */
document.getElementById('btn-share').onclick = async () => {
  const url = location.origin === 'null' ? location.href.split('#')[0] : location.origin + location.pathname;
  try{
    if (navigator.share){
      await navigator.share({ title: '广东 3+证书 数学技能树', text: '按往年分值排的考点树，能看视频能刷题', url });
      return;
    }
  }catch(e){ /* 用户取消就算了 */ }
  try{
    await navigator.clipboard.writeText(url);
    alert('链接已复制，发给同学直接能打开：\n' + url);
  }catch(e){
    prompt('复制这个链接发给同学：', url);
  }
};

let searchTimer;
document.getElementById('search').addEventListener('input', e => {
  clearTimeout(searchTimer);
  const v = e.target.value;
  searchTimer = setTimeout(() => {
    state.query = v;
    renderMain();
  }, 120);
});

document.getElementById('tgl-skip').addEventListener('change', e => {
  state.showSkippable = e.target.checked;
  save(); render();
});

document.getElementById('btn-export').onclick = () => {
  const blob = new Blob([JSON.stringify({
    lit: [...state.lit], goal: state.goal,
    wrong: state.wrong, progress: state.progress,
    exportedAt: new Date().toISOString().slice(0, 10)
  }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `广东3+证书数学技能树_进度_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};

document.getElementById('import-file').addEventListener('change', e => {
  const f = e.target.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    try{
      const d = JSON.parse(r.result);
      state.lit = new Set((d.lit || []).filter(x => byId[x]));
      state.goal = d.goal && byId[d.goal] ? d.goal : null;
      state.wrong = (d.wrong || []).filter(w => byId[w.sid] && QUIZ[w.sid] && QUIZ[w.sid][w.qi]);
      state.progress = d.progress || {};
      save(); render();
    }catch(err){ alert('这个文件读不出来，确认是从这里导出的进度文件。'); }
  };
  r.readAsText(f);
  e.target.value = '';
});

/* =======================================================================
 *  启动
 * ======================================================================= */
load();
document.getElementById('tgl-skip').checked = state.showSkippable;

/* 调试/演示钩子：index.html?lit=g1,p6&sel=g11 预置点亮与选中，方便截图核对 */
(function demoHook(){
  const q = location.search.replace(/^\?/, '');
  if (!q) return;
  const p = new URLSearchParams(q);
  const lit = p.get('lit');
  if (lit) lit.split(',').forEach(x => { if (byId[x]) state.lit.add(x); });
  const sel = p.get('sel');
  if (sel && byId[sel]) state.selected = sel;
  const goal = p.get('goal');
  if (goal && byId[goal]) state.goal = goal;
  if (p.has('qf')) state.qFilter = p.get('qf');
  // ?quiz=s3&qi=0&pick=1 —— 直接看刷题页，pick 预填一个已选答案
  const qz = p.get('quiz');
  if (qz && hasQuiz(qz)){
    const n = QUIZ[qz].length;
    state.quiz = { sid: qz, i: +(p.get('qi') || 0), answers: new Array(n).fill(null), done: false };
    if (p.has('pick')) state.quiz.answers[state.quiz.i] = +p.get('pick');
    // ?finish=ok / finish=no 直接看结算页
    if (p.has('finish')){
      const qs = QUIZ[qz];
      state.quiz.answers = qs.map((q, i) => (p.get('finish') === 'ok' ? q.a : (q.a + 1) % 4));
      const right = state.quiz.answers.filter((a, i) => a === qs[i].a).length;
      state.quiz.done = true;
      state.quiz.rate = right / qs.length;
      state.quiz.right = right;
    }
    state.view = 'quiz';
  }
  // ?wrong=s3:1,s5:0 —— 预置错题本
  const wr = p.get('wrong');
  if (wr) wr.split(',').forEach(pair => {
    const [sid, qi] = pair.split(':');
    if (byId[sid] && QUIZ[sid] && QUIZ[sid][+qi])
      state.wrong.push({ sid, qi: +qi, stage: 0, due: Date.now() - 1000, ts: Date.now() });
  });
})();


/* 支持 #geo 这种直接进入某个领域 */
(function applyHash(){
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, '')).trim();
  if (!h || h === 'home') return;
  if (domById[h]) { state.view = 'domain'; state.domainId = h; return; }
  if (h === 'rank') { state.view = 'rank'; return; }
  if (h === 'plan') { state.view = 'plan'; return; }
  if (h === 'wrong') { state.view = 'wrong'; return; }
  if (h === 'papers') { state.view = 'papers'; return; }
})();

document.getElementById('exam-line').textContent =
  `${EXAM.total} 分 · ${EXAM.minutes} 分钟 · 15 选择 + 5 填空 + 4 解答`;
document.getElementById('foot').innerHTML = `
  广东 3+证书（高职高考）数学技能树 · ${SKILLS.length} 个技能 / ${Object.keys(QUIZ).length} 个技能配了题（共 ${quizCount()} 道）/ ${DOMAINS.length} 个领域<br>
  <b style="color:#8a7550">练习题全部是自编的仿真题，不是历年原卷</b>；解析按"错在哪"讲，不保证和官方答案一致。<br>
  卷面结构依据 2021 版《数学科考试说明》（2021 年起考试院不再公布新考纲，命题依据为《中等职业学校数学课程标准（2020 年版）》）。<br>
  重要度按 2014~2024 各板块平均分值统计与近年真题逐题评述排定。凡标注「存疑」的地方，说明我没能拿到原卷核实 —— 别当结论用。<br>
  视频链接均为 B站 公开内容，版权归各 UP 主；进度存在本机浏览器里，换设备用「导出 / 导入」。
`;

render();
