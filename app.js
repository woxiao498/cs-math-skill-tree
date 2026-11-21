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

/* 点亮这个之后，下一步该学哪个：先挑前置已经齐的，再按重要度、再按步数 */
function pickNextStep(id){
  const kids = downstream(id).filter(k => byId[k]);
  if (!kids.length) return null;
  const ready = kids.filter(k => isUnlocked(k));
  const pool = (ready.length ? ready : kids).slice();
  const myDom = byId[id].d;
  pool.sort((a, b) => {
    // 先给同领域：刚学完数与式，下一步该是整式运算，不是跨到统计去算方差
    const sa = byId[a].d === myDom ? 0 : 1;
    const sb = byId[b].d === myDom ? 0 : 1;
    if (sa !== sb) return sa - sb;
    const la = LV_ORDER[byId[a].lv], lb = LV_ORDER[byId[b].lv];
    if (la !== lb) return la - lb;
    return stepOf(a) - stepOf(b);
  });
  return pool[0];
}

/* 跳到某个技能（换领域 + 选中 + 窄屏弹抽屉） */
function goSkill(sid){
  if (!byId[sid]) return;
  // 搜索态下点「下一步」，主区会被搜索结果占着不换页，看着像没反应
  clearTimeout(searchTimer);
  state.query = '';
  const inp = document.getElementById('search');
  if (inp) inp.value = '';
  state.quiz = null;
  state.view = 'domain';
  state.domainId = byId[sid].d;
  state.selected = sid;
  if (window.innerWidth <= 1080) document.body.classList.add('panel-open');
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
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
  domainView: 'map', // 窄屏领域视图：map 地图 / list 竖排列表
  pitId: null,       // 当前打开的易错点
  pitDone: {},       // { pitId: { 'sid:i': true } } 这个坑里哪些题已经做对过
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
      unlit: [...state.unlitSet], domainView: state.domainView, pitDone: state.pitDone,
      // 模拟考也存：120 分钟的卷子刷新一下就没了，太伤人。不存 timer 本身，存剩余秒数 + 时间戳
      mock: state.mock ? {
        paper: state.mock.paper, ans: state.mock.ans,
        fillSelf: state.mock.fillSelf, solveSelf: state.mock.solveSelf,
        left: state.mock.left, done: state.mock.done, savedAt: Date.now()
      } : null
    }));
  }catch(e){ /* file:// 下个别浏览器禁写，忽略，进度仍存在内存里 */ }
}
// 换过的题不能继承旧题的错题排期或易错点通过记录；整课点亮和成绩不动。
function sameQuestion(w){
  const q = w && Number.isInteger(w.qi) && Array.isArray(QUIZ[w.sid]) && QUIZ[w.sid][w.qi];
  return !!q && (w.rev || 0) === (q.rev || 0);
}
function pitQuestionKey(sid, qi){
  const rev = QUIZ[sid][qi].rev;
  return rev ? sid + ':' + qi + ':v' + rev : sid + ':' + qi;
}
function load(){
  try{
    const raw = localStorage.getItem(KEY) || localStorage.getItem(OLD_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    (d.lit || []).forEach(x => byId[x] && state.lit.add(x));
    state.goal = d.goal && byId[d.goal] ? d.goal : null;
    state.showSkippable = !!d.showSkippable;
    state.wrong = (d.wrong || []).filter(sameQuestion);
    state.progress = d.progress || {};
    state.stats = d.stats || {};
    state.unlitSet = new Set((d.unlit || []).filter(x => byId[x]));
    if (d.domainView === 'list') state.domainView = 'list';
    if (d.pitDone && typeof d.pitDone === 'object') state.pitDone = d.pitDone;
    if (d.streak) state.streak = d.streak;
    // 恢复模拟考：按时间戳扣掉关页面期间流逝的时间，别让人关一夜还剩 120 分钟
    if (d.mock && d.mock.paper && d.mock.paper.choice && d.mock.paper.choice.length){
      const m = d.mock;
      const gap = m.savedAt ? Math.round((Date.now() - m.savedAt) / 1000) : 0;
      state.mock = {
        paper: m.paper, ans: m.ans || [], fillSelf: m.fillSelf || [], solveSelf: m.solveSelf || [],
        left: Math.max(0, (m.left || 0) - gap), done: !!m.done
      };
      if (!state.mock.done && state.mock.left > 0){ state.view = 'mock'; tickMock(); }
      else if (!state.mock.done && state.mock.left <= 0) state.mock.done = true;
    }
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

/* 及格题数。
 * ceil(n×0.8) 在 1~3 题时都等于 n，也就是必须全对 —— 3 题全对通过率只有 0.51，
 * 比 5 题答对 4 题（0.63）还难。边缘考点（C 级 3 题）比核心考点（A 级 5 题）更严，
 * 这个错位说不过去，所以 3 题放一道：答对 2 就算过。1~2 题仍然全对。 */
function needRight(n){
  if (n <= 2) return n;          // 1 题、2 题：全对
  if (n === 3) return 2;         // 3 题：可以错一道
  return Math.ceil(n * QUIT_PASS); // 5 题 → 4
}
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
      if (!QUIZ[sid]) continue;                                          // 没有题组就别碰，否则 .length 会抛错白屏
      if (!state.progress[sid]) continue;                                // 畸形/旧导入可能是 null，别让 .best 打崩
      const pr = state.progress[sid];
      const qn = QUIZ[sid].length;
      if ((pr.n || 0) !== qn) continue;                                  // 题量变了就重做
      // 判定比「答对题数」：旧数据没有 bestRight，用正确率乘回去兜底
      const r = (pr.bestRight != null) ? pr.bestRight : Math.round((pr.best || 0) * qn);
      if (r < needRight(qn)) continue;
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
      state.wrong.push({ sid, qi, rev: QUIZ[sid][qi].rev || 0, stage: 0, due: Date.now() + REVIEW_GAP[0] * 864e5, ts: Date.now() });
    }
  }
}
const dueWrong = () => state.wrong.filter(w => w.due <= Date.now());

/* 这个技能该看哪些视频：技能级优先，没有就用领域级兜底 */
/* 这两个技能没有对口的视频，领域兜底也跟本课无关（p4 韦达定理 ↔ 基础运算）。
 * 宁可写「这一课还没找到合适的视频」，也不拿领域入门片充数 —— 点进去发现讲的是别的东西，比没有更糟。 */
/* 这些技能没有对口的视频，允许「留空」，不要退回到领域兜底 ——
   兜底里是整章的大合集，点开发现讲的根本不是这一课，比空着更糟。
   （p7 比例、p8 三角形：兜底是基础运算；f8 平移：兜底不含平移；
     g9 两圆位置：兜底第二条是直线方程）*/
const NO_FALLBACK_VIDEO = new Set(['p4', 't8', 'p7', 'p8', 'f8', 'g9']);

