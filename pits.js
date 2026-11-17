/* =============================================================
 *  易错点（pit）：跨技能的错因网
 *
 *  为什么单独一张表：像「区间端点能不能取」这种错，
 *  出现在 i2 一元二次不等式、s3 集合运算、i7 分式不等式、f1 求定义域
 *  四个地方，它不属于其中任何一个技能，挂进某一课的题组里就被淹没了。
 *
 *  一个坑 = 一个学生能说出口的错因，不是知识点。
 *  判定标准：学生做错了，能不能指着这一条说「我又是这儿错」。
 *
 *  skills 字段是「这个坑会在哪些课里踩到」，不是「哪些课属于它」。
 * ============================================================= */
const PIT = [
  { id: 'interval', name: '端点能不能取', skills: ['i2', 's3', 'i7', 'f1'],
    desc: '分子为 0 能取，分母为 0 不能取；大于号取不到、大于等于取得到。' },
  { id: 'set-ops', name: '∩ 和 ∪ 记反', skills: ['s1', 's3'],
    desc: '交集是「两边都有」，并集是「合起来」。符号看着像 U 就是合并。' },
  { id: 'denom-zero', name: '分母不能为 0', skills: ['i7', 'p1', 'f1'],
    desc: '化简时约掉的那个因式，只要它可能为 0，就得单独拿出来讨论。' },
  { id: 'sqrt-domain', name: '偶次根号里要 ≥ 0', skills: ['f1', 'e1'],
    desc: '√x 要求 x ≥ 0。求定义域时最容易漏的就是这一条。' },
  { id: 'log-domain', name: '对数的真数 > 0、底数 > 0 且 ≠ 1', skills: ['e5', 'f1'],
    desc: 'log_a N 里 N 必须 > 0，a 必须 > 0 且不等于 1。三个条件缺一个定义域就错。' },
  { id: 'ellipse-c', name: 'c² 是减还是加', skills: ['g12', 'g14'],
    desc: '椭圆 c² = a² − b²，双曲线 c² = a² + b²。记住「椭圆是收着的所以减」。' },
  { id: 'trig-sign', name: '诱导公式的符号看象限', skills: ['t5', 't6'],
    desc: '口诀「奇变偶不变，符号看象限」——先把 α 当锐角，看原角在第几象限，再定正负。' },
  { id: 'sine-ambiguous', name: '正弦定理可能有两个解', skills: ['t11'],
    desc: 'sinB = 1/2 时 B 可能是 30° 也可能是 150°，要检查两角相加会不会超过 180°。' },
  { id: 'seq-index', name: 'd 只加 n−1 次', skills: ['q3', 'q9'],
    desc: 'aₙ = a₁ + (n−1)d。第 10 项只比第 1 项多 9 个 d，不是 10 个。' },
  { id: 'an-sn', name: 'aₙ = Sₙ − Sₙ₋₁ 只在 n ≥ 2 成立', skills: ['q10'],
    desc: '求 a₁ 要单独用 S₁。直接把 S₃ 当 a₃ 是最常见的错。' },
  { id: 'geo-series-q1', name: '等比求和要先看 q 等不等于 1', skills: ['q7'],
    desc: 'q = 1 时求和公式的分母是 0，得单独算 Sₙ = n·a₁。' },
  { id: 'quad-endpoint', name: '闭区间最值要代端点', skills: ['f5', 'f6'],
    desc: '顶点在区间内才取顶点，在区间外就比两个端点。别只算顶点。' },
  { id: 'shift-dir', name: '左右平移的方向', skills: ['f8'],
    desc: '左加右减：括号里是 x+3 是往左移 3。想让它取到原来的值需要更小的 x。' },
  { id: 'intercept', name: '截距是坐标，不是距离', skills: ['g2'],
    desc: '截距可以为负。求 x 轴截距就是令 y = 0 解出 x，别取绝对值。' },
  { id: 'circle-general', name: '圆的一般式配方漏常数项', skills: ['g7'],
    desc: 'x² + y² + Dx + Ey + F = 0 配方时，两边要同时加上 (D/2)² + (E/2)²，F 也要移过去。' },
  { id: 'circle-dist', name: '两圆位置用 d 和 r₁±r₂ 比', skills: ['g9'],
    desc: '先算圆心距 d：d > r₁+r₂ 外离，= 外切，|r₁−r₂| < d < r₁+r₂ 相交，= |r₁−r₂| 内切，< 内含。' },
  { id: 'chord-formula', name: '弦长公式别忘乘 √(1+k²)', skills: ['g17'],
    desc: '|AB| = √(1+k²)·|x₁−x₂|。算完 |x₁−x₂| 忘了乘这一项，是最常见的丢分。' },
  { id: 'delta-open', name: 'Δ 和开口方向要一起看', skills: ['i3', 'g8'],
    desc: 'Δ > 0 只说明有两个根，能不能解出不等式还得看开口朝上还是朝下。' },
  { id: 'without-replacement', name: '「不放回」会改变分母', skills: ['r4', 'r6'],
    desc: '取走一个之后，总数少了一个。不放回抽两次，分母是 n 然后 n−1。' },
  { id: 'variance-n', name: '方差除以 n', skills: ['r10'],
    desc: '方差 = 各数与平均数差的平方和 ÷ n。样本方差才除以 n−1，中职考的是除以 n。' },

  { id: 'vector-parallel', name: '平行和垂直的坐标条件记混', skills: ['v5', 'v7'],
    desc: '平行是 x₁y₂ − x₂y₁ = 0（交叉相乘相等），垂直是 x₁x₂ + y₁y₂ = 0（点积为零）。' },
  { id: 'double-angle', name: '和角公式中间是减号', skills: ['t7'],
    desc: 'cos(α+β) = cosαcosβ − sinαsinβ，加号对应减号。sin 那边才是同号。' },
  { id: 'div-conjugate', name: '复数除法要乘共轭', skills: ['c3'],
    desc: '(a+bi) ÷ (c+di) 要把分子分母同乘 (c−di)，让分母变成实数 c²+d²。' },
  { id: 'ellipse-axis', name: '焦点在哪个轴看分母大小', skills: ['g11', 'g12'],
    desc: 'x² 下面分母大就在 x 轴。不是看 x 和 y 谁在前面，也不是看 a、b 谁写第一。' },
  { id: 'compare-exp-log', name: '底数指数都不同，用 0 和 1 卡', skills: ['e6'],
    desc: '2^0.3、0.3²、log₂0.3 这种，先判断每个数在 0 的哪边、1 的哪边，再排序。' }
];

const PIT_BY_ID = Object.fromEntries(PIT.map(p => [p.id, p]));
