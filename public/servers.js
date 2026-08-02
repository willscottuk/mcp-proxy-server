// --- DOM Elements (Assumed to be globally accessible or passed) ---
const serverListDiv = document.getElementById('server-list');
const serverOverviewListDiv = document.getElementById('server-overview-list');

function escapeServerHtml(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

async function loadServerOverview() {
    if (!serverOverviewListDiv) return;
    serverOverviewListDiv.innerHTML = '<span class="loading loading-spinner loading-md"></span>';
    try {
        const response = await fetch('/admin/status');
        if (!response.ok) throw new Error(response.statusText);
        const status = await response.json();
        window.currentProxyStatus = status;
        renderServerOverview(status.servers || []);
    } catch (error) {
        serverOverviewListDiv.innerHTML = `<div class="alert alert-error">Could not load live server status: ${escapeServerHtml(error.message)}</div>`;
    }
}

function renderServerOverview(servers) {
    if (!serverOverviewListDiv) return;
    if (!servers.length) {
        serverOverviewListDiv.innerHTML = '<div class="alert">No servers configured.</div>';
        return;
    }
    serverOverviewListDiv.innerHTML = servers.slice().sort((a, b) => a.name.localeCompare(b.name)).map(server => {
        const health = server.health || { state: 'checking' };
        const stateClass = health.state === 'connected' ? 'badge-success' : health.state === 'error' ? 'badge-error' : health.state === 'inactive' ? 'badge-ghost' : 'badge-info';
        const counts = server.toolCounts || {};
        const href = `/admin/servers/${encodeURIComponent(server.key)}`;
        return `<article class="server-overview card border border-base-300 bg-base-100 shadow-sm">
            <div class="card-body gap-3 lg:flex-row lg:items-center">
                <div class="min-w-0 flex-1"><div class="flex flex-wrap items-center gap-2"><h3 class="text-lg font-semibold">${escapeServerHtml(server.name)}</h3><span class="badge ${stateClass}">${escapeServerHtml(health.state)}</span><span class="badge badge-outline">${escapeServerHtml(server.transportType)}</span></div>
                <p class="mt-1 break-all text-sm text-base-content/60">${escapeServerHtml(server.key)}</p>
                <div class="mt-2 flex flex-wrap gap-2 text-sm"><span class="badge badge-neutral">${counts.exposed || 0} exposed</span><span class="badge badge-outline">${counts.discovered || 0} discovered</span>${counts.disabled ? `<span class="badge badge-warning">${counts.disabled} disabled</span>` : ''}${counts.problems ? `<span class="badge badge-error">${counts.problems} problems</span>` : ''}</div>
                ${health.error ? `<p class="mt-2 text-sm text-error">${escapeServerHtml(health.error)}</p>` : ''}</div>
                <a class="btn btn-primary btn-sm" href="${href}">View server</a>
            </div></article>`;
    }).join('');
}

async function renderServerDetail(serverKey) {
    const config = window.currentServerConfig?.mcpServers?.[serverKey];
    const status = window.currentProxyStatus || { servers: [], tools: [] };
    const server = (status.servers || []).find(item => item.key === serverKey);
    const header = document.getElementById('server-detail-header');
    const overview = document.getElementById('server-detail-overview');
    const tools = document.getElementById('server-detail-tools');
    if (!config || !header || !overview || !tools) return false;
    const health = server?.health || { state: config.active === false ? 'inactive' : 'checking' };
    header.innerHTML = `<div class="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between"><div><div class="flex flex-wrap items-center gap-2"><h2 class="text-2xl font-semibold">${escapeServerHtml(config.name || serverKey)}</h2><span class="badge ${health.state === 'connected' ? 'badge-success' : health.state === 'error' ? 'badge-error' : 'badge-ghost'}">${escapeServerHtml(health.state)}</span><span class="badge badge-outline">${escapeServerHtml(config.type)}</span></div><p class="mt-1 font-mono text-sm text-base-content/60">${escapeServerHtml(serverKey)}</p></div><button id="refresh-server-button" class="btn btn-outline btn-sm">Refresh health</button></div>`;
    overview.innerHTML = `<div class="grid gap-4 md:grid-cols-3"><div class="stat rounded-box border border-base-300"><div class="stat-title">Exposed tools</div><div class="stat-value text-primary">${server?.toolCounts?.exposed || 0}</div></div><div class="stat rounded-box border border-base-300"><div class="stat-title">Discovered tools</div><div class="stat-value">${server?.toolCounts?.discovered || 0}</div></div><div class="stat rounded-box border border-base-300"><div class="stat-title">Last checked</div><div class="stat-desc">${health.checkedAt ? escapeServerHtml(new Date(health.checkedAt).toLocaleString()) : 'Not checked yet'}</div></div></div>${health.error ? `<div class="alert alert-error mt-4">${escapeServerHtml(health.error)}</div>` : ''}`;
    const serverTools = (status.tools || []).filter(tool => tool.serverName === serverKey);
    tools.innerHTML = serverTools.length ? `<div class="space-y-3">${serverTools.map(tool => `<article class="card border border-base-300 bg-base-100"><div class="card-body py-4"><div class="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between"><div><h3 class="font-semibold">${escapeServerHtml(tool.qualifiedName)}</h3><p class="text-sm text-base-content/60">${escapeServerHtml(tool.description || 'No description')}</p></div><div class="flex flex-wrap gap-2"><span class="badge ${tool.proxyState === 'exposed' ? 'badge-success' : tool.proxyState === 'disabled' ? 'badge-warning' : 'badge-error'}">${escapeServerHtml(tool.proxyState)}</span><span class="badge badge-outline">${escapeServerHtml(tool.effectiveToolType || 'unspecified')}</span></div></div></div></article>`).join('')}</div>` : '<div class="alert">No tools are currently associated with this server.</div>';
    header.querySelector('#refresh-server-button')?.addEventListener('click', async () => {
        const button = header.querySelector('#refresh-server-button'); button.disabled = true; button.textContent = 'Refreshing…';
        try { await fetch(`/admin/servers/${encodeURIComponent(serverKey)}/refresh`, { method: 'POST', headers: csrfHeaders({}) }); await loadServerOverview(); await renderServerDetail(serverKey); }
        finally { button.disabled = false; button.textContent = 'Refresh health'; }
    });
    renderServerConfig({ mcpServers: { [serverKey]: config } });
    return true;
}
// saveConfigButton and saveStatus are obtained within initializeServerSaveListener

// --- Server Configuration Management ---
async function loadServerConfig() {
    const localSaveStatus = document.getElementById('save-status'); 
    if (!localSaveStatus || !serverListDiv) {
        console.error("loadServerConfig: Missing essential DOM elements (saveStatus or serverListDiv).");
        return; 
    }
    localSaveStatus.textContent = 'Loading server configuration...';
    try {
        const response = await fetch('/admin/config');
        if (!response.ok) throw new Error(`Failed to fetch server config: ${response.status} ${response.statusText}`);
        window.currentServerConfig = await response.json(); 
        renderServerConfig(window.currentServerConfig);
        // addInstallButtonListeners is called within renderServerConfig after rendering all entries
        localSaveStatus.textContent = 'Server configuration loaded.';
        window.isServerConfigDirty = false; // Reset dirty flag after successful load
        setTimeout(() => { if(localSaveStatus) localSaveStatus.textContent = ''; }, 3000);
    } catch (error) {
        console.error("Error loading server config:", error);
        if(localSaveStatus) localSaveStatus.textContent = `Error loading server configuration: ${error.message}`;
        if(serverListDiv) serverListDiv.innerHTML = '<p class="error-message">Could not load server configuration.</p>';
    }
}

function renderServerConfig(config) {
    if (!serverListDiv) return; 
    serverListDiv.innerHTML = '';
    if (!config || typeof config !== 'object' || !config.mcpServers) {
         serverListDiv.innerHTML = '<p class="error-message">Invalid server configuration format received.</p>';
         return;
    }
    const servers = config.mcpServers;
    Object.keys(servers).sort().forEach(key => {
         renderServerEntry(key, servers[key]);
    });
     addInstallButtonListeners(); // Ensure listeners are (re-)added after full render
}

function renderServerEntry(key, serverConf, startExpanded = false) {
    if (!serverListDiv) return; 
    const entryDiv = document.createElement('div');
    entryDiv.className = 'server-entry card border border-base-300 bg-base-100 shadow-sm';
    if (!startExpanded) {
        entryDiv.classList.add('collapsed');
    }
    entryDiv.dataset.serverKey = key; 
    entryDiv.dataset.installDirManuallyEdited = 'false'; // Initialize flag

    let type = serverConf.type;
    if (!type) { // Infer type if not explicitly set (for backward compatibility or manual JSON editing)
        if (serverConf.url && !serverConf.command) type = 'sse';
        else if (serverConf.command && !serverConf.url) type = 'stdio';
        else type = 'unknown'; // Or handle as error
    }

    let displayType = 'Unknown';
    if (type === 'sse') displayType = 'SSE';
    else if (type === 'stdio') displayType = 'Stdio';
    else if (type === 'http') displayType = 'HTTP';
    else displayType = type.toUpperCase(); // Fallback for unknown but specified types

    entryDiv.dataset.serverType = type; // Store the actual type

    const headerDiv = document.createElement('div');
    headerDiv.className = 'server-header card-body flex flex-col gap-3 lg:flex-row lg:items-center';
    // Move Active checkbox to the header, at the beginning
    headerDiv.innerHTML = `
        <label class="inline-label server-active-label flex items-center gap-2" title="Activate/Deactivate Server">
            <input type="checkbox" class="server-active-input toggle toggle-primary" ${serverConf.active !== false ? 'checked' : ''}>
            <span class="text-sm">Active</span>
        </label>
        <div class="min-w-0 flex-1">
            <h3 class="break-words text-lg font-semibold">${serverConf.name || key}</h3>
            <div class="mt-1 flex flex-wrap gap-2">
                <span class="server-type badge badge-outline">${displayType}</span>
                <span class="badge badge-ghost break-all">${key}</span>
            </div>
        </div>
        <button class="delete-button btn btn-warning btn-sm">Delete</button>
    `;
    entryDiv.appendChild(headerDiv);

    const detailsDiv = document.createElement('div');
    detailsDiv.className = 'server-details px-8 pb-6';

    // Remove Active checkbox from detailsHtml
    let detailsHtml = `
        <div class="grid gap-4 lg:grid-cols-2">
            <div><label class="label"><span class="label-text">Server Key (Unique ID)</span></label><input type="text" class="server-key-input input input-bordered w-full" value="${key}" required></div>
            <div><label class="label"><span class="label-text">Display Name</span></label><input type="text" class="server-name-input input input-bordered w-full" value="${serverConf.name || ''}"></div>
        </div>
    `;

    if (type === 'sse' || type === 'http') {
        detailsHtml += `
            <div class="mt-4 grid gap-4 lg:grid-cols-2">
                <div class="lg:col-span-2"><label class="label"><span class="label-text">URL</span></label><input type="url" class="server-url-input input input-bordered w-full" value="${serverConf.url || ''}" required></div>
                <div><label class="label"><span class="label-text">API Key (X-Api-Key Header)</span></label><input type="text" class="server-apikey-input input input-bordered w-full" value="${serverConf.apiKey || ''}"></div>
                <div><label class="label"><span class="label-text">Bearer Token (Authorization Header)</span></label><input type="text" class="server-bearertoken-input input input-bordered w-full" value="${serverConf.bearerToken || ''}"></div>
            </div>
        `;
        // Add any type-specific fields for 'http' if they differ from 'sse' in the future
    } else if (type === 'stdio') {
        const baseInstallPath = (typeof window.effectiveToolsFolder === 'string' && window.effectiveToolsFolder.trim() !== '') ? window.effectiveToolsFolder.trim() : 'tools';
        const defaultInstallDir = `${baseInstallPath}/${key}`;
        const installDirValue = serverConf.installDirectory !== undefined ? serverConf.installDirectory : defaultInstallDir;
        
        detailsHtml += `
            <div class="mt-4 grid gap-4 lg:grid-cols-2">
                <div><label class="label"><span class="label-text">Command</span></label><input type="text" class="server-command-input input input-bordered w-full" value="${serverConf.command || ''}" required></div>
                <div><label class="label"><span class="label-text">Arguments (comma-separated)</span></label><input type="text" class="server-args-input input input-bordered w-full" value="${(serverConf.args || []).join(', ')}"></div>
            </div>
            <div class="mt-4 rounded-box border border-base-300 bg-base-200/40 p-4">
                <label class="label px-0 pt-0"><span class="label-text">Environment Variables</span></label>
                <div class="env-vars-container"></div>
                <button type="button" class="add-env-var-button btn btn-outline btn-sm">Add Variable</button>
            </div>
            <div class="divider"></div>
            <div class="grid gap-4 lg:grid-cols-2">
                <div><label class="label"><span class="label-text">Install Directory (optional)</span></label><input type="text" class="server-install-dir-input input input-bordered w-full" value="${installDirValue}"></div>
                <div><label class="label"><span class="label-text">Install Commands (optional, one per line)</span></label><textarea class="server-install-cmds-input textarea textarea-bordered min-h-28 w-full">${(serverConf.installCommands || []).join('\n')}</textarea></div>
            </div>
            <button class="install-button btn btn-info btn-sm mt-3" data-server-key="${key}" ${!installDirValue.trim() ? 'disabled title="Install directory must be set to enable install button"' : ''}>Check/Run Install</button>
            <div class="install-output rounded-box bg-neutral p-3 text-sm text-neutral-content" id="install-output-${key}" style="display: none;"></div>
        `;
    } else {
         detailsHtml += `<div class="error-message alert alert-error">Warning: Unknown server type configuration ('${type}').</div>`;
    }

    detailsDiv.innerHTML = detailsHtml;
    entryDiv.appendChild(detailsDiv);

    const envVarsContainer = detailsDiv.querySelector('.env-vars-container');
    if (envVarsContainer && serverConf.env && typeof serverConf.env === 'object') {
        Object.entries(serverConf.env).forEach(([envKey, envValue]) => {
            addEnvVarRow(envVarsContainer, envKey, String(envValue));
        });
    }

    const addEnvVarButton = detailsDiv.querySelector('.add-env-var-button');
    if (addEnvVarButton) {
        addEnvVarButton.addEventListener('click', () => {
            addEnvVarRow(envVarsContainer);
            window.isServerConfigDirty = true;
        });
    }

    headerDiv.querySelector('h3').addEventListener('click', () => entryDiv.classList.toggle('collapsed'));
    headerDiv.querySelector('h3').style.cursor = 'pointer';

    headerDiv.querySelector('.delete-button').addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(`Are you sure you want to delete server "${serverConf.name || key}"?`)) {
            entryDiv.remove();
            window.isServerConfigDirty = true; 
        }
    });

    const installButton = detailsDiv.querySelector('.install-button');
    const installDirInput = detailsDiv.querySelector('.server-install-dir-input');

    const serverTypeFromDataset = entryDiv.dataset.serverType;
    if (serverTypeFromDataset === 'stdio' && installDirInput) {
        installDirInput.addEventListener('input', () => {
            entryDiv.dataset.installDirManuallyEdited = 'true'; // User is manually editing
            window.isServerConfigDirty = true; 
            if (installButton) {
                const hasDir = !!installDirInput.value.trim();
                installButton.disabled = !hasDir;
                installButton.title = installButton.disabled ? 'Install directory must be set to enable install button' : '';
            }
        });
    }
    
    const keyInput = detailsDiv.querySelector('.server-key-input');
    if (serverTypeFromDataset === 'stdio' && keyInput && installDirInput) {
        keyInput.addEventListener('input', () => {
            window.isServerConfigDirty = true;
            const currentKey = keyInput.value.trim();
            
            if (entryDiv.dataset.installDirManuallyEdited !== 'true') {
                if (currentKey) {
                    const currentBaseInstallPath = (typeof window.effectiveToolsFolder === 'string' && window.effectiveToolsFolder.trim() !== '') ? window.effectiveToolsFolder.trim() : 'tools';
                    const newDynamicDefaultInstallDir = `${currentBaseInstallPath}/${currentKey}`;
                    installDirInput.value = newDynamicDefaultInstallDir;
                    if (installButton) {
                         installButton.disabled = !newDynamicDefaultInstallDir.trim();
                         installButton.title = installButton.disabled ? 'Install directory must be set to enable install button' : '';
                   }
                } else { 
                    installDirInput.value = '';
                    if (installButton) {
                        installButton.disabled = true;
                        installButton.title = 'Install directory must be set to enable install button';
                    }
                }
            }
        });
    }
    
    detailsDiv.querySelectorAll('input:not(.server-key-input):not(.server-install-dir-input), textarea').forEach(input => {
        input.addEventListener('input', () => { window.isServerConfigDirty = true; });
    });
    detailsDiv.querySelectorAll('input[type="checkbox"]').forEach(input => {
        input.addEventListener('change', () => { window.isServerConfigDirty = true; });
    });
    // Server key and install dir already have specific listeners that set dirty flag

    serverListDiv.appendChild(entryDiv);
}

