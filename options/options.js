// API类型的默认配置
const API_CONFIGS = {
    custom: {
        apiBase: '',
        modelPlaceholder: '例如：gpt-4.1-mini',
        requiresKey: true,
        apiBasePlaceholder: '例如：https://your-openai-compatible-endpoint/v1/chat/completions',
        apiKeyPlaceholder: '请输入API密钥',
        modelHelp: '填写你所使用的模型标识，例如：gpt-4.1-mini'
    },
    ollama: {
        apiBase: 'http://127.0.0.1:11434/api/chat',
        modelPlaceholder: 'qwen2.5',
        requiresKey: false,
        apiBasePlaceholder: 'http://127.0.0.1:11434/api/chat',
        apiKeyPlaceholder: '本地模型无需API密钥',
        modelHelp: '常用模型：qwen2.5, llama2, mistral, gemma, codellama等。使用前请确保已安装模型：ollama pull qwen2.5'
    }
};

// 测试API配置
async function testApiConfig(settings) {
    try {
        // 设置基础headers
        let headers = {
            'Content-Type': 'application/json'
        };

        // 如果是自定义API，添加Authorization头
        if (settings.apiType === 'custom') {
            if (!settings.apiKey) {
                throw new Error('API密钥是必填项');
            }
            headers['Authorization'] = `Bearer ${settings.apiKey}`;
        }

        let requestBody;
        if (settings.apiType === 'ollama') {
            // Ollama API 格式
            requestBody = {
                model: settings.model,
                messages: [
                    {
                        role: "system",
                        content: "你是一个帮助理解网页内容的AI助手。"
                    },
                    {
                        role: "user",
                        content: "这是一条测试消息，请回复：API配置测试成功"
                    }
                ],
                stream: false,
                options: {
                    temperature: settings.temperature || 0.7,
                    num_predict: 50
                }
            };
        } else {
            // OpenAI API 格式
            requestBody = {
                model: settings.model,
                messages: [
                    {
                        role: "system",
                        content: "你是一个帮助理解网页内容的AI助手。"
                    },
                    {
                        role: "user",
                        content: "这是一条测试消息，请回复：API配置测试成功"
                    }
                ],
                max_tokens: 50,
                temperature: 0.7,
                stream: false
            };
        }

        const response = await fetch(settings.apiBase, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errorText = await response.text();
            try {
                const errorJson = JSON.parse(errorText);
                throw new Error(errorJson.error?.message || '请求失败');
            } catch (e) {
                if (settings.apiType === 'ollama') {
                    throw new Error(
                        `无法连接到Ollama服务。请检查：\n` +
                        `1. Ollama是否已正确安装\n` +
                        `2. 服务是否已启动：\n` +
                        `   OLLAMA_ORIGINS=* ollama serve\n` +
                        `3. 服务地址是否正确(默认：http://127.0.0.1:11434)\n` +
                        `4. 是否允许跨域请求(OLLAMA_ORIGINS=*)\n` +
                        `5. 是否已安装所需的模型：ollama pull ${settings.model}\n` +
                        `6. 如果问题持续，可以尝试重启Ollama服务`
                    );
                }
                throw new Error(`请求失败: ${errorText}`);
            }
        }

        const data = await response.json();

        // 根据不同的API类型验证响应
        if (settings.apiType === 'ollama') {
            if (data.error) {
                throw new Error(data.error);
            }
            // Ollama API 响应验证
            if (!data.message || !data.message.content) {
                throw new Error('无效的API响应格式');
            }
        } else {
            // OpenAI API 响应验证
            if (!data.choices || !data.choices[0].message) {
                throw new Error('无效的API响应格式');
            }
        }

        return true;
    } catch (error) {
        if (error.message.includes('Failed to fetch') && settings.apiType === 'ollama') {
            throw new Error(
                `无法连接到Ollama服务。请检查：\n` +
                `1. Ollama是否已正确安装\n` +
                `2. 服务是否已启动：\n` +
                `   OLLAMA_ORIGINS=* ollama serve\n` +
                `3. 服务地址是否正确(默认：http://127.0.0.1:11434)\n` +
                `4. 是否允许跨域请求(OLLAMA_ORIGINS=*)\n` +
                `5. 是否已安装所需的模型：ollama pull ${settings.model}\n` +
                `6. 如果问题持续，可以尝试重启Ollama服务`
            );
        }
        throw new Error(`API测试失败: ${error.message}`);
    }
}

