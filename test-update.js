/* 本轮回归：node test-update.js（只用 Node 内置库；浏览器交互另测） */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const nodes = new Map();
const document = {
  body: { classList: { add(){}, remove(){}, toggle(){} } },
  getElementById(id){
    if (!nodes.has(id)) nodes.set(id, { innerHTML: '', textContent: '', style: {}, addEventListener(){}, focus(){} });
    return nodes.get(id);
  },
  querySelectorAll(){ return []; },
  addEventListener(){}
};
const storage = new Map([['gd-math-skill-tree-v2', JSON.stringify({
  lit: ['p2', 'p3', 'p5', 'f1'],
  wrong: [{ sid: 'f1', qi: 0 }, { sid: 'f1', qi: 2 }, { sid: 'f2', qi: 3, rev: 1 }],
  pitDone: { 'sqrt-domain': { 'f1:0': true, 'f1:2': true } }
})]]);
const ctx = vm.createContext({
  assert, document, window: { innerWidth: 1400, addEventListener(){} },
  location: { search: '', hash: '#about' },
  localStorage: { getItem: k => storage.get(k), setItem: (k,v) => storage.set(k,v) }
});
for (const file of ['data.js', 'soft-pre.js', 'videos.js', 'quiz.js', 'pits.js', 'app.js']){
  vm.runInContext(fs.readFileSync(path.join(__dirname,file),'utf8'),ctx,{ filename: file });
}
vm.runInContext(`
  assert.equal(state.view, 'about');
  assert.match(document.getElementById('main').innerHTML, /有逐题统计的：[\\s\\S]*还在估算的：/);
  assert.equal(state.lit.has('f1'), true);
  assert.deepEqual(state.wrong.map(w => w.sid + ':' + w.qi), ['f1:0', 'f2:3']);
  assert.equal(pitQuestionKey('f1', 0), 'f1:0');
  assert.equal(pitQuestionKey('f1', 2), 'f1:2:v1');
  renderPitDetail('sqrt-domain');
  assert.match(document.getElementById('main').innerHTML, /1 \\/ [0-9]+ 道做过并答对/);
  applyImport({ wrong: [{ sid: 'f1', qi: 2 }, { sid: 'f2', qi: 4, rev: 1 }] }, false);
  assert.deepEqual(state.wrong.map(w => w.sid + ':' + w.qi), ['f1:0', 'f2:3', 'f2:4']);
  state.mock = {
    done: true, paper: { choice: [{ sid: 'f1', i: 2, q: QUIZ.f1[2] }], fill: [{}, {}], solve: [{pts:12}, {pts:14}] },
    ans: [QUIZ.f1[2].a], fillSelf: [true, null], solveSelf: [false, true]
  };
  assert.deepEqual(mockScore(), { pts:24, rightChoice:1, choicePts:5, fillPts:5, solvePts:14 });
  renderMock();
  const main = document.getElementById('main');
  assert.match(main.innerHTML, /本次估分/);
  assert.match(main.innerHTML, /没写出来的步骤不算/);
  assert.doesNotMatch(main.innerHTML, /及格线/);
  state.mock = { done:true, basic:true, paper:{choice:state.mock.paper.choice,fill:[],solve:[]},ans:state.mock.ans,fillSelf:[],solveSelf:[] };
  renderMock();
  assert.match(main.innerHTML, /地基卷结果/);
  assert.doesNotMatch(main.innerHTML, /本次估分|mk-est-note/);
`, ctx);
console.log('✓ 关于页直达、换题记录兼容、整卷估分与地基卷回归通过');