function addInstallButtonListeners() {
    document.querySelectorAll('.install-button').forEach(button => {
        const newButton = button.cloneNode(true); 
        button.parentNode.replaceChild(newButton, button);
        newButton.addEventListener('click', () => {
            const serverKey = newButton.dataset.serverKey;
            if (serverKey) {
                handleInstallClick(serverKey); 
            } else {
                console.error("Install button clicked but serverKey is missing.");
            }
        });
    });
}

function addEnvVarRow(container, key = '', value = '') {
    if (!container) return;
    const rowDiv = document.createElement('div');
    rowDiv.classList.add('env-var-row');
    rowDiv.innerHTML = `
        <input type="text" class="env-key-input input input-bordered input-sm" placeholder="Key" value="${key}">
        <span>=</span>
        <input type="text" class="env-value-input input input-bordered input-sm" placeholder="Value" value="${value}">
        <button type="button" class="delete-env-var-button btn btn-error btn-sm">X</button>
    `;
    rowDiv.querySelector('.delete-env-var-button').addEventListener('click', () => {
        rowDiv.remove();
        window.isServerConfigDirty = true; 
    });
    rowDiv.querySelectorAll('input').forEach(input => {
        input.addEventListener('input', () => { window.isServerConfigDirty = true; });
    });
    container.appendChild(rowDiv);
}