function buildHealthUrl(endpoint) {
    try {
        const url = new URL(endpoint);
        url.pathname = '/health';
        url.search = '';
        url.hash = '';
        return url.toString();
    } catch (error) {
        throw new Error('日志服务地址格式无效');
    }
}

async function testSessionLogConfig(settings) {
    if (!settings.enableSessionLogging) {
        return true;
    }

    if (!settings.sessionLogEndpoint.trim()) {
        throw new Error('日志服务地址是必填项');
    }

    if (!settings.sessionLogOutputDir.trim()) {
        throw new Error('日志输出目录是必填项');
    }

    const response = await fetch(buildHealthUrl(settings.sessionLogEndpoint), {
        method: 'GET'
    });

    if (!response.ok) {
        throw new Error(`日志服务不可用: HTTP ${response.status}`);
    }

    const data = await response.json();

    if (!data.ok) {
        throw new Error(data.error || '日志服务状态异常');
    }

    return true;
}

// 更新界面显示
function updateApiTypeUI(apiType) {
    const config = API_CONFIGS[apiType];
    const apiKeyGroup = document.querySelector('.api-key-group');
    const apiBaseInput = document.getElementById('apiBase');
    const modelInput = document.getElementById('model');
    const apiKeyInput = document.getElementById('apiKey');

    // 从存储中加载当前API类型的配置
    chrome.storage.sync.get({
        [`${apiType}_apiKey`]: '',
        [`${apiType}_apiBase`]: apiType === 'custom' ? DEFAULT_SETTINGS.custom_apiBase : config.apiBase,
        [`${apiType}_model`]: apiType === 'custom' ? DEFAULT_SETTINGS.custom_model : config.modelPlaceholder,
    }, (items) => {
        // 更新API密钥输入框
        apiKeyGroup.style.display = config.requiresKey ? 'block' : 'none';
        apiKeyInput.placeholder = config.apiKeyPlaceholder;
        apiKeyInput.value = items[`${apiType}_apiKey`];

        // 更新API请求URL输入框
        apiBaseInput.value = items[`${apiType}_apiBase`];
        apiBaseInput.placeholder = config.apiBasePlaceholder;
        document.getElementById('apiBaseHelp').textContent = `${apiType === 'ollama' ? '本地' : ''} API接口地址`;

        // 更新模型输入框
        modelInput.value = items[`${apiType}_model`];
        modelInput.placeholder = config.modelPlaceholder;
        document.getElementById('modelHelp').textContent = config.modelHelp;
    });
}

// 显示状态消息
function showStatus(message, type = 'success') {
    const status = document.getElementById('status');
    status.textContent = message;
    status.className = `status ${type}`; // type可以是 'success', 'error', 或 'warning'
    status.style.display = 'block';

    // 只有在显示"正在测试API配置..."的临时消息时才自动隐藏
    if (message === '正在测试API配置...') {
        setTimeout(() => {
            // 确保还是显示的同一条消息时才隐藏
            if (status.textContent === message) {
                status.style.display = 'none';
            }
        }, 2000);
    }
}

// 验证设置
function validateSettings(settings) {
    const config = API_CONFIGS[settings.apiType];

    if (!settings.apiBase.trim()) {
        throw new Error('请求URL是必填项');
    }
    if (!settings.model.trim()) {
        throw new Error('AI模型是必填项');
    }
    if (config.requiresKey && !settings.apiKey.trim()) {
        throw new Error('API密钥是必填项');
    }
}

