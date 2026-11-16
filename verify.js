/* 数据自检：改完 data.js / soft-pre.js / quiz.js / videos.js 跑一遍
 *   node verify.js
 * 检查：id 唯一、前置存在、无环、步数可算、题型合法、题库格式、视频引用
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const dir = __dirname;
const ctx = vm.createContext({ console });
for (const f of ['data.js', 'soft-pre.js', 'quiz.js', 'videos.js']) {
  vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f });
}
vm.runInContext('globalThis.__D = { EXAM, DOMAINS, SKILLS, SOFT_PRE, QUIZ, VIDEO_INFO, DOMAIN_VIDEO, SKILL_VIDEO, PAPERS }', ctx);
const { EXAM, DOMAINS, SKILLS, SOFT_PRE, QUIZ, VIDEO_INFO, DOMAIN_VIDEO, SKILL_VIDEO, PAPERS } = ctx.__D;

let bad = 0;
const fail = (m) => { console.error('  ✗ ' + m); bad++; };

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
    if (typeof q.a !== 'number' || q.a < 0 || q.a > 3) fail(`${tag} 答案索引 ${q.a} 越界`);
    if (!q.why || q.why.length < 8) fail(`${tag} 解析太短或缺失`);
  });
}

// 10. 视频引用必须都指向 VIDEO_INFO 里存在的条目
const checkBv = (bv, where) => {
  if (!VIDEO_INFO[bv]) fail(`${where} 引用了 VIDEO_INFO 里没有的 ${bv}`);
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
