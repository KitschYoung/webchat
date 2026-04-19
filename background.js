const DEFAULT_SETTINGS = {
    apiType: 'custom',
    maxTokens: 2048,
    temperature: 0.7,
    enableContext: true,
    maxContextRounds: 3,
    systemPrompt: '你是一个帮助理解网页内容的AI助手。请使用Markdown格式回复。',
    custom_apiKey: '',
    custom_apiBase: '',
    custom_model: '',
    ollama_apiKey: '',
    ollama_apiBase: 'http://127.0.0.1:11434/api/chat',
    ollama_model: 'qwen2.5',
    enableSessionLogging: true,
    sessionLogEndpoint: 'http://127.0.0.1:8765/log-session',
    sessionLogOutputDir: '~/webchat-session-logs',
    sessionLogWorkspaceRoot: '~/webchat-workspace',
    sessionIdleMinutes: 30
};

const STORAGE_KEYS = {
    sessions: 'webchat_sessions_v3',
    pendingLogs: 'webchat_pending_logs_v1'
};

const runtimePorts = {};
const runtimeControllers = {};
let sessionsState = {};
let pendingLogsState = {};
let stateLoadedPromise = null;
let saveStateTimer = null;

chrome.runtime.onInstalled.addListener(() => {
    console.log('扩展已安装');
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    void handleRuntimeMessage(request, sender)
        .then(sendResponse)
        .catch((error) => {
            console.error('处理运行时消息失败:', error);
            sendResponse({ status: 'error', error: error.message });
        });
    return true;
});

chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'answerStream') {
        return;
    }

    port.onMessage.addListener((request) => {
        void handlePortMessage(port, request).catch((error) => {
            console.error('处理端口消息失败:', error);
            sendDirectMessage(port, { type: 'error', error: error.message });
        });
    });

    port.onDisconnect.addListener(() => {
        unregisterPort(port);
    });
});

chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace !== 'sync') {
        return;
    }

    if (changes.systemPrompt) {
        console.log('系统提示词已更新');
    }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.url) {
        void finalizeAndClearSession(tabId, 'tab-url-changed');
        return;
    }

    if (changeInfo.status === 'loading') {
        void finalizeAndClearSession(tabId, 'tab-loading');
    }
});

chrome.tabs.onRemoved.addListener((tabId) => {
    void finalizeAndClearSession(tabId, 'tab-removed');
});

async function handleRuntimeMessage(request, sender) {
    await ensureStateLoaded();
    await recoverInterruptedSessions();

    const { action } = request;

    if (action === 'getHistory') {
        await rotateSessionIfPageChanged(request.tabId);
        const session = getSession(request.tabId);
        return buildHistoryResponse(session);
    }

    if (action === 'prepareGeneration') {
        return await prepareGeneration(request.tabId, request.pageContent || '', request.question || '');
    }

    if (action === 'stopGeneration') {
        return await stopGeneration(request.tabId, request.reason || 'manual-stop');
    }

    if (action === 'clearHistory') {
        await finalizeAndClearSession(request.tabId, request.reason || 'clearHistory');
        return { status: 'ok' };
    }

    if (action === 'getGeneratingState') {
        const session = getSession(request.tabId);
        return session?.generatingState || { isGenerating: false };
    }

    if (action === 'openPopup') {
        chrome.action.openPopup();
        return { status: 'ok' };
    }

    if (action === 'getCurrentTab') {
        return { tabId: sender.tab?.id };
    }

    if (action === 'openOptions') {
        chrome.runtime.openOptionsPage();
        return { status: 'ok' };
    }

    if (action === 'saveHistory') {
        return { status: 'ignored' };
    }

    return { status: 'unknown-action' };
}

async function handlePortMessage(port, request) {
    await ensureStateLoaded();
    await recoverInterruptedSessions();

    const tabId = request.tabId;
    registerPort(tabId, port);

    if (request.action === 'generateAnswer') {
        await startGenerationFromPort(port, request);
        return;
    }

    if (request.action === 'reconnectStream') {
        await reconnectStream(port, request);
        return;
    }

    if (request.action === 'stopGeneration') {
        await stopGeneration(tabId, request.reason || 'manual-stop');
    }
}