function fmtSec(s){
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

/* 一条视频可能是「BV 号整段」（1.0 时代）也可能是「源#分P」（2.0 的某一集），
   统一成同一个形状，上层不用管是哪种。 */
function videoItem(key){
  if (key.includes('#')){
    const [srcKey, pageStr] = key.split('#');
    const s = VIDEO_SRC[srcKey], pg = VIDEO_PAGE[key];
    if (!s || !pg) return null;
    return { bv: s.bv, page: +pageStr, t: pg[0], up: s.up, dur: fmtSec(pg[1]), srcName: s.name, play: '' };
  }
  return VIDEO_INFO[key] ? { bv: key, ...VIDEO_INFO[key] } : null;
}

function videoList(id){
  let keys;
  if (SKILL_VIDEO[id]) keys = SKILL_VIDEO[id];
  else if (NO_FALLBACK_VIDEO.has(id)) keys = [];
  else keys = DOMAIN_VIDEO[byId[id].d] || [];
  return keys.map(videoItem).filter(Boolean);
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
  // 进度条只放两个信息：点亮数和百分比。覆盖分和连续天数都在数据页，
  // 四个信息挤一行，手机一折行蓝线就没了。
  document.getElementById('pbar-text').textContent =
    `已点亮 ${done} / ${vis.length} · ${pct}%`;
}

/* 今天学哪一课：从前置已齐、还没点亮的技能里挑一个（重要度优先、步数小的优先）。
 * 首页第一眼给一个具体的小目标，比「102 个技能」有用得多。 */
function pickTodaySkill(){
  const ready = SKILLS.filter(s =>
    !state.lit.has(s.id) && hasQuiz(s.id) && isUnlocked(s.id) &&
    (state.showSkippable || s.lv !== 'D')
  );
  if (!ready.length) return null;
  // 先按深浅（步数小的先），再按领域先后，最后才比等级。
  // 之前是「步数 → 等级」，结果 r10 升到 A 级后把 p2 顶掉了 —— 刚点亮「数与式的运算」，
  // 首页却推「均值、方差与标准差」，跟结算页说的「下一步整式运算」打架。
  // 地基在 DOMAINS 里排最前，按领域顺序就能保证「同一层里先补前面的」。
  ready.sort((a, b) => {
    const sa = stepOf(a.id), sb = stepOf(b.id);
    if (sa !== sb) return sa - sb;
    const da = DOMAINS.findIndex(d => d.id === a.d);
    const db = DOMAINS.findIndex(d => d.id === b.d);
    if (da !== db) return da - db;
    return LV_ORDER[a.lv] - LV_ORDER[b.lv];
  });
  return ready[0].id;
}

/* 点亮的技能大概值多少分：按往年卷面把 150 分摊到 A/B/C 三档估算。
 * 粗，但比「点亮 4 / 102」有用 —— 学生关心的是离 60 分还有多远。 */
const COVER_PER_SKILL = { A: 4.6, B: 0.62, C: 0.42 };
function coveredScore(){
  return Math.round(SKILLS.filter(s => state.lit.has(s.id))
    .reduce((a, s) => a + (COVER_PER_SKILL[s.lv] || 0), 0));
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
      <div class="dom-card" data-dom="${d.id}" tabindex="0" role="button" style="--dc:${d.color}">
        <h3>${d.name}</h3>
        <div class="meta">
          ${d.id === 'prep'
            ? '<span class="rank-badge" style="background:#1d2733;color:#8fa8c4;border:1px solid #2c3b4d;white-space:nowrap">地基</span>'
            : `<span class="rank-badge lv-${d.lv}">${d.lv}</span>`}
          <span>${d.score}</span>
        </div>
        <div class="desc">${d.desc}</div>
        <div class="foot">
          <span>${litN}/${total} 已点亮${hidden ? ` · 其中 ${hidden} 个可先跳` : ''}</span>
          <span class="mini-bar"><i style="width:${pct}%"></i></span>
          <span title="${ext.size ? `要先学 ${ext.size} 个其他领域的技能` : '没有任何前置，可以从这里开始'}">${ext.size ? `先学 ${ext.size} 个` : '可以从这开始'}</span>
        </div>
      </div>`;
  }).join('');

  const isNewbie = !state.lit.size && !Object.keys(state.progress).length;
  const tid0 = pickTodaySkill();

  // 第一次进来：先把规矩讲清楚，不是丢一堆卡片让人自己猜
  const guide = isNewbie ? `
    <div class="guide">
      <div class="guide-h">第一次来，先看这三句</div>
      <div class="guide-row"><b>1</b><div><span class="gt">这是一张技能树</span>
        做完题才算点亮，点亮了才开得动后面的。</div></div>
      <div class="guide-row"><b>2</b><div><span class="gt">你现在只需要做一件事</span>
        ${tid0 ? `学「${byId[tid0].n}」，${QUIZ[tid0].length} 道题。` : '从下面挑一课开始。'}</div></div>
      <div class="guide-row"><b>3</b><div><span class="gt">答错不扣分</span>
        错题自动进错题本，过 1、3、7、15 天会提醒你再看一遍。</div></div>
    </div>` : '';

  document.getElementById('main').innerHTML = `
    <div class="focus">
      ${(() => {
        const tid = pickTodaySkill();
        if (!tid){
          const litN = SKILLS.filter(s => state.lit.has(s.id)).length;
          return `<div class="flabel">${litN ? '全都点亮了' : '没有能直接开始的课'}</div>
            <div class="fmeta">${litN ? '可以去「重要度排行」回头看哪块还不熟。' : '要先学的还没点亮，去下面从头挑一个。'}</div>`;
        }
        const ts = byId[tid];
        const mins = Math.max(2, Math.round(QUIZ[tid].length * 1.2));
        return `<div class="flabel">今天只做这一课</div>
          <div class="fname">${ts.n}</div>
          <div class="fsub">这课讲：${(ts.pts || []).slice(0, 2).join('、')}</div>
          <div class="fmeta">${QUIZ[tid].length} 道题 · 约 ${mins} 分钟 · ${domById[ts.d].name} · 做完就点亮</div>
          <div class="fbtns">
            <button class="btn fprimary" data-start="${tid}">现在开始</button>
            <button class="btn mini" data-goto-skill="${tid}">这一课教什么</button>
          </div>`;
      })()}
    </div>
    ${guide}
    <div class="sec-title" style="margin-top:32px">
      <h2>全部内容</h2>
      <span>${DOMAINS.length} 个领域 · 先把上面那一课做完，这里不用急着看</span>
    </div>
    <div class="dom-grid">${cards}</div>
    <div class="p-how">
      <b>怎么用</b>
      从上往下学，前置点亮了才开得动。每题选完立刻给解析，讲的是错在哪。
      卡上的 A/B/C/D 是这块在往年卷面里的分量，不是教材要求。想看清「每一分该花在哪」，去顶栏的「重要度排行」。
    </div>`;
}

/* 窄屏的领域视图：按步分组往下排。
 * 和地图并存，由 state.domainView 切换 —— 地图能看前置关系，列表能一眼看全，各有各的用处。 */
function domainViewToggle(){
  if (window.innerWidth > 1080) return '';
  const toList = state.domainView !== 'list';
  return `<button class="btn mini" data-domain-view="${toList ? 'list' : 'map'}" style="margin-left:auto">${toList ? '换成竖排列表' : '换成地图'}</button>`;
}

function renderDomainList(d, vis, hiddenCount){
  const byStep = {};
  vis.forEach(s => { const st = stepOf(s.id); (byStep[st] = byStep[st] || []).push(s); });
  const steps = Object.keys(byStep).map(Number).sort((a, b) => a - b);

  const groups = steps.map(st => {
    const items = byStep[st].map(s => {
      const lit = state.lit.has(s.id);
      const unlocked = isUnlocked(s.id);
      const q = (s.q || []).length ? s.q.join('·') : '可不学';
      const missN = hardPre(s.id).filter(p => !state.lit.has(p)).length;
      const subText = (!lit && missN) ? `还差 ${missN} 课` : q;
      return `<div class="lcard ${lit ? 'lit' : ''} ${unlocked ? '' : 'locked'}"
                   data-skill="${s.id}" tabindex="0" role="button">
        <div class="ltop">
          ${s.d === 'prep'
            ? `<span class="rank-badge" style="background:#1d2733;color:#8fa8c4;border:1px solid #2c3b4d">基</span>`
            : `<span class="rank-badge lv-${s.lv}">${s.lv}</span>`}
          <span class="lnm">${s.n}</span>
        </div>
        <div class="lsub">${subText}${lit ? ' · 已点亮' : ''}</div>
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
      ${domainViewToggle()}
    </div>
    ${d.id === 'prep' ? `<div class="unsure" style="margin-bottom:14px">这一层不出独立考题，所以重要度对这里没有意义 —— 九条全都得会。</div>` : ''}
    ${(() => {
      const minSt = Math.min(...vis.map(s => stepOf(s.id)));
      if (minSt <= 1) return '';
      const entry = vis.find(s => stepOf(s.id) === minSt);
      const outside = entry ? allPre(entry.id).filter(p => !vis.some(v => v.id === p)) : [];
      // 前置都点亮了这句就没意义 —— 学生看到「要先会 X」会以为还有一步没做
      const missing = outside.filter(p => !state.lit.has(p));
      if (!missing.length) return '';
      return `<div class="hint-line">这里从第 ${minSt} 步开始，不是第一课 —— 要先会
        ${missing.map(p => `<b data-goto-skill="${p}">${byId[p].n}</b>`).join('、')}。</div>`;
    })()}
    <div class="dlist">${groups}</div>`;
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

  // 窄屏可以切成竖排列表（默认还是地图）
  if (window.innerWidth <= 1080 && state.domainView === 'list')
    return renderDomainList(d, vis, hiddenCount);

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
    // 锁定态要能一眼看出「差几个前置」，不然和「没学过」分不开
    const missN = hardPre(s.id).filter(p => !state.lit.has(p)).length;
    const subText = (!lit && missN) ? `还差 ${missN} 课` : q;
    return `
      <div class="${cls}" data-skill="${s.id}" tabindex="0" role="button"
           style="left:${p0.x}px;top:${p0.y}px;width:${W}px;height:${H}px;--nc:${d.color}">
        <span class="dot"></span>
        <div class="nm">${s.n}</div>
        <div class="sub">${s.d === 'prep'
          ? `<span class="rank-badge" style="height:17px;min-width:17px;background:#1d2733;color:#8fa8c4;border:1px solid #2c3b4d">基</span>`
          : `<span class="rank-badge lv-${s.lv}" style="height:17px;min-width:17px">${s.lv}</span>`}<span>${subText}</span></div>
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
      ${domainViewToggle()}
    </div>
    ${window.innerWidth <= 1080 ? '<div class="swipe-hint">这张图比屏幕宽，左右滑动看全，点节点看详情。</div>' : ''}
    <div class="legend legend-state">
      <span><i class="lg-lit"></i>已点亮</span>
      <span><i class="lg-open"></i>能学，还没点亮</span>
      <span><i class="lg-lock"></i>要先学会前面的</span>
      <span><i class="lg-skip"></i>可跳过</span>
    </div>
    <div class="legend" style="margin-top:-6px">
      <span><i></i>实线=必须先学</span>
      <span><i class="dash"></i>虚线=推荐先学（不学也能做）</span>
      <span><span class="kbd">点节点</span> 亮出整条前置链</span>
    </div>
    <div class="legend" style="margin-top:-8px">
      <span>步数按整棵树算 —— 某个技能的第一课可能落在别的领域，所以这里的起点不一定是第一步。</span>
    </div>
    ${domId === 'prep' ? `<div class="unsure" style="margin:0 0 14px">这一层不出独立考题，所以重要度对这里没有意义 —— 九条全都得会，缺哪条后面都会塌。</div>` : ''}
    ${(() => {
      // 这个领域的技能不都从第一步开始，得说清为什么，并给出跳转
      const minSt = Math.min(...vis.map(s => stepOf(s.id)));
      if (minSt <= 1) return '';
      const entry = vis.find(s => stepOf(s.id) === minSt);
      const outside = entry ? allPre(entry.id).filter(p => !vis.some(v => v.id === p)) : [];
      // 前置都点亮了这句就没意义 —— 学生看到「要先会 X」会以为还有一步没做
      const missing = outside.filter(p => !state.lit.has(p));
      if (!missing.length) return '';
      return `<div class="hint-line">这里从第 ${minSt} 步开始，不是第一课 —— 要先会
        ${missing.map(p => `<b data-goto-skill="${p}">${byId[p].n}</b>`).join('、')}。点它就能去做。</div>`;
    })()}
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
    return `<div class="rank-row" data-skill="${s.id}" tabindex="0" role="button">
      ${s.d === 'prep'
        ? `<span class="rank-badge" style="background:#1d2733;color:#8fa8c4;border:1px solid #2c3b4d;white-space:nowrap">基</span>`
        : `<span class="rank-badge lv-${s.lv}">${s.lv}</span>`}
      <span class="nm">${s.n}</span>
      <span class="dom">${d.short}</span>
      <span class="how">${s.how}</span>
      <span class="qtags">${q}</span>
    </div>`;
  };

  const prepList = vis.filter(s => s.d === 'prep');
  if (prepList.length){
    html += `<div class="rank-group"><span class="rank-badge" style="background:#1d2733;color:#8fa8c4;border:1px solid #2c3b4d;white-space:nowrap">地基</span>
      不单独占分，但缺哪条后面都会塌 —— 这 ${prepList.length} 条不按 A/B/C/D 排，全都要会</div>`;
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
/* 题库检索：题干、选项、解析都搜，「sin75」「裂项」这种词才找得到 */
function unescHtml(s){
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

function searchQuestions(q){
  const out = [];
  Object.entries(QUIZ).forEach(([sid, arr]) => {
    arr.forEach((qq, i) => {
      const hay = [qq.q, qq.why, ...(qq.o || [])].join(' ').toLowerCase();
      if (hay.includes(q)) out.push({ sid, i, q: qq });
    });
  });
  PAPER_FILL.forEach((qq, i) => {
    if ([qq.q, qq.a, qq.why].join(' ').toLowerCase().includes(q)) out.push({ paper: 'fill', i, q: qq });
  });
  PAPER_SOLVE.forEach((qq, i) => {
    if ([qq.q, qq.a, qq.why, qq.steps || '', qq.std || ''].join(' ').toLowerCase().includes(q))
      out.push({ paper: 'solve', i, q: qq });
  });
  return out;
}

function startSolo(sid, i, pitContext){
  if (!QUIZ[sid] || !QUIZ[sid][i]) return;
  state.quiz = { sid, i, answers: new Array(QUIZ[sid].length).fill(null), done: false, solo: true };
  if (pitContext) state.quiz.pitContext = pitContext;   // 练完回坑页，别丢了上下文
  state.view = 'quiz';
  state.query = '';
  const inp = document.getElementById('search');
  if (inp) inp.value = '';
  state.selected = sid;
  render();
}

function renderSearch(){
  const q = state.query.trim().toLowerCase();
  const hits = visibleSkills().filter(s => {
    const hay = [s.n, s.how, s.tip, domById[s.d].name, ...(s.pts || [])].join(' ').toLowerCase();
    return hay.includes(q);
  });
  const qhits = searchQuestions(q);

  if (!hits.length && !qhits.length){
    main.innerHTML =
      `<div class="empty">没搜到「${escHtml(state.query)}」<br><span>换个说法试试，比如只搜两个字；搜题目内容也能找到</span></div>`;
    return;
  }

  const rows = hits.map(s => {
    const d = domById[s.d];
    return `<div class="rank-row" data-skill="${s.id}" tabindex="0" role="button">
      <span class="rank-badge lv-${s.lv}">${s.lv}</span>
      <span class="nm">${s.n}</span>
      <span class="dom">${d.short}</span>
      <span class="how">${s.how}</span>
    </div>`;
  }).join('');

  const qrows = qhits.slice(0, 40).map(x => {
    const title = x.paper
      ? (x.paper === 'fill' ? '填空题' : '解答题')
      : byId[x.sid].n;
    const txt = x.q.q.length > 64 ? x.q.q.slice(0, 64) + '…' : x.q.q;
    const attr = x.paper
      ? `data-paper-q="${x.paper}:${x.i}"`
      : `data-search-q="${x.sid}:${x.i}"`;
    return `<div class="rank-row" ${attr} tabindex="0" role="button">
      <span class="rank-badge" style="background:#16202c;color:#8fa8c4;border:1px solid #253345;white-space:nowrap">题</span>
      <span class="qres">${txt}</span>
      <span class="dom" style="color:#6a819c">${title}</span>
    </div>`;
  }).join('');

  document.getElementById('main').innerHTML =
    `<div class="sec-title"><h2>「${escHtml(state.query)}」的结果</h2>
       <span>${hits.length} 个技能 · ${qhits.length} 道题</span></div>
     ${hits.length ? `<div class="rank-group">技能</div>${rows}` : ''}
     ${qhits.length ? `<div class="rank-group" style="margin-top:18px">题目（点一道单练）</div>${qrows}
       ${qhits.length > 40 ? `<div class="p-hint">只列出前 40 道，换个更具体的词能缩小范围</div>` : ''}` : ''}`;
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
        <div class="t">${s.n} ${s.d === 'prep'
          ? `<span class="rank-badge" style="height:17px;min-width:17px;background:#1d2733;color:#8fa8c4;border:1px solid #2c3b4d">基</span>`
          : `<span class="rank-badge lv-${s.lv}" style="height:17px;min-width:17px">${s.lv}</span>`}</div>
        <div class="d">${d.name} · 第 ${stepOf(id)} 步 · ${(s.q || []).join('/') || '可不学'}</div>
      </div>
    </div>`;
  }).join('');

  const allDone = done === list.length;
  document.getElementById('main').innerHTML = `
    <div class="crumbs"><a data-go="home">领域总览</a> / <span>学习清单</span></div>
    <div class="sec-title">
      <h2>目标：${g.n}</h2>
      <span>要 ${list.length} 个技能，已完成 ${done} 个，其中 A 级 ${aCount} 个</span>
    </div>
    <div class="plan-actions">
      ${allDone
        ? `<div class="plan-done">✓ 这个目标完成了 —— ${list.length} 个前置技能全部点亮</div>
           <button class="btn primary" data-goal-next>挑下一个目标</button>`
        : `<span class="plan-hint">${list.length - done} 个还没点亮</span>`}
      <button class="btn" data-goal-clear>${allDone ? '清掉这个目标' : '不追这个目标了'}</button>
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
    panel.innerHTML = `<div class="empty">左边点一个技能<br><span>看它要先学什么、考到什么程度、坑在哪</span></div>`;
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
  // 点亮了才给"下一步"，没点亮的话下一步就是把这一课做完
  const nextStep = lit ? pickNextStep(id) : null;

  const pts = (s.pts || []).map(p => `<li>${p}</li>`).join('');
  const qTags = (s.q || []).map(x => `<span class="tag q">${x}题</span>`).join(' ') || '<span class="tag">不考</span>';

  const preChips = (s.pre || []).length
    ? s.pre.map(p => {
        const soft = softs.includes(p);
        const ok = state.lit.has(p);
        return `<span class="chip ${ok ? 'ok' : 'miss'} ${soft ? 'soft' : ''}" data-skill="${p}" tabindex="0" role="button"
          title="${soft ? '学会了更好，不学也能做' : '要先学会这一课'}">${ok ? '✓' : '·'} ${byId[p].n}${soft ? ' (推荐)' : ''}</span>`;
      }).join('')
    : '<span style="font-size:12px;color:var(--txt3)">不用先学别的，从这里开始</span>';

  const kidChips = kids.length
    ? kids.map(k => `<span class="chip" data-skill="${k}">${byId[k].n}</span>`).join('')
    : '<span style="font-size:12px;color:var(--txt3)">没有必修它的下游</span>';

  panel.innerHTML = `
    <div class="panel-grip"></div>
    <button class="panel-close" data-close-panel aria-label="关闭">✕</button>
    <div class="p-head">${s.n}</div>
    <div class="p-domain" style="color:${d.color}">${d.name} · 第 ${stepOf(id)} 步</div>
    <div class="p-row">
      ${s.d === 'prep'
        ? `<span class="rank-badge" style="background:#1d2733;color:#8fa8c4;border:1px solid #2c3b4d;white-space:nowrap">地基</span>
           <span style="font-size:12px;color:#8fa8c4">不出独立考题，但必须会</span>`
        : `<span class="rank-badge lv-${s.lv}">${s.lv}</span>
           <span style="font-size:12px;color:#93a3b8">${({A:'主力，必考',B:'常考',C:'边缘',D:'可跳过'})[s.lv]}</span>`}
      ${qTags}
    </div>

    <details class="p-fold">
      <summary>这课具体要会哪几条（${(s.pts || []).length} 条，有符号，点开看）</summary>
      <ul class="pts" style="--nc:${d.color}">${pts || '<li>（无）</li>'}</ul>
    </details>

    <div class="p-sec">掌握到什么程度</div>
    <div class="p-how">${s.how}</div>

    ${s.tip ? `<div class="p-sec">坑在哪</div><div class="tip">${s.tip}</div>` : ''}

    ${(s.unsure || domUnsure) ? `<div class="unsure">⚠ ${s.unsure || domUnsure}</div>` : ''}

    <div class="p-sec">怎么学 · 视频</div>
    ${vids.length ? vids.map(v => `
      <div class="vcard">
        <div class="vtitle">${escHtml(v.t)}</div>
        <div class="vmeta">${v.srcName
          ? escHtml(v.srcName) + ' · 第 ' + v.page + ' P · ' + v.dur
          : escHtml(v.up) + ' · ' + v.dur + (v.play ? ' · ' + v.play + '播放' : '')}</div>
        <div class="vbtns">
          <button class="btn mini" data-play="${v.bv}" data-page="${v.page || ''}">在本页看</button>
          <a class="btn mini" href="https://www.bilibili.com/video/${v.bv}${v.page ? '?p=' + v.page : ''}" target="_blank" rel="noopener noreferrer">去 B站</a>
        </div>
      </div>`).join('') : '<div style="font-size:12px;color:var(--txt3)">这一课还没找到合适的视频</div>'}
    <div id="player-slot"></div>

    <div class="p-sec">要先学会</div>
    <div class="pre-chips">${preChips}</div>
    ${miss.length
      ? `<div class="pre-tip">要先学会 ${miss.map(m => `<b data-skill="${m}">${byId[m].n}</b>`).join('、')}，这一课才开得动 —— <span style="color:#93a3b8">点名字直接去做</span>。</div>`
      : ''}

    <div class="p-sec">点亮它能解锁</div>
    <div class="pre-chips">${kidChips}</div>
    ${nextStep ? `<div class="nextup">这一步走完了，下一步建议学：<b data-goto-skill="${nextStep}">${byId[nextStep].n}</b></div>` : ''}

    <div class="p-actions">
      ${lit
        ? `<button class="btn lit" data-act="toggle">已点亮 · 点此取消</button>`
        : q
          ? `<button class="btn primary" data-act="quiz">${unlocked ? `开始结业挑战（${QUIZ[id].length} 题）` : '先做做看（要先学的那几课没点亮，做对也不算）'}</button>`
          : `<button class="btn primary" data-act="toggle" ${unlocked ? '' : 'disabled'}>${unlocked ? '点亮它（这课没配题）' : '要先学会前面的课'}</button>`}
      <button class="btn" data-act="goal">设为目标</button>
    </div>
    ${q ? `<div class="p-hint">${lit ? '已通过结业挑战' : `${quizRule(QUIZ[id].length)}才能点亮${best ? ` · 你目前最好成绩 ${Math.round(best * 100)}%` : ''}`}</div>` : ''}
    ${state.goal === id
      ? `<div style="font-size:12px;color:#a9cbef;margin-top:6px">当前目标就是它 ·
           <a data-goal-clear style="color:#7fb0e8;cursor:pointer;text-decoration:underline">取消目标</a></div>`
      : ''}
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
  // 从易错点进来练的，答对就记下「这个坑这一道过了」
  if (z.solo && z.pitContext && oi === q.a){
    state.pitDone[z.pitContext] = state.pitDone[z.pitContext] || {};
    state.pitDone[z.pitContext][pitQuestionKey(z.sid, qi)] = true;
    save();
  }
  // 单题订正：不自动跳，让学生看完解析再点「订正完了」
  if (z.redoOne){
    render();
    return;
  }
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
  const p = state.progress[z.sid] || { tries: 0, best: 0, n: 0, bestRight: 0 };
  const sameSize = p.n === qs.length;      // 题量变没变，决定旧成绩还能不能算
  const need = needRight(qs.length);
  p.tries += 1;
  // 题量变了，旧成绩必须作废：2 题全对和 5 题全对不是一回事。
  // best 存正确率（给人看的），bestRight 存答对题数（给判定用的）——
  // 判定比题数，别拿浮点正确率乘回来比，0.667 和 needRight(3)/3 这种比不稳。
  p.best = sameSize ? Math.max(p.best, rate) : rate;
  p.bestRight = sameSize ? Math.max(p.bestRight || 0, right) : right;
  p.n = qs.length;
  // 过线了也要前置齐才点亮 —— 题会做，不代表这条链上的东西都会
  z.missingPre = hardPre(z.sid).filter(x => !state.lit.has(x));
  if (right >= need && z.missingPre.length === 0){
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
    const pass = z.right >= needRight(qs.length);
    const order = z.order || qs.map((_, k) => k);
    // 这次错了哪几题：原来只说「错题已进错题本」，学生还得自己去翻
    const wrongOnes = order
      .map((qi, idx) => ({ qi, idx, ok: z.answers[idx] === qs[qi].a }))
      .filter(x => !x.ok);
    const litNow = state.lit.has(z.sid);
    const nextId = litNow ? pickNextStep(z.sid) : null;

    main.innerHTML = `
      <div class="crumbs"><a data-go="home">领域总览</a> / <span>结业挑战</span></div>
      <div class="quiz-result">
        <div class="qr-score ${pass ? 'ok' : 'no'}">${Math.round(z.rate * 100)}%</div>
        <div class="qr-line">答对 ${z.right} / ${qs.length} 题</div>
        <div class="qr-msg">${pass
          ? (z.missingPre && z.missingPre.length
              ? `题全对了，但前置还没点亮：${z.missingPre.map(m => byId[m].n).join('、')}。`
              : `${s.n} 已经点亮。`)
          : `差一点。${quizRule(qs.length)}才算过。没过不扣任何东西，错题已经进错题本了。`}</div>
        ${litNow ? `<div class="qr-lit">✦ ${s.n} 点亮了</div>` : ''}
        ${nextId ? `<div class="qr-next">下一步建议学：<b data-goto-skill="${nextId}">${byId[nextId].n}</b></div>` : ''}
        ${wrongOnes.length ? `<div class="qr-wrong">
          <div class="qr-wrong-h">这次错的 ${wrongOnes.length} 题（点一行看为什么错）</div>
          ${wrongOnes.map(x => `<div class="qr-wrow" data-review>
            <span class="qn">${x.idx + 1}</span>
            <div class="qr-wbody">
              <div class="qt">${qs[x.qi].q}</div>
              <div class="why">${qs[x.qi].why}</div>
            </div>
            <button class="btn mini qr-redo" data-redo-wrong="${x.idx}">重做这题</button>
          </div>`).join('')}
        </div>` : ''}
        <div class="qr-actions">
          ${(z.missingPre && z.missingPre.length)
            ? z.missingPre.map(m => `<button class="btn primary" data-goto-skill="${m}">去学「${byId[m].n}」</button>`).join('')
            : ''}
          <button class="btn ${pass ? '' : 'primary'}" data-quiz-retry>再来一次</button>
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
      <div class="quiz-sub">${solo ? '复习错题 · 答对一次往后推一档' : `第 ${i + 1} / ${qs.length} 题 · 答错不扣分，只记进错题本`}</div>
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
        ${!ok && (q.pit || []).length && PIT_BY_ID[q.pit[0]]
          ? `<div class="pit-hint">这题踩的是「<b>${PIT_BY_ID[q.pit[0]].name}</b>」这个坑 ——
              同一课做对不代表它填上了，换个技能还会犯。
              <a data-goto-pit="${q.pit[0]}">单独练这个坑 →</a></div>`
          : ''}
        <div class="qnav">
          ${solo
            ? `<button class="btn primary" data-quiz-quit>${z.pitContext ? '回这个易错点' : '返回错题本'}</button>`
            : z.redoOne
              ? `<button class="btn primary" data-quiz-next>订正完了，回去看成绩</button>`
              : `<button class="btn primary" data-quiz-next>${i === qs.length - 1 ? '看结果' : '下一题'}</button>`}
        </div>` : ''}
    </div>

    ${solo ? '' : `<div style="margin-top:18px"><button class="btn" data-quiz-quit>先不做了</button></div>`}
  `;
}

/* =======================================================================
 *  模拟考：120 分钟计时，选择自动判、填空/解答自评
 * ======================================================================= */
/* 地基卷：只从「已点亮」或「前置已齐」的技能里抽 10 道。
 * 整卷模拟考一上来就是 sin2α，学了三课的人只会觉得白学了 —— 先给一张做得到的。 */
function buildBasicPaper(){
  const pool = [];
  Object.entries(QUIZ).forEach(([sid, arr]) => {
    if (!byId[sid]) return;
    if (!(state.lit.has(sid) || isUnlocked(sid))) return;
    arr.forEach((q, i) => pool.push({ sid, i, q }));
  });
  for (let i = pool.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return { mode: 'basic', choice: pool.slice(0, 10), fill: [], solve: [], stamp: localDate(0) };
}

function startMock(mode){
  const basic = mode === 'basic';
  const paper = basic ? buildBasicPaper() : buildPaper('normal');
  state.mock = {
    paper,
    basic,
    ans: new Array(paper.choice.length).fill(null),
    fillSelf: new Array(paper.fill.length).fill(null),
    solveSelf: new Array(paper.solve.length).fill(null),
    fillText: new Array(paper.fill.length).fill(''),
    solveText: new Array(paper.solve.length).fill(''),
    left: basic ? 0 : EXAM.minutes * 60,
    done: false
  };
  state.view = 'mock';
  state.selected = null;
  state.query = '';
  if (!basic) tickMock();
  render();
}

function stopMockTimer(){
  if (mockTimer){ clearInterval(mockTimer); mockTimer = null; }
}

let mockTimer = null;
function tickMock(){
  stopMockTimer();
  if (!state.mock || state.mock.done) return;
  mockTimer = setInterval(() => {
    if (!state.mock || state.mock.done){ stopMockTimer(); return; }
    state.mock.left -= 1;
    const el = document.getElementById('mk-timer');
    if (el) el.textContent = fmtClock(state.mock.left);
    if (state.mock.left <= 0){
      stopMockTimer();
      state.mock.done = true;
      finishMock();
    }
  }, 1000);
}

function fmtClock(s){
  if (s < 0) s = 0;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function mockScore(){
  const m = state.mock, p = m.paper;
  const rightChoice = p.choice.filter((x, i) => m.ans[i] === x.q.a).length;
  const choicePts = rightChoice * 5;
  const fillPts = p.fill.reduce((sum, q, i) => sum + (m.fillSelf[i] === true ? 5 : 0), 0);
  const solvePts = p.solve.reduce((sum, q, i) => sum + (m.solveSelf[i] === true ? (q.pts || 12) : 0), 0);
  return { pts: choicePts + fillPts + solvePts, rightChoice, choicePts, fillPts, solvePts };
}

function finishMock(){
  stopMockTimer();
  state.mock.done = true;
  // 错的选择题进错题本，模拟卷才不是白做。choice 元素是 { sid, i, q }
  state.mock.paper.choice.forEach((x, idx) => {
    if (state.mock.ans[idx] != null && state.mock.ans[idx] !== x.q.a && sameQuestion({ sid: x.sid, qi: x.i, rev: x.q.rev })){
      scheduleWrong(x.sid, x.i, false);
    }
  });
  save();
  render();
}

function quitMock(){
  stopMockTimer();
  const m = state.mock;
  const hasWork = m && !m.done && (
    m.ans.some(a => a !== null) ||
    (m.fillText || []).some(t => t.trim()) ||
    (m.solveText || []).some(t => t.trim())
  );
  if (hasWork){
    if (!confirm('还没交卷，现在退出会丢掉这次作答。确定退出？')) return;
  }
  state.mock = null;
  state.view = 'paper';
  render();
}

function renderMock(){
  const main = document.getElementById('main');
  const m = state.mock;
  if (!m){ main.innerHTML = `<div class="empty">没有正在进行的模拟考</div>`; return; }
  const p = m.paper;

  if (m.done){
    const sc = mockScore();
    const basic = !!m.basic;
    const total = basic ? p.choice.length * 5 : 150;
    const passLine = Math.ceil(total * 0.6);
    const wrongChoice = p.choice.map((x, i) => ({ i, x })).filter(o => m.ans[o.i] !== o.x.q.a);
    main.innerHTML = `
      <div class="crumbs"><a data-go="home">领域总览</a> / <span>${basic ? '地基卷结果' : '模拟考结果'}</span></div>
      <div class="quiz-result">
        ${basic ? '' : '<div class="mk-est-label">本次估分</div>'}
        <div class="qr-score${basic ? (sc.pts >= passLine ? ' ok' : ' no') : ''}">${sc.pts}<span class="mk-of"> / ${total}</span></div>
        ${basic ? `
          <div class="qr-line">答对 ${sc.rightChoice} / ${p.choice.length} 道${sc.pts >= passLine ? ' · 这些课你都过了' : ` · 及格线是 ${passLine} 分`}</div>
          <div class="qr-msg">这张卷子只从你点亮过、或者前置已经齐了的课里出题，所以它测的是「学过的会不会」，不是「能考几分」。</div>
        ` : `
          <div class="qr-line">选择（自动判）：${sc.choicePts} / 75 分 · 答对 ${sc.rightChoice} / ${p.choice.length} 道<br>
            填空（自评）：${sc.fillPts} / 25 分 · 解答（自评）：${sc.solvePts} / 50 分</div>
          <div class="qr-msg mk-est-note"><b>自评手松一点，估分就可能偏高。</b><br>
            填空只看你原来写的答案；解答对照给分点，没写出来的步骤不算。这里的解答题只记满分或 0 分，考场会按步骤给分。别把这个数当成正式成绩。</div>
        `}
        ${wrongChoice.length ? `<div class="qr-wrong">
          <div class="qr-wrong-h">选择题错这 ${wrongChoice.length} 道（点开看为什么）</div>
          ${wrongChoice.map(o => `<div class="qr-wrow" data-review>
            <span class="qn">${o.i + 1}</span>
            <div><div class="qt">${o.x.q.q}</div><div class="why">${o.x.q.why}</div></div>
          </div>`).join('')}
        </div>` : ''}
        <div class="qr-actions">
          <button class="btn primary" data-mock-start="${m.basic ? 'basic' : 'full'}">再考一次</button>
          ${wrongChoice.length ? `<button class="btn" data-go="wrong">看错题本</button>` : ''}
          <button class="btn" data-go="home">回总览</button>
        </div>
      </div>`;
    return;
  }

  const answered = m.ans.filter(a => a !== null).length;
  const choiceHtml = p.choice.map((x, i) => {
    const sel = m.ans[i];
    return `<div class="mk-q">
      <div class="mk-qt"><b>${i + 1}.</b> ${x.q.q}</div>
      <div class="mk-opts">${x.q.o.map((o, oi) =>
        `<div class="mk-opt ${sel === oi ? 'sel' : ''}" data-mock-opt="${i}:${oi}">
           <span class="ml">${'ABCD'[oi]}</span><span>${o}</span>
         </div>`).join('')}</div>
    </div>`;
  }).join('');

  const fillHtml = p.fill.map((q, i) => {
    const self = m.fillSelf[i];
    return `<div class="mk-q">
      <div class="mk-qt"><b>${p.choice.length + i + 1}.</b>（5 分）${q.q}</div>
      <textarea class="mk-input" rows="2" data-mock-text="fill:${i}" placeholder="在这里写答案，写完对照下面的标准答案自己判">${escHtml(m.fillText[i] || '')}</textarea>
      <details class="mk-ans"><summary>看标准答案</summary>
        <div class="mk-ansbody"><b>${q.a}</b><div class="kwhy">${q.why}</div></div>
      </details>
      <div class="mk-self">
        <span>对照你原来写的答案：</span>
        <button class="btn mini ${self === true ? 'on' : ''}" data-mock-fill="${i}:1">写对了</button>
        <button class="btn mini ${self === false ? 'on' : ''}" data-mock-fill="${i}:0">错了或没写</button>
      </div>
    </div>`;
  }).join('');

  const solveHtml = p.solve.map((q, i) => {
    const self = m.solveSelf[i];
    return `<div class="mk-q">
      <div class="mk-qt"><b>${p.choice.length + p.fill.length + i + 1}.</b>（${q.pts || 12} 分）${q.q}</div>
      <textarea class="mk-input" rows="5" data-mock-text="solve:${i}" placeholder="写解题过程。写完展开答案，对照给分点查漏。">${escHtml(m.solveText[i] || '')}</textarea>
      <details class="mk-ans"><summary>看标准答案和给分点</summary>
        <div class="mk-ansbody"><b>${q.a}</b>
          <div class="kwhy">${q.why}</div>
          ${q.steps ? `<div class="ksteps">给分点：${q.steps}</div>` : ''}
          ${q.std ? `<div class="mk-std">标准写法：\n${q.std}</div>` : ''}
        </div>
      </details>
      <div class="mk-self">
        <span>按你实际写出的步骤判：</span>
        <button class="btn mini ${self === true ? 'on' : ''}" data-mock-solve="${i}:1">答案和给分点都写对了</button>
        <button class="btn mini ${self === false ? 'on' : ''}" data-mock-solve="${i}:0">没写全或有错（本卷不计分）</button>
      </div>
    </div>`;
  }).join('');

  main.innerHTML = `
    <div class="mk-bar">
      <div class="mk-left">
        ${m.basic
          ? `<span class="mk-label">地基卷 · 不计时 · 只出你学过的</span>`
          : `<span class="mk-label">剩余时间</span>
             <span class="mk-timer" id="mk-timer">${fmtClock(m.left)}</span>`}
        <span class="mk-answered">选择题已答 ${answered} / ${p.choice.length}</span>
      </div>
      <div class="mk-right">
        <button class="btn mini" data-mock-exit>退出</button>
        <button class="btn primary" data-mock-submit>交卷</button>
      </div>
    </div>
    <div class="mk-sec">一、选择题（每题 5 分，共 ${p.choice.length * 5} 分）</div>
    ${choiceHtml}
    ${m.basic ? '' : `
      <div class="mk-sec">二、填空题（每题 5 分，共 25 分）· 自评</div>
      ${fillHtml}
      <div class="mk-sec">三、解答题（共 50 分）· 自评</div>
      ${solveHtml}`}
    <div class="mk-end">
      <button class="btn primary" data-mock-submit>交卷并看成绩</button>
    </div>`;
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
        <button class="btn mini" data-play="${p.bv}" data-slot="paper-player">在本页看</button>
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
    <div id="paper-player"></div>`;
}

/* 点「在本页看」才插 iframe，避免一进页面就加载一堆播放器 */
function playVideo(bv, page, slotId){
  const slot = document.getElementById(slotId || 'player-slot');
  if (!slot) return;
  slot.innerHTML = `
    <div class="player">
      <iframe src="https://player.bilibili.com/player.html?bvid=${bv}${page ? '&page=' + page : ''}&autoplay=0&danmaku=0&high_quality=1"
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
  { pts: 12, q: '已知二次函数 y = x² − 4x + 5。(1) 求它的对称轴和顶点坐标；(2) 求它在区间 [0, 3] 上的最大值和最小值。',
    a: '(1) 对称轴 x = 2，顶点 (2, 1)。(2) 最小值 1（在 x=2 处），最大值 5（在 x=0 处）。',
    why: '配方 y=(x−2)²+1 直接读顶点。闭区间最值要比较顶点和两个端点。',
    steps: '配方 3 分；顶点 2 分；判断顶点在区间内 2 分；比较端点 3 分；结论 2 分',
    std: 'y = x²−4x+5 = (x−2)² + 1\n所以对称轴 x = 2，顶点 (2, 1)\n区间 [0,3] 上顶点 x=2 在区间内，最小值 f(2) = 1\nf(0) = 5，f(3) = 2，所以最大值 5' },
  { pts: 12, q: '在 △ABC 中，a = 4，b = 6，C = 60°。(1) 求边 c；(2) 求三角形的面积。',
    a: '(1) c = 2√7。(2) S = 6√3。',
    why: '已知两边夹角直接上余弦定理；面积用 ½ab·sinC。',
    steps: '余弦定理式子 3 分；代入 2 分；c 开方 2 分；面积公式 3 分；结果 2 分',
    std: '由余弦定理 c² = a² + b² − 2ab·cosC\n= 16 + 36 − 2×4×6×½ = 28\n所以 c = 2√7\nS = ½ab·sinC = ½×4×6×(√3/2) = 6√3' },
  { pts: 12, q: '已知等差数列 {aₙ} 中，a₁ = 2，a₄ = 11。(1) 求公差 d 和通项公式；(2) 求前 10 项和 S₁₀。',
    a: '(1) d = 3，aₙ = 3n − 1。(2) S₁₀ = 155。',
    why: 'a₄ = a₁+3d → 11 = 2+3d → d=3。S₁₀ = 10×2 + 10×9/2×3 = 20+135 = 155。',
    steps: '列 a₄ 式子 3 分；解出 d 2 分；写通项 2 分；求和公式 3 分；结果 2 分',
    std: 'a₄ = a₁ + 3d，即 11 = 2 + 3d，得 d = 3\naₙ = 2 + (n−1)×3 = 3n − 1\nS₁₀ = 10×2 + (10×9/2)×3 = 20 + 135 = 155' },
  { pts: 12, q: '某厂第一年产量 100 万件，以后每年比上一年增长 10%。(1) 写出第 n 年产量 aₙ 的表达式；(2) 第几年产量首次超过 130 万件？',
    a: '(1) aₙ = 100×1.1^(n−1)（n 为正整数）。(2) 第 4 年。',
    why: '每年乘固定比例是等比数列。判断大小可以逐年代入，不必解对数不等式。',
    steps: '判断为等比 3 分；写出通项 3 分；逐年代入 3 分；结论 3 分',
    std: '每年乘 1.1，是等比数列，aₙ = 100×1.1^(n−1)（n ∈ N*）\na₁ = 100，a₂ = 110，a₃ = 121，a₄ = 133.1\n133.1 > 130 而 121 < 130，所以第 4 年' },
  { pts: 12, q: '已知椭圆 x²/25 + y²/16 = 1。(1) 求 a、b、c 和焦点坐标；(2) 求离心率。',
    a: '(1) a=5，b=4，c=3，焦点 (±3, 0)。(2) e = 3/5。',
    why: 'c² = a²−b² = 25−16 = 9。焦点在分母大的那个字母所在的轴上。',
    steps: '读出 a、b 共 4 分；c²=a²−b² 2 分；c 2 分；焦点 2 分；离心率 2 分',
    std: '由方程得 a² = 25，b² = 16，所以 a = 5，b = 4\nc² = a² − b² = 9，c = 3\n25 > 16，焦点在 x 轴上，为 (−3,0) 和 (3,0)\ne = c/a = 3/5' },
  { pts: 12, q: '已知圆的方程为 x² + y² − 4x + 2y − 4 = 0。(1) 求圆心和半径；(2) 判断直线 x + y − 1 = 0 与圆的位置关系。',
    a: '(1) 圆心 (2, −1)，半径 3。(2) d = 0 < 3，相交。',
    why: '配方得 (x−2)²+(y+1)²=9。直线过圆心，所以是相交（且是直径）。',
    steps: '配方 4 分；圆心半径 2 分；点到直线距离 3 分；比较并下结论 3 分',
    std: '配方：(x²−4x+4) + (y²+2y+1) = 4 + 4 + 1\n即 (x−2)² + (y+1)² = 9，圆心 (2,−1)，半径 r = 3\n圆心到直线距离 d = |2+(−1)−1|/√2 = 0\nd < r，所以相交（直线过圆心，截得的是直径）' },
  { pts: 12, q: '袋中有 3 个红球、2 个白球，共 5 个球。(1) 任取 1 个，求取到红球的概率；(2) 不放回任取 2 个，求两个都是红球的概率。',
    a: '(1) 3/5。(2) 3/10。',
    why: '第二问是不放回抽样，用组合数算：分子 3 个红球里取 2，分母 5 个球里取 2。',
    steps: '第一问 3 分；分母 C(5,2) 3 分；分子 C(3,2) 3 分；结果 3 分',
    std: '(1) 5 个球里 3 个红，P = 3/5\n(2) 基本事件总数 C(5,2) = 10\n两个都是红球有 C(3,2) = 3 种\nP = 3/10' },

  { pts: 12, q: '已知数列 {aₙ} 满足 aₙ = n·2ⁿ。(1) 求 a₁ 和 a₂；(2) 求前 n 项和 Sₙ。',
    a: '(1) a₁ = 2，a₂ = 8。(2) Sₙ = (n−1)·2^(n+1) + 2。',
    why: '这是「等差 × 等比」，要用错位相减：写出 Sₙ 和 2Sₙ，两式相减，中间变成等比数列，单独求和后化简。2026 年真题第 23 题考的就是它。',
    steps: '第一问 2 分；写出 Sₙ 展开式 3 分；两边乘 2 得 2Sₙ 2 分；相减并求和 3 分；化简 2 分',
    std: 'Sₙ = 1×2 + 2×2² + 3×2³ + … + n×2ⁿ\n2Sₙ = 1×2² + 2×2³ + … + (n−1)×2ⁿ + n×2^(n+1)\n两式相减得 −Sₙ = 2 + 2² + … + 2ⁿ − n×2^(n+1)\n= 2^(n+1) − 2 − n×2^(n+1)\n所以 Sₙ = (n−1)·2^(n+1) + 2' },
  { pts: 12, q: '已知数列 {aₙ} 中 aₙ = 1/[n(n+1)]。(1) 求 a₁ + a₂；(2) 求前 n 项和 Sₙ。',
    a: '(1) 2/3。(2) Sₙ = n/(n+1) = 1 − 1/(n+1)。',
    why: '先拆项：aₙ = 1/n − 1/(n+1)，相加时中间项两两抵消，只剩 1 − 1/(n+1)。2025 年真题第 22 题考的就是拆项相消。',
    steps: '第一问 3 分；拆项 3 分；写出相加后抵消的样子 3 分；结果 3 分',
    std: '(1) a₁ = 1/2，a₂ = 1/6，和 = 2/3\n(2) 因为 1/[n(n+1)] = 1/n − 1/(n+1)\nSₙ = (1 − 1/2) + (1/2 − 1/3) + … + (1/n − 1/(n+1))\n中间项全部抵消，得 Sₙ = 1 − 1/(n+1) = n/(n+1)' },
  { pts: 12, q: '已知数列 {aₙ} 满足 aₙ = (2n − 1) + 2^(n−1)。(1) 求 a₁；(2) 求前 n 项和 Sₙ。',
    a: '(1) a₁ = 2。(2) Sₙ = n² + 2ⁿ − 1。',
    why: '一个等差加一个等比，拆开分别求和再相加（分组求和）。',
    steps: '第一问 2 分；看出可拆成两组 3 分；等差部分求和 4 分；等比部分求和 3 分',
    std: '(1) a₁ = 1 + 1 = 2\n(2) 前 n 项和拆成两组：\n等差部分 1+3+…+(2n−1) = n²\n等比部分 1+2+…+2^(n−1) = 2ⁿ − 1\n所以 Sₙ = n² + 2ⁿ − 1' },

  { pts: 12, q: '某商品每件成本 40 元，售价 60 元时每月卖 200 件；售价每降 1 元，月销量增加 20 件。设每件降价 x 元。(1) 写出月利润 y 与 x 的关系式，并写出 x 的取值范围；(2) 每件降价多少元时月利润最大，最大是多少？',
    a: '(1) y = (20−x)(200+20x) = −20x² + 200x + 4000，0 ≤ x ≤ 20。(2) x = 5 时最大，最大值 4500 元。',
    why: '每件利润 = 售价−成本 = 20−x，销量 = 200+20x。定义域：降价不能超过每件利润 20 元（到 20 元是不赔不赚）。',
    steps: '每件利润 2 分；销量 2 分；关系式 3 分；取值范围 2 分；配方或顶点 2 分；最值 1 分',
    std: '每件利润 = (60−x) − 40 = 20 − x\n月销量 = 200 + 20x\ny = (20−x)(200+20x) = −20x² + 200x + 4000\n由 20−x ≥ 0 且 x ≥ 0，得 0 ≤ x ≤ 20\n配方：y = −20(x−5)² + 4500\n所以 x = 5 时 y 最大，最大 4500 元' },
  { pts: 12, q: '用 40 米长的篱笆靠墙围一个矩形菜地，墙长 25 米（靠墙那面不用篱笆）。设与墙平行的边长为 x 米。(1) 写出面积 S 与 x 的关系式，并写出 x 的取值范围；(2) 求菜地的最大面积。',
    a: '(1) S = x(40−x)/2 = −x²/2 + 20x，0 < x ≤ 25。(2) x = 20 时最大，最大 200 平方米。',
    why: '垂直于墙的边是 (40−x)/2。取值范围受两条限制：x>0，且 x 不能超过墙长 25。顶点 x=20 落在范围内。',
    steps: '另一边表示 2 分；面积式子 3 分；取值范围 2 分；顶点 2 分；判断顶点在范围内 2 分；答 1 分',
    std: '垂直于墙的两条边共 40 − x 米，每条 (40−x)/2 米\nS = x·(40−x)/2 = −½x² + 20x\n由 x > 0 且 x ≤ 25（不能超过墙长），得 0 < x ≤ 25\n对称轴 x = 20 在范围内\nS = −½(20−20)² + 200 = 200' },

  { pts: 12, q: '在 △ABC 中，a = 3，b = 4，C = 60°。(1) 求边 c；(2) 求三角形的面积。',
    a: '(1) c = √13。(2) S = 3√3。',
    why: '余弦定理求 c；面积用 ½ab·sinC，注意用的是两边的夹角。',
    steps: '余弦定理 3 分；代入 2 分；c 3 分；面积公式 3 分；结果 1 分',
    std: 'c² = a² + b² − 2ab·cosC = 9 + 16 − 2×3×4×½ = 13\n所以 c = √13\nS = ½ab·sinC = ½×3×4×(√3/2) = 3√3' },
  { pts: 12, q: '为了测量一座塔的高度，在 A 点测得塔顶的仰角为 30°，沿直线向塔走 40 米到 B 点，测得塔顶的仰角为 45°。求塔高（结果保留根号）。',
    a: '塔高 h = 20(√3 + 1) 米（约 54.6 米）。',
    why: '设塔高 h：B 点到塔底水平距离 = h/tan45° = h；A 点到塔底 = h/tan30° = √3h。两者相差 40。',
    steps: '画图并设塔高 3 分；B 点到塔底 2 分；A 点到塔底 3 分；列方程 2 分；解出并答 2 分',
    std: '设塔高 h 米，塔底为 O\n在直角三角形 OBC 中，∠OBC = 45°，所以 OB = h\n在直角三角形 OAC 中，∠OAC = 30°，所以 OA = h/tan30° = √3h\nOA − OB = AB，即 √3h − h = 40\nh = 40/(√3−1) = 20(√3+1) 米' },

  { pts: 12, q: '已知函数 f(x) = 2^x − ax 的图像经过点 (1, 1)。(1) 求 a 的值；(2) 设 g(x) = −x + 2，求不等式 f(x) > g(x) 的解集。',
    a: '(1) a = 1。(2) 解集是 (1, +∞)。',
    why: '第 (1) 问用「图像过点」：把 x=1、y=1 代进去解 a。第 (2) 问代入后 −x 会两边抵消，剩下 2^x > 2，再用指数函数的单调性把「函数值比大小」变成「指数比大小」。',
    steps: '代入求 a 4 分；写出 f(x) 表达式 2 分；列不等式并化简 3 分；用单调性解出 3 分',
    std: '(1) 图像过点 (1, 1)，所以 f(1) = 1：\n2 − a = 1，得 a = 1\n(2) f(x) = 2^x − x，不等式为\n2^x − x > −x + 2\n两边 −x 抵消，得 2^x > 2 = 2¹\n因为 y = 2^x 是增函数，所以 x > 1\n解集为 (1, +∞)' },
  { pts: 12, q: '某企业 2025 年的产值是 1000 万元，计划以后每年比上一年增长 20%。(1) 若把 2025 年记为第 1 年，写出第 n 年的产值 aₙ（万元）的表达式；(2) 从哪一年开始，产值超过 1700 万元？',
    a: '(1) aₙ = 1000 × 1.2^(n−1)（n 为正整数）。(2) 第 4 年：1000×1.2³ = 1728 > 1700（第 3 年是 1440）。',
    why: '每年比上一年增长 20%，就是每年乘 1.2，属于等比数列。第 1 年是基准，所以第 n 年乘了 n−1 次。判断「哪一年超过」要逐年算，别解对数不等式。',
    steps: '首项和公比各 2 分；通项 3 分；逐年代入 4 分；结论 3 分',
    std: '(1) 第 1 年 1000 万元，每年乘 1.2：\naₙ = 1000 × 1.2^(n−1)（n ∈ N*）\n(2) 逐年算：\n第 1 年 1000，第 2 年 1200，第 3 年 1440，第 4 年 1728\n1440 < 1700 < 1728，所以从第 4 年开始超过 1700 万元' },
  { pts: 14, dom: 'geo', q: '已知椭圆 x²/4 + y² = 1，直线 y = x + 1 与椭圆交于 A、B 两点。(1) 求椭圆的长轴长和焦距；(2) 求弦长 |AB|。',
    a: '(1) 长轴长 4，焦距 2√3。(2) |AB| = 8√2/5。',
    why: '把直线代入椭圆：x²/4 + (x+1)² = 1，化简得 5x² + 8x = 0，两根 x=0 和 x=−8/5。弦长 = √(1+k²)·|x₁−x₂|。',
    steps: '第一问 3 分；联立消元 4 分；解出两根 3 分；弦长公式 2 分；结果 2 分',
    std: '(1) a = 2，b = 1，c = √3，长轴长 2a = 4，焦距 2c = 2√3\n(2) 把 y = x+1 代入 x²/4 + y² = 1：\nx² + 4(x+1)² = 4，整理得 5x² + 8x = 0\n解得 x₁ = 0，x₂ = −8/5，|x₁−x₂| = 8/5\n|AB| = √(1+1²)·|x₁−x₂| = √2 × 8/5 = 8√2/5' },
  { pts: 14, dom: 'geo', q: '已知抛物线 y² = 4x 与直线 y = x − 1 交于 A、B 两点。(1) 求抛物线的焦点坐标；(2) 求线段 AB 的中点坐标；(3) 求弦长 |AB|。',
    a: '(1) 焦点 (1, 0)。(2) 中点 (3, 2)。(3) |AB| = 8。',
    why: '联立得 (x−1)² = 4x，即 x² − 6x + 1 = 0。由韦达定理 x₁+x₂ = 6、x₁x₂ = 1。中点横坐标 3，纵坐标用 y=x−1 算。弦长先求 |x₁−x₂| = √((x₁+x₂)²−4x₁x₂) = √32 = 4√2，再乘 √(1+k²)。',
    steps: '第一问 2 分；联立 3 分；整理成一元二次 2 分；韦达求中点 3 分；弦长公式 2 分；结果 2 分',
    std: '(1) 2p = 4，p = 2，焦点 (1, 0)\n(2) 把 y = x−1 代入 y² = 4x：\n(x−1)² = 4x，即 x² − 6x + 1 = 0\n由韦达定理 x₁ + x₂ = 6，中点横坐标 3\ny₁ + y₂ = (x₁−1) + (x₂−1) = 4，中点纵坐标 2\n所以 AB 中点 (3, 2)\n(3) |x₁−x₂| = √((x₁+x₂)² − 4x₁x₂) = √(36 − 4) = 4√2\n|AB| = √(1+1²)·|x₁−x₂| = √2 × 4√2 = 8' }
];

/* 填空/解答题里也有 < >（x² − x − 6 < 0），进 innerHTML 前先转义 */
[PAPER_FILL, PAPER_SOLVE].forEach(arr => arr.forEach(q => {
  q.q = escHtml(q.q);
  q.a = escHtml(q.a);
  q.why = escHtml(q.why);
  if (q.steps) q.steps = escHtml(q.steps);
  if (q.std) q.std = escHtml(q.std);
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
  // 按领域分值分配这 15 道题：解析几何 3 道、三角 2 道……这样卷子才像真卷。
  // 单按 A/B/C 加权不够——B 级有 70 个技能，数量会压过权重，B 还是占到六成多。
  // prep 不列进来：站点自己写着「不单独占分」，它不该占这 15 道题的名额。
  const DOM_W = { set: 7, ineq: 9, func: 14, explog: 8, trig: 21, seq: 21, vec: 11, geo: 32, prob: 9, cplx: 8 };
  const totalW = Object.values(DOM_W).reduce((a, b) => a + b, 0);
  const bases = {};
  let baseSum = 0;
  const fracs = [];
  for (const [d, w] of Object.entries(DOM_W)){
    const exact = (w / totalW) * 15;
    bases[d] = Math.floor(exact);
    baseSum += bases[d];
    fracs.push([d, exact - Math.floor(exact)]);
  }
  fracs.sort((a, b) => b[1] - a[1]);            // 最大余数法凑够 15
  for (let i = 0; i < 15 - baseSum; i++) bases[fracs[i % fracs.length][0]] += 1;

  const byDom = {};
  for (const sid of Object.keys(bySid)){
    const d = byId[sid] ? byId[sid].d : null;
    if (d) (byDom[d] = byDom[d] || []).push(sid);
  }

  const picks = [];
  const taken = new Set();
  for (const [d, n] of Object.entries(bases)){
    if (n <= 0) continue;
    // 领域内再按 lv 加权（A 3 票、B 2 票、C 1 票）：
    // 只按领域随机抽的话，A 级技能在每个领域里本来就少，抽出来还是 B 占大头。
    const tickets = [];
    (byDom[d] || []).forEach(sid => {
      const l = byId[sid] ? byId[sid].lv : 'C';
      const w = l === 'A' ? 3 : l === 'B' ? 2 : 1;
      for (let i = 0; i < w; i++) tickets.push(sid);
    });
    for (let i = tickets.length - 1; i > 0; i--){
      const j = Math.floor(Math.random() * (i + 1));
      [tickets[i], tickets[j]] = [tickets[j], tickets[i]];
    }
    const usedHere = new Set();
    let got = 0;
    for (const sid of tickets){
      if (got >= n || picks.length >= 15) break;
      if (usedHere.has(sid)) continue;
      usedHere.add(sid);
      taken.add(sid);
      got++;
      const pool = bySid[sid];
      picks.push(pool[Math.floor(Math.random() * pool.length)]);
    }
  }
  // 某个领域题不够时，从剩下的技能里补满 15
  if (picks.length < 15){
    const rest = Object.keys(bySid).filter(sid => !taken.has(sid));
    for (let i = rest.length - 1; i > 0; i--){
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    for (const sid of rest){
      if (picks.length >= 15) break;
      const pool = bySid[sid];
      picks.push(pool[Math.floor(Math.random() * pool.length)]);
    }
  }

  // 抽完要打乱：按领域顺序 push 的话，第一题永远是同一个领域
  for (let i = picks.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [picks[i], picks[j]] = [picks[j], picks[i]];
  }

  const pickN = (arr, n) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--){
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a.slice(0, n);
  };

  // 解答题按分值配：3 道 12 分 + 1 道 14 分的末题，和真卷 12/12/12/14 对齐。
  // 末题优先从圆锥曲线取 —— 真卷那道 14 分基本钉在解析几何上（g17 的 tip 里自己也这么写）。
  const s12 = PAPER_SOLVE.filter(q => (q.pts || 12) !== 14);
  const s14 = PAPER_SOLVE.filter(q => q.pts === 14);
  const s14geo = s14.filter(q => q.dom === 'geo');
  const finalPick = s14geo.length ? pickN(s14geo, 1) : (s14.length ? pickN(s14, 1) : []);
  const solvePicks = finalPick.length
    ? [...pickN(s12, 3), ...finalPick]
    : pickN(PAPER_SOLVE, 4);

  return {
    mode: 'normal',
    choice: picks,
    fill: pickN(PAPER_FILL, 5),
    solve: solvePicks,
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
  const solveHtml = p.solve.map((q, i) => `<div class="pq"><div class="qt">${off + p.fill.length + 1 + i}.（${q.pts || 12} 分）${q.q}</div><div class="pspace"></div></div>`).join('');

  const keyHtml = `
    <div class="pkey">
      <h3>参考答案（自编题，不是官方答案）</h3>
      <div class="kgroup"><b>一、选择题</b><div>${p.choice.map((x, i) => `${i + 1}. ${'ABCD'[x.q.a]}`).join('　')}</div></div>
      ${p.fill.length ? `<div class="kgroup"><b>二、填空题</b><div>${p.fill.map((q, i) => `${off + 1 + i}. ${q.a}`).join('　｜　')}</div></div>` : ''}
      ${p.solve.length ? `<div class="kgroup"><b>三、解答题</b>${p.solve.map((q, i) => `<div class="kitem"><b>${off + p.fill.length + 1 + i}.</b>（${q.pts || 12} 分）${q.a}<div class="kwhy">${q.why}</div>${q.steps ? `<div class="ksteps">给分点：${q.steps}</div>` : ''}${q.std ? `<details class="kstd"><summary>标准写法 —— 照着这个写才拿得到分</summary><div>${q.std}</div></details>` : ''}</div>`).join('')}</div>` : ''}
      <div class="kgroup"><b>每题对应技能</b><div style="font-size:12px;color:#666">${p.choice.map((x, i) => `${i + 1}.${byId[x.sid].n}`).join('　')}</div></div>
    </div>`;

  main.innerHTML = `
    <div class="crumbs noprint"><a data-go="home">领域总览</a> / <span>${isWrong ? '错题卷' : '打印练习卷'}</span></div>
    <div class="p-actions noprint" style="display:flex;gap:9px;flex-wrap:wrap;margin-bottom:16px">
      <button class="btn primary" data-paper-print>打印 / 存成 PDF</button>
      <button class="btn" data-paper-toggle>${showKey ? '只看卷子' : '显示答案'}</button>
      <button class="btn" data-paper-new>${isWrong ? '重新取一遍错题' : '换一张卷子'}</button>
      <button class="btn" data-mock-start="basic">先做地基 10 题（不计时）</button>
      <button class="btn" data-mock-start="full">整卷模拟考（${EXAM.minutes} 分钟）</button>
    </div>
    <div class="noprint" style="font-size:12px;color:#7d92aa;line-height:1.75;margin-bottom:18px">
      ${isWrong
        ? `这份卷子是从你的错题本里取的，共 ${p.choice.length} 道选择题，按「该复习的先后」排好了。<br>做的时候先别看答案，做完点「显示答案」再对。`
        : `15 选择 + 5 填空 + 4 解答，共 150 分、120 分钟，结构和真卷一致。<br>
      <b style="color:var(--txt)">题目是自编的，不是历年原卷</b> —— 真题原卷我没有，也不适合转存到公开仓库。`}
      <br>打印时可以选「另存为 PDF」，手机上用浏览器分享 → 打印也行。
    </div>

    <div class="paper">
      <div class="phead">
        <h2>广东省 3+证书（高职高考）数学 · ${isWrong ? '错题重做卷' : '练习卷'}</h2>
        <div class="pmeta">
          <span>${isWrong ? `共 ${p.choice.length} 题` : '考试时间 120 分钟'}</span>
          ${isWrong ? '' : '<span>满分 150 分</span>'}
        </div>
        <div class="pexam-info">
          <span class="pi">姓名<i class="ul"></i></span>
          <span class="pi">班级<i class="ul"></i></span>
          <span class="pi">考号<i class="ul"></i></span>
          <span class="pi">得分<i class="ul"></i></span>
        </div>
        <div class="pnote"><b>注意事项</b>${(isWrong
          ? ['1. 本卷由你自己的错题组成，题目为自编练习题，非官方真题。']
          : ['1. 本卷为自编练习题，非官方真题。',
             '2. 一、选择题 15 小题，每题 5 分，共 75 分。',
             '3. 二、填空题 5 小题，每题 5 分，共 25 分。',
             '4. 三、解答题 4 小题，共 50 分。']
        ).map(t => `<div>${t}</div>`).join('')}</div>
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
      <div class="sname"><i style="background:${r.d.color}"></i>${r.d.short}</div>
      <div class="smeta">${r.total ? `做过 ${r.total} 题 · 正确率 ${Math.round(r.right / r.total * 100)}%` : '还没做过题'}</div>
      ${bar(r)}
      <div class="slit">${r.lit}/${r.skills}</div>
    </div>`;

  const weakest = tested[0];
  // 样本太少时别下「都 80% 以上」这种结论 —— 做 5 道蒙对 4 道也叫 80%
  const advice = !totalT
    ? '还没做过题。先去首页点「先做第一课」，两道题就算开始。'
    : totalT < 15
      ? `才做了 ${totalT} 道题，样本太少看不出强弱——先做够 15 道再回来看这一页。`
      : weakest && weakest.right / weakest.total < 0.8
        ? `最该补的是<b>${weakest.d.name}</b>，正确率只有 ${Math.round(weakest.right / weakest.total * 100)}%。`
        : '各块正确率都在 80% 以上了，可以往上冲更难的技能。';

  // 技能级最弱：领域级只说得出「三角函数 33%」，说不出「是诱导公式不行还是正弦定理不行」
  const weakSkills = SKILLS
    .map(s => ({ s, st: state.stats[s.id] }))
    .filter(x => x.st && x.st.total >= 2)
    .map(x => ({ ...x, rate: x.st.right / x.st.total }))
    // 已经点亮的课不列「最该补」——不然上面说「点亮了」、下面说「最该补它」，
    // 两句话只能信一句，那这页就废了
    .filter(x => x.rate < 1 && !state.lit.has(x.s.id))
    .sort((a, b) => a.rate - b.rate || b.st.total - a.st.total)
    .slice(0, 5);

  const weakRows = weakSkills.map(x => {
    const d = domById[x.s.d];
    const p = Math.round(x.rate * 100);
    return `<div class="rank-row" data-skill="${x.s.id}" tabindex="0" role="button">
      <span class="rank-badge lv-${x.s.lv}">${x.s.lv}</span>
      <span class="nm">${x.s.n}</span>
      <span class="dom">${d.short}</span>
      <span class="how">做过 ${x.st.total} 题，对 ${x.st.right} 题</span>
      <span class="qtags"><span class="weak-rate" style="color:${p >= 80 ? 'var(--ok-text)' : p >= 60 ? 'var(--txt2)' : 'var(--bad-text)'}">${p}%</span></span>
    </div>`;
  }).join('');

  main.innerHTML = `
    <div class="crumbs"><a data-go="home">领域总览</a> / <span>我的数据</span></div>
    <div class="sec-title"><h2>我的数据</h2><span>只统计你做过的题，没做过的领域不参与排名</span></div>

    <div class="kpis">
      <div class="kpi"><b>${totalR}<span>/${totalT}</span></b><em>累计答对</em></div>
      <div class="kpi"><b>${totalT ? rate + '%' : '—'}</b><em>总正确率</em></div>
      <div class="kpi"><b>${litN}</b><em>已点亮技能</em></div>
      <div class="kpi"><b>${coveredScore()}<span>/${EXAM.total}</span></b><em>按卷面粗估覆盖分</em></div>
      <div class="kpi"><b>${st.days || 0}</b><em>连续学习天数</em></div>
    </div>

    <div class="advice">${advice}</div>

    ${weakRows ? `
      <div class="sec-title" style="margin-top:26px">
        <h2>最该补的几课</h2>
        <span>按技能排的，点一行去看详情</span>
      </div>
      <div class="slist">${weakRows}</div>` : ''}

    <div class="sec-title" style="margin-top:24px"><h2>各领域正确率</h2><span>从弱到强</span></div>
    <div class="slist">${tested.map(rowHtml).join('') || '<div class="empty" style="padding:24px">还没有任何做题记录</div>'}</div>

    ${untested.length ? `
      <div class="sec-title" style="margin-top:22px"><h2>还没碰过的</h2><span>${untested.length} 个领域</span></div>
      <div class="slist dim">${untested.map(rowHtml).join('')}</div>` : ''}

    <div style="margin-top:32px;padding-top:16px;border-top:1px solid #1b2431">
      <button class="btn" data-reset style="border-color:#4d5b6f;color:var(--txt)">清空这台设备上的所有进度</button>
      <span style="font-size:12px;color:var(--txt3);margin-left:10px">清空后没有撤销键，建议先点顶栏「导出」备份</span>
    </div>
  `;
}

/* =======================================================================
 *  易错点：跨技能的错因网
 * ======================================================================= */
function questionsOfPit(pitId){
  // 只收显式挂了这个坑的题。按技能映射收「这一课的所有题」是错的 ——
  // 点「端点能不能取」会带出 s3 那道纯列举的集合题，跟坑没关系。
  const out = [];
  Object.entries(QUIZ).forEach(([sid, arr]) => arr.forEach((q, i) => {
    if ((q.pit || []).includes(pitId)) out.push({ sid, i, q });
  }));
  return out;
}

function renderPits(){
  const main = document.getElementById('main');
  const rows = PIT.map(p => {
    const qs = questionsOfPit(p.id);
    const rec = (state.pitDone && state.pitDone[p.id]) || {};
    const passed = qs.filter(x => rec[pitQuestionKey(x.sid, x.i)]).length;
    const mastered = qs.length > 0 && passed === qs.length;
    return `<div class="pit-card ${mastered ? 'done' : ''}" data-pit="${p.id}" tabindex="0" role="button">
      <div class="pit-h">${mastered ? '✓ ' : ''}${p.name}<span class="pit-n">${mastered ? '已过' : `${passed} / ${qs.length} 道`}</span></div>
      <div class="pit-d">${p.desc}</div>
      <div class="pit-s">会在这几课踩到：${p.skills.map(s => byId[s] ? byId[s].n : s).join('、')}</div>
    </div>`;
  }).join('');
  main.innerHTML = `
    <div class="crumbs"><a data-go="home">领域总览</a> / <span>易错点</span></div>
    <div class="sec-title">
      <h2>易错点</h2>
      <span>${PIT.length} 个坑 · 每个坑横跨好几课，点一个只练这个坑</span>
    </div>
    <div class="hint-line">这些不是知识点，是「你又会错在这儿」的地方。
      同一课做对不代表这个坑填上了——换个技能，同样的错还会犯。</div>
    <div class="pit-list">${rows}</div>`;
}

function renderPitDetail(pitId){
  const main = document.getElementById('main');
  const p = PIT_BY_ID[pitId];
  if (!p){ state.pitId = null; return renderPits(); }
  const qs = questionsOfPit(pitId);
  const rec = (state.pitDone && state.pitDone[pitId]) || {};
  const passed = qs.filter(x => rec[pitQuestionKey(x.sid, x.i)]).length;
  const rows = qs.map(x => {
    const s = byId[x.sid];
    const ok = !!rec[pitQuestionKey(x.sid, x.i)];
    const txt = x.q.q.length > 56 ? x.q.q.slice(0, 56) + '…' : x.q.q;
    return `<div class="rank-row ${ok ? 'pit-ok' : ''}" data-pit-q="${x.sid}:${x.i}" tabindex="0" role="button">
      <span class="rank-badge" style="${ok
        ? 'background:var(--ok-bg);color:var(--ok-text);border:1px solid var(--ok-line)'
        : 'background:#16202c;color:#8fa8c4;border:1px solid #253345'};white-space:nowrap">${ok ? '✓' : '练'}</span>
      <span class="qres">${txt}</span>
      <span class="dom" style="color:#6a819c">${s.n}</span>
    </div>`;
  }).join('');
  main.innerHTML = `
    <div class="crumbs"><a data-go="home">领域总览</a> / <a data-go="pit">易错点</a> / <span>${p.name}</span></div>
    <div class="sec-title">
      <h2>${p.name}</h2>
      <span>${passed} / ${qs.length} 道做过并答对 · 涉及 ${p.skills.length} 课</span>
    </div>
    <div class="hint-line">${p.desc}</div>
    <div class="sec-title" style="margin-top:22px"><h2>只练这个坑</h2><span>点一道单练，答对会记下来，练完回到这一页</span></div>
    <div class="slist">${rows}</div>
    <div style="margin-top:20px"><button class="btn" data-go="pit">← 回易错点列表</button></div>`;
}

function renderAbout(){
  document.getElementById('main').innerHTML = `
    <div class="crumbs"><a href="#home" data-go="home">领域总览</a> / <span>关于</span></div>
    <div class="sec-title"><h2 id="about-heading" tabindex="-1">关于数学技能树</h2><span>${SKILLS.length} 课 · ${DOMAINS.length} 个领域 · ${quizCount()} 道练习题</span></div>
    <div class="about-copy">
      <p>给广东 3+证书（高职高考）的同学用：先知道该学哪一课，再做几道题看看自己会没会。这里的题都是<strong>自编练习，不是历年原卷</strong>；解析着重讲容易错在哪，不是官方评分标准。</p>
      <p>数据截至 2026 年 11 月，按 2027 届（2027 年 1 月考试）整理。考纲或题型如果变了，记得对照当年要求。</p>
      <h3>考情和分值从哪来</h3>
      <p>卷面结构参考 2021 版《数学科考试说明》（2021 年起不再公布新考纲）；命题依据是《中等职业学校数学课程标准（2020 年版）》。</p>
      <p><strong>有逐题统计的：</strong>函数、指数与对数、概率与统计，参考《精准备考全程复习方略·数学》的考情分析。概率只拿到 2023～2026 年的数据。</p>
      <p><strong>还在估算的：</strong>三角、数列、解析几何、向量、集合、不等式、预备知识的分值，参考 2014～2024 年各板块平均分值和近年真题评述，只用来排复习顺序。标「存疑」的地方没有用原卷核实，别当成结论。<a href="https://github.com/woxiao498/cs-math-skill-tree#数据来源">查看详细来源</a>。</p>
      <p>复数部分参考 2025、2026 年真题评述，以及杨宏英《职教高考数学试题之变的思考与启示》（《广东教育》2025 年第 4 期）。</p>
      <h3>视频和学习进度</h3>
      <p>视频来自 B 站公开内容，版权归各 UP 主。进度只存在这台设备的浏览器里，换设备用「更多」里的导出和导入。</p>
    </div>`;
}

/* =======================================================================
 *  渲染总入口
 * ======================================================================= */
function renderMain(){
  // 搜索优先：不然做题途中搜东西，主区一动不动（以前就是这个毛病）
  if (state.query.trim()) { renderSearch(); return; }
  if (state.view === 'quiz') return renderQuiz();
  if (state.view === 'mock') return renderMock();
  if (state.view === 'pit') return state.pitId ? renderPitDetail(state.pitId) : renderPits();
  if (state.view === 'domain') return renderDomain(state.domainId);
  if (state.view === 'rank') return renderRank();
  if (state.view === 'plan') return renderPlan();
  if (state.view === 'wrong') return renderWrong();
  if (state.view === 'papers') return renderPapers();
  if (state.view === 'paper') return renderPaper();
  if (state.view === 'stats') return renderStats();
  if (state.view === 'about') return renderAbout();
  return renderHome();
}
function render(){
  if (sweepLitByScore()) save();
  syncNav();
  // 右栏只有"选中了某个技能"才有意义。首页/排行/数据/错题/真题/卷子都不需要它，
  // 白占 392px 把主区压扁（地图尤其吃亏）。
  const showPanel = !!state.selected && state.view !== 'quiz' && state.view !== 'paper' && state.view !== 'mock';
  document.body.classList.toggle('no-panel', !showPanel);
  if (!state.selected) document.body.classList.remove('panel-open');
  document.body.classList.toggle('quiz-mode', state.view === 'quiz');
  document.body.classList.toggle('paper-mode', state.view === 'paper');
  renderMain();
  renderPanel();
  renderProgress();
  syncHash();
  renderWrongBadge();
}

/* 顶栏当前页高亮。进哪页都长一样的话，用户只能靠面包屑那行 12px 灰字定位。 */
function syncNav(){
  const map = { home: 'home', domain: 'home', rank: 'rank', wrong: 'wrong',
                papers: 'papers', paper: 'papers', stats: 'stats', plan: 'plan' };
  const cur = state.query.trim() ? '' : (map[state.view] || '');
  document.querySelectorAll('[data-nav]').forEach(b => {
    b.classList.toggle('on', b.dataset.nav === cur);
  });
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
    else if (state.view === 'pit') h = '#pit';
    else if (state.view === 'about') h = '#about';
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
    if (go.tagName === 'A' && go.hasAttribute('href')){
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
    }
    goTo(go.dataset.go);
    return;
  }
  const play = e.target.closest('[data-play]');
  if (play){ playVideo(play.dataset.play, play.dataset.page, play.dataset.slot); return; }

  const gs = e.target.closest('[data-goto-skill]');
  if (gs){ goSkill(gs.dataset.gotoSkill); return; }

  // 只重做错的那题：对的成绩保留，做完这道直接重新结算。
  // 注意要排在 data-review 前面 —— 按钮在整行里，整行的监听会先吃掉点击。
  const rw = e.target.closest('[data-redo-wrong]');
  if (rw && state.quiz){
    const idx = +rw.dataset.redoWrong;
    state.quiz.i = idx;
    state.quiz.answers[idx] = null;
    state.quiz.done = false;
    state.quiz.redoOne = true;
    render();
    return;
  }

  // 结算页点一行错题，展开解析
  const wr = e.target.closest('[data-review]');
  if (wr){ wr.classList.toggle('open'); return; }

  /* ---------- 模拟考 ---------- */
  if (e.target.closest('[data-mock-start]')){ startMock(e.target.closest('[data-mock-start]').dataset.mockStart); return; }
  if (e.target.closest('[data-mock-exit]')){ quitMock(); return; }
  if (e.target.closest('[data-mock-submit]')){
    if (!state.mock) return;
    const m = state.mock;
    const left = m.ans.filter(a => a !== null).length;
    const unanswered = m.paper.choice.length - left;
    if (unanswered > 0 && !confirm(`还有 ${unanswered} 道选择题没答，确定交卷？`)) return;
    finishMock(); return;
  }
  const mo = e.target.closest('[data-mock-opt]');
  if (mo && state.mock){
    const [i, oi] = mo.dataset.mockOpt.split(':').map(Number);
    state.mock.ans[i] = oi;
    render();
    return;
  }
  const mf = e.target.closest('[data-mock-fill]');
  if (mf && state.mock){
    const [i, v] = mf.dataset.mockFill.split(':').map(Number);
    state.mock.fillSelf[i] = v === 1;
    render();
    return;
  }
  const ms = e.target.closest('[data-mock-solve]');
  if (ms && state.mock){
    const [i, v] = ms.dataset.mockSolve.split(':').map(Number);
    state.mock.solveSelf[i] = v === 1;
    render();
    return;
  }

  // 搜索结果：点技能跳过去，点题目单练；填空/解答题没得单练，直接把答案弹出来
  const sq = e.target.closest('[data-search-q]');
  if (sq){
    const [sid, i] = sq.dataset.searchQ.split(':');
    startSolo(sid, +i);
    return;
  }
  const pq2 = e.target.closest('[data-paper-q]');
  if (pq2){
    const [kind, idx] = pq2.dataset.paperQ.split(':');
    const arr = kind === 'fill' ? PAPER_FILL : PAPER_SOLVE;
    const qq = arr[+idx];
    if (qq) alert(`${unescHtml(qq.q)}\n\n答案：${unescHtml(qq.a)}\n\n${unescHtml(qq.why)}${qq.steps ? '\n\n给分点：' + unescHtml(qq.steps) : ''}`);
    return;
  }

  // 答错时那句「踩的是哪个坑」点进来的
  const gp = e.target.closest('[data-goto-pit]');
  if (gp){
    state.quiz = null;
    state.pitId = gp.dataset.gotoPit;
    state.view = 'pit';
    state.query = '';
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }

  // 易错点：点一个坑进去，点一道题单练
  const pc = e.target.closest('[data-pit]');
  if (pc){
    state.pitId = pc.dataset.pit;
    state.view = 'pit';
    state.query = '';
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  const pq3 = e.target.closest('[data-pit-q]');
  if (pq3){
    const [sid, i] = pq3.dataset.pitQ.split(':');
    startSolo(sid, +i, state.pitId);   // 带上坑的上下文，练完回坑页
    return;
  }

  // 目标的三个出口：取消、完成、换下一个
  if (e.target.closest('[data-goal-clear]')){
    state.goal = null;
    save(); render();
    return;
  }
  if (e.target.closest('[data-goal-next]')){
    state.goal = null;
    state.view = 'rank';
    save(); render();
    return;
  }

  const dv = e.target.closest('[data-domain-view]');
  if (dv){ state.domainView = dv.dataset.domainView === 'list' ? 'list' : 'map'; save(); render(); return; }

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
  if (e.target.closest('[data-quiz-next]')){
    // 单题订正完：直接重新结算（答对的成绩保留，不用整课重来）
    if (state.quiz && state.quiz.redoOne){
      state.quiz.redoOne = false;
      state.quiz.done = true;
      finishQuiz();
      return;
    }
    nextQuestion();
    return;
  }
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
    state.unlitSet = new Set();
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
  if (view !== 'pit') state.pitId = null;   // 进易错点先看列表
  // 从菜单点「真题 → 生成练习卷」进的是普通卷；错题卷走自己的按钮
  if (view === 'paper') { state.paperMode = 'normal'; paperCache = null; }
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function quitQuiz(){
  const z = state.quiz;
  const solo = z && z.solo;
  const sid = z && z.sid;
  const pit = z && z.pitContext;
  state.quiz = null;
  // 从易错点进来的，练完回那个坑，别甩回错题本 —— 不然想接着练第二道得重新点三层
  if (pit){ state.view = 'pit'; state.pitId = pit; render(); return; }
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

/* 模拟考的填空/解答输入：只记状态，不重绘。
 * 以前 textarea 没有回填，学生写完点「写对了」/选项就会清空。 */
document.getElementById('main').addEventListener('input', e => {
  const t = e.target.closest('[data-mock-text]');
  if (!t || !state.mock) return;
  const [kind, i] = t.dataset.mockText.split(':');
  if (kind === 'fill') state.mock.fillText[+i] = t.value;
  else if (kind === 'solve') state.mock.solveText[+i] = t.value;
});

document.getElementById('panel').addEventListener('click', e => {
  if (e.target.closest('[data-goal-clear]')){
    state.goal = null;
    save(); render();
    return;
  }
  const gs = e.target.closest('[data-goto-skill]');
  if (gs){ goSkill(gs.dataset.gotoSkill); return; }
  if (e.target.closest('[data-close-panel]')){
    state.selected = null;
    document.body.classList.remove('panel-open');
    render();
    return;
  }
  const play = e.target.closest('[data-play]');
  if (play){ playVideo(play.dataset.play, play.dataset.page, play.dataset.slot); return; }

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
  // 窄屏详情是底部抽屉，直接滑出来即可，不用再把页面滚到底（那样会滑过两千多像素）
  if (window.innerWidth <= 1080) document.body.classList.add('panel-open');
  render();
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

/* tabindex 的卡片用 Enter 也能触发（原生只有 button / a 会自己响应） */
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const t = e.target;
  if (!t || !t.getAttribute || t.getAttribute('tabindex') !== '0') return;
  if (t.tagName === 'BUTTON' || t.tagName === 'A') return;
  e.preventDefault();
  t.click();
});

/* 分享给同学：手机上走系统分享，桌面复制链接 */
document.getElementById('btn-pits').onclick = () => {
  document.getElementById('more-wrap').classList.remove('open');
  goTo('pit');
};
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
    v: 3,
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
  const wrongArr = (d.wrong || []).filter(sameQuestion);
  const prog = d.progress || {};
  const stats = d.stats || {};
  // 过滤掉 null / 非对象，畸形文件不该把页面打崩
  for (const k of Object.keys(prog)) { if (!prog[k] || typeof prog[k] !== 'object') delete prog[k]; }
  for (const k of Object.keys(stats)) { if (!stats[k] || typeof stats[k] !== 'object') delete stats[k]; }

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
      if (!byId[k] || !QUIZ[k]) return;
      const n = QUIZ[k].length;
      const cur = state.progress[k] || { tries: 0, best: 0, n: 0 };
      // 只合并「按当前题量考出来」的成绩，题量对不上的不算数。
      // bestRight 必须一起合，否则会出现「这台点亮了、换设备不亮」。
      const rightOf = o => (o.bestRight != null) ? o.bestRight : Math.round((o.best || 0) * n);
      const fileOk = v.n === n, mineOk = cur.n === n;
      state.progress[k] = {
        tries: (cur.tries || 0) + (v.tries || 0),
        best: Math.max(fileOk ? (v.best || 0) : 0, mineOk ? (cur.best || 0) : 0),
        bestRight: Math.max(fileOk ? rightOf(v) : 0, mineOk ? rightOf(cur) : 0),
        n
      };
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
  if (p.has('q')){                       // ?q=拆项 直接看搜索结果
    state.query = p.get('q');
    const inp = document.getElementById('search');
    if (inp) inp.value = state.query;
  }
  if (p.has('paperKey')) state.paperKey = true;
  if (p.get('paperMode') === 'wrong') state.paperMode = 'wrong';
  // ?panelOpen=1 让窄屏抽屉直接弹出来，方便截图核对
  if (p.has('panelOpen')) setTimeout(() => document.body.classList.add('panel-open'), 80);
  if (p.has('more')) setTimeout(() => document.getElementById('more-wrap').classList.add('open'), 80);
  if (p.has('mock')) setTimeout(() => startMock(p.get('mock') === 'basic' ? 'basic' : 'full'), 120);
  // ?demoStats=1 —— 造点做题记录，方便看数据页
  if (p.has('demoStats')){
    // p1 是「点亮了但只有 67%」的场景：它不该出现在「最该补」里
    const demo = { s3: [3, 3], i3: [2, 3], t9: [1, 3], g8: [2, 2], r6: [1, 2], q2: [2, 2], p1: [2, 3] };
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
      state.wrong.push({ sid, qi: +qi, rev: QUIZ[sid][+qi].rev || 0, stage: 0, due: Date.now() - 1000, ts: Date.now() });
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

/* 顶栏「更多」下拉：分享/导出/导入/显示可跳过 一个月用一次，不该和错题本平级 */
(function(){
  const wrap = document.getElementById('more-wrap');
  const btn = document.getElementById('btn-more');
  if (!wrap || !btn) return;
  btn.addEventListener('click', e => {
    e.stopPropagation();
    wrap.classList.toggle('open');
  });
  document.addEventListener('click', e => {
    if (!wrap.contains(e.target)) wrap.classList.remove('open');
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') wrap.classList.remove('open');
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
  if (h === 'paper') { state.view = 'paper'; return; }
  if (h === 'stats') { state.view = 'stats'; return; }
  if (h === 'pit') { state.view = 'pit'; return; }
  if (h === 'about') { state.view = 'about'; return; }
})();

document.getElementById('exam-line').textContent =
  `${EXAM.total} 分 · ${EXAM.minutes} 分钟 · 15 选择 + 5 填空 + 4 解答`;
document.getElementById('foot-about').addEventListener('click', e => {
  if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  if ((state.view === 'quiz' && state.quiz && !state.quiz.done) ||
      (state.view === 'mock' && state.mock && !state.mock.done)){
    // 做题中看关于，另开一页，不丢作答。
    window.open(e.currentTarget.href, '_blank', 'noopener');
    return;
  }
  goTo('about');
  document.getElementById('about-heading').focus({ preventScroll: true });
});

render();
