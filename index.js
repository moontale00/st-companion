import { eventSource, event_types, generateRaw, saveSettings, saveSettingsDebounced } from '../../../../script.js';
import { getContext, extension_settings } from '../../../extensions.js';
import { power_user } from '../../../power-user.js';
import { selected_world_info } from '../../../world-info.js';
import { debounce } from '../../../utils.js';
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
    worldInfoEnabled: false,
    worldInfoEntryTitle: '',
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

/** Pure DOM construction, shared by the live-append path (appendLogEntry) and the
 * chat-load rebuild path (loadLogFromChat) so the bubble markup only lives in one place. */
function renderLogEntry(question, answer) {
    const log = panelEl.find('.companion_log');
    log.find('.companion_log_empty').remove();
    log.append(
        $('<div class="companion_bubble_row companion_bubble_user"></div>')
            .append($('<div class="companion_bubble"></div>').text(question)),
        $('<div class="companion_bubble_row companion_bubble_observer"></div>')
            .append($('<div class="companion_bubble"></div>').text(answer)),
    );
}

const MAX_LOG_ENTRIES = 50;

/**
 * Mirrors the Q&A pair into chat_metadata.companionChat so it survives reload and
 * shows up on another device the next time that device opens this same chat. This
 * is "sync on chat load", not real-time push — SillyTavern core has no live channel
 * for chat_metadata changes (confirmed: no websocket/poll in script.js), same
 * last-write-wins model the World extension's own chatcache uses.
 */
function persistLogEntry(question, answer) {
    // Always re-fetch context rather than caching chatMetadata: it's reassigned
    // wholesale on chat switch (script.js), so a cached reference would go stale.
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
    ns.log.push({ q: question, a: answer, ts: Date.now() });
    if (ns.log.length > MAX_LOG_ENTRIES) {
        ns.log.splice(0, ns.log.length - MAX_LOG_ENTRIES);
    }

    context.updateChatMetadata({ companionChat: ns });
    context.saveMetadataDebounced();
}

/**
 * `expectedChatId` guards against the chat having changed while `generateRaw` was
 * in flight (onSendClick awaits it before calling this): without it, an answer
 * built from the *old* chat's context could get rendered into and persisted onto
 * the *new* chat's log after the user switches chats mid-generation.
 */
function appendLogEntry(question, answer, expectedChatId) {
    if (expectedChatId !== undefined && getContext().chatId !== expectedChatId) {
        console.warn('[STCompanion] chat changed mid-generation, dropping stale answer');
        return;
    }
    renderLogEntry(question, answer);
    const log = panelEl.find('.companion_log');
    log.scrollTop(log[0].scrollHeight);
    persistLogEntry(question, answer);
}

/** Rebuilds the Q&A log from chat_metadata.companionChat — called once when the panel
 * is created and again on every CHAT_CHANGED, so switching chats shows that chat's own
 * log instead of leaving the previous chat's bubbles on screen. */
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
        return;
    }

    for (const entry of entries) {
        renderLogEntry(entry.q, entry.a);
    }
    log.scrollTop(log[0].scrollHeight);
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
 * this rejects. */
async function fetchWithTimeout(url, options) {
    const controller = new AbortController();
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
    const response = await fetchWithTimeout(normalizeCustomApiUrl(settings.customApiUrl), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(settings.customApiKey ? { Authorization: `Bearer ${settings.customApiKey}` } : {}),
        },
        body: JSON.stringify(body),
    });

    const data = await readCustomApiJson(response);
    const choice = data.choices?.[0];
    if (!choice) {
        throw new Error('API 返回缺少 choices[0]');
    }
    return choice.message?.content || '';
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
    const chatIdAtSend = getContext().chatId;
    isSending = true;
    sendBtn.prop('disabled', true).text('思考中…');
    textarea.val('');

    try {
        const prompt = await buildPrompt(question);
        const answer = settings.apiMode === 'custom'
            ? await callCustomApi(prompt, settings.systemPrompt)
            : await generateRaw({ prompt, systemPrompt: settings.systemPrompt });
        appendLogEntry(question, answer || '（陪玩伴侣没有说话）', chatIdAtSend);
    } catch (error) {
        console.error(`[STCompanion] ${settings.apiMode} generation failed`, error);
        appendLogEntry(question, `（生成失败：${error?.message || error}）`, chatIdAtSend);
    } finally {
        isSending = false;
        sendBtn.prop('disabled', false).text('发送');
    }
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
        .append(buildSettingsForm(), buildDebugSection());
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
        renderLoreSection();
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
        renderLoreSection();
        loadLogFromChat();
    });
}