// 验证数值范围（添加对小数的支持）
function validateNumberInput(input, min, max, isFloat = false) {
    // 对于浮点数，先检查是否是有效的数字格式
    if (isFloat) {
        // 允许输入中包含小数点
        if (input.value === '.' || input.value === '') {
            return true; // 允许继续输入
        }
        const value = parseFloat(input.value);
        if (isNaN(value)) {
            input.classList.add('invalid');
            showStatus(`请输入有效的数字`, true);
            return false;
        }
        if (value < min || value > max) {
            input.classList.add('invalid');
            showStatus(`请输入${min}~${max}之间的数值`, true);
            return false;
        }
    } else {
        const value = parseInt(input.value);
        if (isNaN(value) || value < min || value > max) {
            input.classList.add('invalid');
            showStatus(`请输入${min}~${max}之间的数值`, true);
            return false;
        }
    }

    // 验证通过，移除错误状态和提示
    input.classList.remove('invalid');
    const status = document.getElementById('status');
    if (status.classList.contains('error')) {
        status.style.display = 'none';
    }
    return true;
}

// 更新温度显示
function updateTemperatureDisplay(value) {
    document.getElementById('temperatureRange').value = value;
    document.getElementById('temperatureInput').value = value;
}

// 更新最大回复长度显示
function updateMaxTokensDisplay(value) {
    document.getElementById('maxTokensRange').value = value;
    document.getElementById('maxTokensInput').value = value;
}

// 保存设置到Chrome存储
async function saveOptions() {
    const apiType = document.getElementById('apiType').value;
    const settings = {
        apiType,
        maxTokens: parseInt(document.getElementById('maxTokensInput').value),
        temperature: parseFloat(document.getElementById('temperatureInput').value),
        enableSessionLogging: document.getElementById('enableSessionLogging').checked,
        sessionLogEndpoint: document.getElementById('sessionLogEndpoint').value.trim() || DEFAULT_SETTINGS.sessionLogEndpoint,
        sessionLogOutputDir: document.getElementById('sessionLogOutputDir').value.trim() || DEFAULT_SETTINGS.sessionLogOutputDir,
        sessionLogWorkspaceRoot: document.getElementById('sessionLogWorkspaceRoot').value.trim() || DEFAULT_SETTINGS.sessionLogWorkspaceRoot,
        sessionIdleMinutes: parseInt(document.getElementById('sessionIdleMinutes').value, 10) || DEFAULT_SETTINGS.sessionIdleMinutes,
        // 存储当前API类型的配置
        [`${apiType}_apiKey`]: document.getElementById('apiKey').value.trim(),
        [`${apiType}_apiBase`]: apiType === 'custom'
            ? document.getElementById('apiBase').value.trim()
            : (document.getElementById('apiBase').value.trim() || API_CONFIGS[apiType].apiBase),
        [`${apiType}_model`]: document.getElementById('model').value.trim()
    };

    // 添加当前活动的配置到settings中
    settings.activeConfig = {
        apiKey: settings[`${apiType}_apiKey`],
        apiBase: settings[`${apiType}_apiBase`],
        model: settings[`${apiType}_model`]
    };

    try {
        // 验证必填项
        validateSettings({
            apiType,
            apiKey: settings[`${apiType}_apiKey`],
            apiBase: settings[`${apiType}_apiBase`],
            model: settings[`${apiType}_model`]
        });

        // 显示测试中状态
        showStatus('正在测试API配置...');

        // 测试API配置
        await testApiConfig({
            apiType,
            apiKey: settings[`${apiType}_apiKey`],
            apiBase: settings[`${apiType}_apiBase`],
            model: settings[`${apiType}_model`]
        });

        await testSessionLogConfig(settings);

        // 保存设置
        await chrome.storage.sync.set(settings);

        // 显示成功消息（不会自动消失）
        showStatus('✅ API配置和日志配置测试成功，设置已保存');
    } catch (error) {
        // 显示错误消息（不会自动消失）
        showStatus(error.message, 'error');
    }
}