async function ensureStateLoaded() {
    if (!stateLoadedPromise) {
        stateLoadedPromise = chrome.storage.local.get({
            [STORAGE_KEYS.sessions]: {},
            [STORAGE_KEYS.pendingLogs]: {}
        }).then((items) => {
            sessionsState = normalizeSessions(items[STORAGE_KEYS.sessions] || {});
            pendingLogsState = items[STORAGE_KEYS.pendingLogs] || {};
        });
    }

    await stateLoadedPromise;
}

function normalizeSessions(rawSessions) {
    const normalized = {};

    for (const [tabId, session] of Object.entries(rawSessions)) {
        normalized[tabId] = normalizeSession(session);
    }

    return normalized;
}

function normalizeSession(session = {}) {
    return {
        sessionMeta: {
            sessionId: session.sessionMeta?.sessionId || createSessionId(session.sessionMeta?.pageTitle || 'webchat'),
            startedAt: session.sessionMeta?.startedAt || new Date().toISOString(),
            updatedAt: session.sessionMeta?.updatedAt || new Date().toISOString(),
            lastActivityAt: session.sessionMeta?.lastActivityAt || new Date().toISOString(),
            pageUrl: session.sessionMeta?.pageUrl || '',
            pageTitle: session.sessionMeta?.pageTitle || '未命名页面',
            pageDomain: session.sessionMeta?.pageDomain || 'unknown',
            pageContentExcerpt: session.sessionMeta?.pageContentExcerpt || '',
            pageContentLength: session.sessionMeta?.pageContentLength || 0,
            outputFilePath: session.sessionMeta?.outputFilePath || '',
            lastRotationReason: session.sessionMeta?.lastRotationReason || '',
            lastRecoveryReason: session.sessionMeta?.lastRecoveryReason || ''
        },
        history: normalizeHistory(session.history || []),
        generatingState: {
            isGenerating: Boolean(session.generatingState?.isGenerating),
            pendingQuestion: session.generatingState?.pendingQuestion || '',
            requestId: session.generatingState?.requestId || '',
            clientId: session.generatingState?.clientId || '',
            startedAt: session.generatingState?.startedAt || ''
        },
        currentAnswer: session.currentAnswer || '',
        completedAnswer: session.completedAnswer || '',
        reservation: {
            requestId: session.reservation?.requestId || '',
            createdAt: session.reservation?.createdAt || ''
        }
    };
}

function normalizeHistory(history = []) {
    return history.map((message) => ({
        content: message.content || '',
        markdownContent: message.markdownContent || message.content || '',
        isUser: Boolean(message.isUser),
        createdAt: message.createdAt || new Date().toISOString()
    }));
}

function getSession(tabId) {
    return sessionsState[String(tabId)] || null;
}

async function saveSession(tabId, session, flush = false) {
    sessionsState[String(tabId)] = normalizeSession(session);
    if (flush) {
        await flushPersistentState();
        return;
    }
    schedulePersistentStateSave();
}

async function deleteSession(tabId, flush = false) {
    delete sessionsState[String(tabId)];
    if (flush) {
        await flushPersistentState();
        return;
    }
    schedulePersistentStateSave();
}

function schedulePersistentStateSave(delay = 150) {
    if (saveStateTimer) {
        clearTimeout(saveStateTimer);
    }

    saveStateTimer = setTimeout(() => {
        saveStateTimer = null;
        void flushPersistentState();
    }, delay);
}

async function flushPersistentState() {
    if (saveStateTimer) {
        clearTimeout(saveStateTimer);
        saveStateTimer = null;
    }

    await chrome.storage.local.set({
        [STORAGE_KEYS.sessions]: sessionsState,
        [STORAGE_KEYS.pendingLogs]: pendingLogsState
    });
}

