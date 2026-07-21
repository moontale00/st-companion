import { eventSource, event_types, generateRaw, saveSettings, saveSettingsDebounced } from '../../../../script.js';
import { getContext, extension_settings } from '../../../extensions.js';
import { power_user } from '../../../power-user.js';
import { selected_world_info, checkWorldInfo } from '../../../world-info.js';
import { debounce, copyText, download } from '../../../utils.js';
import { debounce_timeout } from '../../../constants.js';

const MODULE_NAME = 'companionChat';
const PANEL_ID = 'companionChatPanel';

const defaultSettings = {
    enabled: true,
    // 'sillytavern' = 走 generateRaw()/酒馆已配置的主API；'custom' = 走下面 customApi* 配置的独立端点。
    apiMode: 'sillytavern',
    customApiUrl: '',
    customApiKey: '',
    customApiModel: '',
    turnsToShow: 2,
    companionTurnsToShow: 10,
    worldInfoEnabled: false,
    worldInfoEntryTitle: '',
    // 数据库（shujuku/ACU 脚本）整合：记忆召回 + 非纪要类小表格批量注入，见 getShujuku* 系列函数。
    shujukuEnabled: false,
    shujukuPrefix: 'TavernDB-ACU-',
    // 与 shujuku 无关的通用兜底：用玩家最近一条输入跑一次 ST 自己的世界书关键词匹配。默认关闭——
    // checkWorldInfo() 哪怕 isDryRun=true 也会无条件 emit WORLDINFO_SCAN_DONE（world-info.js），
    // 而 shujuku 所在的 JS-Slash-Runner 运行时本身会监听这个事件，默认开启会让所有现有用户在没
    // 主动选择的情况下开始触发这个事件，风险自担，所以改成需要用户自己打开。
    autoWorldInfoEnabled: false,
    systemPrompt: '你是一个安静的陪玩伴侣，正在看玩家和AI角色玩文字冒险/角色扮演游戏。'
        + '基于最近的剧情内容，用简短、犀利、有趣的视角回答玩家的问题或发表评论。'
        + '不要替玩家做决定，不要扮演故事里的角色，只以陪玩伴侣身份说话。',
    // null = 使用 CSS 默认位置；拖拽后写入具体像素值，完全独立于 ST 的 movingUIState。
    panelTop: null,
    panelLeft: null,
    // null = 使用 CSS 默认尺寸；调整大小后写入具体像素值。
    panelWidth: null,
    panelHeight: null,
    // null = 使用 CSS 默认位置（右下角悬浮球）；拖拽后写入具体像素值。
    toggleBtnTop: null,
    toggleBtnLeft: null,
};

/** @type {Record<string, any>} */
let settings;
let panelEl = null;
let isSending = false;
// Only non-null while a custom-API fetch is actually in flight — the AbortController lives in
// callCustomApi() itself (see fetchWithTimeout()'s controller param) so onStopClick() can abort
// it directly. Never touches SillyTavern's own generation controller/streamingProcessor.
let activeAbortController = null;
// Per-call state for the in-flight send/reroll request, so onStopClick() can mark exactly this
// call as stopped without a shared boolean getting confused by a next call starting before this
// one's background promise settles (same "capture the moment, don't re-read a shared var later"
// idea as hasChatChanged(expectedChatId) below).
let activeRequestState = null;
// The exact text last sent to the AI (system + user prompt combined), for the "导出上次提示词"
// debug button — captured in generateAnswer(), the one place both pieces are known together.
let lastBuiltPrompt = null;

// Caches the last resolved lore entries so renderContextPreview() and buildPrompt() don't
// each re-scan world info on their own; invalidated on CHAT_CHANGED.
let loreCache = { title: null, enabled: null, promise: null };

function loadSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extension_settings[MODULE_NAME], key)) {
            extension_settings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    return extension_settings[MODULE_NAME];
}

function truncate(text, maxLen) {
    if (!text) {
        return '';
    }
    return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
}

const MAX_TURNS = 20;

/** Single source of truth for what counts as a valid turnsToShow value (matches the input's min/max). */
function normalizeTurns(value) {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n < 1) {
        return defaultSettings.turnsToShow;
    }
    return Math.min(MAX_TURNS, n);
}

function getRecentMessages() {
    const context = getContext();
    const n = normalizeTurns(settings.turnsToShow);
    return context.chat.slice(-n);
}

/** Same role as normalizeTurns() but for companionTurnsToShow — capped at MAX_LOG_ENTRIES
 * since the persisted log itself never holds more than that many entries anyway. */
function normalizeCompanionTurns(value) {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n < 1) {
        return defaultSettings.companionTurnsToShow;
    }
    return Math.min(MAX_LOG_ENTRIES, n);
}

/** The companion's own most recent Q&A entries — this is the primary context for
 * buildPrompt() (see its comment): the companion is a persona who remembers her own past
 * interactions with the player first, and only then looks at the main chat's recent plot. */
function getRecentCompanionHistory() {
    const log = getContext().chatMetadata?.companionChat?.log;
    if (!Array.isArray(log) || log.length === 0) {
        return [];
    }
    const n = normalizeCompanionTurns(settings.companionTurnsToShow);
    return log.slice(-n);
}

/**
 * Loads every entry from every world info book that could plausibly be active for the
 * current chat (chat-bound, character-bound, globally-enabled, persona-bound) — shared by
 * findWorldInfoEntries() and getShujukuTableEntries() so both filter over the same source
 * list instead of two book-resolution implementations drifting apart.
 */
async function collectActiveWorldInfoEntries() {
    const context = getContext();
    const worldNames = new Set();
    const chatWorld = context.chatMetadata?.world_info;
    const charWorld = context.characters?.[context.characterId]?.data?.extensions?.world;
    if (chatWorld) {
        worldNames.add(chatWorld);
    }
    if (charWorld) {
        worldNames.add(charWorld);
    }
    for (const name of selected_world_info) {
        if (name) {
            worldNames.add(name);
        }
    }
    if (power_user.persona_description_lorebook) {
        worldNames.add(power_user.persona_description_lorebook);
    }

    const worldNameList = [...worldNames];
    const results = await Promise.all(worldNameList.map(name => context.loadWorldInfo(name)));
    const entries = [];
    results.forEach((data, i) => {
        if (data?.entries) {
            // context.loadWorldInfo(name) returns raw per-book entries with no `world` field
            // (unlike ST core's getGlobalLore()/getCharacterLore()/etc., which tag it when
            // merging books for the real WI scan) — tag it ourselves so callers (the
            // blacklist UI, getWorldInfoEntryId()) can tell which book an entry came from
            // after this flattens them all into one array.
            for (const entry of Object.values(data.entries)) {
                entries.push(entry.world ? entry : { ...entry, world: worldNameList[i] });
            }
        }
    });
    return entries;
}

/** Stable identity for a world info entry across the blacklist UI and the three filters that
 * respect it — mirrors the World extension's own `${book}::${uid}` composite ID pattern. */
function getWorldInfoEntryId(entry) {
    return `${entry.world || '?'}::${entry.uid}`;
}

/** Entries the user has explicitly marked "never send to the companion" (see
 * saveWorldInfoBlacklist()), scoped per chat via chat_metadata — same storage grain as the
 * companion's own Q&A log (companionChat.log). */
function getWorldInfoBlacklist() {
    const ids = getContext().chatMetadata?.companionWorldInfoBlacklist;
    return new Set(Array.isArray(ids) ? ids : []);
}

/** @returns {boolean} whether it actually persisted — false (no chatId) must not be reported
 * to the user as a successful save. */
function saveWorldInfoBlacklist(ids) {
    const context = getContext();
    if (!context.chatId) {
        return false;
    }
    context.updateChatMetadata({ companionWorldInfoBlacklist: [...ids] });
    context.saveMetadataDebounced();
    // The 故事纪要 lookup caches its result independent of the blacklist, so a saved change
    // wouldn't be reflected until something else happened to invalidate it (e.g. CHAT_CHANGED).
    invalidateLoreCache();
    return true;
}

/** Shared by the three "fetch entries for the AI" functions below so the blacklist Set is
 * only ever spelled out once. */
function filterBlacklisted(entries) {
    const blacklist = getWorldInfoBlacklist();
    return entries.filter(entry => !blacklist.has(getWorldInfoEntryId(entry)));
}

/** All entries whose comment starts with titlePrefix. Fixed from the original .find()-based
 * lookup, which silently dropped every match after the first — e.g. shujuku/ACU exports
 * multiple "TavernDB-ACU-CustomExport-纪要-N" entries sharing one prefix. */
async function findWorldInfoEntries(titlePrefix) {
    if (!titlePrefix) {
        return [];
    }
    const entries = await collectActiveWorldInfoEntries();
    return filterBlacklisted(entries.filter(entry => entry.comment?.toLowerCase().startsWith(titlePrefix.toLowerCase())));
}

