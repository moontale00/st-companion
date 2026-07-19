// 离线断言：跟随 World 插件 docs/*-test.js 的惯例（node docs/log-and-resize-logic-test.js）
// 复刻自 index.js 里本次新增/修复的几段纯逻辑，不依赖浏览器/jQuery UI，用来在浏览器工具不可靠时
// 仍能快速回归这些逻辑本身（jQuery UI resizable 的真实拖拽行为不在本文件覆盖范围，那部分只能在真实浏览器里验证）。

const assert = require('assert');

// ───────── persistLogEntry 的 merge + 裁剪逻辑（复刻自 index.js persistLogEntry）─────────
const MAX_LOG_ENTRIES = 50;
function mergeAndCap(existingNs, question, answer) {
    const ns = existingNs && typeof existingNs === 'object' ? existingNs : { v: 1, log: [] };
    ns.v = 1;
    if (!Array.isArray(ns.log)) {
        ns.log = [];
    }
    ns.log.push({ q: question, a: answer, ts: Date.now() });
    if (ns.log.length > MAX_LOG_ENTRIES) {
        ns.log.splice(0, ns.log.length - MAX_LOG_ENTRIES);
    }
    return ns;
}

{
    // L1 首次写入：从空创建 namespace
    const ns = mergeAndCap(undefined, 'q1', 'a1');
    assert.strictEqual(ns.v, 1, 'L1 v=1');
    assert.strictEqual(ns.log.length, 1, 'L1 log长度=1');
    assert.deepStrictEqual([ns.log[0].q, ns.log[0].a], ['q1', 'a1'], 'L1 内容正确');
    console.log('✓ L1 首次写入从空创建 namespace');
}
{
    // L2 追加到已有 namespace，不覆盖旧条目
    let ns = { v: 1, log: [{ q: 'old_q', a: 'old_a', ts: 1 }] };
    ns = mergeAndCap(ns, 'new_q', 'new_a');
    assert.strictEqual(ns.log.length, 2, 'L2 log长度=2');
    assert.strictEqual(ns.log[0].q, 'old_q', 'L2 旧条目保留在前');
    assert.strictEqual(ns.log[1].q, 'new_q', 'L2 新条目追加在后');
    console.log('✓ L2 追加不覆盖旧条目');
}
{
    // L3 超过 MAX_LOG_ENTRIES(50) 时从最旧的开始裁剪
    let ns = { v: 1, log: Array.from({ length: 50 }, (_, i) => ({ q: `q${i}`, a: `a${i}`, ts: i })) };
    ns = mergeAndCap(ns, 'q_new', 'a_new');
    assert.strictEqual(ns.log.length, 50, 'L3 裁剪后仍是50条');
    assert.strictEqual(ns.log[0].q, 'q1', 'L3 最旧的 q0 被裁掉，q1 变成最旧');
    assert.strictEqual(ns.log[49].q, 'q_new', 'L3 新条目在最后');
    console.log('✓ L3 超过上限时裁掉最旧的条目');
}
{
    // L4 畸形数据兜底：log 字段不是数组时视为空数组重建（不崩溃）
    const ns = mergeAndCap({ v: 1, log: 'not-an-array' }, 'q', 'a');
    assert.ok(Array.isArray(ns.log), 'L4 log 被重建为数组');
    assert.strictEqual(ns.log.length, 1, 'L4 只包含新写入的这一条');
    console.log('✓ L4 畸形 log 字段兜底为数组');
}

// ───────── appendLogEntry 的 chatId 过期保护（复刻自 index.js appendLogEntry）─────────
function shouldDropStaleAnswer(expectedChatId, currentChatId) {
    return expectedChatId !== undefined && currentChatId !== expectedChatId;
}
{
    // A1 发送时和回答落地时聊天没变 → 不丢弃
    assert.strictEqual(shouldDropStaleAnswer('chatA', 'chatA'), false, 'A1 聊天未变不丢弃');
    console.log('✓ A1 聊天未变时正常写入');
}
{
    // A2 发送时和回答落地时聊天变了（用户在等回答时切换了聊天）→ 丢弃
    assert.strictEqual(shouldDropStaleAnswer('chatA', 'chatB'), true, 'A2 聊天已变丢弃');
    console.log('✓ A2 生成期间聊天被切换 → 丢弃过期回答（本次修的 bug）');
}
{
    // A3 未传 expectedChatId（如未来别的调用点）→ 视为不检查，不丢弃
    assert.strictEqual(shouldDropStaleAnswer(undefined, 'chatB'), false, 'A3 未传参不检查');
    console.log('✓ A3 未提供 expectedChatId 时不做过期检查');
}

// ───────── clampSize（复刻自 index.js clampSize）─────────
function clampSize(width, height, innerWidth, innerHeight) {
    return {
        width: Math.min(width, Math.round(innerWidth * 0.9)),
        height: Math.min(height, Math.round(innerHeight * 0.8)),
    };
}
{
    // C1 保存的尺寸小于视口限制 → 原样返回
    const r = clampSize(400, 300, 1920, 1080);
    assert.deepStrictEqual(r, { width: 400, height: 300 }, 'C1 未超限不裁剪');
    console.log('✓ C1 未超出视口限制时原样返回');
}
{
    // C2 保存的尺寸在小屏幕上超限 → 裁剪到视口的 90%/80%
    const r = clampSize(1200, 900, 800, 600);
    assert.deepStrictEqual(r, { width: 720, height: 480 }, 'C2 裁剪到90%/80%');
    console.log('✓ C2 大屏幕存的尺寸在小屏幕上被裁剪');
}

// ───────── makeResizable 的 min/max 冲突保护（复刻自 index.js makeResizable）─────────
function resolveMaxConstraint(minPx, innerPx, fraction) {
    return Math.max(minPx, Math.round(innerPx * fraction));
}
{
    // R1 正常宽视口 → maxWidth 由视口的90%决定，大于 minWidth
    assert.strictEqual(resolveMaxConstraint(260, 1280, 0.9), 1152, 'R1 正常视口用90%');
    console.log('✓ R1 正常视口宽度下 maxWidth 由视口决定');
}
{
    // R2 极窄视口（<289px）→ 90% 会小于 minWidth(260)，必须仍返回 >= minWidth，否则 jQuery UI 拿到自相矛盾的约束
    const maxW = resolveMaxConstraint(260, 250, 0.9); // 250*0.9=225 < 260
    assert.ok(maxW >= 260, 'R2 极窄视口下 maxWidth 不能小于 minWidth（本次修的 bug）');
    assert.strictEqual(maxW, 260, 'R2 具体应等于 minWidth 本身');
    console.log('✓ R2 极窄视口下 maxWidth 不再小于 minWidth');
}

console.log('\n全部断言通过 ✅（L4 merge/裁剪 + A3 过期回答保护 + C2 尺寸裁剪 + R2 极窄视口保护）');