async function recoverInterruptedSessions() {
    let changed = false;

    for (const [tabId, session] of Object.entries(sessionsState)) {
        if (!session.generatingState.isGenerating) {
            continue;
        }

        if (runtimeControllers[tabId]) {
            continue;
        }

        if (session.currentAnswer) {
            session.history.push(createMessage(session.currentAnswer, false));
            session.completedAnswer = session.currentAnswer;
        }

        session.generatingState = createIdleGeneratingState();
        session.sessionMeta.updatedAt = new Date().toISOString();
        session.sessionMeta.lastRecoveryReason = 'service-worker-restart';
        changed = true;
    }

    if (changed) {
        await flushPersistentState();
    }
}

async function prepareGeneration(tabId, pageContent, question) {
    const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
    await flushPendingLogs(settings);

    let sessionReset = false;
    let session = getSession(tabId);
    const tabInfo = await getTabSnapshot(tabId, pageContent);

    if (session) {
        const rotationReason = getRotationReason(session, tabInfo, settings, true);
        if (rotationReason) {
            await finalizeAndClearSession(tabId, rotationReason);
            session = null;
            sessionReset = true;
        }
    }

    if (session?.generatingState.isGenerating) {
        return {
            status: 'busy',
            error: '当前标签已有生成中的回复，请等待完成后再提问。'
        };
    }

    if (session?.reservation.requestId && !isReservationExpired(session.reservation)) {
        return {
            status: 'busy',
            error: '当前标签已有待开始的请求，请稍后重试。'
        };
    }

    if (!session) {
        session = createSession(tabInfo);
    } else {
        updateSessionPageInfo(session, tabInfo);
    }

    session.reservation = {
        requestId: createRequestId(),
        createdAt: new Date().toISOString()
    };
    session.sessionMeta.updatedAt = new Date().toISOString();
    await saveSession(tabId, session, true);

    return {
        status: 'ok',
        requestId: session.reservation.requestId,
        sessionReset,
        sessionId: session.sessionMeta.sessionId,
        question
    };
}

async function startGenerationFromPort(port, request) {
    const tabId = request.tabId;
    const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
    await flushPendingLogs(settings);

    let session = getSession(tabId);
    const tabInfo = await getTabSnapshot(tabId, request.pageContent || '');

    if (!session) {
        sendDirectMessage(port, {
            type: 'error',
            error: '会话已过期，请重新提问。'
        });
        return;
    }

    const rotationReason = getRotationReason(session, tabInfo, settings, true);
    if (rotationReason) {
        await finalizeAndClearSession(tabId, rotationReason);
        sendDirectMessage(port, {
            type: 'session-reset',
            reason: rotationReason
        });
        sendDirectMessage(port, {
            type: 'error',
            error: '会话已切换，请重新发送问题。'
        });
        return;
    }

    if (session.generatingState.isGenerating) {
        sendDirectMessage(port, {
            type: 'error',
            error: '当前标签已有生成中的回复，请等待完成后再提问。'
        });
        return;
    }

    if (!request.requestId || request.requestId !== session.reservation.requestId || isReservationExpired(session.reservation)) {
        sendDirectMessage(port, {
            type: 'error',
            error: '请求凭证已失效，请重新提问。'
        });
        return;
    }

    const question = (request.question || '').trim();
    if (!question) {
        sendDirectMessage(port, {
            type: 'error',
            error: '问题不能为空。'
        });
        return;
    }

    updateSessionPageInfo(session, tabInfo);
    session.history.push(createMessage(question, true));
    session.currentAnswer = '';
    session.completedAnswer = '';
    session.generatingState = {
        isGenerating: true,
        pendingQuestion: question,
        requestId: request.requestId,
        clientId: request.clientId || '',
        startedAt: new Date().toISOString()
    };
    session.reservation = { requestId: '', createdAt: '' };
    touchSession(session);
    await saveSession(tabId, session, true);

    if (request.sessionReset) {
        broadcastToTab(tabId, {
            type: 'session-reset',
            reason: 'new-session'
        });
    }

    await persistSessionLog(tabId, 'question-added', settings);
    await handleAnswerGeneration(tabId, request.pageContent || '', question, settings);
}

