// --- DOM Elements (Assumed to be globally accessible or passed) ---
const toolListDiv = document.getElementById('tool-list');
const saveToolConfigButton = document.getElementById('save-tool-config-button');
let serverToolnameSeparator = '__';

function applyToolFilters() {
    const search = document.getElementById('tool-search-input')?.value.trim().toLowerCase() || '';
    const server = document.getElementById('tool-server-filter')?.value || '';
    const status = document.getElementById('tool-status-filter')?.value || '';
    const type = document.getElementById('tool-type-filter')?.value || '';
    const entries = [...(toolListDiv?.querySelectorAll('.tool-entry') || [])];
    let shown = 0;
    entries.forEach(entry => {
        const matches = (!search || entry.dataset.search.includes(search)) &&
            (!server || entry.dataset.server === server) &&
            (!status || entry.dataset.status === status) &&
            (!type || entry.dataset.type === type);
        entry.hidden = !matches;
        if (matches) shown += 1;
    });
    const summary = document.getElementById('tool-filter-summary');
    if (summary) summary.textContent = entries.length ? `${shown} of ${entries.length} tools shown` : '';
    let empty = toolListDiv?.querySelector('.tool-filter-empty');
    if (entries.length && shown === 0 && !empty) {
        empty = document.createElement('div');
        empty.className = 'tool-filter-empty alert';
        empty.textContent = 'No tools match these filters.';
        toolListDiv?.appendChild(empty);
    } else if (shown > 0 && empty) {
        empty.remove();
    }
}

