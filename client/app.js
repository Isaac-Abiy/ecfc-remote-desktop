/* ECFC Remote Desktop — web client (MVP).
 *
 * JSON protocol over WebSocket. The server must implement:
 *
 *   Client -> Server:
 *     { type: 'signup', email, password }               -> { type:'auth_ok' } | { type:'auth_error', message }
 *     { type: 'auth', email, password }                  -> { type:'auth_ok', tfa_enabled? }
 *                                                        |  { type:'need_2fa', userId }
 *                                                        |  { type:'auth_error', message }
 *     { type: 'verify_2fa', userId, token }             -> { type:'auth_ok' } | { type:'auth_error', message }
 *     { type: 'setup_2fa' }                              -> { type:'2fa_secret', secret, qr_url }
 *     { type: 'enable_2fa', token }                      -> { type:'2fa_enabled' } | { type:'auth_error', message }
 *     { type: 'disable_2fa', password }                  -> { type:'2fa_disabled' } | { type:'auth_error', message }
 *     { type: 'change_password', currentPassword, newPassword }
 *                                                       -> { type:'password_changed' } | { type:'auth_error', message }
 *     { type: 'status', computerId }                    -> { type:'status', computerId, online }
 *     { type: 'connect', computerId }                  -> { type:'connected', computerId }
 *                                                        |  { type:'busy' } | { type:'host_offline' }
 *     { type: 'disconnect' }
 *     { type: 'input', action: 'move', x, y }           // 0.0 - 1.0 relative coords
 *     { type: 'input', action: 'button', button: 'left'|'right'|'middle', down: bool, x, y }
 *     { type: 'input', action: 'click', button: 'left'|'right', x, y }   // tap / right-click shorthand
 *                                                       // (equivalent to button down+up; servers handle both)
 *     { type: 'input', action: 'scroll', dx, dy, x, y }
 *     { type: 'input', action: 'key', key, down, repeat, ctrlKey, altKey, shiftKey, metaKey }
 *     { type: 'input', action: 'type', text }        // type a whole string
 *     { type: 'ping', t }                              -> { type:'pong', t }
 *     { type: 'file_start', name, size }               -> { type:'file_ack' } | { type:'file_error', message }
 *     { type: 'file_chunk', name, index, data }        // ~48KB base64 chunks
 *     { type: 'file_end', name, chunks }               -> { type:'file_done', name, size } | { type:'file_error', message }
 *     { type: 'file_get_list' }                       -> { type:'file_list', files:[{name,size}] }
 *     { type: 'file_dl', name }                       -> { type:'dl_start', name, size, chunks }
 *                                                       + { type:'dl_chunk', name, index, data }*
 *                                                       + { type:'dl_end', name }
 *     { type: 'file_delete', name }                    -> { type:'file_deleted', name } | { type:'file_error', message }
 *     { type: 'file_rename', old, new }                -> { type:'file_renamed', old, new } | { type:'file_error', message }
 *
 *   Server -> Client:
 *     { type: 'auth_ok', tfa_enabled? } | { type: 'auth_error', message }
 *     { type: 'need_2fa', userId }
 *     { type: 'status', computerId, online }
 *     { type: 'connected', computerId }
 *     { type: 'frame', data }                           // base64-encoded JPEG/PNG
 *     { type: 'pong', t }                               // reply to ping
 *     { type: 'host_offline' }                          // computer went offline mid-session
 *     { type: 'busy' }                                  // someone else is connected
 *     { type: 'idle_timeout' }                          // server ended session for inactivity
 *
 * NOTE for the server builder: please implement { type:'ping' } -> { type:'pong', t }
 * echoing the client's timestamp. If the server does not implement it, this
 * client degrades gracefully and shows "—" for ping instead of breaking.
 */