/** Bulk-includable shujuku/ACU "small table" entries (skills/items/character sheets etc.):
 * comment contains the configured database prefix but is NOT one of its per-turn summary/纪要
 * rows — those are handled by getShujukuRecallBlock() instead, via the AI's own
 * relevance-filtered recall, not a blind title match (dumping all 纪要-N rows here would
 * defeat that filtering and grow unbounded as a campaign progresses). */
/** Substring that marks a world info entry as one of shujuku's per-turn summary/纪要 rows —
 * shared by getShujukuTableEntries() and getPlayerTriggeredWorldInfoEntries() so "what counts
 * as a summary row" can't drift between the two places that filter on it. */
const SUMMARY_ENTRY_MARKER = '纪要';

async function getShujukuTableEntries(prefix) {
    if (!prefix) {
        return [];
    }
    const entries = await collectActiveWorldInfoEntries();
    const lowerPrefix = prefix.toLowerCase();
    return filterBlacklisted(entries.filter(entry => {
        const comment = entry.comment?.toLowerCase() || '';
        return comment.includes(lowerPrefix) && !comment.includes(SUMMARY_ENTRY_MARKER);
    }));
}

/** Joins entry contents the same way everywhere buildPrompt()/renderContextPreview() render a
 * list of world-info-style entries into one block of text. */
function formatEntryContents(entries) {
    return entries.map(entry => entry.content).join('\n\n');
}

/** Reads shujuku/ACU's most recently computed memory-recall result, if that script is
 * installed and has run at least once for this chat. Shujuku attaches its raw planning
 * output to whichever chat message triggered it, as `message.qrf_plot_tasks.defaultPlotTask`
 * (current field) or `message.qrf_plot` (legacy fallback) — both are plain properties on the
 * same live `chat` array getContext() exposes, not a JS-Slash-Runner "variable"; no
 * cross-extension API call is needed. Mirrors shujuku's own tag-extraction (find the last
 * closing tag, then the last opening tag before it). Never throws — silently returns null if
 * shujuku isn't installed or its output format changes, since this integration must degrade
 * to "as if not installed" per design. */
function extractLastTagBlock(text, tag) {
    if (!text) {
        return null;
    }
    const closeTag = `</${tag}>`;
    const openTag = `<${tag}>`;
    const closeIdx = text.lastIndexOf(closeTag);
    if (closeIdx === -1) {
        return null;
    }
    const openIdx = text.lastIndexOf(openTag, closeIdx);
    if (openIdx === -1) {
        return null;
    }
    const block = text.slice(openIdx + openTag.length, closeIdx).trim();
    return block || null;
}

function getShujukuRecallBlock() {
    try {
        const chat = getContext().chat;
        if (!Array.isArray(chat)) {
            return null;
        }
        // Keep walking backward past messages whose raw field doesn't actually contain
        // <recall>/<supplement> tags (e.g. a turn shujuku ran but found nothing relevant, or
        // wrote metadata-only output) — the newest message with *a* qrf_plot* field isn't
        // necessarily the newest one with a usable recall block.
        for (let i = chat.length - 1; i >= 0; i--) {
            const raw = chat[i]?.qrf_plot_tasks?.defaultPlotTask || chat[i]?.qrf_plot;
            if (!raw || typeof raw !== 'string') {
                continue;
            }
            const recall = extractLastTagBlock(raw, 'recall');
            const supplement = extractLastTagBlock(raw, 'supplement');
            if (recall || supplement) {
                return { recall, supplement };
            }
        }
    } catch (error) {
        console.warn('[STCompanion] shujuku recall read failed, skipping', error);
    }
    return null;
}

/** `getShujukuRecallBlock()` if the shujuku toggle is on, else null — shared by buildPrompt()
 * and renderContextPreview() so both compute "is there shujuku recall data to work with" the
 * same way. */
function getRecallDataIfEnabled() {
    return settings.shujukuEnabled ? getShujukuRecallBlock() : null;
}

/** How many AM#### codes appear in the extracted <recall> text — used to judge whether
 * this turn's shujuku recall looks healthy (see isRecallHealthy()). */
function countRecallAmCodes(recallText) {
    if (!recallText) {
        return 0;
    }
    return (recallText.match(/AM\d{4}/g) || []).length;
}

/** A recall is "healthy" when it's non-empty and not implausibly large (shujuku's own cap is
 * ~20 relevant entries per turn; anything past 25 suggests a parse/format mismatch, not a
 * real recall) — shared by buildPrompt() and renderContextPreview() so both agree on when
 * getPlayerTriggeredWorldInfoEntries() should exclude 纪要-titled entries. */
function isRecallHealthy(recallData) {
    const count = countRecallAmCodes(recallData?.recall);
    return count > 0 && count <= 25;
}

/**
 * General-purpose fallback, independent of shujuku: runs SillyTavern's own World Info
 * keyword-activation against the player's most recent real input, so the companion sees
 * whatever WI entries would normally trigger for this turn (character/location/item entries
 * with real keywords) — useful even without shujuku installed.
 *
 * Finds the nearest `is_user` message scanning backward through the last few turns; if none
 * is found (edge case), falls back to the last two messages combined, since in a normal
 * user/AI-alternating chat one of them always is the player's.
 *
 * Uses the lower-level checkWorldInfo() (not the getContext()-exposed getWorldInfoPrompt())
 * because only checkWorldInfo returns the raw activated entry objects (with `.comment`) —
 * getWorldInfoPrompt only returns pre-joined strings, which would make it impossible to
 * exclude 纪要 entries by title. isDryRun=true skips sticky/cooldown state writes.
 *
 * `excludeSummaryEntries` is passed by the caller based on whether this turn's shujuku
 * recall (getShujukuRecallBlock()) looked healthy — when it did, 纪要-titled entries are
 * dropped here to avoid duplicating that content; when the recall was empty/unhealthy, they
 * are kept so this fallback can still surface some summary content.
 */
async function getPlayerTriggeredWorldInfoEntries({ excludeSummaryEntries }) {
    try {
        const context = getContext();
        const chat = context.chat;
        if (!Array.isArray(chat) || chat.length === 0) {
            return [];
        }

        let scanText = null;
        for (let i = chat.length - 1; i >= Math.max(0, chat.length - 6); i--) {
            if (chat[i]?.is_user) {
                scanText = chat[i].mes;
                break;
            }
        }
        if (!scanText) {
            scanText = chat.slice(-2).map(m => m?.mes || '').join('\n');
        }
        if (!scanText?.trim()) {
            return [];
        }

        const activated = await checkWorldInfo([scanText], context.maxContext, true);
        // Entries from checkWorldInfo() already carry `.world` — ST core's own getGlobalLore()/
        // getCharacterLore()/etc. (which checkWorldInfo uses internally) tag it when merging
        // books, so no extra tagging is needed here the way collectActiveWorldInfoEntries() does.
        let entries = filterBlacklisted([...(activated?.allActivatedEntries ?? [])]);
        if (excludeSummaryEntries) {
            entries = entries.filter(entry => !entry.comment?.includes(SUMMARY_ENTRY_MARKER));
        }
        return entries;
    } catch (error) {
        console.warn('[STCompanion] world info activation failed, skipping', error);
        return [];
    }
}

function invalidateLoreCache() {
    loreCache = { title: null, enabled: null, promise: null };
}

/** Cached wrapper around findWorldInfoEntries, keyed on the current settings. */
function resolveLoreEntries() {
    const title = settings.worldInfoEntryTitle;
    const enabled = settings.worldInfoEnabled;
    if (!enabled || !title) {
        return Promise.resolve([]);
    }
    if (loreCache.title !== title || loreCache.enabled !== enabled || !loreCache.promise) {
        loreCache = { title, enabled, promise: findWorldInfoEntries(title) };
    }
    return loreCache.promise;
}

function renderRecentMessages() {
    if (!panelEl || !panelEl.is(':visible')) {
        return;
    }

    const container = panelEl.find('.companion_recent_messages');
    container.empty();
    const messages = getRecentMessages();

    if (messages.length === 0) {
        container.append('<div class="companion_recent_message">（还没有消息）</div>');
        return;
    }

    for (const msg of messages) {
        const row = $('<div class="companion_recent_message"></div>');
        row.append($('<span class="companion_msg_name"></span>').text(`${msg.name || '?'}:`));
        row.append($('<span class="companion_msg_text"></span>').text(truncate(msg.mes, 200)));
        container.append(row);
    }
}

/** Read-only debug preview of the three world-info-derived context sources — extended from
 * the original single-section renderLoreSection() to also cover the two new shujuku/auto-WI
 * sources, so the user can confirm each one is actually finding data from this same panel. */