async function reconnectStream(port, request) {
    const session = getSession(request.tabId);

    if (!session) {
        sendDirectMessage(port, { type: 'answer-end' });
        return;
    }

    if (session.completedAnswer) {
        sendDirectMessage(port, {
            type: 'answer-chunk',
            content: session.completedAnswer
        });
        sendDirectMessage(port, { type: 'answer-end' });
        return;
    }

    if (session.currentAnswer) {
        sendDirectMessage(port, {
            type: 'answer-chunk',
            content: session.currentAnswer
        });
        return;
    }

    if (session.generatingState.isGenerating) {
        return;
    }

    sendDirectMessage(port, { type: 'answer-end' });
}

async function handleAnswerGeneration(tabId, pageContent, question, settings) {
    const session = getSession(tabId);
    if (!session) {
        return;
    }

    const abortController = new AbortController();
    runtimeControllers[String(tabId)] = abortController;

    try {
        const messages = buildMessagesForRequest(session, settings, pageContent, question);
        const model = settings[`${settings.apiType}_model`];
        const apiKey = settings[`${settings.apiType}_apiKey`];
        const apiBase = settings[`${settings.apiType}_apiBase`];

        if (!apiBase?.trim()) {
            throw new Error('请先在设置页填写请求URL');
        }

        if (!model?.trim()) {
            throw new Error('请先在设置页填写AI模型');
        }

        if (settings.apiType === 'custom' && !apiKey?.trim()) {
            throw new Error('请先在设置页填写API密钥');
        }

        const requestBody = buildRequestBody(settings, model, messages);
        const headers = {
            'Content-Type': 'application/json'
        };

        if (settings.apiType === 'custom' && apiKey) {
            headers.Authorization = `Bearer ${apiKey}`;
        }

        const response = await fetch(apiBase, {
            method: 'POST',
            headers,
            body: JSON.stringify(requestBody),
            signal: abortController.signal
        });

        if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            throw new Error(errorText || 'API请求失败');
        }

        const inputTokens = Math.ceil((settings.systemPrompt.length + pageContent.length + question.length) / 4);
        broadcastToTab(tabId, {
            type: 'input-tokens',
            tokens: inputTokens
        });

        const reader = response.body?.getReader();
        if (!reader) {
            throw new Error('响应流不可用');
        }

        const decoder = new TextDecoder();
        let buffer = '';
        let accumulatedResponse = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }

            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split('\n');
            buffer = parts.pop() || '';

            for (const rawLine of parts) {
                const content = processStreamLine(settings.apiType, rawLine);
                if (!content) {
                    continue;
                }

                accumulatedResponse += content;
                session.currentAnswer = accumulatedResponse;
                touchSession(session);
                schedulePersistentStateSave();

                broadcastToTab(tabId, {
                    type: 'answer-chunk',
                    content,
                    markdownContent: accumulatedResponse,
                    tokens: Math.ceil(content.length / 4)
                });
            }
        }

        const remainingContent = processStreamLine(settings.apiType, buffer);
        if (remainingContent) {
            accumulatedResponse += remainingContent;
            session.currentAnswer = accumulatedResponse;
            touchSession(session);
        }

        session.history.push(createMessage(accumulatedResponse, false));
        session.completedAnswer = accumulatedResponse;
        session.currentAnswer = accumulatedResponse;
        session.generatingState = createIdleGeneratingState();
        touchSession(session);
        await saveSession(tabId, session, true);

        await persistSessionLog(tabId, 'answer-complete', settings);

        broadcastToTab(tabId, {
            type: 'answer-end',
            markdownContent: accumulatedResponse
        });
    } catch (error) {
        if (error.name === 'AbortError') {
            const latestSession = getSession(tabId);
            if (latestSession) {
                latestSession.generatingState = createIdleGeneratingState();
                latestSession.completedAnswer = latestSession.currentAnswer;
                touchSession(latestSession);
                await saveSession(tabId, latestSession, true);
                await persistSessionLog(tabId, 'answer-stopped', settings);
            }

            broadcastToTab(tabId, {
                type: 'answer-stopped',
                markdownContent: getSession(tabId)?.currentAnswer || ''
            });
        } else {
            console.error('生成回答时出错:', error);
            const latestSession = getSession(tabId);

            if (latestSession) {
                latestSession.history.push(createMessage(`发生错误：${error.message}`, false));
                latestSession.generatingState = createIdleGeneratingState();
                touchSession(latestSession);
                await saveSession(tabId, latestSession, true);
                await persistSessionLog(tabId, 'answer-error', settings);
            }

            broadcastToTab(tabId, {
                type: 'error',
                error: error.message
            });
        }
    } finally {
        delete runtimeControllers[String(tabId)];
    }
}

