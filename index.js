import { eventSource, event_types, generateRaw, saveSettingsDebounced } from '../../../../script.js';
import { getContext, extension_settings } from '../../../extensions.js';
import { power_user } from '../../../power-user.js';
import { selected_world_info } from '../../../world-info.js';
import { debounce } from '../../../utils.js';
import { debounce_timeout } from '../../../constants.js';

const MODULE_NAME = 'companionChat';
const PANEL_ID = 'companionChatPanel';

const defaultSettings = {
    enabled: true,
    turnsToShow: 2,
    worldInfoEnabled: false,
    worldInfoEntryTitle: '',
    systemPrompt: '你是一个安静的陪玩伴侣，正在看玩家和AI角色玩文字冒险/角色扮演游戏。'
        + '基于最近的剧情内容，用简短、犀利、有趣的视角回答玩家的问题或发表评论。'
        + '不要替玩家做决定，不要扮演故事里的角色，只以陪玩伴侣身份说话。',
    // null = 使用 CSS 默认位置；拖拽后写入具体像素值，完全独立于 ST 的 movingUIState。
    panelTop: null,
    panelLeft: null,
};

/** @type {Record<string, any>} */
let settings;
let panelEl = null;
let isSending = false;

// Caches the last resolved lore entry so renderLoreSection() and buildPrompt() don't
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

/**
 * Searches every world info book that could plausibly be active for the current
 * chat (chat-bound, character-bound, globally-enabled, persona-bound) for an
 * entry whose title starts with titlePrefix.
 */
async function findWorldInfoEntry(titlePrefix) {
    if (!titlePrefix) {
        return null;
    }

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

    const results = await Promise.all([...worldNames].map(name => context.loadWorldInfo(name)));
    for (const data of results) {
        if (!data?.entries) {
            continue;
        }
        const match = Object.values(data.entries).find(entry =>
            entry.comment?.toLowerCase().startsWith(titlePrefix.toLowerCase()));
        if (match) {
            return match;
        }
    }

    return null;
}

function invalidateLoreCache() {
    loreCache = { title: null, enabled: null, promise: null };
}