// 从Chrome存储加载设置
function loadOptions() {
    chrome.storage.sync.get({
        apiType: 'custom',
        maxTokens: 2048,
        temperature: 0.7,
        // 自定义API的默认配置
        custom_apiKey: '',
        custom_apiBase: '',
        custom_model: '',
        // ollama的默认配置
        ollama_apiKey: '',
        ollama_apiBase: API_CONFIGS.ollama.apiBase,
        ollama_model: API_CONFIGS.ollama.modelPlaceholder,
        enableSessionLogging: true,
        sessionLogEndpoint: 'http://127.0.0.1:8765/log-session',
        sessionLogOutputDir: '~/webchat-session-logs',
        sessionLogWorkspaceRoot: '~/webchat-workspace',
        sessionIdleMinutes: 30
    }, (items) => {
        document.getElementById('apiType').value = items.apiType;
        document.getElementById('enableSessionLogging').checked = items.enableSessionLogging;
        document.getElementById('sessionLogEndpoint').value = items.sessionLogEndpoint;
        document.getElementById('sessionLogOutputDir').value = items.sessionLogOutputDir;
        document.getElementById('sessionLogWorkspaceRoot').value = items.sessionLogWorkspaceRoot;
        document.getElementById('sessionIdleMinutes').value = items.sessionIdleMinutes;
        document.getElementById('sessionLogSettings').style.display = items.enableSessionLogging ? 'block' : 'none';

        // 确保正确更新maxTokens显示
        const maxTokensRange = document.getElementById('maxTokensRange');
        const maxTokensInput = document.getElementById('maxTokensInput');
        maxTokensRange.value = items.maxTokens;
        maxTokensInput.value = items.maxTokens;

        // 更新温度显示
        updateTemperatureDisplay(items.temperature);

        updateApiTypeUI(items.apiType);
    });
}

// 在现有代码中添加默认设置常量
const DEFAULT_SETTINGS = {
    apiType: 'custom',
    maxTokens: 2048,
    temperature: 0.7,
    custom_apiKey: '',
    custom_apiBase: '',
    custom_model: '',
    ollama_apiKey: 'ollama',
    ollama_apiBase: 'http://127.0.0.1:11434/api/chat',
    ollama_model: 'llama2',
    enableSessionLogging: true,
    sessionLogEndpoint: 'http://127.0.0.1:8765/log-session',
    sessionLogOutputDir: '~/webchat-session-logs',
    sessionLogWorkspaceRoot: '~/webchat-workspace',
    sessionIdleMinutes: 30
};

// 修改还原设置函数
async function resetOptions() {
    try {
        // 直接保存默认设置到存储
        await chrome.storage.sync.set({
            ...DEFAULT_SETTINGS,
            // 添加activeConfig
            activeConfig: {
                apiKey: DEFAULT_SETTINGS.custom_apiKey,
                apiBase: DEFAULT_SETTINGS.custom_apiBase,
                model: DEFAULT_SETTINGS.custom_model
            }
        });

        // 更新UI显示
        document.getElementById('apiType').value = DEFAULT_SETTINGS.apiType;
        document.getElementById('apiKey').value = DEFAULT_SETTINGS.custom_apiKey;
        document.getElementById('apiBase').value = DEFAULT_SETTINGS.custom_apiBase;
        document.getElementById('model').value = DEFAULT_SETTINGS.custom_model;
        document.getElementById('enableSessionLogging').checked = DEFAULT_SETTINGS.enableSessionLogging;
        document.getElementById('sessionLogEndpoint').value = DEFAULT_SETTINGS.sessionLogEndpoint;
        document.getElementById('sessionLogOutputDir').value = DEFAULT_SETTINGS.sessionLogOutputDir;
        document.getElementById('sessionLogWorkspaceRoot').value = DEFAULT_SETTINGS.sessionLogWorkspaceRoot;
        document.getElementById('sessionIdleMinutes').value = DEFAULT_SETTINGS.sessionIdleMinutes;
        document.getElementById('sessionLogSettings').style.display = 'block';
        updateMaxTokensDisplay(DEFAULT_SETTINGS.maxTokens);
        updateTemperatureDisplay(DEFAULT_SETTINGS.temperature);

        // 强制更新输入框显示
        const apiKeyInput = document.getElementById('apiKey');
        const apiBaseInput = document.getElementById('apiBase');
        const modelInput = document.getElementById('model');

        // 设置输入框的值和占位符
        apiKeyInput.value = DEFAULT_SETTINGS.custom_apiKey;
        apiKeyInput.placeholder = API_CONFIGS.custom.apiKeyPlaceholder;

        apiBaseInput.value = DEFAULT_SETTINGS.custom_apiBase;
        apiBaseInput.placeholder = API_CONFIGS.custom.apiBasePlaceholder;

        modelInput.value = DEFAULT_SETTINGS.custom_model;
        modelInput.placeholder = API_CONFIGS.custom.modelPlaceholder;

        // 更新帮助文本
        document.getElementById('apiBaseHelp').textContent = 'API接口地址';
        document.getElementById('modelHelp').textContent = API_CONFIGS.custom.modelHelp;

        // 确保API密钥输入组可见（因为默认是custom类型）
        document.querySelector('.api-key-group').style.display = 'block';

        // 示成功提示
        showStatus('已还原并保存默认设置。注意：使用前请先配置必要的API信息并测试。', 'warning');
    } catch (error) {
        showStatus('还原设置失败：' + error.message, 'error');
    }
}