async function handleInstallClick(serverKey) {
    if (window.isServerConfigDirty === true) { 
        alert("Configuration has unsaved changes. Please save the server configuration before installing.");
        return;
    }

    const installButton = document.querySelector(`.install-button[data-server-key="${serverKey}"]`);
    const outputElement = typeof window.getInstallOutputElement === 'function' ? window.getInstallOutputElement(serverKey) : document.getElementById(`install-output-${serverKey}`);

    if (!outputElement || !installButton) {
        console.error(`Could not find install button or output area for ${serverKey}`);
        return;
    }

    if (!window.adminEventSource || window.adminEventSource.readyState !== EventSource.OPEN) {
         console.log("Admin SSE not connected, attempting to connect before install...");
         if (typeof window.connectAdminSSE === 'function') {
            window.connectAdminSSE(); 
         } else {
             console.error("connectAdminSSE function not found.");
             if(typeof window.appendToInstallOutput === 'function') {
                window.appendToInstallOutput(serverKey, "Error: Cannot establish connection for live updates.\n", true);
             }
             return;
         }
    }

    outputElement.innerHTML = ''; 
    outputElement.style.display = 'block'; 
    if(typeof window.appendToInstallOutput === 'function') {
        window.appendToInstallOutput(serverKey, `Starting installation check for ${serverKey}...\n`);
    }
    installButton.disabled = true;
    installButton.textContent = 'Installing...';

    try {
        const response = await fetch(`/admin/server/install/${serverKey}`, {
            method: 'POST',
            headers: typeof csrfHeaders === 'function' ? csrfHeaders({}) : { 'Content-Type': 'application/json' },
        });
        const result = await response.json();

        if (!response.ok || !result.success) {
            const errorMsg = `Error starting installation process: ${result.error || response.statusText}\n`;
            if(typeof window.appendToInstallOutput === 'function') window.appendToInstallOutput(serverKey, errorMsg, true);
            installButton.disabled = false; 
            installButton.textContent = 'Install Failed';
            return;
        }
        if(typeof window.appendToInstallOutput === 'function') {
            window.appendToInstallOutput(serverKey, `Installation process initiated. Waiting for live output via SSE...\n`);
        }
    } catch (error) {
        console.error(`Error initiating installation for ${serverKey}:`, error);
        const errorMsg = `Network error initiating installation: ${error.message}\n`;
        if(typeof window.appendToInstallOutput === 'function') window.appendToInstallOutput(serverKey, errorMsg, true);
        installButton.disabled = false; 
        installButton.textContent = 'Install Failed';
    }
}