/** Cached wrapper around findWorldInfoEntry, keyed on the current settings. */
function resolveLoreEntry() {
    const title = settings.worldInfoEntryTitle;
    const enabled = settings.worldInfoEnabled;
    if (!enabled || !title) {
        return Promise.resolve(null);
    }
    if (loreCache.title !== title || loreCache.enabled !== enabled || !loreCache.promise) {
        loreCache = { title, enabled, promise: findWorldInfoEntry(title) };
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

async function renderLoreSection() {
    if (!panelEl || !panelEl.is(':visible')) {
        return;
    }

    const section = panelEl.find('.companion_lore_section');
    const content = panelEl.find('.companion_lore_content');

    if (!settings.worldInfoEnabled || !settings.worldInfoEntryTitle) {
        section.addClass('companion_hidden');
        return;
    }

    section.removeClass('companion_hidden');
    try {
        const entry = await resolveLoreEntry();
        content.text(entry?.content || '（未找到匹配的世界书条目）');
    } catch (error) {
        console.error('[STCompanion] failed to load world info', error);
        content.text('（读取世界书失败，详见控制台）');
    }
}

async function buildPrompt(userQuestion) {
    const messages = getRecentMessages();
    const chatText = messages.map(msg => `${msg.name || '?'}: ${msg.mes}`).join('\n') || '（暂无剧情）';

    let loreBlock = '';
    const entry = await resolveLoreEntry();
    if (entry?.content) {
        loreBlock = `【故事纪要】\n${entry.content}\n\n`;
    }

    return `${loreBlock}【最近剧情】\n${chatText}\n\n【玩家问陪玩伴侣】\n${userQuestion}`;
}

function appendLogEntry(question, answer) {
    const log = panelEl.find('.companion_log');
    log.find('.companion_log_empty').remove();
    log.append(
        $('<div class="companion_bubble_row companion_bubble_user"></div>')
            .append($('<div class="companion_bubble"></div>').text(question)),
        $('<div class="companion_bubble_row companion_bubble_observer"></div>')
            .append($('<div class="companion_bubble"></div>').text(answer)),
    );
    log.scrollTop(log[0].scrollHeight);
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

    const sendBtn = panelEl.find('.companion_send_btn');
    isSending = true;
    sendBtn.prop('disabled', true).text('思考中…');
    textarea.val('');

    try {
        const prompt = await buildPrompt(question);
        const answer = await generateRaw({ prompt, systemPrompt: settings.systemPrompt });
        appendLogEntry(question, answer || '（陪玩伴侣没有说话）');
    } catch (error) {
        console.error('[STCompanion] generateRaw failed', error);
        appendLogEntry(question, `（生成失败：${error?.message || error}）`);
    } finally {
        isSending = false;
        sendBtn.prop('disabled', false).text('发送');
    }
}

function buildSettingsForm() {
    const form = $(`
        <div class="companion_settings_form">
            <label>显示最近层数
                <input type="number" class="companion_setting_turns" min="1" max="${MAX_TURNS}" />
            </label>
            <label class="companion_checkbox_label">
                <input type="checkbox" class="companion_setting_wi_enabled" />
                启用纪要表（读取世界书条目）
            </label>
            <label>纪要表条目标题（前缀匹配）
                <input type="text" class="companion_setting_wi_title" placeholder="例如：纪要" />
            </label>
            <label>陪玩伴侣人设
                <textarea class="companion_setting_prompt"></textarea>
            </label>
        </div>
    `);

    const debouncedRenderLoreSection = debounce(() => renderLoreSection(), debounce_timeout.standard);

    form.find('.companion_setting_turns').val(settings.turnsToShow).on('input', function () {
        settings.turnsToShow = normalizeTurns($(this).val());
        saveSettingsDebounced();
        renderRecentMessages();
    });

    form.find('.companion_setting_wi_enabled').prop('checked', settings.worldInfoEnabled).on('change', function () {
        settings.worldInfoEnabled = $(this).prop('checked');
        saveSettingsDebounced();
        renderLoreSection();
    });

    form.find('.companion_setting_wi_title').val(settings.worldInfoEntryTitle).on('input', function () {
        settings.worldInfoEntryTitle = String($(this).val());
        saveSettingsDebounced();
        debouncedRenderLoreSection();
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
        </div>
    `);
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
        cancel: '.companion_settings_toggle, .companion_close_btn',
        stop: (event, ui) => {
            settings.panelTop = Math.round(ui.position.top);
            settings.panelLeft = Math.round(ui.position.left);
            saveSettingsDebounced();
        },
    });
}

function createPanel() {
    const el = $(`
        <div id="${PANEL_ID}">
            <div class="companion_header">
                <span class="companion_title">👁️ 陪玩伴侣</span>
                <span class="companion_settings_toggle" title="设置">⚙</span>
                <span class="companion_close_btn" title="关闭">✕</span>
            </div>
            <div class="companion_body"></div>
            <div class="companion_input_row">
                <textarea class="companion_input" placeholder="问问陪玩伴侣…"></textarea>
                <button class="companion_send_btn">发送</button>
            </div>
        </div>
    `);

    if (Number.isFinite(settings.panelTop) && Number.isFinite(settings.panelLeft)) {
        const { top, left } = clampToViewport(settings.panelTop, settings.panelLeft);
        el.css({ top: `${top}px`, left: `${left}px`, right: 'auto' });
    }

    const settingsWrapper = $('<div class="companion_settings_wrapper companion_hidden"></div>')
        .append(buildSettingsForm(), buildDebugSection());
    const log = $('<div class="companion_log"><div class="companion_log_empty">问问陪玩伴侣，看看TA怎么说…</div></div>');

    el.find('.companion_body').append(settingsWrapper, log);

    el.find('.companion_settings_toggle').on('click', () => settingsWrapper.toggleClass('companion_hidden'));
    el.find('.companion_send_btn').on('click', onSendClick);
    el.find('.companion_input').on('keydown', (e) => {
        // isComposing / keyCode 229 excludes the Enter that confirms an IME candidate
        // (e.g. Pinyin) from being treated as "submit".
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
            e.preventDefault();
            onSendClick();
        }
    });
    el.find('.companion_close_btn').on('click', () => togglePanel(false));

    $('body').append(el);
    makeDraggable(el, '.companion_header');

    panelEl = el;
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
        renderLoreSection();
    } else {
        panelEl.css('display', 'none');
    }
}

function createToggleButton() {
    const btn = $('<div id="companion_toggle_btn" title="陪玩伴侣">👁️</div>');
    btn.on('click', () => togglePanel());
    $('body').append(btn);
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
        renderLoreSection();
    });
}