function populateToolServerFilter() {
    const filter = document.getElementById('tool-server-filter');
    if (!filter) return;
    const selected = filter.value;
    const servers = [...new Set([...(window.discoveredTools || []).map(tool => tool.serverName), ...Object.keys(window.currentToolConfig?.tools || {}).map(key => key.split(serverToolnameSeparator)[0])])]
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
    filter.innerHTML = '<option value="">All servers</option>' + servers.map(server => `<option value="${escapeHtml(server)}">${escapeHtml(window.currentServerConfig?.mcpServers?.[server]?.name || server)}</option>`).join('');
    filter.value = servers.includes(selected) ? selected : '';
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function formatJson(value) {
    if (value === undefined || value === null || value === '') return '';
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
}

function renderJsonPanel(title, value) {
    const json = formatJson(value);
    if (!json) return '';
    return `
        <div class="rounded-box border border-base-300 bg-base-200/40">
            <div class="border-b border-base-300 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-base-content/60">${escapeHtml(title)}</div>
            <pre class="json-panel p-3 text-xs">${escapeHtml(json)}</pre>
        </div>
    `;
}

function annotationBadges(annotations) {
    if (!annotations || typeof annotations !== 'object') return '<span class="badge badge-ghost">No annotations</span>';
    const badges = [];
    if (annotations.title) badges.push(`<span class="badge badge-info">${escapeHtml(annotations.title)}</span>`);
    if (annotations.readOnlyHint === true) badges.push('<span class="badge badge-success">Read-only</span>');
    if (annotations.readOnlyHint === false) badges.push('<span class="badge badge-warning">May write</span>');
    if (annotations.destructiveHint === true) badges.push('<span class="badge badge-error">Destructive</span>');
    if (annotations.destructiveHint === false) badges.push('<span class="badge badge-success">Additive</span>');
    if (annotations.idempotentHint === true) badges.push('<span class="badge badge-neutral">Idempotent</span>');
    if (annotations.openWorldHint === true) badges.push('<span class="badge badge-outline">Open world</span>');
    if (annotations.openWorldHint === false) badges.push('<span class="badge badge-outline">Closed world</span>');
    return badges.length ? badges.join(' ') : '<span class="badge badge-ghost">No annotations</span>';
}

function getToolKey(tool) {
    return tool?.qualifiedName || `${tool.serverName}${serverToolnameSeparator}${tool.name}`;
}

function renderHeaderMappings(mappings) {
    if (!Array.isArray(mappings) || mappings.length === 0) {
        return '<p class="text-sm text-base-content/60">No HTTP header argument mappings discovered.</p>';
    }

    return `
        <div class="overflow-x-auto rounded-box border border-base-300">
            <table class="table table-sm">
                <thead>
                    <tr>
                        <th>Argument Path</th>
                        <th>Header</th>
                        <th>Type</th>
                    </tr>
                </thead>
                <tbody>
                    ${mappings.map(mapping => `
                        <tr>
                            <td><code>${escapeHtml((mapping.argumentPath || []).join('.') || '<root>')}</code></td>
                            <td><code>Mcp-Param-${escapeHtml(mapping.headerName)}</code></td>
                            <td>${escapeHtml(mapping.primitiveType)}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
    `;
}

// --- Tool Configuration Management ---
async function loadToolData() {
    if (!saveToolStatus || !toolListDiv) return;
    saveToolStatus.textContent = 'Loading tool data...';
    window.toolDataLoaded = false;
    try {
        const [toolsResponse, configResponse, envResponse] = await Promise.all([
            fetch('/admin/tools/list'),
            fetch('/admin/tools/config'),
            fetch('/admin/environment')
        ]);

        if (!toolsResponse.ok) throw new Error(`Failed to fetch discovered tools: ${toolsResponse.statusText}`);
        if (!configResponse.ok) throw new Error(`Failed to fetch tool config: ${configResponse.statusText}`);
        if (!envResponse.ok) throw new Error(`Failed to fetch environment info: ${envResponse.statusText}`);

        const toolsResult = await toolsResponse.json();
        window.discoveredTools = toolsResult.tools || [];

        window.currentToolConfig = await configResponse.json();
        if (!window.currentToolConfig || typeof window.currentToolConfig !== 'object' || !window.currentToolConfig.tools) {
            console.warn("Received invalid tool configuration format, initializing empty.", window.currentToolConfig);
            window.currentToolConfig = { tools: {} };
        }

        const envResult = await envResponse.json();
        serverToolnameSeparator = envResult.serverToolnameSeparator || toolsResult.serverToolnameSeparator || '__';
        window.serverToolnameSeparator = serverToolnameSeparator;
        console.log(`Using server toolname separator from backend: "${serverToolnameSeparator}"`);

        renderTools();
        window.toolDataLoaded = true;
        saveToolStatus.textContent = 'Tool data loaded.';
        setTimeout(() => saveToolStatus.textContent = '', 3000);

    } catch (error) {
        console.error("Error loading tool data:", error);
        saveToolStatus.textContent = `Error loading tool data: ${error.message}`;
        toolListDiv.innerHTML = '<div class="alert alert-error">Could not load tool data.</div>';
    }
}

function renderTools() {
    if (!toolListDiv) return;
    toolListDiv.innerHTML = '';

    const discoveredTools = window.discoveredTools || [];
    const currentToolConfig = window.currentToolConfig || { tools: {} };

    if (!Array.isArray(discoveredTools)) {
        toolListDiv.innerHTML = '<div class="alert alert-error">Error: Discovered tools data is not an array.</div>';
        return;
    }
    if (!currentToolConfig || typeof currentToolConfig.tools !== 'object') {
        toolListDiv.innerHTML = '<div class="alert alert-error">Error: Tool configuration data is invalid.</div>';
        return;
    }

    const configuredToolKeys = new Set(Object.keys(currentToolConfig.tools));

    discoveredTools
        .slice()
        .sort((a, b) => getToolKey(a).localeCompare(getToolKey(b)))
        .forEach(tool => {
            const toolKey = getToolKey(tool);
            const config = currentToolConfig.tools[toolKey] || {};
            renderToolEntry(toolKey, tool, config, false, true);
            configuredToolKeys.delete(toolKey);
        });

    configuredToolKeys.forEach(toolKey => {
        const config = currentToolConfig.tools[toolKey];
        const serverKeyForConfigOnlyTool = toolKey.split(serverToolnameSeparator)[0];
        let isServerActiveForConfigOnlyTool = true;

        if (window.currentServerConfig && window.currentServerConfig.mcpServers && window.currentServerConfig.mcpServers[serverKeyForConfigOnlyTool]) {
            const serverConf = window.currentServerConfig.mcpServers[serverKeyForConfigOnlyTool];
            if (serverConf.active === false || String(serverConf.active).toLowerCase() === 'false') {
                isServerActiveForConfigOnlyTool = false;
            }
        }
        console.warn(`Rendering configured tool "${toolKey}" which was not discovered. Associated server active status: ${isServerActiveForConfigOnlyTool}`);
        renderToolEntry(toolKey, null, config, true, isServerActiveForConfigOnlyTool);
    });

    populateToolServerFilter();
    applyToolFilters();

    if (toolListDiv.innerHTML === '') {
        toolListDiv.innerHTML = '<div class="alert">No tools discovered or configured.</div>';
    }
}

function renderToolEntry(toolKey, toolDefinition, toolConfig, isConfigOnly = false, isServerActive = true, target = toolListDiv, readOnly = false) {
    if (!target) return;

    const entryDiv = document.createElement('div');
    entryDiv.className = `tool-entry card border border-base-300 bg-base-100 shadow-sm collapsed${!isServerActive ? ' tool-server-inactive' : ''}`;
    if (!isServerActive) {
        entryDiv.title = 'This tool belongs to an inactive server. Enabling it will have no effect.';
    }
    const exposedName = toolConfig.exposedName || toolKey;
    const displayName = toolDefinition?.displayName || toolDefinition?.effectiveAnnotations?.title || exposedName;
    const exposedNameOverride = toolConfig.exposedName || '';
    const exposedDescriptionOverride = toolConfig.exposedDescription || '';
    const isEnabled = toolConfig.enabled !== false;
    const callType = toolConfig.toolType || toolConfig.callType || '';
    const effectiveToolType = toolDefinition?.effectiveToolType || callType || 'unspecified';
    const toolTypeSource = toolDefinition?.toolTypeSource || (callType ? 'override' : 'unspecified');
    const originalDescription = toolDefinition?.description || 'N/A';
    const transportType = toolDefinition?.transportType || 'unknown';
    const serverName = toolDefinition?.serverName || toolKey.split(serverToolnameSeparator)[0] || 'Unknown';
    const originalName = toolDefinition?.name || toolKey;
    const hasOutputSchema = !!toolDefinition?.outputSchema;
    const mappingCount = Array.isArray(toolDefinition?.mcpHeaderMappings) ? toolDefinition.mcpHeaderMappings.length : 0;
    const taskSupport = toolDefinition?.execution?.taskSupport;
    const proxyState = toolDefinition?.proxyState || (isConfigOnly ? 'missing' : isEnabled ? 'enabled' : 'disabled');

    entryDiv.dataset.toolKey = toolKey;
    entryDiv.dataset.server = serverName;
    entryDiv.dataset.status = proxyState === 'exposed' ? 'enabled' : proxyState;
    entryDiv.dataset.type = effectiveToolType;
    entryDiv.dataset.search = `${displayName} ${toolKey} ${serverName} ${originalDescription}`.toLowerCase();

    entryDiv.innerHTML = `
        <div class="card-body gap-4">
            <div class="tool-header flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div class="flex min-w-0 flex-1 gap-3">
                    <label class="tool-enable-label flex pt-1" title="Enable/Disable Tool">
                        <input type="checkbox" class="tool-enabled-input toggle toggle-primary" ${isEnabled ? 'checked' : ''} ${!isServerActive ? 'disabled' : ''}>
                    </label>
                    <div class="min-w-0 flex-1">
                        <h3 class="break-words text-base font-semibold" title="${!isServerActive ? 'Server is inactive' : 'Expand tool details'}">${escapeHtml(displayName)}</h3>
                        <p class="mt-1 break-all text-xs text-base-content/60">${escapeHtml(toolKey)}</p>
                        <div class="mt-2 flex flex-wrap gap-2">
                            <span class="badge badge-outline">${escapeHtml(serverName)}</span>
                            <span class="badge badge-neutral">${escapeHtml(transportType)}</span>
                            <span class="badge ${isEnabled ? 'badge-success' : 'badge-ghost'}">${isEnabled ? 'Enabled' : 'Disabled'}</span>
                            <span class="badge ${effectiveToolType === 'destructive' ? 'badge-error' : effectiveToolType === 'write' ? 'badge-warning' : effectiveToolType === 'read' ? 'badge-success' : 'badge-ghost'}">${escapeHtml(effectiveToolType)} (${escapeHtml(toolTypeSource)})</span>
                            ${hasOutputSchema ? '<span class="badge badge-info">Structured output</span>' : ''}
                            ${mappingCount ? `<span class="badge badge-secondary">${mappingCount} header mapping${mappingCount === 1 ? '' : 's'}</span>` : ''}
                            ${taskSupport ? `<span class="badge badge-outline">Task ${escapeHtml(taskSupport)}</span>` : ''}
                        </div>
                    </div>
                </div>
                <button class="reset-tool-overrides-button btn btn-ghost btn-sm" title="Reset all overrides for this tool to defaults">Reset</button>
            </div>
            <div class="tool-details mt-2 space-y-5">
                ${isConfigOnly ? '<div class="alert alert-warning">This tool was configured but not discovered by any active server.</div>' : ''}
                <div class="rounded-box border border-base-300 bg-base-200/40 p-4">
                <div class="grid gap-4 lg:grid-cols-3">
                    <div class="lg:col-span-2">
                        <label class="label"><span class="label-text">Exposed Tool Name Override</span></label>
                        <input type="text" class="tool-exposedname-input input input-bordered w-full" value="${escapeHtml(exposedNameOverride)}" placeholder="${escapeHtml(toolKey)}">
                        <p class="mt-1 text-xs text-base-content/60">Must be unique and contain only letters, numbers, underscores, or hyphens. It cannot start with a number.</p>
                    </div>
                    <div>
                        <label class="label"><span class="label-text">Tool type</span></label>
                        <select class="tool-calltype-input select select-bordered w-full">
                            <option value="" ${callType === '' ? 'selected' : ''}>Use upstream metadata</option>
                            <option value="read" ${callType === 'read' ? 'selected' : ''}>Read</option>
                            <option value="write" ${callType === 'write' ? 'selected' : ''}>Write</option>
                            <option value="destructive" ${callType === 'destructive' ? 'selected' : ''}>Destructive</option>
                        </select>
                    </div>
                </div>
                <div>
                    <label class="label"><span class="label-text">Exposed Description Override</span></label>
                    <textarea class="tool-exposeddescription-input textarea textarea-bordered min-h-28 w-full" placeholder="Default: original backend description">${escapeHtml(exposedDescriptionOverride)}</textarea>
                </div>
                </div>
                <div class="rounded-box border border-base-300 bg-base-200/40 p-4">
                    <div class="grid gap-4 lg:grid-cols-2">
                        <div>
                            <div class="text-xs font-semibold uppercase tracking-wide text-base-content/60">Original Backend Tool</div>
                            <p class="mt-1 break-all font-mono text-sm">${escapeHtml(originalName)}</p>
                        </div>
                        <div>
                            <div class="text-xs font-semibold uppercase tracking-wide text-base-content/60">Annotations</div>
                            <div class="mt-2 flex flex-wrap gap-2">${annotationBadges(toolDefinition?.annotations)}</div>
                        </div>
                    </div>
                    <div class="mt-4">
                        <div class="text-xs font-semibold uppercase tracking-wide text-base-content/60">Original Description</div>
                        <p class="mt-1 whitespace-pre-wrap text-sm">${escapeHtml(originalDescription)}</p>
                    </div>
                </div>
                <div class="rounded-box border border-base-300 bg-base-200/40 p-4">
                    <div class="text-xs font-semibold uppercase tracking-wide text-base-content/60">MCP client receives</div>
                    <p class="mt-1 text-sm"><strong>Effective type:</strong> ${escapeHtml(effectiveToolType)} (${escapeHtml(toolTypeSource)})</p>
                    ${renderJsonPanel('Effective annotations', toolDefinition?.effectiveAnnotations)}
                </div>
                <div class="grid gap-4 xl:grid-cols-2">
                    ${renderJsonPanel('Input Schema', toolDefinition?.inputSchema)}
                    ${renderJsonPanel('Output Schema', toolDefinition?.outputSchema)}
                </div>
                <div>
                    <div class="mb-2 text-xs font-semibold uppercase tracking-wide text-base-content/60">HTTP Header Pass-through</div>
                    ${renderHeaderMappings(toolDefinition?.mcpHeaderMappings)}
                </div>
                <div class="grid gap-4 xl:grid-cols-2">
                    ${renderJsonPanel('Execution', toolDefinition?.execution)}
                    ${renderJsonPanel('Metadata', toolDefinition?._meta)}
                    ${renderJsonPanel('Icons', toolDefinition?.icons)}
                </div>
            </div>
        </div>
    `;

    target.appendChild(entryDiv);

    const resetButton = entryDiv.querySelector('.reset-tool-overrides-button');
    if (resetButton) {
        resetButton.addEventListener('click', (e) => {
            e.stopPropagation();
            if (confirm(`Are you sure you want to reset all overrides for tool "${toolKey}"?\nThis will remove any custom settings for its name, description, enabled state, and call type from the configuration. You will need to save the tool configuration to make this permanent.`)) {
                if (window.currentToolConfig && window.currentToolConfig.tools && window.currentToolConfig.tools[toolKey]) {
                    delete window.currentToolConfig.tools[toolKey];
                    if (target.dataset.serverKey && typeof window.renderServerDetail === 'function') {
                        window.renderServerDetail(target.dataset.serverKey);
                    } else {
                        renderTools();
                    }
                    const localSaveToolStatus = document.getElementById('save-tool-status');
                    if (localSaveToolStatus) {
                        localSaveToolStatus.textContent = `Overrides for '${toolKey}' reset. Click "Save & Reload" to apply.`;
                        localSaveToolStatus.style.color = 'orange';
                        setTimeout(() => { if (localSaveToolStatus) localSaveToolStatus.textContent = ''; }, 5000);
                    }
                } else {
                    renderTools();
                    alert(`Tool "${toolKey}" is already using default settings or has no saved overrides.`);
                }
            }
        });
    }

    const headerH3 = entryDiv.querySelector('.tool-header h3');
    if (headerH3) {
        headerH3.addEventListener('click', () => {
            entryDiv.classList.toggle('collapsed');
        });
    }

    if (readOnly) {
        entryDiv.querySelectorAll('input, textarea, select, button').forEach(control => {
            control.disabled = true;
        });
    }
}

function initializeToolSaveListener() {
    if (!saveToolConfigButton || !toolListDiv || !saveToolStatus) return;

    const validToolNameRegex = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;
    const validCallTypes = new Set(['', 'read', 'write', 'destructive']);

    saveToolConfigButton.addEventListener('click', async () => {
        saveToolStatus.textContent = 'Validating and saving tool configuration...';
        saveToolStatus.style.color = 'orange';
        const newToolConfig = { tools: {} };
        const entries = toolListDiv.querySelectorAll('.tool-entry');
        let isValid = true;
        let errorMsg = '';
        const exposedNames = new Set();

        entries.forEach(entryDiv => {
            if (!isValid) return;

            const toolKey = entryDiv.dataset.toolKey;
            const enabledInput = entryDiv.querySelector('.tool-enabled-input');
            const exposedNameInput = entryDiv.querySelector('.tool-exposedname-input');
            const exposedDescriptionInput = entryDiv.querySelector('.tool-exposeddescription-input');
            const callTypeInput = entryDiv.querySelector('.tool-calltype-input');

            const exposedNameOverride = exposedNameInput.value.trim();
            const exposedDescriptionOverride = exposedDescriptionInput.value.trim();
            const callTypeOverride = callTypeInput.value;
            const isEnabled = enabledInput.checked;
            const finalExposedName = exposedNameOverride || toolKey;

            if (exposedNameOverride && !validToolNameRegex.test(exposedNameOverride)) {
                isValid = false;
                errorMsg = `Invalid format for Exposed Tool Name Override "${exposedNameOverride}" for tool "${toolKey}". Use letters, numbers, _, - (cannot start with number).`;
                exposedNameInput.classList.add('input-error');
                return;
            }
            exposedNameInput.classList.remove('input-error');

            if (exposedNames.has(finalExposedName)) {
                isValid = false;
                errorMsg = `Duplicate Exposed Tool Name: "${finalExposedName}". Please ensure all exposed names (including overrides) are unique.`;
                exposedNameInput.classList.add('input-error');
                return;
            }
            exposedNames.add(finalExposedName);

            if (!validCallTypes.has(callTypeOverride)) {
                isValid = false;
                errorMsg = `Invalid call type for tool "${toolKey}".`;
                callTypeInput.classList.add('select-error');
                return;
            }
            callTypeInput.classList.remove('select-error');

            const configData = {
                enabled: isEnabled,
                exposedName: exposedNameOverride || undefined,
                exposedDescription: exposedDescriptionOverride || undefined,
                toolType: callTypeOverride || undefined,
            };

            if (configData.enabled === false || configData.exposedName || configData.exposedDescription || configData.toolType) {
                newToolConfig.tools[toolKey] = configData;
            }
        });

        if (!isValid) {
            window.dispatchEvent(new CustomEvent('tool-config-save-complete', { detail: { success: false, error: errorMsg } }));
            saveToolStatus.textContent = `Error: ${errorMsg}`;
            saveToolStatus.style.color = 'red';
            setTimeout(() => { if(saveToolStatus) saveToolStatus.textContent = ''; saveToolStatus.style.color = 'green'; }, 7000);
            return;
        }

        try {
            saveToolStatus.textContent = 'Saving tool configuration...';
            const response = await fetch('/admin/tools/config', {
                method: 'POST',
                headers: typeof csrfHeaders === 'function' ? csrfHeaders({}) : { 'Content-Type': 'application/json' },
                body: JSON.stringify(newToolConfig)
            });
            const result = await response.json();
            if (response.ok && result.success) {
                saveToolStatus.textContent = 'Tool configuration saved successfully.';
                saveToolStatus.style.color = 'green';
                window.currentToolConfig = newToolConfig;

                if (typeof window.triggerReload === 'function') {
                    await window.triggerReload(saveToolStatus);
                    window.dispatchEvent(new CustomEvent('tool-config-save-complete', { detail: { success: true } }));
                } else {
                    console.error("triggerReload function not found.");
                    saveToolStatus.textContent += ' Reload trigger function not found!';
                    saveToolStatus.style.color = 'red';
                    setTimeout(() => { saveToolStatus.textContent = ''; saveToolStatus.style.color = 'green'; }, 7000);
                }

            } else {
                window.dispatchEvent(new CustomEvent('tool-config-save-complete', { detail: { success: false, error: result.error || response.statusText } }));
                saveToolStatus.textContent = `Error saving tool configuration: ${result.error || response.statusText}`;
                saveToolStatus.style.color = 'red';
                setTimeout(() => { if(saveToolStatus) saveToolStatus.textContent = ''; saveToolStatus.style.color = 'green'; }, 5000);
            }
        } catch (error) {
            window.dispatchEvent(new CustomEvent('tool-config-save-complete', { detail: { success: false, error: error.message } }));
            console.error("Error saving tool config:", error);
            saveToolStatus.textContent = `Network error saving tool configuration: ${error.message}`;
            saveToolStatus.style.color = 'red';
            setTimeout(() => { if(saveToolStatus) saveToolStatus.textContent = ''; saveToolStatus.style.color = 'green'; }, 5000);
        }
    });
}

function saveServerToolEntries(entries) {
    if (!window.currentToolConfig?.tools || !saveToolConfigButton) return false;
    entries.forEach(entry => {
        const toolKey = entry.dataset.toolKey;
        const enabled = entry.querySelector('.tool-enabled-input')?.checked;
        const exposedName = entry.querySelector('.tool-exposedname-input')?.value.trim();
        const exposedDescription = entry.querySelector('.tool-exposeddescription-input')?.value.trim();
        const toolType = entry.querySelector('.tool-calltype-input')?.value;
        if (enabled === false || exposedName || exposedDescription || toolType) {
            window.currentToolConfig.tools[toolKey] = { enabled, exposedName: exposedName || undefined, exposedDescription: exposedDescription || undefined, toolType: toolType || undefined };
        } else {
            delete window.currentToolConfig.tools[toolKey];
        }
    });
    // Re-render the complete catalogue before saving. This deliberately saves
    // every tool, preventing a server-scoped edit from dropping other servers.
    renderTools();
    saveToolConfigButton.click();
    return true;
}

window.loadToolData = loadToolData;
window.renderTools = renderTools;
window.renderToolEntry = renderToolEntry;
window.saveServerToolEntries = saveServerToolEntries;
window.initializeToolSaveListener = initializeToolSaveListener;

['tool-search-input', 'tool-server-filter', 'tool-status-filter', 'tool-type-filter'].forEach(id => {
    const control = document.getElementById(id);
    control?.addEventListener(id === 'tool-search-input' ? 'input' : 'change', applyToolFilters);
});

console.log("tools.js loaded");

function initializeResetAllToolOverridesListener() {
    const resetButton = document.getElementById('reset-all-tool-overrides-button');
    const localSaveToolStatus = window.saveToolStatus || document.getElementById('save-tool-status');

    if (!resetButton) {
        console.warn("Reset All Tool Overrides button not found in DOM.");
        return;
    }

    resetButton.addEventListener('click', async () => {
        if (confirm("Are you sure you want to reset ALL tool overrides?\nThis will clear any custom names, descriptions, enabled/disabled states, and call type overrides for all tools. You will need to click 'Save & Reload Tool Configuration' to make this permanent.")) {
            if (window.currentToolConfig) {
                window.currentToolConfig.tools = {};
                renderTools();

                if (localSaveToolStatus) {
                    localSaveToolStatus.textContent = 'All tool overrides have been reset. Click "Save & Reload" to apply.';
                    localSaveToolStatus.style.color = 'orange';
                    setTimeout(() => { if (localSaveToolStatus) localSaveToolStatus.textContent = ''; }, 7000);
                }
            } else {
                alert("Tool configuration not loaded yet. Please wait or try reloading.");
            }
        }
    });
}

window.initializeResetAllToolOverridesListener = initializeResetAllToolOverridesListener;
