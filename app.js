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

/* -----------------------------------------------------------------------
 * 选项打乱
 * 出题时为了写起来顺手，正确答案都写在第一个，结果 123 道全是选 A ——
 * 学生一路选 A 就满分，练习等于废了。这里按题目内容做确定性打乱：
 * 同一道题每次打开顺序一样（重做时不会因为选项挪位而干扰记忆），
 * 但整体上正确答案均匀分布在 ABCD 四个位置。
 * --------------------------------------------------------------------- */
function seededShuffle(arr, seedStr){
  let h = 2166136261;
  for (let i = 0; i < seedStr.length; i++){
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let s = h >>> 0 || 1;
  const rnd = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--){
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

(function shuffleOptions(){
  for (const [sid, arr] of Object.entries(QUIZ)){
    arr.forEach((q, i) => {
      if (!Array.isArray(q.o) || q.o.length !== 4) return;
      const correct = q.o[q.a];
      const mixed = seededShuffle(q.o, sid + '|' + i + '|' + q.q);
      const pos = mixed.indexOf(correct);
      if (pos < 0) return;              // 理论上不会发生，宁可不动
      q.o = mixed;
      q.a = pos;
    });
  }
})();

/* 题干、选项、解析里全是 < >（1/a < 1/b、|x| > 2），直接进 innerHTML 会被当标签。
 * 打乱之后再统一转义，顺序不能反——打乱的种子用了原始题干。 */
(function escapeQuiz(){
  const esc = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  Object.values(QUIZ).forEach(arr => arr.forEach(q => {
    q.q = esc(q.q);
    q.o = q.o.map(esc);
    q.why = esc(q.why);
  }));
})();

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
  progress: {},      // { sid: { tries, best } }
  stats: {},         // { sid: { right, total } } 用来算各领域正确率
  unlitSet: new Set(), // 用户手动取消过点亮的技能，sweep 不许再自动加回去
  paperKey: false,   // 练习卷是否显示答案
  paperMode: 'normal', // normal = 随机整卷；wrong = 错题卷
  streak: { days: 0, last: null }   // 连续学习天数：做过题才算
};

/* 本地日期，别用 toISOString（那是 UTC，凌晨八点前会算错一天） */
function localDate(offsetDays){
  const d = new Date(Date.now() + (offsetDays || 0) * 864e5);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* 做了一道题，就算今天来过；昨天也来过就 +1，否则从 1 重新数 */
function touchStreak(){
  const today = localDate(0);
  const s = state.streak || { days: 0, last: null };
  if (s.last === today) return;
  s.days = (s.last === localDate(-1)) ? (s.days || 0) + 1 : 1;
  s.last = today;
  state.streak = s;
}

function save(){
  try{
    localStorage.setItem(KEY, JSON.stringify({
      lit: [...state.lit], goal: state.goal, showSkippable: state.showSkippable,
      wrong: state.wrong, progress: state.progress, streak: state.streak, stats: state.stats,
      unlit: [...state.unlitSet]
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
    state.stats = d.stats || {};
    state.unlitSet = new Set((d.unlit || []).filter(x => byId[x]));
    if (d.streak) state.streak = d.streak;
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

/* 及格题数。注意：题量 1~3 时 ceil(n×0.8) 就等于 n，也就是必须全对。
 * 文案不能写「≥80%」——3/3 是 100%，那样等于自己打自己。 */
const needRight = n => Math.max(1, Math.ceil(n * QUIT_PASS));
function quizRule(n){
  const need = needRight(n);
  return need >= n ? `这课 ${n} 题要全对` : `这课 ${n} 题要答对 ${need} 题`;
}

/* 当时做对了但前置没齐，后来前置补齐了 —— 不该让学生再考一遍。
 * 但有两件事必须挡住，否则会吃掉「取消点亮」：
 *   1. 用户手动取消过的（unlitSet），不许自动加回来
 *   2. 成绩要按「当前题量」算，题库从 2 题变 5 题后，旧的 2/2 不能算数 */
function sweepLitByScore(){
  let changed = true, dirty = false;
  while (changed){
    changed = false;
    for (const sid of Object.keys(state.progress)){
      if (state.lit.has(sid) || !byId[sid] || state.unlitSet.has(sid)) continue;
      if ((state.progress[sid].best || 0) < QUIT_PASS) continue;
      if ((state.progress[sid].n || 0) !== QUIZ[sid].length) continue;   // 题量变了就重做
      if (hardPre(sid).every(x => state.lit.has(x))){
        state.lit.add(sid);
        changed = true; dirty = true;
      }
    }
  }
  return dirty;
}

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
  const st = state.streak || {};
  const streakTxt = st.days ? ` · 连续学习 ${st.days} 天` : '';
  document.getElementById('pbar-text').textContent =
    `已点亮 ${done} / ${vis.length} 个技能 · ${pct}%${streakTxt}`;
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
          ${d.id === 'prep'
            ? '<span class="rank-badge" style="background:#1d2733;color:#8fa8c4;border:1px solid #2c3b4d;white-space:nowrap">地基</span>'
            : `<span class="rank-badge lv-${d.lv}">${d.lv}</span>`}
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
    <div class="startbar">
      <div class="sbtxt">
        <b>不知道从哪开始？</b>先点开「集合与逻辑用语」学交集并集 —— 卷面第 1 题基本固定考它，五分钟能上手。<br>
        想先摸摸底也行：直接做题不拦你，答错不扣分，只有前置都点亮了才算真点亮。
      </div>
      <div class="sbbtns">
        <button class="btn mini" data-dom="set">去看集合</button>
        <button class="btn mini primary" data-start="s3">直接做这一课</button>
      </div>
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

  // 手机上一张要横滑三屏的图没什么用，换成按步分组的纵列表
  if (window.innerWidth <= 700) return renderDomainList(d, vis, hiddenCount);

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

/* 窄屏的领域视图：按步分组，一条一条往下排，点一下选中 */
function renderDomainList(d, vis, hiddenCount){
  const byStep = {};
  vis.forEach(s => { const st = stepOf(s.id); (byStep[st] = byStep[st] || []).push(s); });
  const steps = Object.keys(byStep).map(Number).sort((a, b) => a - b);

  const groups = steps.map(st => {
    const items = byStep[st].map(s => {
      const lit = state.lit.has(s.id);
      const unlocked = isUnlocked(s.id);
      const q = (s.q || []).length ? s.q.join('·') : '可不学';
      return `<div class="lcard ${lit ? 'lit' : ''} ${unlocked ? '' : 'locked'} ${s.d === 'prep' ? 'prepcard' : ''}"
                   data-skill="${s.id}">
        <div class="ltop">
          ${s.d === 'prep'
            ? `<span class="rank-badge" style="background:#1d2733;color:#8fa8c4;border:1px solid #2c3b4d">基</span>`
            : `<span class="rank-badge lv-${s.lv}">${s.lv}</span>`}
          <span class="lnm">${s.n}</span>
        </div>
        <div class="lsub">${q}${lit ? ' · 已点亮' : ''}${unlocked ? '' : ' · 前置未齐'}</div>
      </div>`;
    }).join('');
    return `<div class="dgroup">
      <div class="dgroup-h">${STEP_TEXT[st] || ('第 ' + st + ' 步')}</div>
      <div class="dgroup-body">${items}</div>
    </div>`;
  }).join('');

  document.getElementById('main').innerHTML = `
    <div class="crumbs"><a data-go="home">领域总览</a> / <span>${d.name}</span></div>
    <div class="sec-title">
      <h2 style="color:${d.color}">${d.name}</h2>
      <span>${vis.filter(s => state.lit.has(s.id)).length}/${SKILLS.filter(s => s.d === d.id).length} 已点亮${hiddenCount ? ` · 已折叠 ${hiddenCount} 个可跳过项` : ''}</span>
    </div>
    <div class="legend" style="margin-bottom:12px"><span>手机上按步往下排，点一条看详情。图上那张横向地图在电脑上看更清楚。</span></div>
    ${d.id === 'prep' ? `<div class="unsure" style="margin-bottom:14px">这一层不出独立考题，所以重要度对这里没有意义 —— 九条全都得会。</div>` : ''}
    <div class="dlist">${groups}</div>`;
}

/* =======================================================================
 *  视图：重要度排行
 * ======================================================================= */
function renderRank(){
  // qf 可能是从 URL 带进来的，只认这三个值，别的一律忽略
  const QF_OK = ['选择', '填空', '解答'];
  const qf = QF_OK.includes(state.qFilter) ? state.qFilter : '';
  state.qFilter = qf;
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

  /* 预备层单独放：它不出独立考题，混在「A 主力 / B 常考」里会误导时间分配 */
  const rankRow = s => {
    const d = domById[s.d];
    const q = (s.q || []).length ? s.q.map(x => `<span class="tag q">${x}</span>`).join(' ') : '<span class="tag">不考</span>';
    return `<div class="rank-row" data-skill="${s.id}">
      ${s.d === 'prep'
        ? `<span class="rank-badge" style="background:#1d2733;color:#8fa8c4;border:1px solid #2c3b4d;white-space:nowrap">基</span>`
        : `<span class="rank-badge lv-${s.lv}">${s.lv}</span>`}
      <span class="nm">${s.n}</span>
      <span class="dom" style="color:${d.color}88">${d.short}</span>
      <span class="how">${s.how}</span>
      <span style="display:flex;gap:4px">${q}</span>
    </div>`;
  };

  const prepList = vis.filter(s => s.d === 'prep');
  if (prepList.length){
    html += `<div class="rank-group"><span class="rank-badge" style="background:#1d2733;color:#8fa8c4;border:1px solid #2c3b4d;white-space:nowrap">地基</span>
      不单独占分，但缺哪条后面都会塌 —— 这 9 条不按 A/B/C/D 排，全都要会</div>`;
    html += prepList.map(rankRow).join('');
  }

  let cur = null;
  vis.filter(s => s.d !== 'prep').forEach(s => {
    if (s.lv !== cur){
      cur = s.lv;
      html += `<div class="rank-group"><span class="rank-badge lv-${cur}">${cur}</span>${groupName[cur]}</div>`;
    }
    html += rankRow(s);
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
    main.innerHTML =
      `<div class="empty">没搜到「${escHtml(state.query)}」<br><span>换个说法试试，比如只搜两个字</span></div>`;
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
    `<div class="sec-title"><h2>「${escHtml(state.query)}」的 ${hits.length} 个结果</h2></div>${rows}`;
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
  const domUnsure = d.unsure;      // 存疑有时写在领域上（比如复数），技能级没有

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
      ${s.d === 'prep'
        ? `<span class="rank-badge" style="background:#1d2733;color:#8fa8c4;border:1px solid #2c3b4d;white-space:nowrap">地基</span>
           <span style="font-size:11.5px;color:#8fa8c4">不出独立考题，但必须会</span>`
        : `<span class="rank-badge lv-${s.lv}">${s.lv}</span>
           <span style="font-size:11.5px;color:#93a3b8">${({A:'主力，必考',B:'常考',C:'边缘',D:'可跳过'})[s.lv]}</span>`}
      ${qTags}
    </div>

    <div class="p-sec">知识点</div>
    <ul class="pts" style="--nc:${d.color}">${pts || '<li>（无）</li>'}</ul>

    <div class="p-sec">掌握到什么程度</div>
    <div class="p-how">${s.how}</div>

    ${s.tip ? `<div class="p-sec">坑在哪</div><div class="tip">${s.tip}</div>` : ''}

    ${(s.unsure || domUnsure) ? `<div class="unsure">⚠ ${s.unsure || domUnsure}</div>` : ''}

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
    ${q ? `<div class="p-hint">${lit ? '已通过结业挑战' : `${quizRule(QUIZ[id].length)}才能点亮${best ? ` · 你目前最好成绩 ${Math.round(best * 100)}%` : ''}`}</div>` : ''}
    ${state.goal === id ? `<div style="font-size:11.5px;color:#7ed4a3;margin-top:6px">当前目标就是它</div>` : ''}
  `;
}

/* =======================================================================
 *  刷题：结业挑战
 * ======================================================================= */
function startQuiz(sid){
  if (!hasQuiz(sid)) return;
  const n = QUIZ[sid].length;
  // 每次挑战题目顺序都重排。即时给答案是有意的（自学需要反馈），
  // 但至少要堵住"记住第几题选什么"这条路。
  const order = [...Array(n).keys()];
  for (let i = n - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  state.quiz = { sid, order, i: 0, answers: new Array(n).fill(null), done: false };
  state.view = 'quiz';
  state.selected = sid;
  render();
}

function answerQuiz(oi){
  const z = state.quiz;
  if (!z || z.done) return;
  if (z.answers[z.i] !== null) return;         // 已答过就别覆盖
  const qi = z.order ? z.order[z.i] : z.i;
  z.answers[z.i] = oi;
  const q = QUIZ[z.sid][qi];
  scheduleWrong(z.sid, qi, oi === q.a);
  const st = state.stats[z.sid] || { right: 0, total: 0 };
  st.total += 1;
  if (oi === q.a) st.right += 1;
  state.stats[z.sid] = st;
  touchStreak();
  save();
  render();
}

function nextQuestion(){
  const z = state.quiz;
  if (!z) return;
  if (z.solo){ quitQuiz(); return; }        // 单题重做：答完直接回错题本，别跳下一题
  if (z.i < QUIZ[z.sid].length - 1){ z.i++; render(); return; }
  finishQuiz();
}

function finishQuiz(){
  const z = state.quiz;
  if (z.solo){ quitQuiz(); return; }      // 错题单练不结算、不点亮
  const qs = QUIZ[z.sid];
  const order = z.order || qs.map((_, k) => k);
  const right = z.answers.filter((a, i) => a === qs[order[i]].a).length;
  const rate = right / qs.length;
  const p = state.progress[z.sid] || { tries: 0, best: 0 };
  p.tries += 1;
  p.best = Math.max(p.best, rate);
  p.n = qs.length;            // 记下这次是按几道题考出来的，题量变了旧成绩就不算
  // 过线了也要前置齐才点亮 —— 题会做，不代表这条链上的东西都会
  z.missingPre = hardPre(z.sid).filter(x => !state.lit.has(x));
  if (rate >= QUIT_PASS && z.missingPre.length === 0){
    state.lit.add(z.sid);
    state.unlitSet.delete(z.sid);   // 重新考过了，之前的手动取消作废
  }
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
          ? (z.missingPre && z.missingPre.length
              ? `题全对了，但前置还没点亮：${z.missingPre.map(m => byId[m].n).join('、')}。先把它们过了，这个技能才会亮。`
              : `过了。${s.n} 已经点亮。`)
          : `差一点。${quizRule(qs.length)}才算过。没过不扣任何东西，错题已经进错题本了。`}</div>
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
  const order = z.order || qs.map((_, k) => k);
  const q = qs[order[i]];
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

  const bar = order.map((qidx, idx) => {
    const a = z.answers[idx];
    let c = 'seg';
    if (a !== null) c += (a === qs[qidx].a) ? ' seg-ok' : ' seg-no';
    if (idx === i) c += ' seg-cur';
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
    <div style="margin-bottom:16px">
      <button class="btn primary" data-wrong-paper>把错题组成卷子打印（${Math.min(list.length, 20)} 道${list.length > 20 ? '，一份最多 20' : ''}）</button>
    </div>
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
    <div class="legend" style="margin-bottom:14px"><span>这里只放 B站 上的公开讲解视频，题目本身我没拿到原卷，页面上不摆「真题」。想自己刷，看完视频去搜当年原卷。</span></div>
    <div class="advice" style="margin-bottom:16px">
      想打印一份整套的卷子来做？<b>生成一张 150 分的练习卷</b> —— 15 选择 + 5 填空 + 4 解答，结构和真卷一致，可打印或存成 PDF（题目是自编的）。
      <div style="margin-top:9px"><button class="btn mini primary" data-go="paper">生成练习卷</button></div>
    </div>
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
 *  打印练习卷
 *  没有真题原卷（没文件、有版权），所以这里用题库拼一份「同一张卷子」：
 *  15 选择 + 5 填空 + 4 解答，150 分 120 分钟，跟真卷结构一致，可打印存 PDF。
 *  卷子上会写明是自编题，不是原卷。
 * ======================================================================= */
const PAPER_PLAN_DROPPED = true;   // 原来那套 15×5+5×5+4×12=148，和 150 对不上，已废弃

/* 填空题和解答题题库：卷子上要凑齐三种题型，光靠四选一不够 */
const PAPER_FILL = [
  { q: '计算：8^(2/3) = ______', a: '4', why: '先开三次方 8^(1/3)=2，再平方得 4。' },
  { q: '函数 f(x) = √(x − 3) 的定义域是 ______', a: '[3, +∞)', why: '根号下非负，x−3 ≥ 0。' },
  { q: '已知等差数列 a₁ = 3，公差 d = 4，则 a₇ = ______', a: '27', why: 'a₇ = 3 + 6×4 = 27，注意是 6 个间隔。' },
  { q: '已知 sinα = 4/5，α 是第一象限角，则 cosα = ______', a: '3/5', why: 'cos²α = 1−16/25 = 9/25，第一象限取正。' },
  { q: '若向量 a = (2, −1)，b = (1, 3)，则 a·b = ______', a: '−1', why: '2×1 + (−1)×3 = −1。' },
  { q: '过点 (2, 1) 且斜率为 −1 的直线方程是 ______', a: 'x + y − 3 = 0', why: 'y−1 = −(x−2)，整理得 x+y−3=0。' },
  { q: '圆 x² + y² − 2x + 4y = 0 的半径是 ______', a: '√5', why: '(x−1)² + (y+2)² = 5，半径 √5。' },
  { q: '从 5 个人里选 2 个人去开会，共有 ______ 种选法', a: '10', why: '不排顺序，C(5,2) = 10。' },
  { q: '数据 3, 5, 7, 9 的平均数是 ______', a: '6', why: '(3+5+7+9)/4 = 6。' },
  { q: '复数 (2 + i)(1 − i) = ______', a: '3 − i', why: '2−2i+i−i² = 3−i。' },
  { q: '抛物线 y² = 4x 的准线方程是 ______', a: 'x = −1', why: '2p = 4，p = 2，准线 x = −p/2 = −1。' },
  { q: '不等式 x² − x − 6 < 0 的解集是 ______', a: '−2 < x < 3', why: '(x−3)(x+2) < 0，取两根之间。' }
];

const PAPER_SOLVE = [
  { q: '已知二次函数 y = x² − 4x + 5。(1) 求它的对称轴和顶点坐标；(2) 求它在区间 [0, 3] 上的最大值和最小值。',
    a: '(1) 对称轴 x = 2，顶点 (2, 1)。(2) 最小值 1（在 x=2 处），最大值 5（在 x=0 处；f(3)=2，f(0)=5，取 5）。',
    why: '配方 y=(x−2)²+1 直接读顶点。闭区间最值要比较顶点和两个端点。' },
  { q: '在 △ABC 中，a = 4，b = 6，C = 60°。(1) 求边 c；(2) 求三角形的面积。',
    a: '(1) c = 2√7（c² = 16+36−24 = 28）。(2) S = 6√3（½×4×6×sin60° = 12×√3/2）。',
    why: '已知两边夹角直接上余弦定理；面积用 ½ab·sinC。' },
  { q: '已知等差数列 {aₙ} 中，a₁ = 2，a₄ = 11。(1) 求公差 d 和通项公式；(2) 求前 10 项和 S₁₀。',
    a: '(1) d = 3，aₙ = 3n − 1。(2) S₁₀ = 155。',
    why: 'a₄ = a₁+3d → 11 = 2+3d → d=3。S₁₀ = 10×2 + 10×9/2×3 = 20+135 = 155。' },
  { q: '某厂第一年产量 100 万件，以后每年比上一年增长 10%。(1) 写出第 n 年产量 aₙ 的表达式；(2) 第几年产量首次超过 130 万件？（可估算）',
    a: '(1) aₙ = 100×1.1^(n−1)。(2) 第 4 年：100×1.1³ = 133.1 > 130（第 3 年是 121）。',
    why: '每年乘固定比例是等比数列。判断大小可以逐年代入，不必解对数不等式。' },
  { q: '已知椭圆 x²/25 + y²/16 = 1。(1) 求 a、b、c 和焦点坐标；(2) 求离心率。',
    a: '(1) a=5，b=4，c=3，焦点 (±3, 0)。(2) e = 3/5。',
    why: 'c² = a²−b² = 25−16 = 9。焦点在分母大的那个字母所在的轴上。' },
  { q: '已知圆的方程为 x² + y² − 4x + 2y − 4 = 0。(1) 求圆心和半径；(2) 判断直线 x + y − 1 = 0 与圆的位置关系。',
    a: '(1) 圆心 (2, −1)，半径 3。(2) d = |2−1−1|/√2 = 0 < 3，相交。',
    why: '配方得 (x−2)²+(y+1)²=9。直线过圆心，所以是相交（且是直径）。' },
  { q: '袋中有 3 个红球、2 个白球，共 5 个球。(1) 任取 1 个，求取到红球的概率；(2) 任取 2 个，求两个都是红球的概率。',
    a: '(1) 3/5。(2) C(3,2)/C(5,2) = 3/10。',
    why: '第二问是不放回抽样，用组合数算：分子 3 个红球里取 2，分母 5 个球里取 2。' },
  { q: '已知复数 z = 2 + 3i，w = 1 − i。(1) 求 z + w 和 z·w；(2) 求 |z| 和 z 的共轭复数。',
    a: '(1) z+w = 3+2i，z·w = 5+i。(2) |z| = √13，z̄ = 2−3i。',
    why: 'z·w = 2−2i+3i−3i² = 2+i+3 = 5+i。模是 √(4+9)。' }
];

/* 填空/解答题里也有 < >（x² − x − 6 < 0），进 innerHTML 前先转义 */
[PAPER_FILL, PAPER_SOLVE].forEach(arr => arr.forEach(q => {
  q.q = escHtml(q.q);
  q.a = escHtml(q.a);
  q.why = escHtml(q.why);
}));

let paperCache = null;   // 同一份卷子重复打印时不要每次换题

function buildPaper(mode){
  // 错题卷：把错题本里的选择题原样拼成一份，按到期时间排
  if (mode === 'wrong' && state.wrong.length){
    const picks = state.wrong.slice()
      .sort((a, b) => a.due - b.due)
      .map(w => ({ sid: w.sid, i: w.qi, q: QUIZ[w.sid][w.qi] }))
      .filter(x => x.q);
    return { mode: 'wrong', choice: picks.slice(0, 20), fill: [], solve: [], stamp: localDate(0) };
  }

  const all = [];
  Object.entries(QUIZ).forEach(([sid, arr]) => arr.forEach((q, i) => all.push({ sid, i, q })));
  // 先按技能打散，保证 15 道题尽量来自不同技能
  const bySid = {};
  all.forEach(x => { (bySid[x.sid] = bySid[x.sid] || []).push(x); });
  const sids = Object.keys(bySid);
  for (let i = sids.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [sids[i], sids[j]] = [sids[j], sids[i]];
  }
  const picks = [];
  for (const sid of sids){
    if (picks.length >= 15) break;
    const pool = bySid[sid];
    // 每个技能随机抽一道，不能老抽第 0 道，不然新补的题永远进不了卷子
    picks.push(pool[Math.floor(Math.random() * pool.length)]);
  }

  const pickN = (arr, n) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--){
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a.slice(0, n);
  };

  return {
    mode: 'normal',
    choice: picks,
    fill: pickN(PAPER_FILL, 5),
    solve: pickN(PAPER_SOLVE, 4),
    stamp: localDate(0)
  };
}

function renderPaper(){
  if (!paperCache) paperCache = buildPaper(state.paperMode);
  const p = paperCache;
  const isWrong = p.mode === 'wrong';
  const showKey = !!state.paperKey;
  const main = document.getElementById('main');

  let no = 0;
  const choiceHtml = p.choice.map(x => {
    no++;
    const q = x.q;
    return `<div class="pq"><div class="qt">${no}. ${q.q}</div>
      <div class="po">${['A','B','C','D'].map((L, i) => `<span>${L}. ${q.o[i]}</span>`).join('')}</div></div>`;
  }).join('');

  const off = p.choice.length;
  const fillHtml = p.fill.map((q, i) => `<div class="pq"><div class="qt">${off + 1 + i}. ${q.q}</div></div>`).join('');
  const solveHtml = p.solve.map((q, i) => `<div class="pq"><div class="qt">${off + p.fill.length + 1 + i}. ${q.q}</div><div class="pspace"></div></div>`).join('');

  const keyHtml = `
    <div class="pkey">
      <h3>参考答案（自编题，不是官方答案）</h3>
      <div class="kgroup"><b>一、选择题</b><div>${p.choice.map((x, i) => `${i + 1}. ${'ABCD'[x.q.a]}`).join('　')}</div></div>
      ${p.fill.length ? `<div class="kgroup"><b>二、填空题</b><div>${p.fill.map((q, i) => `${off + 1 + i}. ${q.a}`).join('　｜　')}</div></div>` : ''}
      ${p.solve.length ? `<div class="kgroup"><b>三、解答题</b>${p.solve.map((q, i) => `<div class="kitem"><b>${off + p.fill.length + 1 + i}.</b> ${q.a}<div class="kwhy">${q.why}</div></div>`).join('')}</div>` : ''}
      <div class="kgroup"><b>每题对应技能</b><div style="font-size:11.5px;color:#666">${p.choice.map((x, i) => `${i + 1}.${byId[x.sid].n}`).join('　')}</div></div>
    </div>`;

  main.innerHTML = `
    <div class="crumbs noprint"><a data-go="home">领域总览</a> / <span>${isWrong ? '错题卷' : '打印练习卷'}</span></div>
    <div class="noprint" style="display:flex;gap:9px;flex-wrap:wrap;margin-bottom:16px">
      <button class="btn primary" data-paper-print>打印 / 存成 PDF</button>
      <button class="btn" data-paper-toggle>${showKey ? '只看卷子' : '显示答案'}</button>
      <button class="btn" data-paper-new>${isWrong ? '重新取一遍错题' : '换一张卷子'}</button>
    </div>
    <div class="noprint" style="font-size:12px;color:#7d92aa;line-height:1.75;margin-bottom:18px">
      ${isWrong
        ? `这份卷子是从你的错题本里取的，共 ${p.choice.length} 道选择题，按「该复习的先后」排好了。<br>做的时候先别看答案，做完点「显示答案」再对。`
        : `15 选择 + 5 填空 + 4 解答，共 150 分、120 分钟，结构和真卷一致。<br>
      <b style="color:#b9a06a">题目是自编的，不是历年原卷</b> —— 真题原卷我没有，也不适合转存到公开仓库。`}
      <br>打印时可以选「另存为 PDF」，手机上用浏览器分享 → 打印也行。
    </div>

    <div class="paper">
      <div class="phead">
        <h2>广东省 3+证书（高职高考）数学 · ${isWrong ? '错题重做卷' : '练习卷'}</h2>
        <div class="pmeta">
          <span>${isWrong ? `共 ${p.choice.length} 题` : '考试时间 120 分钟'}</span>
          ${isWrong ? '' : '<span>满分 150 分</span>'}
          <span>生成于 ${p.stamp}</span>
        </div>
        <div class="pnote">${isWrong
          ? '本卷由你自己的错题组成，题目为自编练习题，非官方真题。'
          : '本卷为自编练习题，非官方真题。一、选择题 15 小题每题 5 分共 75 分；二、填空题 5 小题每题 5 分共 25 分；三、解答题 4 小题共 50 分。'}</div>
      </div>
      <div class="psec">一、选择题${isWrong ? '' : '（每小题 5 分，共 75 分）'}</div>
      ${choiceHtml}
      ${p.fill.length ? `<div class="psec">二、填空题（每小题 5 分，共 25 分）</div>${fillHtml}` : ''}
      ${p.solve.length ? `<div class="psec">三、解答题（共 50 分）</div>${solveHtml}` : ''}
      ${showKey ? keyHtml : ''}
    </div>
  `;
}
function renderStats(){
  const main = document.getElementById('main');
  const byDom = {};
  DOMAINS.forEach(d => { byDom[d.id] = { d, right: 0, total: 0, skills: 0, lit: 0 }; });
  SKILLS.forEach(s => {
    const b = byDom[s.d];
    if (!b) return;
    b.skills += 1;
    if (state.lit.has(s.id)) b.lit += 1;
    const st = state.stats[s.id];
    if (st && st.total) { b.right += st.right; b.total += st.total; }
  });

  const rows = Object.values(byDom);
  const totalR = rows.reduce((a, b) => a + b.right, 0);
  const totalT = rows.reduce((a, b) => a + b.total, 0);
  const rate = totalT ? Math.round(totalR / totalT * 100) : 0;
  const litN = SKILLS.filter(s => state.lit.has(s.id)).length;
  const st = state.streak || {};

  // 做过的按正确率从低到高排（最弱在最上面），没做过的垫底
  const tested = rows.filter(r => r.total > 0).sort((a, b) => a.right / a.total - b.right / b.total);
  const untested = rows.filter(r => r.total === 0);

  const bar = r => {
    const p = r.total ? Math.round(r.right / r.total * 100) : 0;
    const cls = !r.total ? 'none' : p >= 80 ? 'good' : p >= 60 ? 'mid' : 'bad';
    return `<div class="sbar"><i class="${cls}" style="width:${r.total ? Math.max(p, 2) : 0}%"></i></div>`;
  };

  const rowHtml = r => `
    <div class="srow" data-dom="${r.d.id}">
      <div class="sname" style="color:${r.d.color}">${r.d.short}</div>
      <div class="smeta">${r.total ? `做过 ${r.total} 题 · 正确率 ${Math.round(r.right / r.total * 100)}%` : '还没做过题'}</div>
      ${bar(r)}
      <div class="slit">${r.lit}/${r.skills}</div>
    </div>`;

  const weakest = tested[0];
  const advice = !totalT
    ? '还没做过题，先去首页点「直接做这一课」试试水。'
    : weakest && weakest.right / weakest.total < 0.8
      ? `最该补的是<b>${weakest.d.name}</b>，正确率只有 ${Math.round(weakest.right / weakest.total * 100)}%。`
      : '各块正确率都在 80% 以上了，可以往上冲更难的技能。';

  main.innerHTML = `
    <div class="crumbs"><a data-go="home">领域总览</a> / <span>我的数据</span></div>
    <div class="sec-title"><h2>我的数据</h2><span>只统计你做过的题，没做过的领域不参与排名</span></div>

    <div class="kpis">
      <div class="kpi"><b>${totalR}<span>/${totalT}</span></b><em>累计答对</em></div>
      <div class="kpi"><b>${totalT ? rate + '%' : '—'}</b><em>总正确率</em></div>
      <div class="kpi"><b>${litN}</b><em>已点亮技能</em></div>
      <div class="kpi"><b>${st.days || 0}</b><em>连续学习天数</em></div>
    </div>

    <div class="advice">${advice}</div>

    <div class="sec-title" style="margin-top:24px"><h2>各领域正确率</h2><span>从弱到强</span></div>
    <div class="slist">${tested.map(rowHtml).join('') || '<div class="empty" style="padding:24px">还没有任何做题记录</div>'}</div>

    ${untested.length ? `
      <div class="sec-title" style="margin-top:22px"><h2>还没碰过的</h2><span>${untested.length} 个领域</span></div>
      <div class="slist dim">${untested.map(rowHtml).join('')}</div>` : ''}

    <div style="margin-top:32px;padding-top:16px;border-top:1px solid #1b2431">
      <button class="btn" data-reset style="border-color:#5c2f28;color:#c9705f">清空这台设备上的所有进度</button>
      <span style="font-size:11.5px;color:#5f7085;margin-left:10px">清空后没有撤销键，建议先点顶栏「导出」备份</span>
    </div>
  `;
}

/* =======================================================================
 *  渲染总入口
 * ======================================================================= */
function renderMain(){
  // 搜索优先：不然做题途中搜东西，主区一动不动（以前就是这个毛病）
  if (state.query.trim()) { renderSearch(); return; }
  if (state.view === 'quiz') return renderQuiz();
  if (state.view === 'domain') return renderDomain(state.domainId);
  if (state.view === 'rank') return renderRank();
  if (state.view === 'plan') return renderPlan();
  if (state.view === 'wrong') return renderWrong();
  if (state.view === 'papers') return renderPapers();
  if (state.view === 'paper') return renderPaper();
  if (state.view === 'stats') return renderStats();
  return renderHome();
}
function render(){
  if (sweepLitByScore()) save();
  // 右栏只有"选中了某个技能"才有意义。首页/排行/数据/错题/真题/卷子都不需要它，
  // 白占 392px 把主区压扁（地图尤其吃亏）。
  const showPanel = !!state.selected && state.view !== 'quiz' && state.view !== 'paper';
  document.body.classList.toggle('no-panel', !showPanel);
  document.body.classList.toggle('quiz-mode', state.view === 'quiz');
  document.body.classList.toggle('paper-mode', state.view === 'paper');
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
    else if (state.view === 'paper') h = '#paper';
    else if (state.view === 'stats') h = '#stats';
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

  const st = e.target.closest('[data-start]');
  if (st){ startQuiz(st.dataset.start); return; }

  if (e.target.closest('[data-paper-print]')){ window.print(); return; }
  if (e.target.closest('[data-paper-toggle]')){ state.paperKey = !state.paperKey; render(); return; }
  if (e.target.closest('[data-paper-new]')){
    paperCache = null;
    if (state.paperMode === 'wrong' && !state.wrong.length){
      alert('错题本是空的，没有可以组卷的题了。');
      return;
    }
    render(); return;
  }
  if (e.target.closest('[data-wrong-paper]')){
    if (!state.wrong.length) return;
    state.paperMode = 'wrong';
    paperCache = null;
    state.view = 'paper';
    state.selected = null;
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }

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

  if (e.target.closest('[data-reset]')){
    if (!confirm('要清空这台设备上的全部进度吗？\n（点亮、错题本、做题成绩、连续天数）')) return;
    if (!confirm('再确认一次：清空之后没有撤销键。\n建议先点顶栏「导出」存一份。')) return;
    state.lit = new Set();
    state.wrong = [];
    state.progress = {};
    state.stats = {};
    state.goal = null;
    state.streak = { days: 0, last: null };
    save(); render();
    return;
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
  clearTimeout(searchTimer);      // 搜索的防抖定时器不掐掉，会把刚切的视图又盖回去
  state.view = view;
  state.query = '';
  document.getElementById('search').value = '';
  if (view !== 'domain') state.selected = null;
  if (view !== 'quiz') state.quiz = null;
  // 从菜单点「真题 → 生成练习卷」进的是普通卷；错题卷走自己的按钮
  if (view === 'paper') { state.paperMode = 'normal'; paperCache = null; }
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
      state.unlitSet.add(id);   // 记下来，不然 sweep 下次渲染又自动点亮回去
    } else if (isUnlocked(id)) {
      state.lit.add(id);
      state.unlitSet.delete(id);
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
  // 窄屏上详情面板在下面，点完自动滚过去，不然像没反应
  if (window.innerWidth <= 1080 && state.view !== 'quiz'){
    setTimeout(() => {
      const p = document.getElementById('panel');
      if (p) p.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 60);
  }
}

document.getElementById('btn-home').onclick = () => goTo('home');
document.getElementById('btn-rank').onclick = () => goTo('rank');
document.getElementById('btn-wrong').onclick = () => goTo('wrong');
document.getElementById('btn-papers').onclick = () => goTo('papers');
document.getElementById('btn-stats').onclick = () => goTo('stats');
document.getElementById('btn-plan').onclick = () => goTo('plan');

/* 键盘：做题时 1~4 直接选，回车下一题 —— 手机上用不到，电脑上快很多。
 * 焦点在输入框里时一律不接管，不然打「2」会直接选中 B。 */
document.addEventListener('keydown', e => {
  if (state.view !== 'quiz') return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  const z = state.quiz;
  if (!z || z.done) return;
  if (e.key >= '1' && e.key <= '4'){
    if (z.answers[z.i] === null){ e.preventDefault(); answerQuiz(+e.key - 1); }
  } else if (e.key === 'Enter'){
    if (z.answers[z.i] !== null){ e.preventDefault(); nextQuestion(); }
  }
});

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
    v: 2,
    lit: [...state.lit], goal: state.goal,
    wrong: state.wrong, progress: state.progress,
    stats: state.stats, streak: state.streak,
    unlit: [...state.unlitSet],
    exportedAt: localDate(0)
  }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `广东3+证书数学技能树_进度_${localDate(0)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};

/* 导入：以前是无条件覆盖，连 stats 都不带，换设备后「我的数据」会清零 */
function applyImport(d, overwrite){
  const litSet = new Set((d.lit || []).filter(x => byId[x]));
  const wrongArr = (d.wrong || []).filter(w => byId[w.sid] && QUIZ[w.sid] && QUIZ[w.sid][w.qi]);
  const prog = d.progress || {};
  const stats = d.stats || {};

  if (overwrite){
    state.lit = litSet;
    state.wrong = wrongArr;
    state.progress = prog;
    state.stats = stats;
    state.unlitSet = new Set((d.unlit || []).filter(x => byId[x]));
  } else {
    litSet.forEach(x => state.lit.add(x));
    (d.unlit || []).filter(x => byId[x]).forEach(x => state.unlitSet.add(x));
    wrongArr.forEach(w => {
      if (!state.wrong.some(o => o.sid === w.sid && o.qi === w.qi)) state.wrong.push(w);
    });
    Object.entries(prog).forEach(([k, v]) => {
      const cur = state.progress[k] || { tries: 0, best: 0 };
      state.progress[k] = { tries: (cur.tries || 0) + (v.tries || 0), best: Math.max(cur.best || 0, v.best || 0) };
    });
    Object.entries(stats).forEach(([k, v]) => {
      const cur = state.stats[k] || { right: 0, total: 0 };
      state.stats[k] = { right: (cur.right || 0) + (v.right || 0), total: (cur.total || 0) + (v.total || 0) };
    });
  }
  if (d.goal && byId[d.goal]) state.goal = d.goal;
  if (d.streak && (d.streak.days || 0) > ((state.streak && state.streak.days) || 0)) state.streak = d.streak;
}

document.getElementById('import-file').addEventListener('change', e => {
  const f = e.target.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    let d;
    try{ d = JSON.parse(r.result); }
    catch(err){ alert('这个文件读不出来，确认是从这里导出的进度文件。'); return; }
    if (confirm('导入进度。\n\n「确定」= 用文件里的记录覆盖这台设备\n「取消」= 下一步再选')){
      applyImport(d, true);
      save(); render();
    } else if (confirm('要合并进去吗？\n\n「确定」= 合并（点亮取并集、错题去重、成绩取高的）\n「取消」= 什么都不做')){
      applyImport(d, false);
      save(); render();
    }
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
  if (p.has('qf')) {
    const v = p.get('qf');
    state.qFilter = ['选择', '填空', '解答'].includes(v) ? v : '';
  }
  if (p.has('streak')) state.streak = { days: +p.get('streak'), last: localDate(0) };
  if (p.has('paperKey')) state.paperKey = true;
  if (p.get('paperMode') === 'wrong') state.paperMode = 'wrong';
  // ?demoStats=1 —— 造点做题记录，方便看数据页
  if (p.has('demoStats')){
    const demo = { s3: [3, 3], i3: [2, 3], t9: [1, 3], g8: [2, 2], r6: [1, 2], q2: [2, 2] };
    Object.entries(demo).forEach(([sid, [r, t]]) => { state.stats[sid] = { right: r, total: t }; });
    ['p1', 'p2', 's1', 's2', 's3', 'i2'].forEach(x => state.lit.add(x));
    state.streak = { days: 5, last: localDate(0) };
  }
  // ?quiz=s3&qi=0&pick=1 —— 直接看刷题页，pick 预填一个已选答案
  const qz = p.get('quiz');
  if (qz && hasQuiz(qz)){
    const n = QUIZ[qz].length;
    state.quiz = { sid: qz, order: [...Array(n).keys()], i: +(p.get('qi') || 0), answers: new Array(n).fill(null), done: false };
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


/* 窗口变窄/变宽时，领域图要在「横向地图」和「纵向列表」之间切换 */
let _rzTimer;
window.addEventListener('resize', () => {
  clearTimeout(_rzTimer);
  _rzTimer = setTimeout(() => {
    if (state.view === 'domain') render();
  }, 180);
});

/* 支持 #geo 这种直接进入某个领域 */
(function applyHash(){
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, '')).trim();
  if (!h || h === 'home') return;
  if (domById[h]) { state.view = 'domain'; state.domainId = h; return; }
  if (h === 'rank') { state.view = 'rank'; return; }
  if (h === 'plan') { state.view = 'plan'; return; }
  if (h === 'wrong') { state.view = 'wrong'; return; }
  if (h === 'papers') { state.view = 'papers'; return; }
  if (h === 'paper') { state.view = 'paper'; return; }
  if (h === 'stats') { state.view = 'stats'; return; }
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