async function renderContextPreview() {
    if (!panelEl || !panelEl.is(':visible')) {
        return;
    }

    const section = panelEl.find('.companion_lore_section');
    const content = panelEl.find('.companion_lore_content');
    if (!settings.worldInfoEnabled || !settings.worldInfoEntryTitle) {
        section.addClass('companion_hidden');
    } else {
        section.removeClass('companion_hidden');
        try {
            const entries = await resolveLoreEntries();
            content.text(entries.length > 0 ? formatEntryContents(entries) : '（未找到匹配的世界书条目）');
        } catch (error) {
            console.error('[STCompanion] failed to load world info', error);
            content.text('（读取世界书失败，详见控制台）');
        }
    }

    // Computed once and reused by both the shujuku and auto-WI sections below, instead of
    // each independently re-reading the chat array for the same value.
    const recallData = getRecallDataIfEnabled();

    const shujukuSection = panelEl.find('.companion_shujuku_section');
    const shujukuContent = panelEl.find('.companion_shujuku_content');
    if (!settings.shujukuEnabled) {
        shujukuSection.addClass('companion_hidden');
    } else {
        shujukuSection.removeClass('companion_hidden');
        try {
            const tableEntries = await getShujukuTableEntries(settings.shujukuPrefix);
            const parts = [];
            if (recallData?.recall) {
                parts.push(`【记忆召回】\n${recallData.recall}`);
            }
            if (recallData?.supplement) {
                parts.push(`【补充信息】\n${recallData.supplement}`);
            }
            if (tableEntries.length > 0) {
                parts.push(`【数据表】\n${formatEntryContents(tableEntries)}`);
            }
            shujukuContent.text(parts.length > 0 ? parts.join('\n\n') : '（未检测到数据库数据，可能未安装 shujuku 或本轮尚未召回）');
        } catch (error) {
            console.error('[STCompanion] failed to read shujuku data', error);
            shujukuContent.text('（读取数据库失败，详见控制台）');
        }
    }

    const autoWiSection = panelEl.find('.companion_auto_wi_section');
    const autoWiContent = panelEl.find('.companion_auto_wi_content');
    if (!settings.autoWorldInfoEnabled) {
        autoWiSection.addClass('companion_hidden');
    } else {
        autoWiSection.removeClass('companion_hidden');
        try {
            const entries = await getPlayerTriggeredWorldInfoEntries({ excludeSummaryEntries: isRecallHealthy(recallData) });
            autoWiContent.text(entries.length > 0 ? formatEntryContents(entries) : '（本轮无匹配）');
        } catch (error) {
            console.error('[STCompanion] failed to run auto world info', error);
            autoWiContent.text('（运行世界书匹配失败，详见控制台）');
        }
    }
}

/**
 * Ordered so the companion's own memory of the player comes first and outweighs the main
 * chat's plot: she's a persona who remembers her past interactions with the player before
 * she looks at what's currently happening in the story to react to it.
 */
async function buildPrompt(userQuestion) {
    const history = getRecentCompanionHistory();
    const historyText = history.length > 0
        ? history.map(item => `玩家: ${item.q}\n陪玩伴侣: ${item.a}`).join('\n\n')
        : '（暂无记录，这是你和玩家的第一次对话）';

    // Each of these three optional sections is independently guarded: a broken/unreachable
    // world info book (loadWorldInfo() rejecting) must not take down the whole answer,
    // including the companion's own history and the main chat's recent plot below.
    let loreBlock = '';
    try {
        const loreEntries = await resolveLoreEntries();
        if (loreEntries.length > 0) {
            loreBlock = `【故事纪要】\n${formatEntryContents(loreEntries)}\n\n`;
        }
    } catch (error) {
        console.warn('[STCompanion] failed to load lore entries, skipping', error);
    }

    const recallData = getRecallDataIfEnabled();
    let shujukuBlock = '';
    if (settings.shujukuEnabled) {
        try {
            const tableEntries = await getShujukuTableEntries(settings.shujukuPrefix);
            const parts = [];
            if (recallData?.recall) {
                parts.push(`【数据库记忆召回（本轮相关的过去剧情摘要）】\n${recallData.recall}`);
            }
            if (recallData?.supplement) {
                parts.push(`【数据库补充信息】\n${recallData.supplement}`);
            }
            if (tableEntries.length > 0) {
                parts.push(`【数据库数据表】\n${formatEntryContents(tableEntries)}`);
            }
            if (parts.length > 0) {
                shujukuBlock = `${parts.join('\n\n')}\n\n`;
            }
        } catch (error) {
            console.warn('[STCompanion] failed to load shujuku table entries, skipping', error);
        }
    }

    let autoWorldInfoBlock = '';
    if (settings.autoWorldInfoEnabled) {
        const triggeredEntries = await getPlayerTriggeredWorldInfoEntries({ excludeSummaryEntries: isRecallHealthy(recallData) });
        if (triggeredEntries.length > 0) {
            autoWorldInfoBlock = `【本轮触发的世界书设定】\n${formatEntryContents(triggeredEntries)}\n\n`;
        }
    }

    const messages = getRecentMessages();
    const chatText = messages.map(msg => `${msg.name || '?'}: ${msg.mes}`).join('\n') || '（暂无剧情）';

    return `【你和玩家的对话记录（最重要，这是你作为陪玩伴侣人设延续的依据）】\n${historyText}\n\n`
        + `${loreBlock}${shujukuBlock}${autoWorldInfoBlock}`
        + `【最近剧情（仅供参考，据此对当下情况做出反应）】\n${chatText}\n\n【玩家问陪玩伴侣】\n${userQuestion}`;
}

/** Pure DOM construction, shared by the live-append path (appendLogEntry) and the
 * chat-load rebuild path (loadLogFromChat) so the bubble markup only lives in one place. */
function renderLogEntry(question, answer) {
    const log = panelEl.find('.companion_log');
    log.find('.companion_log_empty').remove();

    const observerBubble = $('<div class="companion_bubble"></div>').text(answer);
    const copyBtn = $('<span class="companion_bubble_copy_btn" title="复制">📋</span>')
        .on('click', () => copyBubbleAnswer(answer, copyBtn));
    observerBubble.append(copyBtn);

    log.append(
        $('<div class="companion_bubble_row companion_bubble_user"></div>')
            .append($('<div class="companion_bubble"></div>').text(question)),
        $('<div class="companion_bubble_row companion_bubble_observer"></div>')
            .append(observerBubble),
    );
}

/** Reuses the flash-confirmation idiom already established by flushSettingsWithConfirm(). */
async function copyBubbleAnswer(answer, btnEl) {
    try {
        await copyText(answer);
        const original = btnEl.text();
        btnEl.text('✅');
        setTimeout(() => btnEl.text(original), 1200);
    } catch (error) {
        console.error('[STCompanion] copyText failed', error);
        toastr.error(error?.message || String(error), '复制失败');
    }
}

const MAX_LOG_ENTRIES = 50;

/** Fetches (or creates) the persisted companion log namespace for the current chat, applies
 * `mutate` to its `log` array, then writes it back via chat_metadata — this is "sync on chat
 * load", not real-time push: SillyTavern core has no live channel for chat_metadata changes
 * (confirmed: no websocket/poll in script.js), same last-write-wins model the World extension's
 * own chatcache uses. Shared by persistLogEntry/deleteLastLogEntry/replaceLastLogEntryAnswer so
 * all three log-mutating paths stay consistent instead of three copies of the same
 * fetch-or-create boilerplate drifting apart.
 * Always re-fetches context rather than caching chatMetadata: it's reassigned wholesale on
 * chat switch (script.js), so a cached reference would go stale. */
function mutatePersistedLog(mutate) {
    const context = getContext();
    if (!context.chatId) {
        return;
    }

    const existing = context.chatMetadata?.companionChat;
    const ns = existing && typeof existing === 'object' ? existing : { v: 1, log: [] };
    ns.v = 1;
    if (!Array.isArray(ns.log)) {
        ns.log = [];
    }
    mutate(ns.log);

    context.updateChatMetadata({ companionChat: ns });
    context.saveMetadataDebounced();
}

function getLastLogEntry() {
    const log = getContext().chatMetadata?.companionChat?.log;
    return Array.isArray(log) && log.length > 0 ? log[log.length - 1] : null;
}

/** Mirrors the Q&A pair into chat_metadata.companionChat so it survives reload and shows up on
 * another device the next time that device opens this same chat. */
function persistLogEntry(question, answer) {
    mutatePersistedLog(log => {
        log.push({ q: question, a: answer, ts: Date.now() });
        if (log.length > MAX_LOG_ENTRIES) {
            log.splice(0, log.length - MAX_LOG_ENTRIES);
        }
    });
}

function deleteLastLogEntry() {
    mutatePersistedLog(log => { log.pop(); });
}

/** `ts` is bumped to now — it's only ever used as a "most recent activity" ordering signal,
 * never displayed as an original ask time, so treating it as last-modified rather than
 * created-at is intentional. */
