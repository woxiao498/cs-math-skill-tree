/* 数据自检：改完 data.js / soft-pre.js / quiz.js / videos.js 跑一遍
 *   node verify.js
 * 检查：id 唯一、前置存在、无环、步数可算、题型合法、题库格式、视频引用
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const dir = __dirname;
const ctx = vm.createContext({ console });
for (const f of ['data.js', 'soft-pre.js', 'quiz.js', 'videos.js', 'pits.js']) {
  vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f });
}
vm.runInContext('globalThis.__D = { EXAM, DOMAINS, SKILLS, SOFT_PRE, QUIZ, VIDEO_INFO, VIDEO_SRC, VIDEO_PAGE, DOMAIN_VIDEO, SKILL_VIDEO, PAPERS, PIT }', ctx);
const { EXAM, DOMAINS, SKILLS, SOFT_PRE, QUIZ, VIDEO_INFO, VIDEO_SRC, VIDEO_PAGE, DOMAIN_VIDEO, SKILL_VIDEO, PAPERS, PIT } = ctx.__D;

let bad = 0;
const fail = (m) => { console.error('  ✗ ' + m); bad++; };
const warn = (m) => { console.warn('  ! ' + m); };

// 1. id 唯一
const seen = new Map();
for (const s of SKILLS) {
  if (seen.has(s.id)) fail(`重复 id: ${s.id}`);
  seen.set(s.id, s);
}
const byId = Object.fromEntries(SKILLS.map(s => [s.id, s]));

// 2. 前置指向存在
for (const s of SKILLS) {
  for (const p of (s.pre || [])) {
    if (!byId[p]) fail(`${s.id} 的前置 ${p} 不存在`);
    if (p === s.id) fail(`${s.id} 把自己当前置`);
  }
}

// 3. 领域合法
for (const s of SKILLS) {
  if (!DOMAINS.some(d => d.id === s.d)) fail(`${s.id} 的领域 ${s.d} 不存在`);
}

// 4. 软前置必须真的在 pre 里
for (const [child, arr] of Object.entries(SOFT_PRE)) {
  if (!byId[child]) { fail(`SOFT_PRE 里的 ${child} 不是有效技能`); continue; }
  for (const p of arr) {
    if (!(byId[child].pre || []).includes(p)) fail(`SOFT_PRE: ${child} 标了 ${p} 为软前置，但它不在 pre 里`);
  }
}

// 5. 题型合法
const QT = ['选择', '填空', '解答'];
for (const s of SKILLS) {
  for (const q of (s.q || [])) if (!QT.includes(q)) fail(`${s.id} 题型 "${q}" 不合法`);
}

// 6. 必填字段
for (const s of SKILLS) {
  for (const f of ['n', 'd', 'lv', 'how', 'pts']) {
    if (s[f] === undefined) fail(`${s.id} 缺字段 ${f}`);
  }
  if (!['A', 'B', 'C', 'D'].includes(s.lv)) fail(`${s.id} 的 lv=${s.lv} 不合法`);
  if (!Array.isArray(s.pts) || s.pts.length === 0) fail(`${s.id} 没有知识点`);
}

// 7. 无环 + 最长前置链
const softOf = id => SOFT_PRE[id] || [];
const hardPre = id => (byId[id].pre || []).filter(p => !softOf(id).includes(p));
const memo = {};
const stack = new Set();
function step(id) {
  if (memo[id]) return memo[id];
  if (stack.has(id)) { fail(`检测到环: ${id}`); return 1; }
  stack.add(id);
  const h = hardPre(id);
  const v = h.length ? 1 + Math.max(...h.map(step)) : 1;
  stack.delete(id);
  return memo[id] = v;
}
SKILLS.forEach(s => step(s.id));

// 8. 前置的步数必须严格小于自身
for (const s of SKILLS) {
  for (const p of hardPre(s.id)) {
    if (memo[p] >= memo[s.id]) fail(`${s.id} 的硬前置 ${p} 步数 ${memo[p]} 不小于自身 ${memo[s.id]}`);
  }
}

// 9. 题库
let qTotal = 0;
const covered = new Set();
for (const [k, arr] of Object.entries(QUIZ)) {
  if (!byId[k]) { fail(`题库里的 ${k} 不是有效技能`); continue; }
  covered.add(k);
  if (!Array.isArray(arr) || !arr.length) { fail(`${k} 空题组`); continue; }
  arr.forEach((q, i) => {
    qTotal++;
    const tag = `${k}[${i}]`;
    if (!q.q) fail(`${tag} 缺题干`);
    if (!Array.isArray(q.o) || q.o.length !== 4) fail(`${tag} 选项不是 4 个`);
    if (new Set(q.o).size !== 4) fail(`${tag} 选项有重复`);
    if (q.a !== 0) fail(`${tag} 正确选项必须写在第一个（a: 0）`);
    if (q.rev != null && (!Number.isInteger(q.rev) || q.rev < 1)) fail(`${tag} 换题版本 rev 必须是正整数`);
    if (!q.why || q.why.length < 8) fail(`${tag} 解析太短或缺失`);
  });
}

// 10. 视频引用必须都指向 VIDEO_INFO 里存在的条目
const checkBv = (ref, where) => {
  if (typeof ref === 'string' && ref.includes('#')){
    const [sid, page] = ref.split('#');
    if (!VIDEO_SRC[sid]) fail(`${where} 引用了不存在的视频源 ${sid}`);
    else if (!VIDEO_PAGE[ref]) fail(`${where} 引用了不存在的分P ${ref}`);
    return;
  }
  if (!VIDEO_INFO[ref]) fail(`${where} 引用了 VIDEO_INFO 里没有的 ${ref}`);
};
Object.entries(SKILL_VIDEO).forEach(([sid, arr]) => {
  if (!byId[sid]) fail(`SKILL_VIDEO 里的 ${sid} 不是有效技能`);
  arr.forEach(bv => checkBv(bv, `SKILL_VIDEO['${sid}']`));
});
Object.entries(DOMAIN_VIDEO).forEach(([did, arr]) => {
  if (!DOMAINS.some(d => d.id === did)) fail(`DOMAIN_VIDEO 里的 ${did} 不是有效领域`);
  arr.forEach(bv => checkBv(bv, `DOMAIN_VIDEO['${did}']`));
});
PAPERS.forEach(p => checkBv(p.bv, `PAPERS ${p.year}`));

// 11. D 级是「可跳过」，不该配题、也不该挂题型标签
for (const s of SKILLS){
  if (s.lv !== 'D') continue;
  if (QUIZ[s.id]) fail(`${s.id}（${s.n}）是 D 级可跳过，却配了题`);
  if ((s.q || []).length) fail(`${s.id}（${s.n}）是 D 级，q 里却还写着 ${s.q.join('/')}`);
}

// 12. A 级至少 5 题 —— 只有 5 题时「答对 4 题」才等于 80%
for (const s of SKILLS){
  if (s.lv !== 'A') continue;
  const n = (QUIZ[s.id] || []).length;
  if (n < 5) fail(`${s.id}（${s.n}）是 A 级，只有 ${n} 题，不足 5 题则 80% 等于全对`);
}

// 13. 每个非 D 技能至少要能取到一条视频（技能级没有就得有领域兜底）
for (const s of SKILLS){
  if (s.lv === 'D') continue;
  if (!(SKILL_VIDEO[s.id] || DOMAIN_VIDEO[s.d])) fail(`${s.id}（${s.n}）取不到任何视频`);
}

// 14. 题干的「按上题」这种依赖，单练时会没头没尾
for (const [k, arr] of Object.entries(QUIZ)){
  arr.forEach((q, i) => {
    if (/^按上题/.test(q.q) || /按上题/.test(q.q)) fail(`${k}[${i}] 题干依赖「上题」，错题单练和组卷时会没头没尾`);
  });
}

// 15. 易错点表（pits.js）
if (typeof PIT !== 'undefined'){
  const pitIds = new Set(PIT.map(p => p.id));
  PIT.forEach(p => {
    if (!p.skills || !p.skills.length) fail(`易错点 ${p.id} 没映射到任何技能`);
    p.skills.forEach(id => { if (!byId[id]) fail(`易错点 ${p.id} 引用了不存在的技能 ${id}`); });
    if (new Set(p.skills).size !== p.skills.length) fail(`易错点 ${p.id} 的 skills 有重复`);
  });
  // 每题挂的 pit 必须存在
  for (const [k, arr] of Object.entries(QUIZ)){
    arr.forEach((q, i) => {
      (q.pit || []).forEach(id => {
        if (!pitIds.has(id)) fail(`${k}[${i}] 挂了不存在的易错点 ${id}`);
      });
    });
  }
  // 每个坑至少要有 2 道「显式挂了它」的题 —— 一道只能算见过，不算练过。
  const pitCount = {};
  PIT.forEach(p => { pitCount[p.id] = 0; });
  Object.values(QUIZ).forEach(arr => arr.forEach(q => (q.pit || []).forEach(id => {
    if (pitCount[id] != null) pitCount[id] += 1;
  })));
  const thin = PIT.filter(p => (pitCount[p.id] || 0) < 2).map(p => `${p.id}(${pitCount[p.id]||0})`);
  if (thin.length) fail(`这些易错点没挂够 2 道题：${thin.join(' ')}`);
  else console.log(`  易错点 ${PIT.length} 个，每个都有 ≥2 道专属题`);
}

// ---------- 报告 ----------
const lvCount = { A: 0, B: 0, C: 0, D: 0 };
SKILLS.forEach(s => lvCount[s.lv]++);
const maxStep = Math.max(...SKILLS.map(s => memo[s.id]));
const steps = {};
SKILLS.forEach(s => { steps[memo[s.id]] = (steps[memo[s.id]] || 0) + 1; });
const A = SKILLS.filter(s => s.lv === 'A');
const ANoQuiz = A.filter(s => !covered.has(s.id));

console.log('数据自检');
console.log(`  技能 ${SKILLS.length} 个 · 领域 ${DOMAINS.length} 个 · 知识点 ${SKILLS.reduce((a, s) => a + s.pts.length, 0)} 条`);
console.log(`  重要度  A ${lvCount.A} · B ${lvCount.B} · C ${lvCount.C} · D ${lvCount.D}`);
console.log(`  最长前置链 ${maxStep} 步，分布 ${JSON.stringify(steps)}`);
console.log(`  题库 ${Object.keys(QUIZ).length} 个技能 / ${qTotal} 道题（A 级 ${A.length} 个，缺题 ${ANoQuiz.length} 个）`);
console.log(`  视频 ${Object.keys(VIDEO_INFO).length} 个条目 · 技能级映射 ${Object.keys(SKILL_VIDEO).length} 个 · 真题讲解 ${PAPERS.length} 年`);
console.log(bad ? `\n✗ 有 ${bad} 处问题` : '\n✓ 全部通过');
process.exit(bad ? 1 : 0);