function initializeServerSaveListener() {
    const localSaveConfigButton = document.getElementById('save-config-button');
    const localServerListDiv = document.getElementById('server-list');
    const localSaveStatus = document.getElementById('save-status');

    if (!localSaveConfigButton || !localServerListDiv || !localSaveStatus) {
        console.error("Save listener setup failed: Missing crucial DOM elements for servers section.");
        return;
    }

    localSaveConfigButton.addEventListener('click', async () => {
        localSaveStatus.textContent = 'Saving server configuration...';
        localSaveStatus.style.color = 'orange';
        // Server detail pages render one entry at a time. Start with the full
        // loaded configuration so saving one edit cannot discard every other
        // server.
        const newConfig = {
            ...(window.currentServerConfig || {}),
            mcpServers: { ...(window.currentServerConfig?.mcpServers || {}) }
        };
        const entries = localServerListDiv.querySelectorAll('.server-entry');
        let isValid = true;
        let errorMsg = '';

        entries.forEach(entryDiv => {
            if (!isValid) return;

            const newKeyInput = entryDiv.querySelector('.server-key-input');
            const newKey = newKeyInput.value.trim();
            const originalKey = entryDiv.dataset.serverKey;

            if (!newKey) {
                isValid = false; errorMsg = 'Server Key cannot be empty.'; newKeyInput.style.border = '1px solid red'; return;
            } else { newKeyInput.style.border = ''; }

            if (newConfig.mcpServers.hasOwnProperty(newKey) && newKey !== originalKey) {
                 isValid = false; errorMsg = `Duplicate Server Key: "${newKey}".`; newKeyInput.style.border = '1px solid red'; return;
            }

            const nameInput = entryDiv.querySelector('.server-name-input');
            const activeInput = entryDiv.querySelector('.server-active-input');
            const urlInput = entryDiv.querySelector('.server-url-input');
            const apiKeyInput = entryDiv.querySelector('.server-apikey-input');
            const bearerTokenInput = entryDiv.querySelector('.server-bearertoken-input');
            const commandInput = entryDiv.querySelector('.server-command-input');
            const argsInput = entryDiv.querySelector('.server-args-input');
            const envVarsContainer = entryDiv.querySelector('.env-vars-container');
            const installDirInputFromForm = entryDiv.querySelector('.server-install-dir-input'); // Renamed to avoid conflict
            const installCmdsInput = entryDiv.querySelector('.server-install-cmds-input');

            const serverType = entryDiv.dataset.serverType || (urlInput ? 'sse' : (commandInput ? 'stdio' : 'unknown'));
            const serverData = {
                name: nameInput.value.trim() || undefined,
                active: activeInput.checked,
                type: serverType
            };

            if (serverType === 'sse' || serverType === 'http') {
                serverData.url = urlInput.value.trim();
                if (!serverData.url) { isValid = false; errorMsg = `URL required for ${serverType.toUpperCase()} server "${newKey}".`; urlInput.style.border = '1px solid red'; }
                else { urlInput.style.border = ''; }
                const apiKey = apiKeyInput.value.trim();
                const bearerToken = bearerTokenInput.value.trim();
                if (apiKey) serverData.apiKey = apiKey;
                if (bearerToken) serverData.bearerToken = bearerToken;
            } else if (serverType === 'stdio') {
                serverData.command = commandInput.value.trim();
                if (!serverData.command) { isValid = false; errorMsg = `Command required for Stdio server "${newKey}".`; commandInput.style.border = '1px solid red'; }
                else { commandInput.style.border = ''; }
                const argsString = argsInput.value.trim();
                serverData.args = argsString ? argsString.split(',').map(arg => arg.trim()).filter(arg => arg) : [];
                serverData.env = {};
                if (envVarsContainer) {
                    envVarsContainer.querySelectorAll('.env-var-row').forEach(row => {
                        const envKeyInput = row.querySelector('.env-key-input');
                        const envValueInput = row.querySelector('.env-value-input');
                        const key = envKeyInput.value.trim();
                        const value = envValueInput.value; // Keep value as is, don't trim
                        if (key) {
                            if (serverData.env.hasOwnProperty(key)) {
                                isValid = false; errorMsg = `Duplicate env key "${key}" for server "${newKey}".`;
                                envKeyInput.style.border = '1px solid red';
                            } else { serverData.env[key] = value; envKeyInput.style.border = '';}
                        } else if (value) { // Only error if value is present but key is not
                             isValid = false; errorMsg = `Env key cannot be empty if value is set for server "${newKey}".`;
                             envKeyInput.style.border = '1px solid red';
                        } else {
                            envKeyInput.style.border = ''; // Clear border if both are empty
                        }
                    });
                }
                if (!isValid) return; // Exit early if env var validation failed
                if (installDirInputFromForm && installCmdsInput) {
                    const installDir = installDirInputFromForm.value.trim();
                    const installCmds = installCmdsInput.value.trim().split('\n').map(cmd => cmd.trim()).filter(cmd => cmd);
                    if (installDir) {
                         serverData.installDirectory = installDir;
                         serverData.installCommands = installCmds; // Can be empty array
                    } else if (installCmds.length > 0) { // Only error if commands exist but dir doesn't
                         isValid = false; errorMsg = `Install Directory required if Install Commands provided for "${newKey}".`;
                         installDirInputFromForm.style.border = '1px solid red';
                    } else {
                        if (installDirInputFromForm) installDirInputFromForm.style.border = ''; // Clear border if both are empty
                    }
                }
            } else {
                 isValid = false; errorMsg = `Unknown or unhandled server type "${serverType}" for server "${newKey}".`;
                 const header = entryDiv.querySelector('.server-header');
                 if(header) header.style.border = '1px solid red';
            }

            if (isValid) {
                 if (originalKey && originalKey !== newKey) {
                     delete newConfig.mcpServers[originalKey];
                 }
                 newConfig.mcpServers[newKey] = serverData;
                 const header = entryDiv.querySelector('.server-header');
                 if(header) header.style.border = '';
            }
        });

        if (!isValid) {
            localSaveStatus.textContent = `Error: ${errorMsg}`;
            localSaveStatus.style.color = 'red';
            setTimeout(() => { if(localSaveStatus) localSaveStatus.textContent = ''; localSaveStatus.style.color = 'green'; }, 5000);
            return;
        }

        try {
            const response = await fetch('/admin/config', {
                method: 'POST',
                headers: typeof csrfHeaders === 'function' ? csrfHeaders({}) : { 'Content-Type': 'application/json' },
                body: JSON.stringify(newConfig)
            });
            const result = await response.json();
            if (response.ok && result.success) {
                localSaveStatus.textContent = 'Server configuration saved successfully.';
                localSaveStatus.style.color = 'green';
                window.currentServerConfig = newConfig;
                window.isServerConfigDirty = false; 
                renderServerConfig(window.currentServerConfig); 
                if (typeof window.triggerReload === 'function') {
                    await window.triggerReload(localSaveStatus);
                } else {
                     console.error("triggerReload function not found.");
                     localSaveStatus.textContent += ' Reload trigger function not found!';
                     localSaveStatus.style.color = 'red';
                     setTimeout(() => { if(localSaveStatus) localSaveStatus.textContent = ''; localSaveStatus.style.color = 'green'; }, 7000);
                }
            } else {
                localSaveStatus.textContent = `Error saving: ${result.error || response.statusText}`;
                localSaveStatus.style.color = 'red';
                 setTimeout(() => { if(localSaveStatus) localSaveStatus.textContent = ''; localSaveStatus.style.color = 'green'; }, 5000);
            }
        } catch (error) {
            localSaveStatus.textContent = `Network error saving: ${error.message}`;
            localSaveStatus.style.color = 'red';
             setTimeout(() => { if(localSaveStatus) localSaveStatus.textContent = ''; localSaveStatus.style.color = 'green'; }, 5000);
        }
    });
}