async function stopGeneration(tabId, reason) {
    const session = getSession(tabId);
    if (!session?.generatingState.isGenerating) {
        return { status: 'idle' };
    }

    const controller = runtimeControllers[String(tabId)];
    if (controller) {
        controller.abort(reason);
        return { status: 'stopping' };
    }

    session.generatingState = createIdleGeneratingState();
    touchSession(session);
    await saveSession(tabId, session, true);
    return { status: 'idle' };
}

function buildMessagesForRequest(session, settings, pageContent, question) {
    const history = settings.enableContext
        ? session.history.slice(-(Math.max(1, settings.maxContextRounds) * 2))
        : [];

    return [
        {
            role: 'system',
            content: settings.systemPrompt
        },
        ...history.map((message) => ({
            role: message.isUser ? 'user' : 'assistant',
            content: message.markdownContent || message.content
        })),
        {
            role: 'user',
            content: `基于以下网页内容回答问题：\n\n${pageContent}\n\n问题：${question}`
        }
    ];
}

function buildRequestBody(settings, model, messages) {
    if (settings.apiType === 'ollama') {
        return {
            model,
            messages,
            stream: true,
            options: {
                temperature: settings.temperature,
                num_predict: settings.maxTokens
            }
        };
    }

    return {
        model,
        messages,
        max_tokens: settings.maxTokens,
        temperature: settings.temperature,
        stream: true
    };
}

function buildHistoryResponse(session) {
    if (!session) {
        return {
            history: [],
            isGenerating: false,
            pendingQuestion: '',
            currentAnswer: ''
        };
    }

    return {
        history: session.history,
        isGenerating: session.generatingState.isGenerating,
        pendingQuestion: session.generatingState.pendingQuestion,
        currentAnswer: session.currentAnswer || '',
        sessionId: session.sessionMeta.sessionId
    };
}

async function getTabSnapshot(tabId, pageContent = '') {
    let tab = null;

    try {
        tab = await chrome.tabs.get(tabId);
    } catch (error) {
        console.warn('读取标签页信息失败:', error);
    }

    const pageUrl = tab?.url || `tab://${tabId}`;
    return {
        pageUrl,
        pageTitle: tab?.title || '未命名页面',
        pageDomain: extractHostname(pageUrl),
        pageContentExcerpt: buildPageContentExcerpt(pageContent),
        pageContentLength: pageContent.length
    };
}

function createSession(tabInfo) {
    const now = new Date().toISOString();
    return normalizeSession({
        sessionMeta: {
            sessionId: createSessionId(tabInfo.pageTitle),
            startedAt: now,
            updatedAt: now,
            lastActivityAt: now,
            pageUrl: tabInfo.pageUrl,
            pageTitle: tabInfo.pageTitle,
            pageDomain: tabInfo.pageDomain,
            pageContentExcerpt: tabInfo.pageContentExcerpt,
            pageContentLength: tabInfo.pageContentLength
        },
        history: [],
        generatingState: createIdleGeneratingState(),
        currentAnswer: '',
        completedAnswer: '',
        reservation: {
            requestId: '',
            createdAt: ''
        }
    });
}

