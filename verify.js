/* 数据自检：改完 data.js / soft-pre.js 跑一遍
 *   node verify.js
 * 检查：id 唯一、前置存在、无环、步数可算、题型合法、软前置归属
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const dir = __dirname;
const ctx = vm.createContext({ console });
for (const f of ['data.js', 'soft-pre.js']) {
  vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f });
}
vm.runInContext('globalThis.__D = { EXAM, DOMAINS, SKILLS, SOFT_PRE }', ctx);
const { EXAM, DOMAINS, SKILLS, SOFT_PRE } = ctx.__D;

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

// 8. 前置的步数必须严格小于自身（否则"步"不是拓扑序）
for (const s of SKILLS) {
  for (const p of hardPre(s.id)) {
    if (memo[p] >= memo[s.id]) fail(`${s.id} 的硬前置 ${p} 步数 ${memo[p]} 不小于自身 ${memo[s.id]}`);
  }
}

// ---------- 报告 ----------
const lvCount = { A: 0, B: 0, C: 0, D: 0 };
SKILLS.forEach(s => lvCount[s.lv]++);
const maxStep = Math.max(...SKILLS.map(s => memo[s.id]));
const steps = {};
SKILLS.forEach(s => { steps[memo[s.id]] = (steps[memo[s.id]] || 0) + 1; });

console.log('数据自检');
console.log(`  技能 ${SKILLS.length} 个 · 领域 ${DOMAINS.length} 个 · 知识点 ${SKILLS.reduce((a, s) => a + s.pts.length, 0)} 条`);
console.log(`  重要度  A ${lvCount.A} · B ${lvCount.B} · C ${lvCount.C} · D ${lvCount.D}`);
console.log(`  最长前置链 ${maxStep} 步，分布 ${JSON.stringify(steps)}`);
console.log(`  卷面 ${EXAM.total} 分 / ${EXAM.minutes} 分钟`);
console.log('  各领域：');
for (const d of DOMAINS) {
  const ds = SKILLS.filter(s => s.d === d.id);
  const ext = new Set();
  ds.forEach(s => (s.pre || []).forEach(p => { if (byId[p].d !== d.id) ext.add(p); }));
  console.log(`    ${String(ds.length).padStart(2)} 个 · ${d.short}\t${d.lv}  ${d.score}\t外部前置 ${ext.size}`);
}
console.log('  可跳过（D 级）：' + SKILLS.filter(s => s.lv === 'D').map(s => s.n).join(' / '));
console.log(bad ? `\n✗ 有 ${bad} 处问题` : '\n✓ 全部通过');
process.exit(bad ? 1 : 0);
