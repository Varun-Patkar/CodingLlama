/**
 * CodingLlama — Webview-side JavaScript
 *
 * Copilot-style layout:
 *  - Top bar with sessions toggle and new chat button
 *  - Collapsible horizontal sessions list
 *  - Chat messages area
 *  - Self-contained input box at bottom with mode dropup + model dropup + send
 *
 * acquireVsCodeApi() is called exactly ONCE at the top level.
 * Static models data is injected by the extension as window.__STATIC_MODELS__.
 */
(function () {
  // ── VS Code API — must be called exactly once ──────────────────────────
  const vscode = acquireVsCodeApi();

  // ── Static models data injected by webviewHtml.ts ──────────────────────
  const STATIC_MODELS = window.__STATIC_MODELS__ || [];

  // ── Application state ──────────────────────────────────────────────────
  let state = vscode.getState() || {
    sessions: [],
    activeSession: null,
    selectedModel: null,
    installedModels: [],
    pullingModels: {},
    sessionsExpanded: true,
    activeMode: 'Ask',
    attachments: [],
    sessionFilter: 'all',     // 'all' | 'streaming' | 'unread'
  };

  // Per-session streaming state: { [sessionId]: { content, active } }
  var streamingStates = {};

  // Editor context from the extension (current file + selection info)
  let editorContext = { fileName: null, hasSelection: false, selectionText: null, selectionRange: null };

  // System prompt token count (sent by extension on activeSession)
  let systemPromptTokens = 0;

  // Dynamic context sizes fetched from Ollama (for non-static models)
  var dynamicContextSizes = {};

  // Track whether we just finished streaming (to avoid double-render)
  let justFinishedStreaming = false;

  // Track which dropup is open: null, 'mode', or 'model'
  let openDropup = null;
  let messagesContainer = null;
  let chatInput = null;
  let sendBtn = null;

  // ── Initial render ─────────────────────────────────────────────────────
  const app = document.getElementById('app');
  let appReady = false;

  // Show connectivity check screen first
  renderOllamaCheck();
  vscode.postMessage({ type: 'checkOllama' });

  // ── Message listener — receives data from the extension host ───────────
  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'ollamaStatus':
        if (msg.online) {
          if (!appReady) {
            appReady = true;
            render();
            vscode.postMessage({ type: 'ready' });
          }
        } else {
          renderOllamaOffline();
        }
        break;

      case 'sessions':
        state.sessions = msg.sessions;
        saveState();
        renderSessionsList();
        break;

      case 'activeSession':
        var prevSessionId = state.activeSession ? state.activeSession.id : null;
        state.activeSession = msg.session;
        if (msg.selectedModel) {
          state.selectedModel = msg.selectedModel;
        }
        if (msg.systemPromptTokens !== undefined) {
          systemPromptTokens = msg.systemPromptTokens;
        }
        saveState();
        var newSessionId = state.activeSession ? state.activeSession.id : null;
        // Skip re-render only if we just finished streaming on the SAME session
        if (justFinishedStreaming && prevSessionId === newSessionId) {
          justFinishedStreaming = false;
        } else {
          justFinishedStreaming = false;
          renderChatArea();
        }
        renderSessionsList();
        updateModelButton();
        updateTokenCounter();
        break;

      case 'userMessage':
        scrollToBottom();
        break;

      case 'streamStart': {
        var sid = msg.sessionId;
        streamingStates[sid] = { content: '', active: true };
        // Only show streaming UI if this is the active session
        if (state.activeSession && state.activeSession.id === sid) {
          appendStreamingMessage();
        }
        renderSessionsList(); // update status icon
        break;
      }

      case 'streamToken': {
        var sid2 = msg.sessionId;
        if (streamingStates[sid2]) {
          streamingStates[sid2].content += msg.token;
        }
        if (state.activeSession && state.activeSession.id === sid2) {
          updateStreamingMessage(streamingStates[sid2]?.content || '');
          scrollToBottom();
        }
        break;
      }

      case 'streamReplay': {
        // Replaying accumulated content when switching to a streaming session
        var sid3 = msg.sessionId;
        if (streamingStates[sid3]) {
          streamingStates[sid3].content = msg.content;
        }
        if (state.activeSession && state.activeSession.id === sid3) {
          appendStreamingMessage();
          updateStreamingMessage(msg.content);
          scrollToBottom();
        }
        break;
      }

      case 'streamEnd': {
        var sid4 = msg.sessionId;
        delete streamingStates[sid4];
        if (state.activeSession && state.activeSession.id === sid4) {
          justFinishedStreaming = true;
          finaliseStreamingMessage();
          enableInput();
          scrollToBottom();
        }
        renderSessionsList();
        break;
      }

      case 'streamError': {
        var sid5 = msg.sessionId;
        delete streamingStates[sid5];
        if (state.activeSession && state.activeSession.id === sid5) {
          showStreamError(msg.error);
          enableInput();
        }
        renderSessionsList();
        break;
      }

      case 'models':
        state.installedModels = msg.installed;
        if (msg.contextSizes) { dynamicContextSizes = msg.contextSizes; }
        // Auto-select best installed model if none selected yet
        autoSelectModel();
        saveState();
        if (openDropup === 'model') { renderModelDropup(); }
        updateTokenCounter();
        break;

      case 'pullStart':
        state.pullingModels[msg.model] = 0;
        saveState();
        if (openDropup === 'model') { renderModelDropup(); }
        break;

      case 'pullProgress':
        state.pullingModels[msg.model] = msg.progress;
        saveState();
        if (openDropup === 'model') { renderModelDropup(); }
        break;

      case 'pullDone':
        delete state.pullingModels[msg.model];
        saveState();
        break;

      case 'pullError':
        delete state.pullingModels[msg.model];
        saveState();
        if (openDropup === 'model') { renderModelDropup(); }
        break;

      case 'compactStart':
        // Show a "compacting" indicator in the chat area
        if (messagesContainer) {
          messagesContainer.innerHTML = '';
          var compactMsg = el('div', { className: 'chat-empty' });
          compactMsg.appendChild(el('div', { className: 'chat-empty-icon', textContent: '📦' }));
          compactMsg.appendChild(el('div', { className: 'chat-empty-text', textContent: 'Compacting conversation...' }));
          messagesContainer.appendChild(compactMsg);
        }
        break;

      case 'editorContext':
        editorContext = {
          fileName: msg.fileName || null,
          hasSelection: msg.hasSelection || false,
          selectionText: msg.selectionText || null,
          selectionRange: msg.selectionRange || null,
        };
        renderContextBar();
        updateTokenCounter();
        break;

      case 'fileAdded':
        addAttachment({ type: 'file', name: msg.name, content: msg.content });
        break;

      case 'selectionAdded':
        addAttachment({ type: 'selection', name: msg.name, content: msg.content });
        break;

      case 'imageAdded':
        addAttachment({ type: 'image', name: msg.name, dataUrl: msg.dataUrl });
        break;
    }
  });

  function saveState() { vscode.setState(state); }

  // ── Auto model selection logic ─────────────────────────────────────────

  /**
   * Auto-selects the best installed model:
   *  1. If a recommended (static) model is installed, pick best tier (high > medium > low)
   *  2. Otherwise pick from whatever is installed in Ollama
   *  3. Only runs if no model is currently selected or selected model isn't installed
   */
  function autoSelectModel() {
    const installed = state.installedModels || [];
    if (installed.length === 0) { return; }

    // If current selection is installed, keep it
    if (state.selectedModel && installed.includes(state.selectedModel)) { return; }

    // Tier priority for static models
    const tierPriority = { high: 3, medium: 2, low: 1 };

    // Find the best installed static model
    const installedStatic = STATIC_MODELS
      .filter(m => installed.includes(m.id))
      .sort((a, b) => (tierPriority[b.tier] || 0) - (tierPriority[a.tier] || 0));

    if (installedStatic.length > 0) {
      state.selectedModel = installedStatic[0].id;
    } else {
      // No static models installed — pick the first installed model
      state.selectedModel = installed[0];
    }

    saveState();
    vscode.postMessage({ type: 'selectModel', model: state.selectedModel });
    updateModelButton();
  }

  // ── Ollama connectivity screens ─────────────────────────────────────────

  /** Shows a "Checking Ollama..." spinner while we verify connectivity. */
  function renderOllamaCheck() {
    app.innerHTML = '';
    const wrap = el('div', { className: 'chat-empty' });
    wrap.style.height = '100%';
    wrap.appendChild(el('div', { className: 'chat-empty-icon', textContent: '🔍' }));
    wrap.appendChild(el('div', { className: 'chat-empty-text', textContent: 'Checking if Ollama is running...' }));
    app.appendChild(wrap);
  }

  /** Shows instructions to start Ollama + a Retry button. */
  function renderOllamaOffline() {
    app.innerHTML = '';
    const wrap = el('div', { style: 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;padding:16px;gap:14px;text-align:center;' });

    wrap.appendChild(el('div', { style: 'font-size:36px;', textContent: '⚠️' }));
    wrap.appendChild(el('div', { style: 'font-size:14px;font-weight:600;', textContent: 'Ollama is not running' }));
    wrap.appendChild(el('div', { style: 'font-size:12px;opacity:0.7;', textContent: 'Start the Ollama server first, then click Retry.' }));

    // Command instructions
    const commands = el('div', { style: 'width:100%;max-width:340px;text-align:left;display:flex;flex-direction:column;gap:10px;margin-top:4px;' });

    const cmdSections = [
      { label: 'PowerShell', cmd: '$env:OLLAMA_ORIGINS="*"; ollama serve' },
      { label: 'CMD (Windows)', cmd: 'set OLLAMA_ORIGINS=* && ollama serve' },
      { label: 'Bash / macOS Terminal', cmd: 'OLLAMA_ORIGINS=* ollama serve' },
      { label: 'Docker', cmd: 'docker run -d -p 11434:11434 -e OLLAMA_ORIGINS=* ollama/ollama' },
    ];

    cmdSections.forEach((section) => {
      const group = el('div', { style: 'display:flex;flex-direction:column;gap:2px;' });
      group.appendChild(el('div', { style: 'font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.4px;opacity:0.5;', textContent: section.label }));
      const codeWrap = el('div', { style: 'background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border,#444);border-radius:4px;padding:6px 8px;font-family:var(--vscode-editor-font-family,monospace);font-size:12px;word-break:break-all;user-select:all;cursor:text;' });
      codeWrap.textContent = section.cmd;
      group.appendChild(codeWrap);
      commands.appendChild(group);
    });

    wrap.appendChild(commands);

    // Retry button
    const retryBtn = el('button', { style: 'margin-top:8px;background:var(--vscode-button-background,#0e639c);color:var(--vscode-button-foreground,#fff);border:none;border-radius:4px;padding:6px 20px;font-size:13px;cursor:pointer;font-family:inherit;' });
    retryBtn.textContent = 'Retry';
    retryBtn.addEventListener('click', () => {
      renderOllamaCheck();
      vscode.postMessage({ type: 'checkOllama' });
    });
    wrap.appendChild(retryBtn);

    app.appendChild(wrap);
  }

  // ── Render ─────────────────────────────────────────────────────────────

  /** Full initial render. */
  function render() {
    app.innerHTML = '';
    app.appendChild(createTopBar());
    app.appendChild(createSessionsBar());

    const chatArea = el('div', { className: 'chat-area' });
    messagesContainer = el('div', { className: 'messages-container', id: 'messages-container' });
    chatArea.appendChild(messagesContainer);
    app.appendChild(chatArea);

    app.appendChild(createInputBox());
    renderChatArea();
    renderSessionsList();
    // Request editor context for the "+" button
    vscode.postMessage({ type: 'getEditorContext' });
  }

  // ── Top bar ────────────────────────────────────────────────────────────

  function createTopBar() {
    const bar = el('div', { className: 'top-bar' });

    const left = el('div', { className: 'top-bar-left' });
    const title = el('div', { className: 'top-bar-title', id: 'sessions-toggle' });
    const chevron = el('span', {
      className: 'chevron' + (state.sessionsExpanded ? ' open' : ''),
      textContent: '▶',
      id: 'sessions-chevron',
    });
    title.appendChild(chevron);
    title.appendChild(document.createTextNode(' Sessions'));
    title.addEventListener('click', toggleSessions);
    left.appendChild(title);
    bar.appendChild(left);

    const actions = el('div', { className: 'top-bar-actions' });

    // Filter dropdown
    var filterSelect = el('select', { className: 'session-filter', id: 'session-filter', title: 'Filter sessions' });
    [['all', 'All'], ['streaming', '⟳ Active'], ['unread', '● Unread']].forEach(function(opt) {
      var o = el('option', { textContent: opt[1] });
      o.value = opt[0];
      if (state.sessionFilter === opt[0]) { o.selected = true; }
      filterSelect.appendChild(o);
    });
    filterSelect.addEventListener('change', function() {
      state.sessionFilter = filterSelect.value;
      saveState();
      renderSessionsList();
    });
    actions.appendChild(filterSelect);

    const newBtn = el('button', { className: 'icon-btn', title: 'New Chat', textContent: '+' });
    newBtn.addEventListener('click', () => vscode.postMessage({ type: 'newChat' }));
    actions.appendChild(newBtn);
    bar.appendChild(actions);

    return bar;
  }

  function toggleSessions() {
    state.sessionsExpanded = !state.sessionsExpanded;
    saveState();
    const bar = document.getElementById('sessions-bar');
    const chevron = document.getElementById('sessions-chevron');
    if (bar) {
      bar.className = 'sessions-bar ' + (state.sessionsExpanded ? '' : 'collapsed');
    }
    if (chevron) {
      chevron.className = 'chevron' + (state.sessionsExpanded ? ' open' : '');
    }
  }

  // ── Sessions bar ───────────────────────────────────────────────────────

  function createSessionsBar() {
    const bar = el('div', {
      className: 'sessions-bar ' + (state.sessionsExpanded ? '' : 'collapsed'),
      id: 'sessions-bar',
    });
    const scroll = el('div', { className: 'sessions-scroll', id: 'sessions-list' });
    bar.appendChild(scroll);
    return bar;
  }

  function renderSessionsList() {
    const list = document.getElementById('sessions-list');
    if (!list) { return; }
    list.innerHTML = '';

    const sessions = state.sessions || [];
    const activeId = state.activeSession?.id;
    const filter = state.sessionFilter || 'all';

    // Apply filter
    var filtered = sessions;
    if (filter === 'streaming') {
      filtered = sessions.filter(function(s) { return !!streamingStates[s.id]; });
    } else if (filter === 'unread') {
      filtered = sessions.filter(function(s) { return s.status === 'unread' || !!streamingStates[s.id]; });
    }

    if (filtered.length === 0) {
      var emptyText = sessions.length === 0 ? 'No sessions yet' : 'No matching sessions';
      list.appendChild(el('div', { className: 'sessions-empty', textContent: emptyText }));
      return;
    }

    filtered.forEach((session) => {
      const item = el('div', {
        className: 'session-item' + (session.id === activeId ? ' active' : ''),
      });

      // Status icon
      var isStreaming = !!streamingStates[session.id];
      var statusIcon = '';
      var statusClass = 'session-status';
      if (isStreaming) {
        statusIcon = '⟳';
        statusClass += ' status-streaming';
      } else if (session.status === 'unread') {
        statusIcon = '●';
        statusClass += ' status-unread';
      }
      if (statusIcon) {
        item.appendChild(el('span', { className: statusClass, textContent: statusIcon }));
      }

      item.appendChild(el('span', { className: 'session-title', textContent: session.title }));
      item.appendChild(el('span', { className: 'session-time', textContent: formatTime(session.createdAt) }));

      const delBtn = el('button', {
        className: 'session-delete',
        textContent: '×',
        title: 'Delete session',
      });
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'deleteSession', id: session.id });
      });
      item.appendChild(delBtn);

      item.addEventListener('click', () => {
        vscode.postMessage({ type: 'selectSession', id: session.id });
      });

      list.appendChild(item);
    });
  }

  // ── Chat area ──────────────────────────────────────────────────────────

  function renderChatArea() {
    messagesContainer = document.getElementById('messages-container');
    if (!messagesContainer) { return; }
    messagesContainer.innerHTML = '';

    const session = state.activeSession;

    if (!session) {
      const empty = el('div', { className: 'chat-empty' });
      empty.appendChild(el('div', { className: 'chat-empty-icon', textContent: '💬' }));
      empty.appendChild(el('div', { className: 'chat-empty-text', textContent: 'Start a new chat or select a session' }));
      messagesContainer.appendChild(empty);
      return;
    }

    if (session.messages.length === 0) {
      const empty = el('div', { className: 'chat-empty' });
      empty.appendChild(el('div', { className: 'chat-empty-icon', textContent: '🦙' }));
      empty.appendChild(el('div', { className: 'chat-empty-text', textContent: 'Ask me anything about your code' }));
      messagesContainer.appendChild(empty);
      return;
    }

    session.messages.forEach((msg, idx) => {
      messagesContainer.appendChild(createMessageEl(msg.role, msg.content, msg.attachments || null, idx, msg.model || null));
    });

    // Redo button — shown when there's a redo stack
    if (session.redoStack && session.redoStack.length > 0) {
      var redoBar = el('div', { className: 'redo-bar' });
      var redoBtn = el('button', { className: 'redo-btn', title: 'Redo — restore removed messages' });
      redoBtn.textContent = 'Redo (' + session.redoStack.length + ' messages)';
      redoBtn.addEventListener('click', function() {
        vscode.postMessage({ type: 'redoMessages' });
      });
      redoBar.appendChild(redoBtn);
      messagesContainer.appendChild(redoBar);
    }

    scrollToBottom();
  }

  function createMessageEl(role, content, attachments, messageIndex, modelName) {
    var wrapper = el('div', { className: 'message-wrapper' });

    // Checkpoint bar (before each message except index 0)
    if (messageIndex > 0) {
      var cpBar = el('div', { className: 'checkpoint-bar' });
      var restoreBtn = el('button', { className: 'checkpoint-btn', title: 'Restore checkpoint — go back to this point' });
      restoreBtn.textContent = 'Restore Checkpoint';
      restoreBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        vscode.postMessage({ type: 'restoreCheckpoint', messageIndex: messageIndex });
      });
      cpBar.appendChild(restoreBtn);

      var forkBtn = el('button', { className: 'checkpoint-btn', title: 'Fork conversation from this point' });
      forkBtn.textContent = 'Fork';
      forkBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        vscode.postMessage({ type: 'forkConversation', messageIndex: messageIndex });
      });
      cpBar.appendChild(forkBtn);

      wrapper.appendChild(cpBar);
    }

    if (role === 'user') {
      wrapper.appendChild(createUserBubble(content, attachments, messageIndex));
    } else {
      wrapper.appendChild(createAssistantBubble(content, modelName));
    }

    return wrapper;
  }

  /** Creates a right-aligned user bubble. Clickable to edit inline. */
  function createUserBubble(content, attachments, messageIndex) {
    var bubble = el('div', { className: 'bubble-user' });
    bubble.setAttribute('data-msg-index', messageIndex);

    var body = el('div', { className: 'bubble-content' });
    body.innerHTML = renderMarkdown(content);
    bubble.appendChild(body);

    // Attachment pills below content
    if (attachments && attachments.length > 0) {
      var attBar = el('div', { className: 'msg-attachments' });
      attachments.forEach(function(att) {
        var tag = el('span', { className: 'msg-attachment-tag' });
        var imgSrc = att.dataUrl || att.imageUri;
        if (att.type === 'image' && imgSrc) {
          var thumb = document.createElement('img');
          thumb.className = 'msg-attachment-thumb';
          thumb.src = imgSrc;
          thumb.addEventListener('click', function(e) { e.stopPropagation(); openImageModal(imgSrc); });
          tag.appendChild(thumb);
        } else if (att.type === 'image') {
          tag.appendChild(el('span', { className: 'tag-icon', textContent: '🖼' }));
        } else {
          tag.appendChild(el('span', { className: 'tag-icon', textContent: att.type === 'selection' ? '✂' : '📄' }));
        }
        tag.appendChild(document.createTextNode(att.name));
        attBar.appendChild(tag);
      });
      bubble.appendChild(attBar);
    }

    // Click to enter edit mode
    bubble.addEventListener('click', function(e) {
      if (e.target.tagName === 'IMG' || e.target.tagName === 'BUTTON') { return; }
      if (bubble.classList.contains('editing')) { return; }
      openBubbleEdit(bubble, messageIndex, content, attachments);
    });

    return bubble;
  }

  /** Creates a left-aligned assistant bubble with action bar + model badge. */
  function createAssistantBubble(content, modelName) {
    var bubble = el('div', { className: 'bubble-assistant' });

    var body = el('div', { className: 'bubble-content' });
    body.innerHTML = renderMarkdown(content);
    bubble.appendChild(body);

    // Action bar: copy + regenerate + model badge
    var actions = el('div', { className: 'bubble-actions' });

    var copyBtn = el('button', { className: 'bubble-action-btn', title: 'Copy response' });
    copyBtn.textContent = '📋';
    copyBtn.addEventListener('click', function() {
      navigator.clipboard.writeText(content).then(function() {
        copyBtn.textContent = '✓';
        setTimeout(function() { copyBtn.textContent = '📋'; }, 1500);
      });
    });
    actions.appendChild(copyBtn);

    // Hide regenerate while this session is streaming
    if (!isActiveSessionStreaming()) {
      var regenBtn = el('button', { className: 'bubble-action-btn', title: 'Regenerate response' });
      regenBtn.textContent = '🔄';
      regenBtn.addEventListener('click', function() {
        if (!state.activeSession) { return; }
        var msgs = state.activeSession.messages;
        for (var i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role === 'user') {
            vscode.postMessage({
              type: 'resend',
              messageIndex: i,
              text: msgs[i].content,
              model: state.selectedModel,
              attachments: [],
            });
            break;
          }
        }
      });
      actions.appendChild(regenBtn);
    }

    if (modelName) {
      actions.appendChild(el('span', { className: 'bubble-model-badge', textContent: modelName }));
    }

    bubble.appendChild(actions);
    return bubble;
  }

  function appendStreamingMessage() {
    if (!messagesContainer) { return; }
    const empty = messagesContainer.querySelector('.chat-empty');
    if (empty) { empty.remove(); }

    const msg = el('div', { className: 'bubble-assistant', id: 'streaming-msg' });
    msg.appendChild(el('div', { className: 'bubble-content streaming-cursor', id: 'streaming-content' }));
    messagesContainer.appendChild(msg);
    disableInput();
    scrollToBottom();
  }

  function updateStreamingMessage(content) {
    const body = document.getElementById('streaming-content');
    if (body) { body.innerHTML = renderMarkdown(content || ''); }
  }

  function finaliseStreamingMessage() {
    const body = document.getElementById('streaming-content');
    if (body) {
      body.classList.remove('streaming-cursor');
      body.removeAttribute('id');
    }
    const msg = document.getElementById('streaming-msg');
    if (msg) { msg.removeAttribute('id'); }
    saveState();
  }

  function showStreamError(error) {
    if (!messagesContainer) { return; }
    const streamMsg = document.getElementById('streaming-msg');
    if (streamMsg) { streamMsg.remove(); }
    const errEl = el('div', { className: 'message-error', id: 'temp-error' });
    errEl.textContent = '⚠ Error: ' + error;
    messagesContainer.appendChild(errEl);
    scrollToBottom();
    // Auto-dismiss after 5 seconds
    setTimeout(function() {
      var e = document.getElementById('temp-error');
      if (e) { e.remove(); }
    }, 5000);
  }

  function scrollToBottom() {
    if (messagesContainer) {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
  }

  // ── Input box ──────────────────────────────────────────────────────────

  function createInputBox() {
    const box = el('div', { className: 'input-box', id: 'input-box' });

    // Context bar: attached files/images + "add file" button
    const contextBar = el('div', { className: 'context-bar', id: 'context-bar' });
    box.appendChild(contextBar);

    // Textarea
    chatInput = el('textarea', {
      className: 'chat-input',
      id: 'chat-input',
      placeholder: 'Ask CodingLlama...',
    });
    chatInput.setAttribute('rows', '2');
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    });

    // Update token counter as user types
    chatInput.addEventListener('input', () => { updateTokenCounter(); });

    // Paste handler — images for vision models
    chatInput.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      if (!items) { return; }
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) { readImageFile(file); }
          break;
        }
      }
    });

    box.appendChild(chatInput);

    // Drag & drop handlers on the input box
    box.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      box.classList.add('drag-over');
    });
    box.addEventListener('dragleave', (e) => {
      e.preventDefault();
      box.classList.remove('drag-over');
    });
    box.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      box.classList.remove('drag-over');
      handleDrop(e);
    });

    // Toolbar row
    const toolbar = el('div', { className: 'input-toolbar' });

    // Left: mode + model pills
    const left = el('div', { className: 'input-toolbar-left' });

    // Mode dropdown button
    const modeBtn = el('button', { className: 'pill-btn', id: 'mode-btn' });
    modeBtn.appendChild(el('span', { className: 'pill-label', textContent: state.activeMode }));
    modeBtn.appendChild(el('span', { className: 'arrow', textContent: '▲' }));
    modeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleDropup('mode');
    });
    left.appendChild(modeBtn);

    // Model dropdown button
    const modelBtn = el('button', { className: 'pill-btn', id: 'model-btn' });
    modelBtn.appendChild(el('span', { className: 'pill-label', id: 'model-btn-label', textContent: getSelectedModelLabel() }));
    modelBtn.appendChild(el('span', { className: 'arrow', textContent: '▲' }));
    modelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleDropup('model');
    });
    left.appendChild(modelBtn);

    toolbar.appendChild(left);

    // Right: token counter + send button
    const right = el('div', { className: 'input-toolbar-right' });

    // Token counter (pie chart circle)
    right.appendChild(createTokenCounter());

    sendBtn = el('button', { className: 'send-btn', id: 'send-btn', title: 'Send message' });
    sendBtn.textContent = '➤';
    sendBtn.addEventListener('click', handleSend);
    right.appendChild(sendBtn);

    // Stop button (hidden by default, shown during streaming)
    const stopBtn = el('button', { className: 'stop-btn', id: 'stop-btn', title: 'Stop generation' });
    stopBtn.textContent = '■';
    stopBtn.style.display = 'none';
    stopBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'stopGeneration', sessionId: state.activeSession ? state.activeSession.id : null });
    });
    right.appendChild(stopBtn);
    right.appendChild(sendBtn);

    toolbar.appendChild(right);
    box.appendChild(toolbar);

    return box;
  }

  function getSelectedModelLabel() {
    if (!state.selectedModel) { return 'Select model'; }
    var m = STATIC_MODELS.find(function(m) { return m.id === state.selectedModel; });
    return m ? m.label : formatModelName(state.selectedModel);
  }

  /**
   * Converts a raw model ID like "qwen3:8b" or "llama3.1-8b-32k:latest"
   * into "Qwen 3 8B (qwen3:8b)" or "Llama 3.1 8B 32K (llama3.1-8b-32k)".
   */
  function formatModelName(modelId) {
    // Split into name and tag
    var parts = modelId.split(':');
    var name = parts[0];
    var tag = parts.length > 1 ? parts.slice(1).join(':') : '';

    // Convert name: replace - and . with space, capitalize each word, uppercase size tokens
    var formatted = name
      .replace(/[-_.]/g, ' ')
      .replace(/\b(\d+(\.\d+)?)(b|k|m)\b/gi, function(_, num, dec, suffix) {
        return num + suffix.toUpperCase();
      })
      .split(' ')
      .map(function(word) {
        // Don't capitalize pure size tokens like "8B", "32K"
        if (/^\d/.test(word)) { return word; }
        return word.charAt(0).toUpperCase() + word.slice(1);
      })
      .join(' ');

    // Add tag in parentheses if it's not "latest"
    if (tag && tag !== 'latest') {
      return formatted + ' (' + modelId + ')';
    }
    return formatted + ' (' + name + ')';
  }

  function updateModelButton() {
    const label = document.getElementById('model-btn-label');
    if (label) { label.textContent = getSelectedModelLabel(); }
  }

  function handleSend() {
    chatInput = document.getElementById('chat-input');
    if (!chatInput) { return; }
    const text = chatInput.value.trim();
    if (!text || isActiveSessionStreaming()) { return; }

    if (!state.selectedModel) {
      showStreamError('No model selected. Open the model picker and select or download one.');
      return;
    }

    // Build attachments payload
    const attachments = (state.attachments || []).map(a => ({
      type: a.type,
      name: a.name,
      content: a.content || undefined,
      dataUrl: a.dataUrl || undefined,
    }));

    // Include auto-selected editor text if present (shown as solid pill)
    if (editorContext.hasSelection && editorContext.selectionText) {
      attachments.unshift({
        type: 'selection',
        name: editorContext.fileName + ':' + editorContext.selectionRange,
        content: editorContext.selectionText,
        dataUrl: undefined,
      });
    }

    // Auto-compact if sending this message would push usage past 90%
    var preCheck = computeTokenBreakdown();
    if (preCheck.pct > 90 && preCheck.historyTokens > 0 && state.activeSession) {
      // Compact first, then send after a delay to let compaction finish
      vscode.postMessage({ type: 'compactAndSend', model: state.selectedModel, text: text, attachments: attachments });
    } else if (!state.activeSession) {
      vscode.postMessage({ type: 'newChat' });
      setTimeout(() => {
        vscode.postMessage({ type: 'send', text, model: state.selectedModel, attachments });
      }, 100);
    } else {
      vscode.postMessage({ type: 'send', text, model: state.selectedModel, attachments });
    }

    // Optimistically render user message with its attachments
    const displayAttachments = attachments.map(function(a) { return { type: a.type, name: a.name, dataUrl: a.dataUrl }; });
    if (messagesContainer) {
      const empty = messagesContainer.querySelector('.chat-empty');
      if (empty) { empty.remove(); }
      const msgCount = state.activeSession ? state.activeSession.messages.length : 0;
      messagesContainer.appendChild(createMessageEl('user', text, displayAttachments, msgCount));
      scrollToBottom();
    }

    chatInput.value = '';
    // Clear attachments after sending
    state.attachments = [];
    saveState();
    renderContextBar();
    updateTokenCounter();
  }

  /** Returns true if the currently viewed session has an active stream. */
  function isActiveSessionStreaming() {
    if (!state.activeSession) { return false; }
    return !!streamingStates[state.activeSession.id];
  }

  function disableInput() {
    const btn = document.getElementById('send-btn');
    const stop = document.getElementById('stop-btn');
    const input = document.getElementById('chat-input');
    if (btn) { btn.style.display = 'none'; }
    if (stop) { stop.style.display = ''; }
    if (input) { input.disabled = true; }
  }

  function enableInput() {
    const btn = document.getElementById('send-btn');
    const stop = document.getElementById('stop-btn');
    const input = document.getElementById('chat-input');
    if (btn) { btn.style.display = ''; btn.disabled = false; }
    if (stop) { stop.style.display = 'none'; }
    if (input) { input.disabled = false; input.focus(); }
  }

  // ── Token counter ───────────────────────────────────────────────────────

  /** Rough token estimate: ~4 characters per token for English/code text. */
  function estimateTokens(text) {
    if (!text) { return 0; }
    return Math.ceil(text.length / 4);
  }

  /** Gets the context window size for the selected model. */
  function getContextSize() {
    var m = STATIC_MODELS.find(function(m) { return m.id === state.selectedModel; });
    if (m) { return m.contextSize; }
    // Use dynamic context size from Ollama /api/show
    if (state.selectedModel && dynamicContextSizes[state.selectedModel]) {
      return dynamicContextSizes[state.selectedModel];
    }
    return 8192; // fallback
  }

  /** Computes a full token breakdown for the current input state. */
  function computeTokenBreakdown() {
    const inputText = (document.getElementById('chat-input') || {}).value || '';
    const session = state.activeSession;
    const contextSize = getContextSize();

    // System prompt tokens (constant, sent by extension)
    var sysTokens = systemPromptTokens || 0;

    // History tokens (all existing messages)
    let historyTokens = 0;
    if (session && session.messages) {
      session.messages.forEach(function(msg) {
        historyTokens += estimateTokens(msg.content);
      });
    }

    // Current input tokens
    const inputTokens = estimateTokens(inputText);

    // Attachment tokens
    let attachmentTokens = 0;
    const atts = state.attachments || [];
    atts.forEach(function(a) {
      if (a.content) { attachmentTokens += estimateTokens(a.content); }
      if (a.type === 'image') { attachmentTokens += 768; } // images use ~768 tokens
    });

    // Selection context tokens (auto-attached)
    let selectionTokens = 0;
    if (editorContext.hasSelection && editorContext.selectionText) {
      selectionTokens = estimateTokens(editorContext.selectionText);
    }

    const totalUsed = sysTokens + historyTokens + inputTokens + attachmentTokens + selectionTokens;
    const pct = Math.min((totalUsed / contextSize) * 100, 100);

    return {
      systemTokens: sysTokens,
      historyTokens,
      inputTokens,
      attachmentTokens,
      selectionTokens,
      totalUsed,
      contextSize,
      pct,
    };
  }

  /** Creates the token counter SVG pie chart element. */
  function createTokenCounter() {
    const wrap = el('div', { className: 'token-counter', id: 'token-counter' });

    // SVG pie ring
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');

    const bgCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    bgCircle.setAttribute('cx', '12');
    bgCircle.setAttribute('cy', '12');
    bgCircle.setAttribute('r', '9');
    bgCircle.setAttribute('class', 'ring-bg');
    svg.appendChild(bgCircle);

    const fillCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    fillCircle.setAttribute('cx', '12');
    fillCircle.setAttribute('cy', '12');
    fillCircle.setAttribute('r', '9');
    fillCircle.setAttribute('class', 'ring-fill green');
    fillCircle.setAttribute('id', 'token-ring');
    // Circumference = 2 * π * 9 ≈ 56.55
    fillCircle.setAttribute('stroke-dasharray', '56.55');
    fillCircle.setAttribute('stroke-dashoffset', '56.55'); // start empty
    svg.appendChild(fillCircle);

    wrap.appendChild(svg);

    // Center label
    wrap.appendChild(el('div', { className: 'tc-label', id: 'token-label', textContent: '0%' }));

    // Tooltip
    const tooltip = el('div', { className: 'token-tooltip', id: 'token-tooltip' });
    wrap.appendChild(tooltip);

    // Hover logic: show on mouseenter, hide 1s after mouseleave
    // unless mouse re-enters counter or tooltip
    var hideTimeout = null;

    function showTooltip() {
      if (hideTimeout) { clearTimeout(hideTimeout); hideTimeout = null; }
      wrap.classList.add('tooltip-visible');
    }

    function scheduleHide() {
      if (hideTimeout) { clearTimeout(hideTimeout); }
      hideTimeout = setTimeout(function() {
        wrap.classList.remove('tooltip-visible');
        hideTimeout = null;
      }, 500);
    }

    wrap.addEventListener('mouseenter', showTooltip);
    wrap.addEventListener('mouseleave', scheduleHide);
    tooltip.addEventListener('mouseenter', showTooltip);
    tooltip.addEventListener('mouseleave', scheduleHide);

    // Initial update
    setTimeout(updateTokenCounter, 50);

    return wrap;
  }

  /** Updates the token counter ring and tooltip. */
  function updateTokenCounter() {
    const b = computeTokenBreakdown();

    // Update ring
    const ring = document.getElementById('token-ring');
    if (ring) {
      const circ = 56.55;
      const offset = circ - (circ * b.pct / 100);
      ring.setAttribute('stroke-dashoffset', String(offset));
      ring.className.baseVal = 'ring-fill ' + (b.pct > 90 ? 'red' : b.pct > 70 ? 'yellow' : 'green');
    }

    // Update label
    const label = document.getElementById('token-label');
    if (label) { label.textContent = Math.round(b.pct) + '%'; }

    // Update tooltip
    const tooltip = document.getElementById('token-tooltip');
    if (tooltip) {
      tooltip.innerHTML = '';
      const rows = [
        ['System Prompt', formatTokenCount(b.systemTokens)],
        ['History', formatTokenCount(b.historyTokens)],
        ['Input', formatTokenCount(b.inputTokens)],
        ['Attachments', formatTokenCount(b.attachmentTokens)],
      ];
      if (b.selectionTokens > 0) {
        rows.push(['Selection', formatTokenCount(b.selectionTokens)]);
      }

      rows.forEach(function(r) {
        const row = el('div', { className: 'token-tooltip-row' });
        row.appendChild(el('span', { className: 'token-tooltip-label', textContent: r[0] }));
        row.appendChild(el('span', { className: 'token-tooltip-value', textContent: r[1] }));
        tooltip.appendChild(row);
      });

      tooltip.appendChild(el('div', { className: 'token-tooltip-sep' }));

      const totalRow = el('div', { className: 'token-tooltip-row' });
      totalRow.appendChild(el('span', { className: 'token-tooltip-label', textContent: 'Total' }));
      totalRow.appendChild(el('span', { className: 'token-tooltip-value', textContent: formatTokenCount(b.totalUsed) + ' / ' + formatTokenCount(b.contextSize) }));
      tooltip.appendChild(totalRow);

      // Compact button — always visible, disabled if no messages yet
      tooltip.appendChild(el('div', { className: 'token-tooltip-sep' }));
      var hasMessages = b.historyTokens > 0;
      var compactBtn = el('button', {
        className: 'compact-btn' + (hasMessages && !isActiveSessionStreaming() ? '' : ' compact-btn-disabled'),
        textContent: '📦 Compact conversation',
        title: hasMessages ? 'Summarize conversation to save tokens' : 'Send at least 1 message first',
      });
      if (hasMessages && !isActiveSessionStreaming()) {
        compactBtn.addEventListener('click', function() {
          vscode.postMessage({ type: 'compactConversation', model: state.selectedModel });
        });
      }
      tooltip.appendChild(compactBtn);
    }
  }

  /** Formats a token count: 1234 → "1.2K", 123456 → "123K" */
  function formatTokenCount(n) {
    if (n >= 1000000) { return (n / 1000000).toFixed(1) + 'M'; }
    if (n >= 1000) { return (n / 1000).toFixed(1) + 'K'; }
    return String(n);
  }

  // ── Context bar & attachments ───────────────────────────────────────────

  /** Checks if the selected model supports vision (has -vl or vision in name). */
  function isVisionModel() {
    const m = (state.selectedModel || '').toLowerCase();
    return m.includes('-vl') || m.includes('vision') || m.includes('llava');
  }

  /** Adds an attachment to state and re-renders the context bar. */
  function addAttachment(att) {
    if (!state.attachments) { state.attachments = []; }
    // Avoid duplicate files
    const exists = state.attachments.some(a => a.name === att.name && a.type === att.type);
    if (exists) { return; }
    state.attachments.push({
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      ...att,
    });
    saveState();
    renderContextBar();
    updateTokenCounter();
  }

  /** Removes an attachment by id. */
  function removeAttachment(id) {
    state.attachments = (state.attachments || []).filter(a => a.id !== id);
    saveState();
    renderContextBar();
    updateTokenCounter();
  }

  /** Renders the context bar: "+" button for current file + attached items. */
  function renderContextBar() {
    const bar = document.getElementById('context-bar');
    if (!bar) { return; }
    bar.innerHTML = '';

    // 📎 Attach file button — opens VS Code file picker
    const attachBtn = el('button', { className: 'add-context-btn', title: 'Attach file' });
    attachBtn.appendChild(el('span', { textContent: '📎' }));
    attachBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'attachFile' });
    });
    bar.appendChild(attachBtn);

    // Show current file / selection as context option
    if (editorContext.fileName) {
      if (editorContext.hasSelection && editorContext.selectionRange) {
        // Selection active — show as a solid pill with line range, auto-added
        const pill = el('div', { className: 'attachment-pill', title: 'Selected text from ' + editorContext.fileName });
        pill.appendChild(el('span', { className: 'pill-icon', textContent: '✂' }));
        pill.appendChild(el('span', { className: 'pill-name', textContent: editorContext.fileName + ':' + editorContext.selectionRange }));
        // "×" removes the auto-selection (user can re-add via "+" button)
        const removeBtn = el('button', { className: 'pill-remove', title: 'Remove', textContent: '×' });
        removeBtn.addEventListener('click', () => {
          editorContext.hasSelection = false;
          editorContext.selectionText = null;
          editorContext.selectionRange = null;
          renderContextBar();
        });
        pill.appendChild(removeBtn);
        bar.appendChild(pill);
      } else {
        // No selection — show dashed "+ filename" button to add the whole file
        const addBtn = el('button', { className: 'add-context-btn', title: 'Add ' + editorContext.fileName });
        addBtn.appendChild(el('span', { className: 'plus', textContent: '+' }));
        addBtn.appendChild(document.createTextNode(' ' + editorContext.fileName));
        addBtn.addEventListener('click', () => {
          vscode.postMessage({ type: 'addCurrentFile' });
        });
        bar.appendChild(addBtn);
      }
    }

    // Render each attachment as a pill
    (state.attachments || []).forEach((att) => {
      const pill = el('div', {
        className: 'attachment-pill' + (att.type === 'image' ? ' attachment-pill-image' : ''),
      });

      if (att.type === 'image' && att.dataUrl) {
        const thumb = el('img', { className: 'pill-thumb' });
        thumb.src = att.dataUrl;
        pill.appendChild(thumb);
      } else {
        const icon = att.type === 'selection' ? '✂' : '📄';
        pill.appendChild(el('span', { className: 'pill-icon', textContent: icon }));
      }

      pill.appendChild(el('span', { className: 'pill-name', textContent: att.name }));

      const removeBtn = el('button', { className: 'pill-remove', title: 'Remove', textContent: '×' });
      removeBtn.addEventListener('click', () => removeAttachment(att.id));
      pill.appendChild(removeBtn);

      bar.appendChild(pill);
    });
  }

  /** Handles files dropped onto the input box. */
  function handleDrop(e) {
    const dt = e.dataTransfer;
    if (!dt) { return; }

    // Handle dropped files from OS file explorer (File objects available)
    if (dt.files && dt.files.length > 0) {
      for (const file of dt.files) {
        if (file.type.startsWith('image/')) {
          readImageFile(file);
        } else {
          readTextFile(file);
        }
      }
      return;
    }

    // Handle URI drops (from VS Code explorer / editor tabs)
    // VS Code puts file URIs in text/uri-list
    const uriList = dt.getData('text/uri-list');
    if (uriList) {
      const lines = uriList.split('\n').filter(l => l.trim() && !l.startsWith('#'));
      for (const uri of lines) {
        const decoded = decodeURIComponent(uri.trim());
        const name = decoded.split(/[\\/]/).pop() || decoded;
        // Send to extension host to read the actual file content
        vscode.postMessage({ type: 'readDroppedUri', uri: decoded, name });
      }
      return;
    }

    // Fallback: try text/plain (some editors put paths here)
    const plainText = dt.getData('text/plain');
    if (plainText && (plainText.startsWith('/') || plainText.startsWith('file://') || /^[a-zA-Z]:[\\/]/.test(plainText))) {
      const name = plainText.split(/[\\/]/).pop() || plainText;
      vscode.postMessage({ type: 'readDroppedUri', uri: plainText, name });
    }
  }

  /** Reads a text file via FileReader and adds it as an attachment. */
  function readTextFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      addAttachment({ type: 'file', name: file.name, content: reader.result });
    };
    reader.readAsText(file);
  }

  /** Reads an image file via FileReader and adds it as an attachment (if vision model). */
  function readImageFile(file) {
    if (!isVisionModel()) {
      showStreamError('Image attachments are only supported with vision models (names containing -vl). Select a vision model first.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      addAttachment({ type: 'image', name: file.name, dataUrl: reader.result });
    };
    reader.readAsDataURL(file);
  }

  // ── Edit & Resend ──────────────────────────────────────────────────────

  /**
   * Opens inline edit mode inside a user bubble.
   * The bubble content is replaced with a textarea. The assistant response
   * below gets greyed out. Click outside or Esc cancels editing.
   */
  function openBubbleEdit(bubble, messageIndex, originalText, originalAttachments) {
    bubble.classList.add('editing');
    var editAttachments = originalAttachments ? originalAttachments.slice() : [];

    // Save original HTML to restore on cancel
    var originalHTML = bubble.innerHTML;

    // Grey out the next sibling (assistant response) if present
    var nextSibling = bubble.nextElementSibling;
    if (nextSibling && nextSibling.classList.contains('bubble-assistant')) {
      nextSibling.classList.add('bubble-greyed');
    }

    // Replace content with textarea
    bubble.innerHTML = '';

    var textarea = el('textarea', { className: 'bubble-edit-textarea' });
    textarea.value = originalText;
    bubble.appendChild(textarea);

    // Auto-fit height to content (no scroll, no manual resize)
    function autoResize() {
      textarea.style.height = 'auto';
      textarea.style.height = textarea.scrollHeight + 'px';
    }
    textarea.addEventListener('input', autoResize);
    // Initial fit after DOM insertion
    setTimeout(autoResize, 0);

    // Editable attachments
    var attArea = el('div', { className: 'bubble-edit-attachments' });
    bubble.appendChild(attArea);

    function renderEditAtts() {
      attArea.innerHTML = '';
      editAttachments.forEach(function(att, i) {
        var pill = el('div', { className: 'attachment-pill' + (att.type === 'image' ? ' attachment-pill-image' : '') });
        if (att.type === 'image' && (att.dataUrl || att.imageUri)) {
          var thumb = document.createElement('img');
          thumb.className = 'pill-thumb';
          thumb.src = att.dataUrl || att.imageUri;
          pill.appendChild(thumb);
        } else {
          pill.appendChild(el('span', { className: 'pill-icon', textContent: att.type === 'selection' ? '✂' : att.type === 'image' ? '🖼' : '📄' }));
        }
        pill.appendChild(el('span', { className: 'pill-name', textContent: att.name }));
        var rmBtn = el('button', { className: 'pill-remove', title: 'Remove', textContent: '×' });
        rmBtn.addEventListener('click', function(e) { e.stopPropagation(); editAttachments.splice(i, 1); renderEditAtts(); });
        pill.appendChild(rmBtn);
        attArea.appendChild(pill);
      });
      var addBtn = el('button', { className: 'add-context-btn' });
      addBtn.appendChild(el('span', { className: 'plus', textContent: '+' }));
      addBtn.appendChild(document.createTextNode(' Add'));
      addBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        vscode.postMessage({ type: 'attachFile' });
        var handler = function(ev) {
          var m = ev.data;
          if (m.type === 'fileAdded') { editAttachments.push({ type: 'file', name: m.name, content: m.content }); renderEditAtts(); window.removeEventListener('message', handler); }
          else if (m.type === 'imageAdded') { editAttachments.push({ type: 'image', name: m.name, dataUrl: m.dataUrl }); renderEditAtts(); window.removeEventListener('message', handler); }
        };
        window.addEventListener('message', handler);
      });
      attArea.appendChild(addBtn);
    }
    renderEditAtts();

    // Action buttons
    var actions = el('div', { className: 'bubble-edit-actions' });
    var cancelBtn = el('button', { className: 'bubble-edit-cancel', textContent: 'Cancel' });
    cancelBtn.addEventListener('click', function(e) { e.stopPropagation(); closeBubbleEdit(bubble, originalHTML, nextSibling); });
    actions.appendChild(cancelBtn);

    var submitBtn = el('button', { className: 'bubble-edit-submit', textContent: 'Submit' });
    submitBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      var newText = textarea.value.trim();
      if (!newText) { return; }
      // If streaming this session, stop it first
      if (isActiveSessionStreaming() && state.activeSession) {
        vscode.postMessage({ type: 'stopGeneration', sessionId: state.activeSession.id });
      }
      vscode.postMessage({
        type: 'resend',
        messageIndex: messageIndex,
        text: newText,
        model: state.selectedModel,
        attachments: editAttachments.map(function(a) { return { type: a.type, name: a.name, content: a.content, dataUrl: a.dataUrl }; }),
      });
    });
    actions.appendChild(submitBtn);
    bubble.appendChild(actions);

    // Focus textarea
    textarea.focus();
    textarea.selectionStart = textarea.value.length;

    // Enter = submit, Shift+Enter = newline, Escape = cancel
    textarea.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitBtn.click();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeBubbleEdit(bubble, originalHTML, nextSibling);
      }
    });

    // Click outside cancels
    var outsideHandler = function(e) {
      if (!bubble.contains(e.target)) {
        closeBubbleEdit(bubble, originalHTML, nextSibling);
        document.removeEventListener('mousedown', outsideHandler);
      }
    };
    // Delay to avoid catching the click that opened edit mode
    setTimeout(function() { document.addEventListener('mousedown', outsideHandler); }, 50);

    // Store handler ref so closeBubbleEdit can remove it
    bubble._outsideHandler = outsideHandler;
  }

  /** Restores a user bubble from edit mode to its original state. */
  function closeBubbleEdit(bubble, originalHTML, greyedSibling) {
    bubble.classList.remove('editing');
    bubble.innerHTML = originalHTML;
    if (greyedSibling) { greyedSibling.classList.remove('bubble-greyed'); }
    if (bubble._outsideHandler) {
      document.removeEventListener('mousedown', bubble._outsideHandler);
      delete bubble._outsideHandler;
    }
    // Re-attach click handler (since innerHTML was restored)
    var idx = parseInt(bubble.getAttribute('data-msg-index') || '0');
    bubble.addEventListener('click', function handler(e) {
      if (e.target.tagName === 'IMG' || e.target.tagName === 'BUTTON') { return; }
      if (bubble.classList.contains('editing')) { return; }
      var session = state.activeSession;
      if (!session) { return; }
      var msg = session.messages[idx];
      if (msg && msg.role === 'user') {
        openBubbleEdit(bubble, idx, msg.content, msg.attachments);
      }
    });
  }

  // ── Dropup menus ───────────────────────────────────────────────────────

  function toggleDropup(which) {
    if (openDropup === which) {
      closeDropup();
    } else {
      closeDropup();
      openDropup = which;
      if (which === 'mode') { renderModeDropup(); }
      if (which === 'model') {
        vscode.postMessage({ type: 'getModels' });
        renderModelDropup();
      }
    }
  }

  function closeDropup() {
    openDropup = null;
    const existing = document.getElementById('dropup-container');
    if (existing) { existing.remove(); }
    const backdrop = document.getElementById('dropup-backdrop');
    if (backdrop) { backdrop.remove(); }
  }

  // ── Mode dropup ────────────────────────────────────────────────────────

  function renderModeDropup() {
    closeDropup(); // clear first
    openDropup = 'mode';

    const inputBox = document.getElementById('input-box');
    if (!inputBox) { return; }

    // Backdrop
    const backdrop = el('div', { className: 'dropup-backdrop', id: 'dropup-backdrop' });
    backdrop.addEventListener('click', closeDropup);
    document.body.appendChild(backdrop);

    const menu = el('div', { className: 'dropup-menu align-left', id: 'dropup-container' });
    menu.appendChild(el('div', { className: 'dropup-title', textContent: 'Mode' }));

    const modes = [
      { name: 'Ask', enabled: true },
      { name: 'Plan', enabled: false },
      { name: 'Agent', enabled: false },
    ];

    modes.forEach((mode) => {
      const item = el('div', {
        className: 'dropup-item' + (state.activeMode === mode.name ? ' selected' : '') + (!mode.enabled ? ' disabled' : ''),
      });
      item.appendChild(el('span', { className: 'dropup-item-name', textContent: mode.name }));
      if (!mode.enabled) {
        item.appendChild(el('span', { className: 'wip-badge', textContent: 'Coming soon' }));
        item.setAttribute('title', 'Work in progress');
      }
      if (mode.enabled) {
        item.addEventListener('click', () => {
          state.activeMode = mode.name;
          saveState();
          const modeLabel = document.querySelector('#mode-btn .pill-label');
          if (modeLabel) { modeLabel.textContent = mode.name; }
          closeDropup();
        });
      }
      menu.appendChild(item);
    });

    inputBox.appendChild(menu);
  }

  // ── Model dropup ──────────────────────────────────────────────────────

  function renderModelDropup() {
    // Remove existing but keep openDropup state
    const existing = document.getElementById('dropup-container');
    if (existing) { existing.remove(); }
    const existingBackdrop = document.getElementById('dropup-backdrop');
    if (existingBackdrop) { existingBackdrop.remove(); }

    if (openDropup !== 'model') { return; }

    const inputBox = document.getElementById('input-box');
    if (!inputBox) { return; }

    // Backdrop
    const backdrop = el('div', { className: 'dropup-backdrop', id: 'dropup-backdrop' });
    backdrop.addEventListener('click', closeDropup);
    document.body.appendChild(backdrop);

    const menu = el('div', { className: 'dropup-menu align-left', id: 'dropup-container' });
    menu.appendChild(el('div', { className: 'dropup-title', textContent: 'Recommended' }));

    // Render static models
    STATIC_MODELS.forEach((model) => {
      const isInstalled = (state.installedModels || []).includes(model.id);
      const isSelected = state.selectedModel === model.id;
      const isPulling = model.id in (state.pullingModels || {});

      const item = el('div', {
        className: 'dropup-item'
          + (isSelected ? ' selected' : '')
          + (!isInstalled && !isPulling ? ' model-not-installed' : ''),
      });

      item.appendChild(el('span', { className: 'dropup-item-name', textContent: model.label }));

      // Tier badge
      const badgeClass = 'dropup-item-badge model-badge-' + model.tier;
      item.appendChild(el('span', { className: badgeClass, textContent: model.badge }));

      // Size
      item.appendChild(el('span', { className: 'dropup-item-right', textContent: model.sizeGb + ' GB' }));

      if (isPulling) {
        const pct = state.pullingModels[model.id] || 0;
        item.appendChild(el('span', { className: 'model-progress', textContent: pct + '%' }));
      } else if (!isInstalled) {
        const dlBtn = el('button', { className: 'model-download-btn', textContent: 'Download' });
        dlBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          vscode.postMessage({ type: 'pullModel', model: model.id });
        });
        item.appendChild(dlBtn);
      }

      if (isInstalled && !isPulling) {
        item.style.cursor = 'pointer';
        item.addEventListener('click', () => {
          state.selectedModel = model.id;
          saveState();
          vscode.postMessage({ type: 'selectModel', model: model.id });
          updateModelButton();
          closeDropup();
        });
      }

      menu.appendChild(item);
    });

    // Show any installed models NOT in the static list
    const extraModels = (state.installedModels || []).filter(
      id => !STATIC_MODELS.some(m => m.id === id)
    );
    if (extraModels.length > 0) {
      menu.appendChild(el('div', { className: 'dropup-separator' }));
      menu.appendChild(el('div', { className: 'dropup-title', textContent: 'Other Installed' }));
      extraModels.forEach((modelId) => {
        const isSelected = state.selectedModel === modelId;
        const item = el('div', {
          className: 'dropup-item' + (isSelected ? ' selected' : ''),
        });
        // Format: "Nice Name (tag)" e.g. "Qwen 3 8B (qwen3:8b)"
        var displayName = formatModelName(modelId);
        item.appendChild(el('span', { className: 'dropup-item-name', textContent: displayName }));

        // Show context size if known
        var ctxSize = dynamicContextSizes[modelId];
        if (ctxSize) {
          item.appendChild(el('span', { className: 'dropup-item-right', textContent: formatTokenCount(ctxSize) + ' ctx' }));
        }

        item.style.cursor = 'pointer';
        item.addEventListener('click', () => {
          state.selectedModel = modelId;
          saveState();
          vscode.postMessage({ type: 'selectModel', model: modelId });
          updateModelButton();
          closeDropup();
        });
        menu.appendChild(item);
      });
    }

    inputBox.appendChild(menu);
  }

  // ── Markdown renderer ──────────────────────────────────────────────────

  // ── Markdown renderer (uses the `marked` library) ───────────────────────

  // Configure marked once at startup
  (function initMarked() {
    if (typeof marked !== 'undefined' && marked.marked) {
      marked.marked.setOptions({
        breaks: true,    // Convert \n to <br> (GFM style)
        gfm: true,       // GitHub Flavored Markdown (tables, strikethrough, etc.)
      });
    }
  })();

  /**
   * Renders markdown text to HTML using the marked library.
   * Falls back to escaped plaintext if marked is unavailable or throws.
   */
  function renderMarkdown(text) {
    if (!text) { return ''; }
    try {
      if (typeof marked !== 'undefined' && marked.marked) {
        return marked.marked(text);
      }
    } catch (e) {
      // Fall through to plaintext
    }
    // Fallback: escaped plaintext with line breaks
    return escapeHtml(text).replace(/\n/g, '<br>');
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ── Image modal ────────────────────────────────────────────────────────

  /** Opens a full-screen modal showing the image. Click overlay or × to close. */
  function openImageModal(src) {
    var overlay = el('div', { className: 'image-modal-overlay', id: 'image-modal' });

    var closeBtn = el('button', { className: 'image-modal-close', textContent: '×' });
    closeBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      closeImageModal();
    });
    overlay.appendChild(closeBtn);

    var img = document.createElement('img');
    img.className = 'image-modal-img';
    img.src = src;
    img.addEventListener('click', function(e) { e.stopPropagation(); });
    overlay.appendChild(img);

    // Click on the dark overlay to close
    overlay.addEventListener('click', closeImageModal);

    // Escape key to close
    var escHandler = function(e) {
      if (e.key === 'Escape') { closeImageModal(); document.removeEventListener('keydown', escHandler); }
    };
    document.addEventListener('keydown', escHandler);

    document.body.appendChild(overlay);
  }

  /** Closes the image modal if open. */
  function closeImageModal() {
    var modal = document.getElementById('image-modal');
    if (modal) { modal.remove(); }
  }

  // ── Utility helpers ────────────────────────────────────────────────────

  function el(tag, props) {
    const elem = document.createElement(tag);
    if (props) {
      Object.entries(props).forEach(([key, value]) => {
        if (key === 'textContent') { elem.textContent = value; }
        else if (key === 'className') { elem.className = value; }
        else if (key === 'style' && typeof value === 'string') { elem.setAttribute('style', value); }
        else if (key === 'innerHTML') { elem.innerHTML = value; }
        else { elem.setAttribute(key, value); }
      });
    }
    return elem;
  }

  function formatTime(ts) {
    if (!ts) { return ''; }
    const date = new Date(ts);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) { return 'Just now'; }
    if (diffMins < 60) { return diffMins + 'm ago'; }
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) { return diffHours + 'h ago'; }
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) { return diffDays + 'd ago'; }
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
})();