function updateSessionPageInfo(session, tabInfo) {
    session.sessionMeta.pageUrl = tabInfo.pageUrl;
    session.sessionMeta.pageTitle = tabInfo.pageTitle;
    session.sessionMeta.pageDomain = tabInfo.pageDomain;

    if (tabInfo.pageContentExcerpt) {
        session.sessionMeta.pageContentExcerpt = tabInfo.pageContentExcerpt;
        session.sessionMeta.pageContentLength = tabInfo.pageContentLength;
    }
}

function touchSession(session) {
    const now = new Date().toISOString();
    session.sessionMeta.updatedAt = now;
    session.sessionMeta.lastActivityAt = now;
}

function createIdleGeneratingState() {
    return {
        isGenerating: false,
        pendingQuestion: '',
        requestId: '',
        clientId: '',
        startedAt: ''
    };
}

function createMessage(content, isUser) {
    return {
        content,
        markdownContent: content,
        isUser,
        createdAt: new Date().toISOString()
    };
}

function processStreamLine(apiType, rawLine) {
    const line = rawLine.trim();
    if (!line) {
        return '';
    }

    const payload = line.startsWith('data:') ? line.slice(5).trim() : line;
    if (!payload || payload === '[DONE]') {
        return '';
    }

    try {
        return extractContentFromChunk(apiType, JSON.parse(payload));
    } catch (parseError) {
        console.warn('解析响应块失败:', parseError, payload);
        return '';
    }
}

function extractContentFromChunk(apiType, parsed) {
    if (apiType === 'ollama') {
        return parsed.message?.content || '';
    }
    return parsed.choices?.[0]?.delta?.content || '';
}

function extractHostname(rawUrl) {
    try {
        return new URL(rawUrl).hostname || 'unknown';
    } catch (error) {
        return 'unknown';
    }
}

function buildPageContentExcerpt(pageContent = '') {
    return pageContent.replace(/\s+/g, ' ').trim().slice(0, 1500);
}

function createSessionId(pageTitle) {
    const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const titlePart = slugify(pageTitle).slice(0, 24) || 'webchat';
    const randomPart = Math.random().toString(36).slice(2, 8);
    return `lingsi-${timestamp}-${titlePart}-${randomPart}`;
}