function replaceLastLogEntryAnswer(newAnswer) {
    mutatePersistedLog(log => {
        if (log.length > 0) {
            log[log.length - 1].a = newAnswer;
            log[log.length - 1].ts = Date.now();
        }
    });
}

/**
 * `expectedChatId` guards against the chat having changed while `generateRaw` was
 * in flight (onSendClick awaits it before calling this): without it, an answer
 * built from the *old* chat's context could get rendered into and persisted onto
 * the *new* chat's log after the user switches chats mid-generation.
 */
/** Shared by appendLogEntry/onRerollLastClick to detect the chat having changed while an
 * awaited generation was in flight. */
function hasChatChanged(expectedChatId) {
    return getContext().chatId !== expectedChatId;
}

function appendLogEntry(question, answer, expectedChatId) {
    if (expectedChatId !== undefined && hasChatChanged(expectedChatId)) {
        console.warn('[STCompanion] chat changed mid-generation, dropping stale answer');
        return;
    }
    renderLogEntry(question, answer);
    const log = panelEl.find('.companion_log');
    log.scrollTop(log[0].scrollHeight);
    persistLogEntry(question, answer);
    updateLogActionState();
}

/** Rebuilds the Q&A log from chat_metadata.companionChat — called when the panel is created,
 * on every CHAT_CHANGED, and after a reroll/delete (onRerollLastClick/onDeleteLastClick), so
 * the visible log always matches persisted state instead of drifting from it. */
function loadLogFromChat() {
    if (!panelEl) {
        return;
    }

    const log = panelEl.find('.companion_log');
    log.empty();

    const context = getContext();
    const entries = context.chatMetadata?.companionChat?.log;
    if (!Array.isArray(entries) || entries.length === 0) {
        log.append('<div class="companion_log_empty">问问陪玩伴侣，看看TA怎么说…</div>');
    } else {
        for (const entry of entries) {
            renderLogEntry(entry.q, entry.a);
        }
        log.scrollTop(log[0].scrollHeight);
    }
    updateLogActionState();
}

const CUSTOM_API_TIMEOUT_MS = 60000;

/**
 * Ports World's normalizeUrl()/getProxyBase() (world-engine-api.js) — only append
 * /chat/completions if the user hasn't already typed it, no automatic /v1 insertion
 * (that broke non-standard version prefixes like /api/v3 for World's users).
 */