// 事件监听器
document.addEventListener('DOMContentLoaded', async () => {
    loadOptions();

    const apiType = document.getElementById('apiType');
    const maxTokensRange = document.getElementById('maxTokensRange');
    const maxTokensInput = document.getElementById('maxTokensInput');
    const temperatureRange = document.getElementById('temperatureRange');
    const temperatureInput = document.getElementById('temperatureInput');
    const saveButton = document.getElementById('save');
    const resetButton = document.getElementById('reset');
    const toggleApiKeyBtn = document.getElementById('toggleApiKey');
    const apiKeyInput = document.getElementById('apiKey');
    const autoHideDialog = document.getElementById('autoHideDialog');
    const enableContext = document.getElementById('enableContext');
    const maxContextRounds = document.getElementById('maxContextRounds');
    const systemPrompt = document.getElementById('systemPrompt');
    const contextSettings = document.getElementById('contextSettings');
    const enableSessionLogging = document.getElementById('enableSessionLogging');
    const sessionLogSettings = document.getElementById('sessionLogSettings');
    const testSessionLogButton = document.getElementById('testSessionLog');
    const sessionLogEndpoint = document.getElementById('sessionLogEndpoint');
    const sessionLogOutputDir = document.getElementById('sessionLogOutputDir');
    const sessionLogWorkspaceRoot = document.getElementById('sessionLogWorkspaceRoot');
    const sessionIdleMinutes = document.getElementById('sessionIdleMinutes');

    apiType.addEventListener('change', (e) => {
        updateApiTypeUI(e.target.value);
    });

    maxTokensRange.addEventListener('input', (e) => {
        updateMaxTokensDisplay(e.target.value);
    });

    maxTokensInput.addEventListener('input', (e) => {
        if (validateNumberInput(e.target, 128, 4096)) {
            updateMaxTokensDisplay(e.target.value);
        }
    });

    temperatureRange.addEventListener('input', (e) => {
        updateTemperatureDisplay(e.target.value);
    });

    temperatureInput.addEventListener('input', (e) => {
        if (!/^[0-9.]*$/.test(e.target.value)) {
            e.target.value = e.target.value.replace(/[^0-9.]/g, '');
        }

        const dots = e.target.value.match(/\./g);

        if (dots && dots.length > 1) {
            e.target.value = e.target.value.replace(/\.+/g, '.');
        }

        if (validateNumberInput(e.target, 0, 1, true) && !isNaN(parseFloat(e.target.value))) {
            updateTemperatureDisplay(e.target.value);
        }
    });

    temperatureInput.addEventListener('blur', (e) => {
        const value = parseFloat(e.target.value);

        if (isNaN(value) || value < 0 || value > 1) {
            updateTemperatureDisplay(temperatureRange.value);
            return;
        }

        updateTemperatureDisplay(Math.round(value * 10) / 10);
    });

    saveButton.addEventListener('click', async () => {
        if (!validateNumberInput(maxTokensInput, 128, 4096) ||
            !validateNumberInput(temperatureInput, 0, 1, true)) {
            return;
        }

        await saveOptions();
    });

    let isVisible = false;
    apiKeyInput.type = 'password';
    toggleApiKeyBtn.title = '点击显示';

    toggleApiKeyBtn.addEventListener('click', () => {
        isVisible = !isVisible;
        apiKeyInput.type = isVisible ? 'text' : 'password';

        toggleApiKeyBtn.innerHTML = `
            <span class="eye-icon">
                ${isVisible ? `
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/>
                    </svg>
                ` : `
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z"/>
                    </svg>
                `}
            </span>
        `;
    });

    resetButton.addEventListener('click', () => {
        if (confirm('确定要还原所有设置到默认值吗？\n注意：\n1. 所有设置将被立即还原并保存\n2. 使用前请先配置必要的API信息\n3. 请记得测试API配置是否正确')) {
            resetOptions();
        }
    });

    chrome.storage.sync.get({
        autoHideDialog: true,
        enableContext: true,
        maxContextRounds: 3,
        systemPrompt: '你是一个帮助理解网页内容的AI助手。请使用Markdown格式回复。'
    }, (items) => {
        autoHideDialog.checked = items.autoHideDialog;
        enableContext.checked = items.enableContext;
        maxContextRounds.value = items.maxContextRounds;
        systemPrompt.value = items.systemPrompt;
        contextSettings.style.display = items.enableContext ? 'block' : 'none';
    });

    enableContext.addEventListener('change', () => {
        const isEnabled = enableContext.checked;
        contextSettings.style.display = isEnabled ? 'block' : 'none';
        chrome.storage.sync.set({ enableContext: isEnabled });
    });

    maxContextRounds.addEventListener('change', () => {
        let value = parseInt(maxContextRounds.value, 10);
        value = Math.max(1, Math.min(10, value));
        maxContextRounds.value = value;
        chrome.storage.sync.set({ maxContextRounds: value });
    });

    enableSessionLogging.addEventListener('change', () => {
        const isEnabled = enableSessionLogging.checked;
        sessionLogSettings.style.display = isEnabled ? 'block' : 'none';
        chrome.storage.sync.set({ enableSessionLogging: isEnabled });
    });

    testSessionLogButton.addEventListener('click', async () => {
        try {
            showStatus('正在测试日志服务...');
            await testSessionLogConfig({
                enableSessionLogging: enableSessionLogging.checked,
                sessionLogEndpoint: sessionLogEndpoint.value.trim() || DEFAULT_SETTINGS.sessionLogEndpoint,
                sessionLogOutputDir: sessionLogOutputDir.value.trim() || DEFAULT_SETTINGS.sessionLogOutputDir,
                sessionLogWorkspaceRoot: sessionLogWorkspaceRoot.value.trim() || DEFAULT_SETTINGS.sessionLogWorkspaceRoot
            });
            showStatus('✅ 日志服务可用，后续会话会写入本地 Markdown');
        } catch (error) {
            showStatus(error.message, 'error');
        }
    });

    sessionIdleMinutes.addEventListener('change', () => {
        let value = parseInt(sessionIdleMinutes.value, 10);
        value = Math.max(1, Math.min(720, value || DEFAULT_SETTINGS.sessionIdleMinutes));
        sessionIdleMinutes.value = value;
        chrome.storage.sync.set({ sessionIdleMinutes: value });
    });

    let promptTimeout;
    systemPrompt.addEventListener('input', () => {
        if (promptTimeout) {
            clearTimeout(promptTimeout);
        }

        promptTimeout = setTimeout(() => {
            chrome.storage.sync.set({
                systemPrompt: systemPrompt.value || '你是一个帮助理解网页内容的AI助手。请使用Markdown格式回复。'
            });
        }, 1000);
    });

    let saveTimeout;
    const debounceSave = (value) => {
        if (saveTimeout) {
            clearTimeout(saveTimeout);
        }

        saveTimeout = setTimeout(() => {
            chrome.storage.sync.set({ autoHideDialog: value });
        }, 1000);
    };

    autoHideDialog.addEventListener('change', () => {
        debounceSave(autoHideDialog.checked);
    });
});