function createRequestId() {
    return `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function slugify(text = '') {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function isReservationExpired(reservation) {
    if (!reservation?.requestId || !reservation?.createdAt) {
        return true;
    }
    return Date.now() - new Date(reservation.createdAt).getTime() > 60 * 1000;
}

function getRotationReason(session, tabInfo, settings, forQuestion) {
    if (session.sessionMeta.pageUrl && tabInfo.pageUrl && session.sessionMeta.pageUrl !== tabInfo.pageUrl) {
        return 'page-changed';
    }

    if (!forQuestion) {
        return '';
    }

    const lastActivityAt = new Date(session.sessionMeta.lastActivityAt).getTime();
    const idleMs = Math.max(1, settings.sessionIdleMinutes) * 60 * 1000;

    if (session.history.length > 0 && Date.now() - lastActivityAt >= idleMs) {
        return 'idle-timeout';
    }

    return '';
}

async function rotateSessionIfPageChanged(tabId) {
    const session = getSession(tabId);
    if (!session) {
        return;
    }

    const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
    const tabInfo = await getTabSnapshot(tabId);
    const rotationReason = getRotationReason(session, tabInfo, settings, false);

    if (rotationReason) {
        await finalizeAndClearSession(tabId, rotationReason);
    }
}

function registerPort(tabId, port) {
    const key = String(tabId);
    if (!runtimePorts[key]) {
        runtimePorts[key] = new Set();
    }
    runtimePorts[key].add(port);
    port.__tabId = key;
}

function unregisterPort(port) {
    const tabId = port.__tabId;
    if (!tabId || !runtimePorts[tabId]) {
        return;
    }

    runtimePorts[tabId].delete(port);
    if (runtimePorts[tabId].size === 0) {
        delete runtimePorts[tabId];
    }
}

function sendDirectMessage(port, message) {
    try {
        port.postMessage(message);
    } catch (error) {
        unregisterPort(port);
    }
}

function broadcastToTab(tabId, message) {
    const ports = runtimePorts[String(tabId)];
    if (!ports) {
        return;
    }

    for (const port of [...ports]) {
        sendDirectMessage(port, message);
    }
}

async function finalizeAndClearSession(tabId, reason) {
    const session = getSession(tabId);
    if (!session) {
        return;
    }

    const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);

    if (session.generatingState.isGenerating) {
        const controller = runtimeControllers[String(tabId)];
        if (controller) {
            controller.abort(reason);
        }
        session.generatingState = createIdleGeneratingState();
    }

    session.sessionMeta.lastRotationReason = reason;
    touchSession(session);
    await saveSession(tabId, session, true);
    await persistSessionLog(tabId, reason, settings);
    await deleteSession(tabId, true);
}

async function persistSessionLog(tabId, reason, providedSettings = null) {
    const session = getSession(tabId);
    if (!session || session.history.length === 0) {
        return;
    }

    const settings = providedSettings || await chrome.storage.sync.get(DEFAULT_SETTINGS);
    if (!settings.enableSessionLogging) {
        return;
    }

    await flushPendingLogs(settings);

    const model = settings[`${settings.apiType}_model`];
    const payload = {
        version: chrome.runtime.getManifest().version,
        savedAt: new Date().toISOString(),
        reason,
        outputDir: settings.sessionLogOutputDir,
        workspaceRoot: settings.sessionLogWorkspaceRoot,
        session: {
            sessionId: session.sessionMeta.sessionId,
            startedAt: session.sessionMeta.startedAt,
            updatedAt: session.sessionMeta.updatedAt,
            status: session.generatingState.isGenerating ? 'generating' : 'completed',
            page: {
                title: session.sessionMeta.pageTitle,
                url: session.sessionMeta.pageUrl,
                domain: session.sessionMeta.pageDomain,
                excerpt: session.sessionMeta.pageContentExcerpt,
                contentLength: session.sessionMeta.pageContentLength
            },
            assistant: {
                apiType: settings.apiType,
                model,
                temperature: settings.temperature,
                maxTokens: settings.maxTokens,
                enableContext: settings.enableContext,
                maxContextRounds: settings.maxContextRounds
            },
            messages: session.history.map((message, index) => ({
                index: index + 1,
                role: message.isUser ? 'user' : 'assistant',
                content: message.markdownContent || message.content,
                createdAt: message.createdAt
            })),
            messageCount: session.history.length,
            turnCount: Math.ceil(session.history.length / 2)
        }
    };

    try {
        const result = await postSessionLog(settings, payload);
        if (result?.filePath) {
            session.sessionMeta.outputFilePath = result.filePath;
            await saveSession(tabId, session, true);
        }
    } catch (error) {
        console.warn('同步会话日志失败，已加入待重试队列:', error);
        pendingLogsState[session.sessionMeta.sessionId] = payload;
        await flushPersistentState();
    }
}

async function postSessionLog(settings, payload) {
    const response = await fetch(settings.sessionLogEndpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(errorText || `HTTP ${response.status}`);
    }

    return await response.json().catch(() => null);
}

async function flushPendingLogs(settings) {
    const entries = Object.entries(pendingLogsState);
    if (entries.length === 0 || !settings.enableSessionLogging) {
        return;
    }

    let changed = false;

    for (const [sessionId, payload] of entries) {
        try {
            await postSessionLog(settings, payload);
            delete pendingLogsState[sessionId];
            changed = true;
        } catch (error) {
            console.warn('重试待写日志失败:', error);
            break;
        }
    }

    if (changed) {
        await flushPersistentState();
    }
}
