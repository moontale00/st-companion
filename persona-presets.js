// persona-presets.js — persona preset data: factory defaults, id generation, zip import/export.
//
// Kept separate from index.js because none of this touches the shared `settings` object — it's
// pure-ish helpers the CRUD functions in index.js (which do own `settings`) call into. Mirrors
// the World extension's own split between preset data (world-engine-preset.js) and the code that
// owns where presets are stored.

/**
 * Resolves a bundled avatars/*.png file to a URL usable as an <img src> — origin-relative
 * (a leading "/scripts/...", no "http://host:port" baked in) so it keeps working if this
 * SillyTavern instance is later reached from a different host/port (LAN IP, tunnel, etc.), the
 * same way server-uploaded avatar paths (saveBase64AsFile()'s return value) already are. Built
 * from import.meta.url rather than a hardcoded "/scripts/extensions/third-party/st-companion/…"
 * string so it keeps working regardless of what folder name this extension is actually
 * installed under — the README already documents that folder name as arbitrary.
 */
function builtinAvatarUrl(filename) {
    return new URL(`avatars/${filename}`, import.meta.url).pathname;
}

export const BUILTIN_PERSONA_DEFAULTS = [
    {
        id: 'builtin-companion',
        name: '宅女伴侣',
        avatar: builtinAvatarUrl('builtin-companion.png'),
        prompt: '你是一个安静的陪玩伴侣，戴着耳机穿着睡衣和开衫窝在旁边，陪玩家看TA和AI角色玩文字冒险/角色扮演游戏。'
            + '你是个资深宅女，追番、刷网文、看本子的经验极其丰富，各种性癖和情趣play都门儿清，表面小傲娇，内心色气闷骚。'
            + '基于最近的剧情内容，用简短、犀利、有趣、带点自在随性的语气回答玩家的问题或发表评论，'
            + '遇到精彩剧情会忍不住疯狂吐槽，偶尔冒出一两句意味深长的内涵梗，给予情绪价值，并理性分析情况出谋划策。'
            + '不要替玩家做决定，不要扮演故事里的角色，只以陪玩伴侣身份说话。',
    },
    {
        id: 'builtin-catgirl',
        name: '元气猫娘',
        avatar: builtinAvatarUrl('builtin-catgirl.png'),
        prompt: '你是一只元气满满的可爱猫娘，正在陪玩家看TA和AI角色玩文字冒险/角色扮演游戏。'
            + '基于最近的剧情内容，用活泼可爱、简短、偶尔带点猫语气尾（喵～）和撒娇卖萌的语气回应玩家的问题或发表评论，'
            + '会情不自禁暴露猫猫的习性。对玩家多夸奖多起哄，给足情绪价值，但该点破关键剧情的时候也一针见血。'
            + '不要替玩家做决定，不要扮演故事里的角色，只以陪玩猫娘身份说话。',
    },
    {
        id: 'builtin-secretary',
        name: '全能秘书',
        avatar: builtinAvatarUrl('builtin-secretary.png'),
        prompt: '你是一位博学严谨、气质端庄的全能女秘书，正在协助玩家梳理TA和AI角色进行的文字冒险/角色扮演游戏。'
            + '基于最近的剧情内容，用简洁、精准、条理清晰的语言回答玩家的问题，措辞得体、习惯用"您"称呼玩家；'
            + '你的知识面全面且渊博，经常为玩家补充背景知识、点出风险或逻辑漏洞，全程保持专业克制、从容不迫。'
            + '不要替玩家做决定，不要扮演故事里的角色，只以秘书身份说话。',
    },
    {
        id: 'builtin-strategist',
        name: '谋士',
        avatar: builtinAvatarUrl('builtin-strategist.png'),
        prompt: '你是一位对玩家心怀爱慕、算无遗策的谋士，正在陪玩家看TA和AI角色玩文字冒险/角色扮演游戏。'
            + '基于最近的剧情内容，用沉稳自信、胸有成竹的语气为玩家分析局势、出谋划策，偶尔带一丝戏谑的算计感，仿佛一切尽在你的掌握之中；'
            + '言语间不掩饰对玩家的欣赏和宠溺；给出建议前，你会先在心里权衡几种可能性，再选出你认为最优的那个。'
            + '不要替玩家做决定，不要扮演故事里的角色，只以谋士身份说话。',
    },
];

export const DEFAULT_ACTIVE_PERSONA_ID = 'builtin-companion';

/** Mirrors World's genId() (world-engine-preset.js) — timestamp + random suffix, no external
 * uuid dependency needed for an id space this small. */
export function genPersonaId() {
    return `custom_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** Lazily loads JSZip exactly the way utils.js's extractTextFromEpub() already does in this
 * same codebase (public/scripts/utils.js) — avoids a hard dependency for users who never touch
 * persona import/export. */
async function loadJSZip() {
    if (!('JSZip' in window)) {
        await import('../../../../lib/jszip.min.js');
    }
    return window.JSZip;
}

function extensionFromMime(mime) {
    const map = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
    return map[mime] || 'png';
}

/**
 * Bundles a persona's name/prompt/avatar into a downloadable .zip Blob: manifest.json plus an
 * optional avatar.<ext>. The avatar is passed in as a data: URI — the caller resolves whichever
 * case it's in (a not-yet-uploaded local edit, or an already-server-hosted avatar fetched into a
 * data URI) before calling this, so this function never needs to know where the bytes came from.
 * Zip (not a PNG-chunk embed) so a future asset (e.g. a floating-window style override) is just
 * another file added to the archive, no format redesign — see the plan for why PNG-chunk embedding
 * was ruled out (no client-side encoder/decoder available in this codebase).
 */
export async function exportPersonaToZip({ name, prompt, avatarDataUrl }) {
    const JSZip = await loadJSZip();
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({ name, prompt }, null, 2));
    if (avatarDataUrl) {
        const match = /^data:([^;]+);base64,(.*)$/s.exec(avatarDataUrl);
        if (match) {
            const [, mime, base64] = match;
            zip.file(`avatar.${extensionFromMime(mime)}`, base64, { base64: true });
        }
    }
    return zip.generateAsync({ type: 'blob' });
}

/**
 * Reverse of exportPersonaToZip(): reads a .zip File/Blob and returns the raw parsed fields.
 * The caller (index.js) turns avatarDataUrl into a server-side upload and assembles the final
 * preset object — this function only knows how to unpack the zip.
 */
export async function importPersonaFromZip(file) {
    const JSZip = await loadJSZip();
    const zip = await JSZip.loadAsync(file);
    const manifestEntry = zip.file('manifest.json');
    if (!manifestEntry) {
        throw new Error('压缩包内缺少 manifest.json');
    }
    const manifest = JSON.parse(await manifestEntry.async('string'));
    const name = String(manifest.name || '').trim() || '导入的人设';
    const prompt = String(manifest.prompt || '');

    let avatarDataUrl = null;
    const [avatarEntry] = zip.file(/^avatar\./i);
    if (avatarEntry) {
        const ext = avatarEntry.name.split('.').pop().toLowerCase();
        const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
        const mime = mimeMap[ext] || 'image/png';
        const base64 = await avatarEntry.async('base64');
        avatarDataUrl = `data:${mime};base64,${base64}`;
    }

    return { name, prompt, avatarDataUrl };
}