(function () {
  'use strict';

  /* ---------------- Config & storage ---------------- */
  var DEFAULT_SERVER_URL =
    (typeof SERVER_URL === 'string' && SERVER_URL) ? SERVER_URL : 'ws://localhost:8080';
  var LS_COMPUTERS = 'ecfc_rd_computers';
  var LS_SERVER = 'ecfc_rd_server';
  var LS_USER = 'ecfc_rd_user';

  function serverURL() {
    // Server field is locked in the UI — always use the built-in URL so a
    // mistyped address can never break the connection.
    try { localStorage.removeItem(LS_SERVER); } catch (e) {}
    return DEFAULT_SERVER_URL;
  }

  function loadComputers() {
    try {
      var arr = JSON.parse(localStorage.getItem(LS_COMPUTERS) || '[]');
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function saveComputers(list) {
    localStorage.setItem(LS_COMPUTERS, JSON.stringify(list));
  }

  /* ---------------- State ---------------- */
  var state = {
    ws: null,
    authed: false,
    username: '',
    email: '',
    pendingUserId: null,     // set when server asks for a 2FA code at sign-in
    resetEmail: null,        // email typed into the forgot-password flow
    tfaEnabled: false,       // whether the signed-in account has 2FA on
    computers: loadComputers(),   // [{ id, name }]
    statuses: {},                // computerId -> true/false/null(unknown)
    viewOnlyHosts: {},           // computerId -> true when the host is view-only
    session: null,               // { computerId, viewOnly }
    frames: 0,
    fpsTimer: null,
    pingTimer: null,
    pongWatchdog: null,
    fitMode: true,
    kbCapture: false,
    stickyMods: { ctrl: false, alt: false, shift: false, meta: false },
    connecting: false,
    filesOpen: false,
    dl: null,               // active download: { name, size, chunks:[], received, expected }
  };

  var IS_TOUCH = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);

  /* ---------------- DOM ---------------- */
  function $(id) { return document.getElementById(id); }
  var splash = $('splash'),
      loginScreen = $('screen-login'), signupScreen = $('screen-signup'),
      tfaScreen = $('screen-2fa'), settingsScreen = $('screen-settings'),
      homeScreen = $('screen-home'), sessionScreen = $('screen-session'),
      loginUser = $('login-user'), loginPass = $('login-pass'), loginServer = $('login-server'),
      loginBtn = $('login-btn'), loginError = $('login-error'),
      signupEmail = $('signup-email'), signupPass = $('signup-pass'), signupPass2 = $('signup-pass2'),
      signupServer = $('signup-server'), signupBtn = $('signup-btn'), signupError = $('signup-error'),
      tfaCode = $('tfa-code'), tfaBtn = $('tfa-btn'), tfaError = $('tfa-error'),
      tfaBack = $('tfa-back'), gotoSignup = $('goto-signup'), gotoSignin = $('goto-signin'),
      gotoReset = $('goto-reset'), resetScreen = $('screen-reset'),
      resetEmail = $('reset-email'), resetSendBtn = $('reset-send-btn'),
      resetError = $('reset-error'), resetStepEmail = $('reset-step-email'),
      resetStepCode = $('reset-step-code'), resetCode = $('reset-code'),
      resetPass = $('reset-pass'), resetPass2 = $('reset-pass2'),
      resetError2 = $('reset-error2'), resetConfirmBtn = $('reset-confirm-btn'),
      resetSentTo = $('reset-sent-to'), resetBack = $('reset-back'),
      resetResend = $('reset-resend'),
      settingsBtn = $('settings-btn'), settingsBack = $('settings-back'),
      tfaSetupView = $('tfa-setup-view'), tfaQrView = $('tfa-qr-view'),
      tfaEnabledView = $('tfa-enabled-view'), tfaDisableView = $('tfa-disable-view'),
      tfaEnableBtn = $('tfa-enable-btn'), tfaQr = $('tfa-qr'), tfaSecret = $('tfa-secret'),
      tfaSetupCode = $('tfa-setup-code'), tfaSetupError = $('tfa-setup-error'),
      tfaConfirmBtn = $('tfa-confirm-btn'), tfaDisableBtn = $('tfa-disable-btn'),
      tfaDisablePass = $('tfa-disable-pass'), tfaDisableError = $('tfa-disable-error'),
      tfaDisableCancel = $('tfa-disable-cancel'), tfaDisableConfirm = $('tfa-disable-confirm'),
      pwCur = $('pwcur'), pwNew = $('pwnew'), pwNew2 = $('pwnew2'),
      pwChangeError = $('pwchange-error'), pwChangeBtn = $('pwchange-btn'),
      homeUser = $('home-user'), logoutBtn = $('logout-btn'),
      addId = $('add-id'), addBtn = $('add-btn'), addError = $('add-error'),
      computerList = $('computer-list'), emptyHint = $('empty-hint'), refreshBtn = $('refresh-btn'),
      toolbarDisc = $('disc-btn'), sessionTitle = $('session-title'),
      statFps = $('stat-fps'), statPing = $('stat-ping'),
      kbBtn = $('kb-btn'), fitBtn = $('fit-btn'),
      viewport = $('viewport'), frameImg = $('frame-img'), sessionMsg = $('session-msg'),
      keybar = $('keybar'), keyCatcher = $('key-catcher'),
      typeBtn = $('type-btn'), typeDialog = $('type-dialog'), typeText = $('type-text'),
      typeSend = $('type-send'), typeCancel = $('type-cancel'),
      uploadBtn = $('upload-btn'), filesBtn = $('files-btn'),
      filesPanel = $('files-panel'), filesClose = $('files-close'),
      filesRefresh = $('files-refresh'), filesUpload = $('files-upload'),
      fileList = $('file-list'), filePicker = $('file-picker'),
      transferProgress = $('transfer-progress'), transferBar = $('transfer-bar'),
      transferLabel = $('transfer-label'),
      viewonlyBadge = $('viewonly-badge'),
      hostViewers = $('host-viewers'), hostVideo = $('host-video'), hostCanvas = $('host-canvas'),
      toastEl = $('toast');

  /* ---------------- Screens & toast ---------------- */
  function showScreen(name) {
    loginScreen.classList.toggle('hidden', name !== 'login');
    signupScreen.classList.toggle('hidden', name !== 'signup');
    resetScreen.classList.toggle('hidden', name !== 'reset');
    tfaScreen.classList.toggle('hidden', name !== '2fa');
    settingsScreen.classList.toggle('hidden', name !== 'settings');
    homeScreen.classList.toggle('hidden', name !== 'home');
    sessionScreen.classList.toggle('hidden', name !== 'session');
  }

  var toastTimer = null;
  function toast(msg, ms) {
    toastEl.textContent = msg;
    toastEl.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.add('hidden'); }, ms || 3200);
  }

  function showLoginError(msg) {
    loginError.textContent = msg;
    loginError.classList.remove('hidden');
  }
  function clearLoginError() { loginError.classList.add('hidden'); }

  function showSignupError(msg) {
    signupError.textContent = msg;
    signupError.classList.remove('hidden');
  }
  function clearSignupError() { signupError.classList.add('hidden'); }

  function resetAuthButtons() {
    loginBtn.disabled = false;
    loginBtn.textContent = 'Sign in';
    signupBtn.disabled = false;
    signupBtn.textContent = 'Create account';
    tfaBtn.disabled = false;
    tfaBtn.textContent = 'Verify';
    resetSendBtn.disabled = false;
    resetSendBtn.textContent = 'Send reset code';
    resetConfirmBtn.disabled = false;
    resetConfirmBtn.textContent = 'Set new password';
  }

  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  /* ---------------- WebSocket ---------------- */
  function send(obj) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  function closeSocket() {
    if (state.ws) {
      try { state.ws.onopen = state.ws.onmessage = state.ws.onclose = state.ws.onerror = null; } catch (e) {}
      try { state.ws.close(); } catch (e) {}
      state.ws = null;
    }
    state.authed = false;
  }

  function connect(onOpen, onFail) {
    closeSocket();
    var ws;
    try {
      ws = new WebSocket(serverURL());
    } catch (e) {
      onFail && onFail('Invalid server URL.');
      return;
    }
    state.ws = ws;

    var opened = false;
    ws.onopen = function () {
      opened = true;
      onOpen && onOpen();
    };
    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      handleMessage(msg);
    };
    ws.onclose = function () {
      state.ws = null;
      if (!opened) {
        onFail && onFail('Could not reach the server. Check the server address.');
        return;
      }
      onSocketDropped();
    };
    ws.onerror = function () { /* onclose follows with details */ };
  }

  function onSocketDropped() {
    var wasAuthed = state.authed;
    state.authed = false;
    if (state.session) {
      endSession('Connection to the server was lost.');
    } else if (wasAuthed) {
      showScreen('login');
      showLoginError('Disconnected from the server. Please sign in again.');
    } else if (!tfaScreen.classList.contains('hidden') || !signupScreen.classList.contains('hidden') || !resetScreen.classList.contains('hidden')) {
      // Socket died mid-signup, mid-2FA or mid-reset: back to sign in.
      state.pendingUserId = null;
      state.resetEmail = null;
      resetAuthButtons();
      showScreen('login');
      showLoginError('Lost connection to the server. Please try again.');
    }
  }

  /* ---------------- Incoming messages ---------------- */
  function handleMessage(msg) {
    switch (msg.type) {
      case 'auth_ok':
        state.authed = true;
        state.connecting = false;
        state.pendingUserId = null;
        state.tfaEnabled = !!msg.tfa_enabled;
        resetAuthButtons();
        homeUser.textContent = state.email || state.username;
        showScreen('home');
        renderComputers();
        refreshStatuses();
        break;

      case 'reset_sent':
        // Server emailed a 6-digit code (or the email isn't registered —
        // either way we show the same next step).
        resetAuthButtons();
        resetSentTo.textContent = state.resetEmail || '';
        resetCode.value = '';
        resetPass.value = '';
        resetPass2.value = '';
        resetError2.classList.add('hidden');
        resetStepEmail.classList.add('hidden');
        resetStepCode.classList.remove('hidden');
        toast('Code sent — check your email 📧', 4000);
        setTimeout(function () { try { resetCode.focus(); } catch (e) {} }, 80);
        break;

      case 'password_reset':
        // New password is set. Back to sign-in with a clean slate.
        closeSocket();
        resetAuthButtons();
        loginPass.value = '';
        loginUser.value = state.resetEmail || loginUser.value;
        state.resetEmail = null;
        showScreen('login');
        toast('Password changed! Sign in with your new password 🎉', 5000);
        break;

      case 'password_changed':
        // Password changed from Settings — the session stays signed in.
        state.changingPassword = false;
        pwChangeBtn.disabled = false;
        pwChangeBtn.textContent = 'Change password';
        pwCur.value = '';
        pwNew.value = '';
        pwNew2.value = '';
        pwChangeError.classList.add('hidden');
        toast('Password changed! 🎉', 4000);
        break;

      case 'need_2fa':        // Signed in OK, but the account wants a second-factor code.
        state.connecting = false;
        state.pendingUserId = msg.userId || null;
        resetAuthButtons();
        tfaCode.value = '';
        tfaError.classList.add('hidden');
        showScreen('2fa');
        setTimeout(function () { try { tfaCode.focus(); } catch (e) {} }, 80);
        break;

      case 'auth_error':
        state.connecting = false;
        state.pendingUserId = null;
        resetAuthButtons();
        var errMsg = msg.message || 'Authentication failed. Check your details and try again.';
        // Route the error to whichever auth surface is visible.
        if (!settingsScreen.classList.contains('hidden')) {
          // 2FA enable/disable or password change failed inside Settings.
          tfaConfirmBtn.disabled = false;
          tfaConfirmBtn.textContent = 'Confirm & enable';
          tfaDisableConfirm.disabled = false;
          tfaDisableConfirm.textContent = 'Disable 2FA';
          tfaEnableBtn.disabled = false;
          tfaEnableBtn.textContent = 'Enable 2FA';
          pwChangeBtn.disabled = false;
          pwChangeBtn.textContent = 'Change password';
          if (!tfaQrView.classList.contains('hidden')) {
            tfaSetupError.textContent = errMsg;
            tfaSetupError.classList.remove('hidden');
          } else if (!tfaDisableView.classList.contains('hidden')) {
            tfaDisableError.textContent = errMsg;
            tfaDisableError.classList.remove('hidden');
          } else if (state.changingPassword) {
            state.changingPassword = false;
            pwChangeError.textContent = errMsg;
            pwChangeError.classList.remove('hidden');
          } else {
            toast(errMsg, 4000);
          }
        } else if (!tfaScreen.classList.contains('hidden')) {
          tfaError.textContent = errMsg;
          tfaError.classList.remove('hidden');
          showScreen('login');
          showLoginError(errMsg);
        } else if (!resetScreen.classList.contains('hidden')) {
          // Forgot-password step failed: show the error on the visible step.
          var onCodeStep = !resetStepCode.classList.contains('hidden');
          var rTarget = onCodeStep ? resetError2 : resetError;
          rTarget.textContent = errMsg;
          rTarget.classList.remove('hidden');
          if (onCodeStep) {
            resetConfirmBtn.disabled = false;
            resetConfirmBtn.textContent = 'Set new password';
          } else {
            resetSendBtn.disabled = false;
            resetSendBtn.textContent = 'Send reset code';
          }
        } else if (!signupScreen.classList.contains('hidden')) {
          signupError.textContent = errMsg;
          signupError.classList.remove('hidden');
        } else {
          showLoginError(errMsg);
        }
        if (!state.authed) closeSocket();
        break;

      case '2fa_secret':
        // Server replied to { type:'setup_2fa' } with the TOTP secret.
        tfaEnableBtn.disabled = false;
        tfaEnableBtn.textContent = 'Enable 2FA';
        show2faSecret(msg.secret, msg.qr_url);
        break;

      case '2fa_enabled':
        tfaConfirmBtn.disabled = false;
        tfaConfirmBtn.textContent = 'Confirm & enable';
        state.tfaEnabled = true;
        render2faSettings();
        toast('2FA enabled — your account is now extra secure. 🎉');
        break;

      case '2fa_disabled':
        tfaDisableConfirm.disabled = false;
        tfaDisableConfirm.textContent = 'Disable 2FA';
        state.tfaEnabled = false;
        render2faSettings();
        toast('2FA has been turned off.');
        break;

      case 'status':
        if (msg.computerId) {
          state.statuses[msg.computerId] = !!msg.online;
          state.viewOnlyHosts[msg.computerId] = !!msg.viewOnly;
          renderComputers();
        }
        break;

      case 'connected':
        state.connecting = false;
        startSession(msg.computerId, !!msg.viewOnly);
        break;

      case 'frame':
        if (state.session && msg.data) renderFrame(msg.data);
        break;

      case 'pong':
        if (msg.t) {
          var rtt = Date.now() - msg.t;
          statPing.textContent = rtt + ' ms';
        }
        if (state.pongWatchdog) { clearTimeout(state.pongWatchdog); state.pongWatchdog = null; }
        break;

      case 'host_offline':
        if (state.session) endSession('This computer went offline.');
        else toast('That computer is offline.');
        refreshStatuses();
        break;

      case 'busy':
        if (state.session) endSession('Someone else is connected to this computer.');
        else { state.connecting = false; toast('Someone else is already connected to that computer.'); }
        break;

      case 'idle_timeout':
        endSession('Disconnected for inactivity.');
        break;

      /* ---------------- File transfer replies ---------------- */
      case 'file_ack':
        // Host accepted the upload — chunks are flowing; progress is local.
        break;

      case 'file_error':
        hideProgress();
        state.dl = null;
        toast('File error: ' + (msg.message || 'something went wrong'));
        break;

      case 'file_done':
        hideProgress();
        toast('✅ Uploaded "' + (msg.name || 'file') + '" to the PC!');
        refreshFileList();
        break;

      case 'file_list':
        renderFileList(Array.isArray(msg.files) ? msg.files : []);
        break;

      case 'dl_start':
        state.dl = {
          name: msg.name || 'download',
          size: +msg.size || 0,
          chunks: [],
          received: 0,
          expected: +msg.chunks || 0,
        };
        setProgress('Downloading ' + state.dl.name, 0);
        break;

      case 'dl_chunk': {
        var dlc = state.dl;
        if (!dlc || typeof msg.data !== 'string') break;
        dlc.chunks[+msg.index || 0] = msg.data;
        dlc.received++;
        if (dlc.expected) setProgress('Downloading ' + dlc.name, dlc.received / dlc.expected);
        break;
      }

      case 'dl_end': {
        var dl = state.dl;
        state.dl = null;
        hideProgress();
        if (!dl) break;
        try {
          var bin = atob(dl.chunks.join(''));
          var u8 = new Uint8Array(bin.length);
          for (var bi = 0; bi < bin.length; bi++) u8[bi] = bin.charCodeAt(bi);
          var blob = new Blob([u8], { type: 'application/octet-stream' });
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = dl.name || 'download';
          document.body.appendChild(a);
          a.click();
          setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
          toast('⬇️ Downloaded "' + dl.name + '"');
        } catch (e) {
          toast('Download failed — the file was corrupted.');
        }
        break;
      }

      case 'file_deleted':
        toast('🗑️ Deleted "' + (msg.name || 'file') + '"');
        refreshFileList();
        break;

      case 'file_renamed':
        toast('✏️ Renamed to "' + (msg.new || 'file') + '"');
        refreshFileList();
        break;

      default:
        // Unknown message type — ignore (forward compatibility).
        break;
    }
  }

  /* ---------------- Sign in ---------------- */
  function doLogin() {
    clearLoginError();
    var email = loginUser.value.trim().toLowerCase();
    var password = loginPass.value;
    var server = loginServer.value.trim();
    if (!email || !password) { showLoginError('Enter your email and password.'); return; }
    if (!isValidEmail(email)) { showLoginError('That email address doesn\'t look right.'); return; }
    if (server) localStorage.setItem(LS_SERVER, server);
    localStorage.setItem(LS_USER, email);
    state.email = email;
    state.username = email; // keep for backwards-compatible display
    state.connecting = true;
    loginBtn.disabled = true;
    loginBtn.textContent = 'Signing in…';
    connect(
      function () { send({ type: 'auth', email: email, password: password }); },
      function (err) {
        state.connecting = false;
        resetAuthButtons();
        showLoginError(err);
      }
    );
  }

  loginBtn.addEventListener('click', doLogin);
  loginPass.addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
  loginUser.addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });

  logoutBtn.addEventListener('click', function () {
    closeSocket();
    loginPass.value = '';
    state.tfaEnabled = false;
    showScreen('login');
  });

  /* ---------------- Sign up ---------------- */
  function doSignup() {
    clearSignupError();
    var email = signupEmail.value.trim().toLowerCase();
    var password = signupPass.value;
    var password2 = signupPass2.value;
    var server = signupServer.value.trim();
    if (!email || !password) { showSignupError('Enter an email and password.'); return; }
    if (!isValidEmail(email)) { showSignupError('That email address doesn\'t look right.'); return; }
    if (password.length < 8) { showSignupError('Password must be at least 8 characters.'); return; }
    if (password !== password2) { showSignupError('Passwords don\'t match.'); return; }
    if (server) localStorage.setItem(LS_SERVER, server);
    localStorage.setItem(LS_USER, email);
    state.email = email;
    state.username = email;
    state.connecting = true;
    signupBtn.disabled = true;
    signupBtn.textContent = 'Creating account…';
    connect(
      function () { send({ type: 'signup', email: email, password: password }); },
      function (err) {
        state.connecting = false;
        resetAuthButtons();
        showSignupError(err);
      }
    );
  }

  signupBtn.addEventListener('click', doSignup);
  signupPass2.addEventListener('keydown', function (e) { if (e.key === 'Enter') doSignup(); });
  signupPass.addEventListener('keydown', function (e) { if (e.key === 'Enter') doSignup(); });
  signupEmail.addEventListener('keydown', function (e) { if (e.key === 'Enter') doSignup(); });

  /* ---------------- Forgot password ---------------- */
  function showResetError(el, msg) {
    el.textContent = msg;
    el.classList.remove('hidden');
  }

  function openReset() {
    state.resetEmail = null;
    resetEmail.value = (loginUser.value || '').trim();
    resetError.classList.add('hidden');
    resetError2.classList.add('hidden');
    resetStepEmail.classList.remove('hidden');
    resetStepCode.classList.add('hidden');
    resetAuthButtons();
    showScreen('reset');
    setTimeout(function () { try { resetEmail.focus(); } catch (e) {} }, 80);
  }

  function doRequestReset() {
    resetError.classList.add('hidden');
    var email = resetEmail.value.trim().toLowerCase();
    if (!email) { showResetError(resetError, 'Enter your email address.'); return; }
    if (!isValidEmail(email)) { showResetError(resetError, 'That email address doesn\'t look right.'); return; }
    state.resetEmail = email;
    resetSendBtn.disabled = true;
    resetSendBtn.textContent = 'Sending…';
    connect(
      function () { send({ type: 'request_reset', email: email }); },
      function (err) {
        resetSendBtn.disabled = false;
        resetSendBtn.textContent = 'Send reset code';
        showResetError(resetError, err);
      }
    );
    // Server replies { type:'reset_sent' } or { type:'auth_error', message }.
  }

  function doConfirmReset() {
    resetError2.classList.add('hidden');
    var code = resetCode.value.replace(/\D/g, '');
    var p1 = resetPass.value;
    var p2 = resetPass2.value;
    if (code.length !== 6) { showResetError(resetError2, 'Enter the 6-digit code from the email.'); return; }
    if (p1.length < 8) { showResetError(resetError2, 'Password must be at least 8 characters.'); return; }
    if (p1 !== p2) { showResetError(resetError2, 'Passwords don\'t match.'); return; }
    resetConfirmBtn.disabled = true;
    resetConfirmBtn.textContent = 'Setting…';
    var payload = { type: 'reset_password', email: state.resetEmail, code: code, password: p1 };
    if (!send(payload)) {
      // Socket died while typing — reconnect and retry once.
      connect(function () { send(payload); },
        function (err) {
          resetConfirmBtn.disabled = false;
          resetConfirmBtn.textContent = 'Set new password';
          showResetError(resetError2, err);
        });
    }
    // Server replies { type:'password_reset' } or { type:'auth_error', message }.
  }

  gotoReset.addEventListener('click', function (e) {
    e.preventDefault();
    closeSocket();
    openReset();
  });
  resetBack.addEventListener('click', function (e) {
    e.preventDefault();
    closeSocket();
    state.resetEmail = null;
    showScreen('login');
  });
  resetSendBtn.addEventListener('click', doRequestReset);
  resetEmail.addEventListener('keydown', function (e) { if (e.key === 'Enter') doRequestReset(); });
  resetConfirmBtn.addEventListener('click', doConfirmReset);
  resetPass2.addEventListener('keydown', function (e) { if (e.key === 'Enter') doConfirmReset(); });
  resetResend.addEventListener('click', function (e) {
    e.preventDefault();
    doRequestReset(); // server rate-limits resends per account
  });
  // Digits only; jump to the password field when the 6th digit lands.
  resetCode.addEventListener('input', function () {
    resetCode.value = resetCode.value.replace(/\D/g, '').slice(0, 6);
    if (resetCode.value.length === 6) { try { resetPass.focus(); } catch (e) {} }
  });

  /* ---------------- Switch between sign in / sign up ---------------- */
  gotoSignup.addEventListener('click', function (e) {
    e.preventDefault();
    clearLoginError();
    signupServer.value = loginServer.value || serverURL();
    showScreen('signup');
  });
  gotoSignin.addEventListener('click', function (e) {
    e.preventDefault();
    clearSignupError();
    loginServer.value = signupServer.value || serverURL();
    showScreen('login');
  });
  tfaBack.addEventListener('click', function (e) {
    e.preventDefault();
    closeSocket();
    state.pendingUserId = null;
    tfaError.classList.add('hidden');
    showScreen('login');
  });

  /* ---------------- 2FA verification at sign-in ---------------- */
  function doVerify2fa() {
    var token = tfaCode.value.trim().replace(/\s+/g, '');
    tfaError.classList.add('hidden');
    if (!/^\d{6}$/.test(token)) {
      tfaError.textContent = 'Enter the 6-digit code from your authenticator app.';
      tfaError.classList.remove('hidden');
      return;
    }
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      tfaError.textContent = 'Lost connection to the server. Please sign in again.';
      tfaError.classList.remove('hidden');
      return;
    }
    tfaBtn.disabled = true;
    tfaBtn.textContent = 'Verifying…';
    send({ type: 'verify_2fa', userId: state.pendingUserId, token: token });
    // Server replies { type:'auth_ok' } or { type:'auth_error' }.
  }

  tfaBtn.addEventListener('click', doVerify2fa);
  tfaCode.addEventListener('keydown', function (e) { if (e.key === 'Enter') doVerify2fa(); });
  // Auto-submit when the 6th digit is typed.
  tfaCode.addEventListener('input', function () {
    tfaCode.value = tfaCode.value.replace(/\D/g, '').slice(0, 6);
    if (tfaCode.value.length === 6) doVerify2fa();
  });

  /* ---------------- Settings: 2FA setup ---------------- */
  settingsBtn.addEventListener('click', function () {
    render2faSettings();
    showScreen('settings');
  });
  settingsBack.addEventListener('click', function () {
    // Cancel any in-progress 2FA setup view when leaving.
    showScreen('home');
  });

  // Show the right 2FA panel based on whether the account has 2FA on.
  function render2faSettings() {
    tfaSetupCode.value = '';
    tfaSetupError.classList.add('hidden');
    tfaDisablePass.value = '';
    tfaDisableError.classList.add('hidden');
    tfaSetupView.classList.toggle('hidden', state.tfaEnabled);
    tfaQrView.classList.add('hidden');
    tfaEnabledView.classList.toggle('hidden', !state.tfaEnabled);
    tfaDisableView.classList.add('hidden');
    // Fresh change-password form every time Settings opens.
    pwCur.value = '';
    pwNew.value = '';
    pwNew2.value = '';
    pwChangeError.classList.add('hidden');
    pwChangeBtn.disabled = false;
    pwChangeBtn.textContent = 'Change password';
    state.changingPassword = false;
  }

  // Step 1: ask the server for a fresh TOTP secret.
  tfaEnableBtn.addEventListener('click', function () {
    tfaSetupError.classList.add('hidden');
    tfaEnableBtn.disabled = true;
    tfaEnableBtn.textContent = 'Generating…';
    if (!send({ type: 'setup_2fa' })) {
      tfaEnableBtn.disabled = false;
      tfaEnableBtn.textContent = 'Enable 2FA';
      toast('Not connected to the server.');
    }
    // Server replies { type:'2fa_secret', secret, qr_url }.
  });

  // Step 2: display the secret + QR code for the authenticator app.
  function show2faSecret(secret, qrUrl) {
    if (!secret) {
      tfaSetupError.textContent = 'The server didn\'t send a secret. Try again.';
      tfaSetupError.classList.remove('hidden');
      return;
    }
    tfaSecret.textContent = secret;
    var imgSrc;
    if (qrUrl && /^https?:\/\//i.test(qrUrl)) {
      // Server gave us a ready-made QR image URL.
      imgSrc = qrUrl;
    } else {
      // Build an otpauth:// URL and render it via a free QR image service.
      var otpauth = qrUrl && qrUrl.indexOf('otpauth://') === 0
        ? qrUrl
        : 'otpauth://totp/ECFC%20Remote%20Desktop:' + encodeURIComponent(state.email || 'user') +
          '?secret=' + encodeURIComponent(secret) + '&issuer=' + encodeURIComponent('ECFC Remote Desktop');
      imgSrc = 'https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=' + encodeURIComponent(otpauth);
    }
    tfaQr.src = imgSrc;
    tfaSetupView.classList.add('hidden');
    tfaQrView.classList.remove('hidden');
    tfaEnabledView.classList.add('hidden');
    setTimeout(function () { try { tfaSetupCode.focus(); } catch (e) {} }, 80);
  }

  // Step 3: confirm with a code from the app → server enables 2FA.
  function doConfirm2fa() {
    var token = tfaSetupCode.value.trim().replace(/\s+/g, '');
    tfaSetupError.classList.add('hidden');
    if (!/^\d{6}$/.test(token)) {
      tfaSetupError.textContent = 'Enter the 6-digit code from your authenticator app.';
      tfaSetupError.classList.remove('hidden');
      return;
    }
    tfaConfirmBtn.disabled = true;
    tfaConfirmBtn.textContent = 'Confirming…';
    if (!send({ type: 'enable_2fa', token: token })) {
      tfaConfirmBtn.disabled = false;
      tfaConfirmBtn.textContent = 'Confirm & enable';
      toast('Not connected to the server.');
    }
    // Server replies { type:'2fa_enabled' } or { type:'auth_error', message }.
  }
  tfaConfirmBtn.addEventListener('click', doConfirm2fa);
  tfaSetupCode.addEventListener('keydown', function (e) { if (e.key === 'Enter') doConfirm2fa(); });
  tfaSetupCode.addEventListener('input', function () {
    tfaSetupCode.value = tfaSetupCode.value.replace(/\D/g, '').slice(0, 6);
  });

  // Disable 2FA (password confirmation required).
  tfaDisableBtn.addEventListener('click', function () {
    tfaEnabledView.classList.add('hidden');
    tfaDisableView.classList.remove('hidden');
    setTimeout(function () { try { tfaDisablePass.focus(); } catch (e) {} }, 80);
  });
  tfaDisableCancel.addEventListener('click', function () {
    render2faSettings();
  });
  function doDisable2fa() {
    var password = tfaDisablePass.value;
    tfaDisableError.classList.add('hidden');
    if (!password) {
      tfaDisableError.textContent = 'Enter your password to confirm.';
      tfaDisableError.classList.remove('hidden');
      return;
    }
    tfaDisableConfirm.disabled = true;
    tfaDisableConfirm.textContent = 'Disabling…';
    if (!send({ type: 'disable_2fa', password: password })) {
      tfaDisableConfirm.disabled = false;
      tfaDisableConfirm.textContent = 'Disable 2FA';
      toast('Not connected to the server.');
    }
    // Server replies { type:'2fa_disabled' } or { type:'auth_error', message }.
  }
  tfaDisableConfirm.addEventListener('click', doDisable2fa);
  tfaDisablePass.addEventListener('keydown', function (e) { if (e.key === 'Enter') doDisable2fa(); });

  /* ---------------- Settings: change password ---------------- */
  function showPwChangeError(m) {
    pwChangeError.textContent = m;
    pwChangeError.classList.remove('hidden');
  }
  function doChangePassword() {
    var cur = pwCur.value, nw = pwNew.value, nw2 = pwNew2.value;
    pwChangeError.classList.add('hidden');
    if (!cur) {
      showPwChangeError('Enter your current password.');
      return;
    }
    if (nw.length < 8) {
      showPwChangeError('New password must be at least 8 characters.');
      return;
    }
    if (nw !== nw2) {
      showPwChangeError('The new passwords don\'t match.');
      return;
    }
    state.changingPassword = true;
    pwChangeBtn.disabled = true;
    pwChangeBtn.textContent = 'Changing…';
    if (!send({ type: 'change_password', currentPassword: cur, newPassword: nw })) {
      state.changingPassword = false;
      pwChangeBtn.disabled = false;
      pwChangeBtn.textContent = 'Change password';
      toast('Not connected to the server.');
    }
    // Server replies { type:'password_changed' } or { type:'auth_error', message }.
  }
  pwChangeBtn.addEventListener('click', doChangePassword);
  pwNew2.addEventListener('keydown', function (e) { if (e.key === 'Enter') doChangePassword(); });

  /* ---------------- Home: computer list ---------------- */
  function renderComputers() {
    computerList.innerHTML = '';
    emptyHint.classList.toggle('hidden', state.computers.length > 0);
    state.computers.forEach(function (pc) {
      var card = document.createElement('div');
      card.className = 'pc-card';

      var online = state.statuses[pc.id]; // true / false / undefined
      var dotCls = online === true ? 'online' : (online === false ? 'offline' : '');
      var statusTxt = online === true ? 'Online' : (online === false ? 'Offline' : 'Checking…');
      if (online === true && state.viewOnlyHosts[pc.id]) statusTxt += ' · 👁️ view-only';

      card.innerHTML =
        '<div class="pc-icon">🖥️</div>' +
        '<div class="pc-info">' +
          '<div class="pc-name"></div>' +
          '<div class="pc-id"></div>' +
          '<div class="pc-status"><span class="status-dot ' + dotCls + '"></span><span></span></div>' +
        '</div>' +
        '<div class="pc-actions">' +
          '<button class="btn primary small connect-btn">Connect</button>' +
          '<button class="btn ghost small remove-btn" title="Remove">✕</button>' +
        '</div>';

      card.querySelector('.pc-name').textContent = pc.name;
      card.querySelector('.pc-id').textContent = pc.id;
      card.querySelector('.pc-status span:last-child').textContent = statusTxt;

      var connectBtn = card.querySelector('.connect-btn');
      connectBtn.disabled = online !== true;
      connectBtn.addEventListener('click', function () { connectComputer(pc.id); });

      card.querySelector('.remove-btn').addEventListener('click', function () {
        if (!confirm('Remove ' + pc.id + ' from your list?')) return;
        state.computers = state.computers.filter(function (c) { return c.id !== pc.id; });
        delete state.statuses[pc.id];
        saveComputers(state.computers);
        renderComputers();
      });

      computerList.appendChild(card);
    });
  }

  function refreshStatuses() {
    if (!state.authed) return;
    state.computers.forEach(function (pc) {
      state.statuses[pc.id] = undefined;
      send({ type: 'status', computerId: pc.id });
    });
    renderComputers();
  }

  refreshBtn.addEventListener('click', refreshStatuses);

  function addComputer() {
    var id = addId.value.trim().toUpperCase();
    addError.classList.add('hidden');
    if (!/^[A-Z0-9]{6}$/.test(id)) {
      addError.textContent = 'Computer ID must be exactly 6 letters/numbers.';
      addError.classList.remove('hidden');
      return;
    }
    if (state.computers.some(function (c) { return c.id === id; })) {
      addError.textContent = 'That computer is already in your list.';
      addError.classList.remove('hidden');
      return;
    }
    state.computers.push({ id: id, name: 'Computer ' + id });
    saveComputers(state.computers);
    addId.value = '';
    renderComputers();
    state.statuses[id] = undefined;
    send({ type: 'status', computerId: id });
    renderComputers();
  }
  addBtn.addEventListener('click', addComputer);
  addId.addEventListener('keydown', function (e) { if (e.key === 'Enter') addComputer(); });

  function connectComputer(id) {
    if (state.connecting) return;
    state.connecting = true;
    toast('Connecting to ' + id + '…');
    if (!send({ type: 'connect', computerId: id })) {
      state.connecting = false;
      toast('Not connected to the server.');
    }
    // Server replies: { type:'connected' } | { type:'busy' } | { type:'host_offline' }
  }

  /* ---------------- Session ---------------- */
  function startSession(computerId, viewOnly) {
    state.session = { computerId: computerId, viewOnly: !!viewOnly };
    state.frames = 0;
    sessionTitle.textContent = computerId + (state.session.viewOnly ? ' 👁️' : '');
    statFps.textContent = '0 FPS';
    statPing.textContent = '— ms';
    sessionMsg.classList.add('hidden');
    frameImg.removeAttribute('src');
    setFitMode(true);
    applyViewOnlyUI();
    // Keyboard capture: on by default for desktop, off for touch (toggle summons soft keyboard).
    // Never capture keys for a view-only session — there's nothing to control.
    setKbCapture(!IS_TOUCH && !state.session.viewOnly);
    showScreen('session');
    setTimeout(function () { viewport.focus({ preventScroll: true }); }, 50);

    state.fpsTimer = setInterval(function () {
      statFps.textContent = state.frames + ' FPS';
      state.frames = 0;
    }, 1000);

    state.pingTimer = setInterval(function () {
      if (!send({ type: 'ping', t: Date.now() })) return;
      // Graceful degradation: if the server never implements pong, show "—".
      if (state.pongWatchdog) clearTimeout(state.pongWatchdog);
      state.pongWatchdog = setTimeout(function () { statPing.textContent = '— ms'; }, 12000);
    }, 5000);
  }

  // View-only sessions: hide every control, show the badge instead.
  // (sendInput + handleKey also refuse input when session.viewOnly is set.)
  function applyViewOnlyUI() {
    var vo = !!(state.session && state.session.viewOnly);
    kbBtn.classList.toggle('hidden', vo);
    typeBtn.classList.toggle('hidden', vo);
    uploadBtn.classList.toggle('hidden', vo);
    filesBtn.classList.toggle('hidden', vo);
    viewonlyBadge.classList.toggle('hidden', !vo);
  }

  function endSession(message) {
    if (!state.session) return;
    send({ type: 'disconnect' });
    state.session = null;
    clearInterval(state.fpsTimer); state.fpsTimer = null;
    clearInterval(state.pingTimer); state.pingTimer = null;
    if (state.pongWatchdog) { clearTimeout(state.pongWatchdog); state.pongWatchdog = null; }
    try { keyCatcher.blur(); } catch (e) {}
    // Restore the control UI in case this was a view-only session.
    kbBtn.classList.remove('hidden');
    typeBtn.classList.remove('hidden');
    uploadBtn.classList.remove('hidden');
    filesBtn.classList.remove('hidden');
    viewonlyBadge.classList.add('hidden');
    // Close the new session UI too.
    typeDialog.classList.add('hidden');
    typeText.value = '';
    closeFilesPanel();
    state.dl = null;
    hideProgress();
    showScreen('home');
    refreshStatuses();
    if (message) toast(message, 4000);
  }

  toolbarDisc.addEventListener('click', function () { endSession(); });

  function renderFrame(b64) {
    // Data URL is simple and reliable for JPEG/PNG frames at MVP scale.
    frameImg.src = 'data:image/jpeg;base64,' + b64;
    state.frames++;
  }

  /* ---------------- Input helpers ---------------- */
  function relCoords(clientX, clientY) {
    var r = frameImg.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    var x = (clientX - r.left) / r.width;
    var y = (clientY - r.top) / r.height;
    x = Math.min(1, Math.max(0, x));
    y = Math.min(1, Math.max(0, y));
    return { x: +x.toFixed(4), y: +y.toFixed(4) };
  }

  function sendInput(obj) {
    if (!state.session || state.session.viewOnly) return false; // view-only: no input
    obj.type = 'input';
    return send(obj);
  }

  /* ---------------- Mouse (desktop) ---------------- */
  var lastMoveSent = 0;
  frameImg.addEventListener('mousemove', function (e) {
    var now = Date.now();
    if (now - lastMoveSent < 30) return; // throttle to ~33 msgs/sec
    lastMoveSent = now;
    var p = relCoords(e.clientX, e.clientY);
    if (p) sendInput({ action: 'move', x: p.x, y: p.y });
  });

  frameImg.addEventListener('mousedown', function (e) {
    if (e.button !== 0 && e.button !== 1 && e.button !== 2) return;
    var p = relCoords(e.clientX, e.clientY);
    if (!p) return;
    var btn = e.button === 2 ? 'right' : (e.button === 1 ? 'middle' : 'left');
    if (e.button === 0) {
      // Left button held down (enables drag); mouseup releases it.
      sendInput({ action: 'button', button: 'left', down: true, x: p.x, y: p.y });
    } else {
      sendInput({ action: 'click', button: btn, x: p.x, y: p.y });
    }
    e.preventDefault();
  });

  frameImg.addEventListener('mouseup', function (e) {
    if (e.button !== 0) return;
    var p = relCoords(e.clientX, e.clientY);
    if (p) sendInput({ action: 'button', button: 'left', down: false, x: p.x, y: p.y });
  });

  frameImg.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    var p = relCoords(e.clientX, e.clientY);
    if (p) sendInput({ action: 'click', button: 'right', x: p.x, y: p.y });
  });

  var lastWheelSent = 0;
  frameImg.addEventListener('wheel', function (e) {
    e.preventDefault();
    var now = Date.now();
    if (now - lastWheelSent < 50) return;
    lastWheelSent = now;
    var p = relCoords(e.clientX, e.clientY) || { x: 0.5, y: 0.5 };
    sendInput({ action: 'scroll', dx: Math.sign(e.deltaX), dy: Math.sign(e.deltaY) * 3, x: p.x, y: p.y });
  }, { passive: false });

  /* ---------------- Touch ---------------- */
  var touch = { mode: null, id: null, startX: 0, startY: 0, startT: 0, moved: false, longPressed: false, timer: null, lastY: 0, lastMove: 0 };

  function clearLongPress() {
    if (touch.timer) { clearTimeout(touch.timer); touch.timer = null; }
  }

  viewport.addEventListener('touchstart', function (e) {
    e.preventDefault();
    if (!state.session) return;
    if (e.touches.length === 2) {
      // Two-finger scroll mode.
      clearLongPress();
      touch.mode = 'scroll';
      touch.lastY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      return;
    }
    if (e.touches.length === 1) {
      var t = e.touches[0];
      touch.mode = 'tap';
      touch.id = t.identifier;
      touch.startX = t.clientX; touch.startY = t.clientY;
      touch.startT = Date.now();
      touch.moved = false; touch.longPressed = false;
      var p = relCoords(t.clientX, t.clientY);
      clearLongPress();
      touch.timer = setTimeout(function () {
        // Long-press (500ms) = right-click.
        if (touch.mode === 'tap' && !touch.moved && p) {
          touch.longPressed = true;
          sendInput({ action: 'click', button: 'right', x: p.x, y: p.y });
          if (navigator.vibrate) { try { navigator.vibrate(40); } catch (err) {} }
        }
      }, 500);
    }
  }, { passive: false });

  viewport.addEventListener('touchmove', function (e) {
    e.preventDefault();
    if (!state.session) return;
    if (touch.mode === 'scroll' && e.touches.length >= 2) {
      var midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      var dy = touch.lastY - midY;
      touch.lastY = midY;
      if (Math.abs(dy) > 2) {
        var midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        var p = relCoords(midX, midY) || { x: 0.5, y: 0.5 };
        sendInput({ action: 'scroll', dx: 0, dy: Math.round(dy * 2), x: p.x, y: p.y });
      }
      return;
    }
    if (touch.mode === 'tap' && e.touches.length === 1) {
      var t = e.touches[0];
      var dx = t.clientX - touch.startX, dy2 = t.clientY - touch.startY;
      if (Math.abs(dx) > 10 || Math.abs(dy2) > 10) {
        touch.moved = true;
        clearLongPress();
        var now = Date.now();
        if (now - touch.lastMove > 30) {
          touch.lastMove = now;
          var p2 = relCoords(t.clientX, t.clientY);
          if (p2) sendInput({ action: 'move', x: p2.x, y: p2.y });
        }
      }
    }
  }, { passive: false });

  function touchEnd(e) {
    e.preventDefault();
    if (!state.session) { touch.mode = null; return; }
    if (touch.mode === 'tap') {
      clearLongPress();
      var dt = Date.now() - touch.startT;
      if (!touch.moved && !touch.longPressed && dt < 600) {
        // Single tap = left click.
        var p = relCoords(touch.startX, touch.startY);
        if (p) sendInput({ action: 'click', button: 'left', x: p.x, y: p.y });
      }
    }
    touch.mode = null;
  }
  viewport.addEventListener('touchend', touchEnd, { passive: false });
  viewport.addEventListener('touchcancel', function () { clearLongPress(); touch.mode = null; });

  /* ---------------- Keyboard ---------------- */
  function setKbCapture(on) {
    state.kbCapture = on;
    kbBtn.classList.toggle('active', on);
    keybar.classList.toggle('hidden', !(on && IS_TOUCH));
    if (on && IS_TOUCH) {
      // Summon the soft keyboard on phones.
      setTimeout(function () { try { keyCatcher.focus({ preventScroll: true }); } catch (e) {} }, 60);
    } else {
      try { keyCatcher.blur(); } catch (e) {}
    }
  }
  kbBtn.addEventListener('click', function () { setKbCapture(!state.kbCapture); });

  // Refocus the catcher if the user taps the screen while keyboard mode is on.
  viewport.addEventListener('click', function () {
    if (state.kbCapture && IS_TOUCH) {
      try { keyCatcher.focus({ preventScroll: true }); } catch (e) {}
    }
  });

  var PREVENT_KEYS = { Tab: true, ArrowUp: true, ArrowDown: true, ArrowLeft: true, ArrowRight: true, ' ': true };

  function handleKey(e, down) {
    if (!state.session || !state.kbCapture || state.session.viewOnly) return;
    // Typing in the Type-text dialog must not also leak keystrokes to the PC.
    var t = e.target;
    if (t && t !== keyCatcher && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    // Don't hijack browser-reserved shortcuts the page can't override anyway;
    // but stop keys that would scroll/move focus in this page.
    if (down && PREVENT_KEYS[e.key] && !e.ctrlKey && !e.metaKey) e.preventDefault();
    if (down && e.key === 'Tab') e.preventDefault();

    var key = e.key;
    // Normalize a few odd values for the host.
    if (key === ' ') key = 'Space';

    sendInput({
      action: 'key', key: key, down: down, repeat: !!e.repeat,
      ctrlKey: !!(e.ctrlKey || state.stickyMods.ctrl),
      altKey: !!(e.altKey || state.stickyMods.alt),
      shiftKey: !!(e.shiftKey || state.stickyMods.shift),
      metaKey: !!(e.metaKey || state.stickyMods.meta),
    });

    // Sticky modifiers apply to the next non-modifier key, then clear.
    if (down && !e.repeat && !isModifierKey(e.key)) clearStickyMods();
  }

  function isModifierKey(k) {
    return k === 'Control' || k === 'Alt' || k === 'Shift' || k === 'Meta';
  }
  function clearStickyMods() {
    state.stickyMods.ctrl = state.stickyMods.alt = state.stickyMods.shift = state.stickyMods.meta = false;
    var btns = keybar.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) btns[i].classList.remove('sticky-on');
  }

  document.addEventListener('keydown', function (e) { handleKey(e, true); });
  document.addEventListener('keyup', function (e) { handleKey(e, false); });

  // Mobile special-keys bar: Esc / Tab / Del send immediately; Ctrl/Alt/Shift/Win are sticky.
  keybar.addEventListener('click', function (e) {
    var btn = e.target.closest('button');
    if (!btn || !state.session) return;
    var k = btn.getAttribute('data-k');
    if (k === 'mod-ctrl' || k === 'mod-alt' || k === 'mod-shift' || k === 'mod-meta') {
      var name = k.slice(4);
      state.stickyMods[name] = !state.stickyMods[name];
      btn.classList.toggle('sticky-on', state.stickyMods[name]);
      return;
    }
    sendInput({ action: 'key', key: k, down: true, repeat: false,
      ctrlKey: state.stickyMods.ctrl, altKey: state.stickyMods.alt,
      shiftKey: state.stickyMods.shift, metaKey: state.stickyMods.meta });
    setTimeout(function () {
      sendInput({ action: 'key', key: k, down: false, repeat: false,
        ctrlKey: false, altKey: false, shiftKey: false, metaKey: false });
    }, 90);
    clearStickyMods();
  });

  /* ---------------- Type-text dialog ---------------- */
  typeBtn.addEventListener('click', function () {
    if (!state.session) { toast('Connect to a computer first.'); return; }
    typeText.value = '';
    typeDialog.classList.remove('hidden');
    setTimeout(function () { try { typeText.focus({ preventScroll: true }); } catch (e) {} }, 60);
  });
  typeCancel.addEventListener('click', function () {
    typeDialog.classList.add('hidden');
    typeText.value = '';
  });
  function sendTypedText() {
    var text = typeText.value;
    typeDialog.classList.add('hidden');
    typeText.value = '';
    if (!text) return;
    if (!sendInput({ action: 'type', text: text })) toast('Not connected to the server.');
    else toast('Sent to PC ⌨️');
  }
  typeSend.addEventListener('click', sendTypedText);

  // Mobile soft keyboard: keydown events often arrive with key='Unidentified'
  // for real letters, so typed text goes nowhere via per-key capture. The
  // input event carries the actual characters — type them and clear the field.
  // (Existing per-key capture above is kept untouched.)
  keyCatcher.addEventListener('input', function (e) {
    if (!state.session || !state.kbCapture) { keyCatcher.value = ''; return; }
    var v = keyCatcher.value;
    keyCatcher.value = '';
    if (e.inputType === 'deleteContentBackward' || e.inputType === 'deleteContentForward') {
      sendInput({ action: 'key', key: 'Backspace', down: true });
      setTimeout(function () { sendInput({ action: 'key', key: 'Backspace', down: false }); }, 60);
      return;
    }
    var text = String(v).replace(/\r?\n/g, ''); // Enter is already handled by keydown
    if (text) sendInput({ action: 'type', text: text });
  });

  /* ---------------- File transfer ---------------- */
  var MAX_UPLOAD = 100 * 1024 * 1024;  // 100 MB cap, matches the host
  var CHUNK_BIN = 36 * 1024;           // binary bytes → ~48KB base64 per chunk

  function b64encodeBytes(u8) {
    var s = '';
    for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s);
  }

  function fmtSize(n) {
    n = +n || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }

  function setProgress(label, frac) {
    frac = Math.min(1, Math.max(0, frac));
    transferProgress.classList.remove('hidden');
    transferBar.style.width = Math.round(frac * 100) + '%';
    transferLabel.textContent = label + ' ' + Math.round(frac * 100) + '%';
  }
  function hideProgress() {
    transferProgress.classList.add('hidden');
    transferBar.style.width = '0%';
    transferLabel.textContent = '';
  }

  /* ----- Files panel ----- */
  function openFilesPanel() {
    filesPanel.classList.remove('hidden');
    state.filesOpen = true;
    refreshFileList();
  }
  function closeFilesPanel() {
    filesPanel.classList.add('hidden');
    state.filesOpen = false;
  }
  filesBtn.addEventListener('click', function () {
    if (!state.session) { toast('Connect to a computer first.'); return; }
    if (state.filesOpen) closeFilesPanel();
    else openFilesPanel();
  });
  filesClose.addEventListener('click', closeFilesPanel);
  filesRefresh.addEventListener('click', refreshFileList);

  function refreshFileList() {
    if (!state.session) return;
    if (!send({ type: 'file_get_list' })) toast('Not connected to the server.');
    // Host replies { type:'file_list', files:[{name,size}] }.
  }

  function renderFileList(files) {
    fileList.innerHTML = '';
    if (!files.length) {
      fileList.innerHTML = '<p class="muted small center">No files yet — upload one! 📤</p>';
      return;
    }
    files.forEach(function (f) {
      var row = document.createElement('div');
      row.className = 'file-row';
      row.innerHTML =
        '<div class="file-icon">📄</div>' +
        '<div class="file-info"><div class="file-name"></div>' +
        '<div class="file-size muted small"></div></div>' +
        '<div class="file-actions">' +
        '<button class="btn ghost small" title="Download">⬇️</button>' +
        '<button class="btn ghost small" title="Rename">✏️</button>' +
        '<button class="btn ghost small" title="Delete">🗑️</button>' +
        '</div>';
      row.querySelector('.file-name').textContent = f.name;
      row.querySelector('.file-size').textContent = fmtSize(f.size);
      var btns = row.querySelectorAll('.file-actions button');
      btns[0].addEventListener('click', function () { downloadFile(f.name); });
      btns[1].addEventListener('click', function () { renameFile(f.name); });
      btns[2].addEventListener('click', function () { deleteFile(f.name); });
      fileList.appendChild(row);
    });
  }

  function downloadFile(name) {
    if (!send({ type: 'file_dl', name: name })) { toast('Not connected to the server.'); return; }
    state.dl = { name: name, size: 0, chunks: [], received: 0, expected: 0 };
    setProgress('Downloading ' + name, 0);
    // Host streams { type:'dl_start' } { type:'dl_chunk' }… { type:'dl_end' }.
  }

  function renameFile(oldName) {
    var newName = prompt('Rename "' + oldName + '" to:', oldName);
    if (newName === null) return;
    newName = newName.trim();
    if (!newName || newName === oldName) return;
    if (!send({ type: 'file_rename', old: oldName, new: newName })) {
      toast('Not connected to the server.');
    }
    // Host replies { type:'file_renamed' } or { type:'file_error' }.
  }

  function deleteFile(name) {
    if (!confirm('Delete "' + name + '" from the office PC?')) return;
    if (!send({ type: 'file_delete', name: name })) {
      toast('Not connected to the server.');
    }
    // Host replies { type:'file_deleted' } or { type:'file_error' }.
  }

  /* ----- Upload (device → church PC) ----- */
  uploadBtn.addEventListener('click', function () {
    if (!state.session) { toast('Connect to a computer first.'); return; }
    filePicker.click();
  });
  filesUpload.addEventListener('click', function () { filePicker.click(); });

  filePicker.addEventListener('change', function () {
    var f = filePicker.files && filePicker.files[0];
    filePicker.value = '';
    if (!f) return;
    if (!state.session) { toast('Connect to a computer first.'); return; }
    if (f.size > MAX_UPLOAD) {
      toast('That file is over 100 MB — too big to send.');
      return;
    }
    // Auto-open the files panel so the progress bar is visible.
    openFilesPanel();
    uploadFile(f);
  });

  function uploadFile(f) {
    var reader = new FileReader();
    reader.onload = function () {
      var bytes = new Uint8Array(reader.result);
      var totalChunks = Math.max(1, Math.ceil(bytes.length / CHUNK_BIN));
      if (!send({ type: 'file_start', name: f.name, size: f.size })) {
        toast('Not connected to the server.');
        return;
      }
      setProgress('Uploading ' + f.name, 0);
      var i = 0;
      function nextChunk() {
        if (!state.session) { toast('Upload stopped — session ended.'); hideProgress(); return; }
        if (i >= totalChunks) {
          send({ type: 'file_end', name: f.name, chunks: totalChunks });
          return;
        }
        var slice = bytes.subarray(i * CHUNK_BIN, (i + 1) * CHUNK_BIN);
        send({ type: 'file_chunk', name: f.name, index: i, data: b64encodeBytes(slice) });
        i++;
        setProgress('Uploading ' + f.name, i / totalChunks);
        // Yield to the UI thread every 20 chunks so the bar actually moves.
        if (i % 20 === 0) setTimeout(nextChunk, 0);
        else nextChunk();
      }
      nextChunk();
      // Host replies { type:'file_ack' } then { type:'file_done' } or { type:'file_error' }.
    };
    reader.onerror = function () { toast('Could not read that file.'); };
    reader.readAsArrayBuffer(f);
  }


  /* ---------------- Fit-to-screen toggle ---------------- */
  function setFitMode(fit) {
    state.fitMode = fit;
    frameImg.classList.toggle('fit', fit);
    frameImg.classList.toggle('fill', !fit);
    fitBtn.style.opacity = fit ? '1' : '0.55';
  }
  fitBtn.addEventListener('click', function () { setFitMode(!state.fitMode); });

  /* ---------------- Boot ---------------- */
  function boot() {
    loginServer.value = serverURL();
    signupServer.value = serverURL();
    var savedUser = localStorage.getItem(LS_USER);
    if (savedUser) { loginUser.value = savedUser; signupEmail.value = savedUser; }
    setTimeout(function () {
      splash.classList.add('fade');
      setTimeout(function () {
        splash.style.display = 'none';
        showScreen('login');
        loginUser.focus();
      }, 450);
    }, 900);
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