// Expose functions to be called from script.js
window.loadServerConfig = loadServerConfig;
window.loadServerOverview = loadServerOverview;
window.renderServerDetail = renderServerDetail;
window.renderServerEntry = renderServerEntry; // Keep this exposed if script.js uses it directly
window.addInstallButtonListeners = addInstallButtonListeners;
window.handleInstallClick = handleInstallClick;
window.initializeServerSaveListener = initializeServerSaveListener;

// --- Helper function to add a new server entry of a specific type ---
// This can be called by buttons in index.html (via script.js)
window.addNewServerEntry = function(type) {
    if (!serverListDiv) {
        console.error("Cannot add new server: serverListDiv not found.");
        return;
    }
    let newKeyNumber = 1;
    while (window.currentServerConfig && window.currentServerConfig.mcpServers && window.currentServerConfig.mcpServers.hasOwnProperty(`new_${type}_server_${newKeyNumber}`)) {
        newKeyNumber++;
    }
    const newKey = `new_${type}_server_${newKeyNumber}`;

    const defaultConfig = {
        name: `New ${type.toUpperCase()} Server`,
        active: true,
        type: type
    };

    if (type === 'stdio') {
        defaultConfig.command = "";
        defaultConfig.args = [];
        defaultConfig.env = {};
    } else if (type === 'sse' || type === 'http') {
        defaultConfig.url = "";
    }
    
    // Add to current config in memory (optional, but good for consistency if not saving immediately)
    if (!window.currentServerConfig) window.currentServerConfig = { mcpServers: {} };
    if (!window.currentServerConfig.mcpServers) window.currentServerConfig.mcpServers = {};
    window.currentServerConfig.mcpServers[newKey] = defaultConfig;

    renderServerEntry(newKey, defaultConfig, true); // Render expanded
    window.isServerConfigDirty = true;
    const newEntryDiv = serverListDiv.querySelector(`.server-entry[data-server-key="${newKey}"]`);
    if (newEntryDiv) {
        newEntryDiv.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const keyInput = newEntryDiv.querySelector('.server-key-input');
        if(keyInput) keyInput.focus();
    }
}

console.log("servers.js loaded");