function normalizeCustomApiUrl(url) {
    const trimmed = String(url || '').trim().replace(/\/+$/, '');
    if (!trimmed) {
        return '';
    }
    return trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}/chat/completions`;
}

function getCustomApiBaseUrl(url) {
    return normalizeCustomApiUrl(url).replace(/\/chat\/completions$/, '');
}

/** Fixed internal safety net (not user-configurable, per explicit request to keep the
 * settings UI minimal) so a hung custom endpoint can't leave "思考中…" stuck forever —
 * onSendClick's existing `finally` already unconditionally resets the send button once
 * this rejects.
 * Takes an optional externally-owned controller (callCustomApi passes one it registers as
 * activeAbortController, so the stop button can cancel this specific request) — callers that
 * don't care about cancellation (fetchCustomApiModels) just omit it and get a private one. */
async function fetchWithTimeout(url, options, controller = new AbortController()) {
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, CUSTOM_API_TIMEOUT_MS);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
        if (timedOut) {
            throw new Error(`请求超时（${CUSTOM_API_TIMEOUT_MS / 1000}s 无响应）`);
        }
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

/** Shared response handling for both callCustomApi() and fetchCustomApiModels() —
 * mirrors World's error-shape handling (world-engine-api.js) so failures surface a
 * readable message instead of a raw parse exception. */
async function readCustomApiJson(response) {
    const text = await response.text();
    let data = {};
    let parseError = null;
    try {
        data = text ? JSON.parse(text) : {};
    } catch (error) {
        parseError = error;
    }
    // Check the HTTP status before the parse result: a non-2xx response is often an
    // HTML error page or plain-text body (wrong URL, gateway error, etc.), and reporting
    // "not valid JSON" for that would hide the actually useful status/detail.
    if (!response.ok) {
        const detail = data?.error?.message || (text ? text.slice(0, 500) : response.statusText);
        throw new Error(`HTTP ${response.status}: ${detail}`);
    }
    if (parseError) {
        throw new Error(`API 返回不是有效 JSON：${parseError.message}`);
    }
    return data;
}

function requireCustomApiUrl() {
    if (!settings.customApiUrl?.trim()) {
        throw new Error('未配置 API URL');
    }
}

/**
 * Calls the user-configured custom OpenAI-compatible endpoint instead of ST's main
 * API. Same (prompt, systemPrompt) => Promise<string> shape as generateRaw() so
 * onSendClick can swap between them with one ternary.
 */
async function callCustomApi(prompt, systemPrompt) {
    requireCustomApiUrl();
    const messages = [];
    if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const body = { model: settings.customApiModel || 'gpt-3.5-turbo', messages, stream: false };
    // Registered as activeAbortController so onStopClick() can cancel exactly this request —
    // this fetch only ever talks to the user's own configured endpoint, never SillyTavern core,
    // so aborting it has zero effect on the tavern's own generation.
    const controller = new AbortController();
    activeAbortController = controller;
    try {
        const response = await fetchWithTimeout(normalizeCustomApiUrl(settings.customApiUrl), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(settings.customApiKey ? { Authorization: `Bearer ${settings.customApiKey}` } : {}),
            },
            body: JSON.stringify(body),
        }, controller);

        const data = await readCustomApiJson(response);
        const choice = data.choices?.[0];
        if (!choice) {
            throw new Error('API 返回缺少 choices[0]');
        }
        return choice.message?.content || '';
    } finally {
        if (activeAbortController === controller) {
            activeAbortController = null;
        }
    }
}

/** Ports World's fetchModelList() (world-engine-api.js) for the "获取列表" button. */
async function fetchCustomApiModels() {
    requireCustomApiUrl();
    const response = await fetchWithTimeout(`${getCustomApiBaseUrl(settings.customApiUrl)}/models`, {
        method: 'GET',
        headers: settings.customApiKey ? { Authorization: `Bearer ${settings.customApiKey}` } : {},
    });

    const data = await readCustomApiJson(response);
    return (data.data || []).map(m => m.id).filter(Boolean);
}

/** Recomputes the reroll/delete buttons' disabled state — disabled whenever a generation
 * is in flight or there's no log entry yet for them to act on. */
function updateLogActionState() {
    if (!panelEl) {
        return;
    }
    const disabled = isSending || !getLastLogEntry();
    panelEl.find('.companion_reroll_btn, .companion_delete_last_btn').toggleClass('companion_action_disabled', disabled);
}

/** Reflects the current `isSending` flag onto the send button and the reroll/delete buttons,
 * since reroll shares the same lock (only one companion-panel generation at a time). While
 * sending, the button stays enabled and turns into a round stop icon (see .companion_send_btn_stop
 * in style.css) instead of being disabled, so the user can click it to cancel. */
function setBusyUI() {
    if (!panelEl) {
        return;
    }
    panelEl.find('.companion_send_btn')
        .prop('disabled', false)
        .toggleClass('companion_send_btn_stop', isSending)
        .attr('title', isSending ? '停止' : '')
        .text(isSending ? '' : '发送');
    updateLogActionState();
}

/** Shared by onSendClick/onRerollLastClick: builds the prompt for `question` and routes it to
 * whichever provider `settings.apiMode` currently selects. */
async function generateAnswer(question) {
    const prompt = await buildPrompt(question);
    lastBuiltPrompt = `===== System Prompt =====\n${settings.systemPrompt}\n\n===== User Prompt =====\n${prompt}`;
    return settings.apiMode === 'custom'
        ? await callCustomApi(prompt, settings.systemPrompt)
        : await generateRaw({ prompt, systemPrompt: settings.systemPrompt });
}

/** Claims the busy lock for a new send/reroll call and returns its own per-call state object —
 * see onStopClick() for why this can't just be a shared boolean. `restoreText` is what
 * onStopClick() should pop back into the input if the user cancels this call (the just-typed
 * question for onSendClick, null for onRerollLastClick, which has no "typed text" of its own). */
function beginRequest(restoreText) {
    const requestState = { stopped: false, restoreText };
    activeRequestState = requestState;
    isSending = true;
    setBusyUI();
    return requestState;
}

/** Releases the busy lock claimed by beginRequest(), unless onStopClick() already did so
 * synchronously for this same call (see the finally-block comments in onSendClick/onRerollLastClick
 * for why that case must not reset state a newer call may have since claimed). */
function endRequest(requestState) {
    if (!requestState.stopped) {
        activeRequestState = null;
        isSending = false;
        setBusyUI();
    }
}

async function onSendClick() {
    if (isSending || !panelEl) {
        return;
    }

    const textarea = panelEl.find('.companion_input');
    const question = String(textarea.val() || '').trim();
    if (!question) {
        return;
    }

    const chatIdAtSend = getContext().chatId;
    const requestState = beginRequest(question);
    textarea.val('');

    try {
        const answer = await generateAnswer(question);
        if (requestState.stopped) {
            return; // onStopClick() already reset the UI; silently drop this late result.
        }
        appendLogEntry(question, answer || '（陪玩伴侣没有说话）', chatIdAtSend);
    } catch (error) {
        if (requestState.stopped) {
            return;
        }
        console.error(`[STCompanion] ${settings.apiMode} generation failed`, error);
        appendLogEntry(question, `（生成失败：${error?.message || error}）`, chatIdAtSend);
    } finally {
        endRequest(requestState);
    }
}

/** Cancels whichever send/reroll call is currently in flight, without touching anything outside
 * this extension. generateRaw() (used for apiMode==='sillytavern') exposes no cancellation signal
 * of its own — the only lever ST provides is emitting event_types.GENERATION_STOPPED globally,
 * but that also gets picked up by SillyTavern's own main-chat generation controller and a few
 * other one-shot listeners (group automode, slash-command cleanup) — stopping the companion must
 * never risk interrupting the tavern's own generation, so that event is deliberately never used
 * here. Instead this is a "soft stop": the in-flight generateRaw() request keeps running in the
 * background and completes on its own, but its result is silently discarded (requestState.stopped
 * short-circuits onSendClick/onRerollLastClick's continuation) while the UI recovers immediately.
 * For apiMode==='custom' the request is our own fetch() to the user's endpoint, so it can and does
 * get a real abort() — still zero effect on SillyTavern either way. */
function onStopClick() {
    if (!isSending || !activeRequestState) {
        return;
    }
    activeRequestState.stopped = true;
    activeAbortController?.abort();
    if (typeof activeRequestState.restoreText === 'string') {
        panelEl.find('.companion_input').val(activeRequestState.restoreText).trigger('focus');
    }
    activeRequestState = null;
    isSending = false;
    setBusyUI();
}

async function onRerollLastClick() {
    if (isSending || !panelEl) {
        return;
    }
    const lastEntry = getLastLogEntry();
    if (!lastEntry) {
        return;
    }

    const chatIdAtSend = getContext().chatId;
    const requestState = beginRequest(null);

    try {
        const answer = await generateAnswer(lastEntry.q);
        if (requestState.stopped) {
            // Stopping = keep whatever answer was showing before this reroll; never touching
            // replaceLastLogEntryAnswer()/loadLogFromChat() here *is* the "restore".
            return;
        }
        if (hasChatChanged(chatIdAtSend)) {
            console.warn('[STCompanion] chat changed mid-reroll, dropping stale answer');
            return;
        }
        replaceLastLogEntryAnswer(answer || '（陪玩伴侣没有说话）');
        loadLogFromChat();
    } catch (error) {
        if (requestState.stopped) {
            return;
        }
        // Unlike onSendClick, a failed reroll does not overwrite the existing (possibly fine)
        // answer with an error string — it just surfaces a toast and leaves the entry as-is.
        console.error(`[STCompanion] ${settings.apiMode} reroll failed`, error);
        toastr.error(error?.message || String(error), '重试失败');
    } finally {
        endRequest(requestState);
    }
}

function onDeleteLastClick() {
    if (isSending || !panelEl || !getLastLogEntry()) {
        return;
    }
    deleteLastLogEntry();
    loadLogFromChat();
}

function buildSettingsForm() {
    const form = $(`
        <div class="companion_settings_form">
            <label>API 模式
                <select class="companion_setting_api_mode">
                    <option value="sillytavern">跟随 SillyTavern 主API</option>
                    <option value="custom">自定义 API</option>
                </select>
            </label>
            <div class="companion_custom_api_fields companion_hidden">
                <label>API URL
                    <input type="text" class="companion_setting_custom_url" placeholder="https://api.openai.com/v1" />
                </label>
                <label>API Key
                    <input type="password" class="companion_setting_custom_key" />
                </label>
                <label>模型
                    <input type="text" class="companion_setting_custom_model" />
                </label>
                <button type="button" class="companion_fetch_models_btn">获取列表</button>
                <select class="companion_custom_model_list companion_hidden"></select>
            </div>
            <label>读取sillytavern层数
                <input type="number" class="companion_setting_turns" min="1" max="${MAX_TURNS}" />
            </label>
            <label>读取陪玩层数
                <input type="number" class="companion_setting_companion_turns" min="1" max="${MAX_LOG_ENTRIES}" />
            </label>
            <label class="companion_checkbox_label">
                <input type="checkbox" class="companion_setting_wi_enabled" />
                启用纪要表（读取世界书条目）
            </label>
            <label>纪要表条目标题（前缀匹配）
                <input type="text" class="companion_setting_wi_title" placeholder="例如：纪要" />
            </label>
            <label class="companion_checkbox_label">
                <input type="checkbox" class="companion_setting_shujuku_enabled" />
                启用数据库（shujuku）整合
            </label>
            <label>数据库前缀（用于匹配数据表，纪要由智能召回单独处理，不受此项影响）
                <input type="text" class="companion_setting_shujuku_prefix" placeholder="TavernDB-ACU-" />
            </label>
            <label class="companion_checkbox_label">
                <input type="checkbox" class="companion_setting_auto_wi_enabled" />
                启用本轮世界书自动触发（根据玩家最近一条输入匹配世界书，与是否安装数据库脚本无关）
            </label>
            <label>陪玩伴侣人设
                <textarea class="companion_setting_prompt"></textarea>
            </label>
        </div>
    `);

    const customApiFields = form.find('.companion_custom_api_fields');

    form.find('.companion_setting_api_mode').val(settings.apiMode).on('change', function () {
        settings.apiMode = $(this).val();
        saveSettingsDebounced();
        customApiFields.toggleClass('companion_hidden', settings.apiMode !== 'custom');
    });
    customApiFields.toggleClass('companion_hidden', settings.apiMode !== 'custom');

    form.find('.companion_setting_custom_url').val(settings.customApiUrl).on('input', function () {
        settings.customApiUrl = String($(this).val()).trim();
        saveSettingsDebounced();
    });

    form.find('.companion_setting_custom_key').val(settings.customApiKey).on('input', function () {
        settings.customApiKey = String($(this).val());
        saveSettingsDebounced();
    });

    const modelInput = form.find('.companion_setting_custom_model');
    modelInput.val(settings.customApiModel).on('input', function () {
        settings.customApiModel = String($(this).val());
        saveSettingsDebounced();
    });

    const modelList = form.find('.companion_custom_model_list');
    modelList.on('change', function () {
        const val = $(this).val();
        if (!val) {
            return;
        }
        modelInput.val(val);
        settings.customApiModel = val;
        saveSettingsDebounced();
    });

    form.find('.companion_fetch_models_btn').on('click', async function () {
        const btn = $(this);
        const originalText = btn.text();
        btn.prop('disabled', true).text('获取中…');
        try {
            const models = await fetchCustomApiModels();
            if (models.length === 0) {
                throw new Error('未返回任何模型');
            }
            // Only touch the list once we know we have results — leaving a previous
            // successful fetch's list intact (rather than emptied-but-still-visible)
            // if this attempt fails.
            modelList.empty().append('<option value="">选择模型…</option>');
            for (const id of models) {
                modelList.append($('<option></option>').val(id).text(id));
            }
            modelList.removeClass('companion_hidden');
        } catch (error) {
            console.error('[STCompanion] fetchCustomApiModels failed', error);
            toastr.error(error?.message || String(error), '获取模型列表失败');
        } finally {
            btn.prop('disabled', false).text(originalText);
        }
    });

    const debouncedRenderContextPreview = debounce(() => renderContextPreview(), debounce_timeout.standard);

    form.find('.companion_setting_turns').val(settings.turnsToShow).on('input', function () {
        settings.turnsToShow = normalizeTurns($(this).val());
        saveSettingsDebounced();
        renderRecentMessages();
    });

    form.find('.companion_setting_companion_turns').val(settings.companionTurnsToShow).on('input', function () {
        settings.companionTurnsToShow = normalizeCompanionTurns($(this).val());
        saveSettingsDebounced();
    });

    form.find('.companion_setting_wi_enabled').prop('checked', settings.worldInfoEnabled).on('change', function () {
        settings.worldInfoEnabled = $(this).prop('checked');
        saveSettingsDebounced();
        renderContextPreview();
    });

    form.find('.companion_setting_wi_title').val(settings.worldInfoEntryTitle).on('input', function () {
        settings.worldInfoEntryTitle = String($(this).val());
        saveSettingsDebounced();
        debouncedRenderContextPreview();
    });

    form.find('.companion_setting_shujuku_enabled').prop('checked', settings.shujukuEnabled).on('change', function () {
        settings.shujukuEnabled = $(this).prop('checked');
        saveSettingsDebounced();
        renderContextPreview();
    });

    form.find('.companion_setting_shujuku_prefix').val(settings.shujukuPrefix).on('input', function () {
        settings.shujukuPrefix = String($(this).val()).trim();
        saveSettingsDebounced();
        debouncedRenderContextPreview();
    });

    form.find('.companion_setting_auto_wi_enabled').prop('checked', settings.autoWorldInfoEnabled).on('change', function () {
        settings.autoWorldInfoEnabled = $(this).prop('checked');
        saveSettingsDebounced();
        renderContextPreview();
    });

    form.find('.companion_setting_prompt').val(settings.systemPrompt).on('input', function () {
        settings.systemPrompt = String($(this).val());
        saveSettingsDebounced();
    });

    return form;
}

/** Read-only preview of what actually gets sent to generateRaw — kept out of the
 * primary chat view (see plan: "视觉主次颠倒" feedback) but still live-updating. */
function buildDebugSection() {
    return $(`
        <div class="companion_debug_section">
            <div class="companion_debug_heading">调试信息（喂给陪玩伴侣的原始上下文）</div>
            <div class="companion_section_title">最近剧情</div>
            <div class="companion_recent_messages"></div>
            <div class="companion_lore_section companion_hidden">
                <div class="companion_section_title">故事纪要</div>
                <div class="companion_lore_content"></div>
            </div>
            <div class="companion_shujuku_section companion_hidden">
                <div class="companion_section_title">数据库（shujuku）</div>
                <div class="companion_shujuku_content"></div>
            </div>
            <div class="companion_auto_wi_section companion_hidden">
                <div class="companion_section_title">本轮触发的世界书</div>
                <div class="companion_auto_wi_content"></div>
            </div>
            <button type="button" class="companion_export_prompt_btn">导出上次提示词</button>
        </div>
    `);
}

/** Whether an entry's title marks it as one of a character card's "chain-of-thought"/
 * reasoning-instruction entries (as opposed to plain lore) — confirmed against a real
 * character card export: an entry literally titled "正文cot(专用预设关)" exists alongside a
 * "COT" placeholder. Shared by the default-checked state in buildWorldInfoBlacklistRow() and
 * the "一键拉黑思维链" button so both apply the exact same rule. */
function isCotEntryTitle(title) {
    return /思维链|cot/i.test(title || '');
}

/** Builds one checkbox row for the world-info blacklist section. Uses .text() (not template
 * interpolation) for the entry title since it's arbitrary user/character-card content.
 * Defaults to checked (blacklisted) if the entry is already saved as blacklisted OR looks
 * like a 思维链/CoT entry — the latter per explicit request to pre-flag those by default. */
function buildWorldInfoBlacklistRow(entry, blacklist) {
    const id = getWorldInfoEntryId(entry);
    const chars = entry.content?.length || 0;
    const title = entry.comment || '（无标题）';
    const row = $('<label class="companion_wi_blacklist_row"></label>');
    const checkbox = $('<input type="checkbox" class="companion_wi_blacklist_check" />')
        .prop('checked', blacklist.has(id) || isCotEntryTitle(entry.comment))
        .attr('data-entry-id', id);
    row.append(
        checkbox,
        $('<span class="companion_wi_blacklist_row_title"></span>').text(title),
        $('<span class="companion_wi_blacklist_row_chars"></span>').text(`${chars}字符`),
    );
    return row;
}

/**
 * Manual "never send to the companion" world info blacklist — see saveWorldInfoBlacklist().
 * Mirrors the World extension's own checkbox-list pattern (composite `book::uid` IDs,
 * 全选/取消全选 only mutating DOM state until an explicit Save persists it) but simplified:
 * no IndexedDB store, no per-entry auto/const/key/off override — just checked (blacklisted)
 * or not.
 */
function buildWorldInfoBlacklistSection() {
    const section = $(`
        <div class="companion_wi_blacklist_section">
            <div class="companion_wi_blacklist_header">
                <span class="companion_section_title">世界书黑名单（勾选的条目永远不会发给陪玩AI）</span>
                <span class="companion_wi_blacklist_toggle" title="展开/收起">▶</span>
            </div>
            <div class="companion_wi_blacklist_body companion_hidden">
                <div class="companion_wi_blacklist_desc">
                    没勾选的条目不会整本世界书原样塞给陪玩AI：「故事纪要」「数据库数据表」只发标题匹配前缀的条目；
                    「本轮世界书自动触发」跟随酒馆自己原生的关键词/常驻触发逻辑，只有这一轮真的会被激活的条目
                    （以及书里本来就标了「常驻」的条目）才会发出去。这里的黑名单是在这基础上再加一层
                    「无论如何都不发」的强制排除，不是唯一的过滤手段，不用担心随手一勾就把 token 烧干。
                </div>
                <div class="companion_wi_blacklist_summary">已拉黑 0 / 共 0 条</div>
                <div class="companion_wi_blacklist_search_row">
                    <input type="text" class="companion_wi_blacklist_search" placeholder="搜索条目标题…" />
                </div>
                <div class="companion_wi_blacklist_global_actions">
                    <button type="button" class="companion_wi_blacklist_select_all">全选</button>
                    <button type="button" class="companion_wi_blacklist_clear_all">取消全选</button>
                    <button type="button" class="companion_wi_blacklist_disable_cot">一键拉黑思维链</button>
                    <button type="button" class="companion_wi_blacklist_save" disabled>保存黑名单</button>
                </div>
                <div class="companion_wi_blacklist_list"></div>
            </div>
        </div>
    `);

    const body = section.find('.companion_wi_blacklist_body');
    const toggle = section.find('.companion_wi_blacklist_toggle');
    const list = section.find('.companion_wi_blacklist_list');
    const summary = section.find('.companion_wi_blacklist_summary');
    const searchInput = section.find('.companion_wi_blacklist_search');
    const saveBtn = section.find('.companion_wi_blacklist_save');
    // Bumped on every loadList() call; a load only applies its results if it's still the
    // newest one in flight when it resolves — guards a rapid collapse→re-expand firing a
    // second load before the first settles, which would otherwise append duplicate groups
    // into `list` (both loads' `.empty()` happen before either's `.append()`).
    let loadToken = 0;
    // Which chat's data is currently reflected in the DOM. Save only proceeds when this still
    // matches the live chat — CHAT_CHANGED below clears it so a list left open from a
    // previous chat can never be saved into a different chat's chat_metadata.
    let loadedChatId = null;

    function updateSummary() {
        const checkboxes = list.find('.companion_wi_blacklist_check');
        const checked = checkboxes.filter(':checked');
        summary.text(`已拉黑 ${checked.length} / 共 ${checkboxes.length} 条`);
    }

    /** Hides rows (and any group left with zero visible rows) that don't match the search
     * query — 全选/取消全选 (both global and per-group) then only ever touch visible rows. */
    function applySearchFilter() {
        const query = searchInput.val().trim().toLowerCase();
        list.find('.companion_wi_blacklist_row').each(function () {
            const title = $(this).find('.companion_wi_blacklist_row_title').text().toLowerCase();
            $(this).toggleClass('companion_hidden', !(!query || title.includes(query)));
        });
        let anyVisible = false;
        list.find('.companion_wi_blacklist_group').each(function () {
            const hasVisibleRow = $(this).find('.companion_wi_blacklist_row:not(.companion_hidden)').length > 0;
            $(this).toggleClass('companion_hidden', !hasVisibleRow);
            anyVisible = anyVisible || hasVisibleRow;
        });
        list.find('.companion_wi_blacklist_no_results').toggleClass('companion_hidden', anyVisible || !query);
    }

    async function loadList() {
        const token = ++loadToken;
        saveBtn.prop('disabled', true);
        loadedChatId = null;
        list.empty();
        searchInput.val('');
        summary.text('加载中…');
        try {
            const entries = await collectActiveWorldInfoEntries();
            if (token !== loadToken) {
                return;
            }
            const blacklist = getWorldInfoBlacklist();

            const groups = new Map();
            for (const entry of entries) {
                const bookName = entry.world || '?';
                if (!groups.has(bookName)) {
                    groups.set(bookName, []);
                }
                groups.get(bookName).push(entry);
            }

            if (groups.size === 0) {
                list.append('<div class="companion_wi_blacklist_empty">（当前没有生效的世界书条目）</div>');
            }

            for (const [bookName, bookEntries] of groups) {
                const group = $('<div class="companion_wi_blacklist_group"></div>');
                const header = $('<div class="companion_wi_blacklist_group_header"></div>');
                header.append($('<span class="companion_wi_blacklist_group_title"></span>').text(`${bookName}（${bookEntries.length}条）`));
                const groupActions = $(`
                    <span class="companion_wi_blacklist_group_actions">
                        <button type="button" data-group-action="select">全选</button>
                        <button type="button" data-group-action="clear">取消全选</button>
                    </span>
                `);
                header.append(groupActions);
                const entriesContainer = $('<div class="companion_wi_blacklist_group_entries"></div>');
                for (const entry of bookEntries) {
                    entriesContainer.append(buildWorldInfoBlacklistRow(entry, blacklist));
                }
                groupActions.find('[data-group-action]').on('click', function () {
                    const select = $(this).attr('data-group-action') === 'select';
                    entriesContainer.find('.companion_wi_blacklist_row:not(.companion_hidden) .companion_wi_blacklist_check').prop('checked', select);
                    updateSummary();
                });
                group.append(header, entriesContainer);
                list.append(group);
            }

            list.append('<div class="companion_wi_blacklist_no_results companion_hidden">（没有标题匹配的条目）</div>');
            list.find('.companion_wi_blacklist_check').on('change', updateSummary);
            updateSummary();
            loadedChatId = getContext().chatId;
            saveBtn.prop('disabled', false);
        } catch (error) {
            if (token !== loadToken) {
                return;
            }
            console.error('[STCompanion] failed to load world info entries for blacklist', error);
            summary.text('加载世界书条目失败，详见控制台');
            // Save stays disabled — there's nothing valid in `list` to save.
        }
    }

    toggle.on('click', () => {
        const willShow = body.hasClass('companion_hidden');
        body.toggleClass('companion_hidden', !willShow);
        toggle.text(willShow ? '▼' : '▶');
        // Re-scan on every expand (not just the first) so a book change elsewhere is picked
        // up — this is a one-off settings action, not worth caching like resolveLoreEntries().
        if (willShow) {
            loadList();
        }
    });

    // A chat switch invalidates whatever is currently rendered — collapse and disable Save
    // rather than leave a stale, now-mismatched list open and saveable into the new chat.
    eventSource.on(event_types.CHAT_CHANGED, () => {
        loadToken++;
        loadedChatId = null;
        saveBtn.prop('disabled', true);
        body.addClass('companion_hidden');
        toggle.text('▶');
        list.empty();
        searchInput.val('');
        summary.text('已拉黑 0 / 共 0 条');
    });

    searchInput.on('input', applySearchFilter);

    section.find('.companion_wi_blacklist_select_all').on('click', () => {
        list.find('.companion_wi_blacklist_row:not(.companion_hidden) .companion_wi_blacklist_check').prop('checked', true);
        updateSummary();
    });
    section.find('.companion_wi_blacklist_clear_all').on('click', () => {
        list.find('.companion_wi_blacklist_row:not(.companion_hidden) .companion_wi_blacklist_check').prop('checked', false);
        updateSummary();
    });
    // Additive, not a reset: only checks 思维链/CoT-titled rows, leaves every other row's
    // state untouched — a quick way to re-apply the default-CoT rule (e.g. after manually
    // unchecking some while browsing) without needing to collapse/re-expand the whole section.
    section.find('.companion_wi_blacklist_disable_cot').on('click', () => {
        list.find('.companion_wi_blacklist_row').each(function () {
            if (isCotEntryTitle($(this).find('.companion_wi_blacklist_row_title').text())) {
                $(this).find('.companion_wi_blacklist_check').prop('checked', true);
            }
        });
        updateSummary();
    });
    saveBtn.on('click', () => {
        // Belt-and-braces beyond the `disabled` prop: also refuse if the chat has moved on
        // since the list was loaded (disabled should already prevent this, but a stale click
        // queued right as CHAT_CHANGED fires shouldn't slip through either).
        if (saveBtn.prop('disabled') || loadedChatId !== getContext().chatId) {
            return;
        }
        // .get() over the full (unfiltered) list — Save always reflects every entry's real
        // checked state, not just whatever the search box currently shows.
        const ids = list.find('.companion_wi_blacklist_check:checked').map((_, el) => el.dataset.entryId).get();
        if (saveWorldInfoBlacklist(ids)) {
            toastr.success(`已保存 ${ids.length} 条黑名单`, '陪玩伴侣');
        } else {
            toastr.error('保存失败：当前没有有效的聊天', '陪玩伴侣');
        }
    });

    return section;
}

/**
 * Clamps a saved panel position back into the current viewport. Needed because
 * jQuery UI's `containment` option only bounds the panel *during* an active drag —
 * a position saved on a larger screen/window can still end up off-screen when the
 * panel is recreated on a smaller one, with no drag possible to recover it since
 * the header itself would be off-screen.
 */
function clampToViewport(top, left) {
    const maxTop = Math.max(0, window.innerHeight - 80);
    const maxLeft = Math.max(0, window.innerWidth - 80);
    return {
        top: Math.min(Math.max(0, top), maxTop),
        left: Math.min(Math.max(0, left), maxLeft),
    };
}

/** Same rationale as clampToViewport, but for a saved width/height: a size saved on a
 * large screen shouldn't render larger than the current viewport can sensibly show. */
function clampSize(width, height) {
    return {
        width: Math.min(width, Math.round(window.innerWidth * 0.9)),
        height: Math.min(height, Math.round(window.innerHeight * 0.8)),
    };
}

/**
 * Wires up dragging via jQuery UI's `.draggable()` (already loaded app-wide, see
 * public/index.html — including the touch-punch adapter, so this gets touch
 * support for free). Deliberately NOT using ST core's `dragElement()`: that one
 * only works when the user has enabled ST's global "Moving UI" setting
 * (`power_user.movingUI`, off by default) — do not "simplify" this back to
 * dragElement(), it would silently reintroduce that dependency.
 */
function makeDraggable(el, handle) {
    el.draggable({
        handle,
        containment: 'window',
        cancel: '.companion_settings_toggle, .companion_close_btn, .companion_maximize_btn',
        stop: (event, ui) => {
            settings.panelTop = Math.round(ui.position.top);
            settings.panelLeft = Math.round(ui.position.left);
            saveSettingsDebounced();
        },
    });
}

/**
 * Wires up resizing via jQuery UI's `.resizable()` — same touch-punch adapter that
 * makeDraggable relies on patches the shared `$.ui.mouse` base both widgets extend,
 * so this gets touch support for free too, no extra code needed.
 * Only e/s/se handles: the panel is anchored by top+left (or top+right before the
 * first drag), and those handles never move that anchor corner, so no extra position
 * bookkeeping is needed beyond width/height (unlike n/w, which would).
 */
function makeResizable(el) {
    const MIN_WIDTH = 260;
    const MIN_HEIGHT = 200;
    el.resizable({
        handles: 'e, s, se',
        minWidth: MIN_WIDTH,
        minHeight: MIN_HEIGHT,
        // max() guards narrow viewports (<289px wide) where 90% of innerWidth would
        // otherwise dip below minWidth and hand jQuery UI a contradictory constraint.
        maxWidth: Math.max(MIN_WIDTH, Math.round(window.innerWidth * 0.9)),
        maxHeight: Math.max(MIN_HEIGHT, Math.round(window.innerHeight * 0.8)),
        stop: (event, ui) => {
            settings.panelWidth = Math.round(ui.size.width);
            settings.panelHeight = Math.round(ui.size.height);
            saveSettingsDebounced();
        },
    });
}

let isMaximized = false;
let preMaximizeRect = null;

/**
 * Toggles between the panel's normal (draggable/resizable) size and a near-fullscreen
 * layout. Unlike ST core's own maximize toggle (a plain CSS class swap on a
 * non-interactive panel), this panel is a live jQuery UI draggable/resizable instance,
 * so dragging/resizing must be explicitly disabled while maximized — otherwise a drag
 * or resize attempt would immediately fight the .companion_maximized CSS rule by
 * writing new inline top/left/width/height.
 */
function toggleMaximize() {
    if (!panelEl) {
        return;
    }
    const btn = panelEl.find('.companion_maximize_btn');

    if (!isMaximized) {
        preMaximizeRect = {
            top: panelEl[0].style.top,
            left: panelEl[0].style.left,
            right: panelEl[0].style.right,
            width: panelEl[0].style.width,
            height: panelEl[0].style.height,
        };
        panelEl.draggable('disable').resizable('disable');
        panelEl.css({ top: '', left: '', right: '', width: '', height: '' });
        panelEl.addClass('companion_maximized');
        btn.text('🗗').attr('title', '还原');
    } else {
        panelEl.removeClass('companion_maximized');
        panelEl.css(preMaximizeRect || {});
        panelEl.draggable('enable').resizable('enable');
        btn.text('⛶').attr('title', '最大化');
    }
    isMaximized = !isMaximized;
}

/**
 * Every settings field already auto-saves via saveSettingsDebounced() on input/change
 * (unchanged behavior — see buildSettingsForm()), so this isn't load-bearing for
 * correctness. Its job is purely reassurance: call the non-debounced saveSettings()
 * (script.js) for an immediate flush instead of waiting out the debounce timer, and
 * optionally flash a visible confirmation on the button that triggered it.
 */
async function flushSettingsWithConfirm(btnEl) {
    await saveSettings();
    if (btnEl) {
        const original = btnEl.text();
        btnEl.text('已保存 ✓');
        setTimeout(() => btnEl.text(original), 1200);
    }
}

function createPanel() {
    const el = $(`
        <div id="${PANEL_ID}">
            <div class="companion_header">
                <span class="companion_title">👁️ 陪玩伴侣</span>
                <span class="companion_maximize_btn" title="最大化">⛶</span>
                <span class="companion_settings_toggle" title="设置">⚙</span>
                <span class="companion_close_btn" title="关闭">✕</span>
            </div>
            <div class="companion_body"></div>
            <div class="companion_input_row">
                <div class="companion_input_actions">
                    <span class="companion_reroll_btn" title="重新生成上一条回答">🔁</span>
                    <span class="companion_delete_last_btn" title="删除上一条问答">🗑️</span>
                </div>
                <textarea class="companion_input" placeholder="问问陪玩伴侣…"></textarea>
                <button class="companion_send_btn">发送</button>
            </div>
        </div>
    `);

    if (Number.isFinite(settings.panelTop) && Number.isFinite(settings.panelLeft)) {
        const { top, left } = clampToViewport(settings.panelTop, settings.panelLeft);
        el.css({ top: `${top}px`, left: `${left}px`, right: 'auto' });
    }
    if (Number.isFinite(settings.panelWidth) && Number.isFinite(settings.panelHeight)) {
        const { width, height } = clampSize(settings.panelWidth, settings.panelHeight);
        el.css({ width: `${width}px`, height: `${height}px` });
    }

    const settingsScroll = $('<div class="companion_settings_scroll"></div>')
        .append(buildSettingsForm(), buildWorldInfoBlacklistSection(), buildDebugSection());
    const saveSettingsBtn = $('<button type="button" class="companion_save_settings_btn">保存设置</button>');
    const settingsFooter = $('<div class="companion_settings_footer"></div>').append(saveSettingsBtn);
    const settingsWrapper = $('<div class="companion_settings_wrapper companion_hidden"></div>')
        .append(settingsScroll, settingsFooter);
    const log = $('<div class="companion_log"><div class="companion_log_empty">问问陪玩伴侣，看看TA怎么说…</div></div>');
    const inputRow = el.find('.companion_input_row');

    el.find('.companion_body').append(settingsWrapper, log);

    el.find('.companion_maximize_btn').on('click', toggleMaximize);
    saveSettingsBtn.on('click', () => flushSettingsWithConfirm(saveSettingsBtn));
    el.find('.companion_settings_toggle').on('click', () => {
        // Settings and chat share the same small panel body — showing both at once left
        // the settings form squeezed into a half-height scroll box. There's no need to
        // see the chat log/send button while adjusting settings, so give settings the
        // full body height and bring the chat view back once settings are closed again.
        const willShowSettings = settingsWrapper.hasClass('companion_hidden');
        settingsWrapper.toggleClass('companion_hidden', !willShowSettings);
        log.toggleClass('companion_hidden', willShowSettings);
        inputRow.toggleClass('companion_hidden', willShowSettings);
        if (!willShowSettings) {
            // Leaving the settings view — flush immediately rather than leaving a pending
            // debounced save around; silent (no button to flash a confirmation on).
            flushSettingsWithConfirm();
        }
    });
    el.find('.companion_send_btn').on('click', () => {
        if (isSending) {
            onStopClick();
        } else {
            onSendClick();
        }
    });
    el.find('.companion_reroll_btn').on('click', onRerollLastClick);
    el.find('.companion_delete_last_btn').on('click', onDeleteLastClick);
    el.find('.companion_export_prompt_btn').on('click', () => {
        if (!lastBuiltPrompt) {
            toastr.warning('还没有发送过消息，没有可导出的提示词', '陪玩伴侣');
            return;
        }
        download(lastBuiltPrompt, 'companion-last-prompt.txt', 'text/plain');
    });
    el.find('.companion_close_btn').on('click', () => togglePanel(false));

    $('body').append(el);
    makeDraggable(el, '.companion_header');
    makeResizable(el);

    panelEl = el;
    loadLogFromChat();
}

function togglePanel(forceState) {
    if (!panelEl) {
        createPanel();
    }

    const shouldShow = typeof forceState === 'boolean' ? forceState : !panelEl.is(':visible');
    if (shouldShow) {
        // jQuery's .show() doesn't know this element's "visible" display value is
        // `flex` (set in style.css) rather than the tag-default `block` it falls
        // back to — using it here silently breaks the panel's flex layout (the
        // settings/debug section stops being height-constrained and overflows,
        // getting clipped by the panel's `overflow: hidden`). Set display explicitly.
        panelEl.css('display', 'flex');
        renderRecentMessages();
        renderContextPreview();
    } else {
        panelEl.css('display', 'none');
    }
}

/**
 * Hand-rolled drag (not jQuery UI) for the toggle button, mirroring World's own
 * makeBallDraggable() (world-engine-ui.js) rather than makeDraggable() above: this
 * single element is both a click target (open/close the panel) and a drag target
 * (reposition), and jQuery UI's .draggable() doesn't cleanly suppress the click that
 * would otherwise fire right after a drag ends. The `moved` flag + a capture-phase
 * click listener (same technique World uses) is what makes that distinction work.
 */
function makeToggleButtonDraggable(btn) {
    const el = btn[0];
    let dragging = false;
    let moved = false;
    let startX = 0, startY = 0, startLeft = 0, startTop = 0;

    function onMove(event) {
        if (!dragging) {
            return;
        }
        const point = event.touches ? event.touches[0] : event;
        const dx = point.clientX - startX;
        const dy = point.clientY - startY;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
            moved = true;
        }
        if (event.cancelable) {
            event.preventDefault();
        }
        // clampToViewport keeps the button fully reachable even after the window shrinks;
        // never use `bottom`/`right` here — see the .companion_maximized CSS comment for why.
        const { top, left } = clampToViewport(startTop + dy, startLeft + dx);
        el.style.top = `${top}px`;
        el.style.left = `${left}px`;
        el.style.right = 'auto';
    }

    function onUp() {
        if (!dragging) {
            return;
        }
        dragging = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend', onUp);
        if (!moved) {
            return;
        }
        settings.toggleBtnTop = Math.round(parseFloat(el.style.top));
        settings.toggleBtnLeft = Math.round(parseFloat(el.style.left));
        saveSettingsDebounced();
    }

    function onDown(event) {
        const point = event.touches ? event.touches[0] : event;
        dragging = true;
        moved = false;
        startX = point.clientX;
        startY = point.clientY;
        const rect = el.getBoundingClientRect();
        startLeft = rect.left;
        startTop = rect.top;
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend', onUp);
    }

    el.addEventListener('mousedown', onDown);
    el.addEventListener('touchstart', onDown, { passive: true });
    // Capture phase so this always runs before the bubble-phase togglePanel() click
    // handler below, regardless of listener registration order.
    el.addEventListener('click', (event) => {
        if (moved) {
            event.preventDefault();
            event.stopImmediatePropagation();
            moved = false;
        }
    }, true);
}

function createToggleButton() {
    const btn = $('<div id="companion_toggle_btn" title="陪玩伴侣">👁️</div>');
    if (Number.isFinite(settings.toggleBtnTop) && Number.isFinite(settings.toggleBtnLeft)) {
        const { top, left } = clampToViewport(settings.toggleBtnTop, settings.toggleBtnLeft);
        btn.css({ top: `${top}px`, left: `${left}px`, right: 'auto' });
    }
    $('body').append(btn);
    makeToggleButtonDraggable(btn);
    btn.on('click', () => togglePanel());
}

export async function init() {
    settings = loadSettings();
    createToggleButton();

    // ST's own floating panels all close on Escape; match that expectation even
    // though this panel isn't part of ST's #movingDivs family.
    $(document).on('keydown.companionChat', (e) => {
        if (e.key === 'Escape' && panelEl && panelEl.is(':visible')) {
            togglePanel(false);
        }
    });

    const messageRefreshEvents = [
        event_types.CHARACTER_MESSAGE_RENDERED,
        event_types.USER_MESSAGE_RENDERED,
        event_types.MESSAGE_DELETED,
        event_types.MESSAGE_UPDATED,
        event_types.MESSAGE_SWIPED,
    ];
    for (const evt of messageRefreshEvents) {
        eventSource.on(evt, renderRecentMessages);
    }

    eventSource.on(event_types.CHAT_CHANGED, () => {
        invalidateLoreCache();
        renderRecentMessages();
        renderContextPreview();
        loadLogFromChat();
    });
}
