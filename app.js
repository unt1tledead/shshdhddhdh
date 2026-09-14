/* global Telegram */
'use strict';

const APP_VERSION = '20260812';
console.log(`[APP] app.js loaded, version ${APP_VERSION}`);
window.APP_VERSION = APP_VERSION;

// ── Telegram Mini App init ────────────────────────────────────────────────
const tg = window.Telegram?.WebApp;
if (tg) {
    tg.ready();
    tg.expand();
    try { if (tg.requestFullscreen) tg.requestFullscreen(); } catch (_) {}
    try { if (tg.setHeaderColor)    tg.setHeaderColor('#0d0d0d'); } catch (_) {}
    try { if (tg.setBackgroundColor) tg.setBackgroundColor('#0d0d0d'); } catch (_) {}
}

// ── Storage keys ──────────────────────────────────────────────────────────
const KEY_PIN      = 'gw_pin';
const KEY_ATTEMPTS = 'gw_pin_attempts';
const KEY_LOCKOUT  = 'gw_pin_lockout';
const KEY_LEGEND   = 'gw_legend_hidden';
const KEY_UID      = 'gw_uid';
const KEY_PROFILE_HIDDEN = 'gw_profile_hidden';

const MAX_ATTEMPTS     = 3;
const LOCKOUT_MS       = 60 * 60 * 1000; // 1 hour

// ── PIN State ─────────────────────────────────────────────────────────────
let pinBuffer = '';
let setupDraftPin = '';
let pinMode = 'enter';
let _searchUsers = [];
let _viewedUser = null;
let _currentWallets = [];
let _pendingDealId = null; // ID сделки для открытия после авторизации

// Expose PIN functions immediately — inline onclick in index.html needs them
// before onAppReady() is ever called (type="module" hides them from global scope)
window.pinPress = pinPress;
window.pinBackspace = pinBackspace;

// ── Boot ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    boot();
});

function boot() {
    // Парсим параметры из URL для открытия сделки
    const params = new URLSearchParams(window.location.search);
    const dealIdParam = params.get('deal_id');
    console.log('🔍 URL params:', {
        fullSearch: window.location.search,
        dealIdParam: dealIdParam,
        allParams: Object.fromEntries(params),
    });
    if (dealIdParam) {
        _pendingDealId = parseInt(dealIdParam);
        console.log(`📌 Pending deal ID set to: ${_pendingDealId}`);
    }

    // Check active lockout
    const lockoutUntil = parseInt(localStorage.getItem(KEY_LOCKOUT) || '0');
    if (lockoutUntil > Date.now()) {
        pinMode = localStorage.getItem(KEY_PIN) ? 'enter' : 'setup';
        showScreen('pin-screen');
        updatePinTexts();
        startLockoutTimer(lockoutUntil);
        return;
    }

    const storedPin = localStorage.getItem(KEY_PIN);
    if (!storedPin) {
        pinMode = 'setup';
        showScreen('pin-screen');
        updatePinTexts();
        return;
    }

    pinMode = 'enter';
    showScreen('pin-screen');
    updatePinTexts();
}

function updatePinTexts() {
    const titleEl = document.getElementById('pin-title');
    const subEl = document.getElementById('pin-subtitle');
    const warningEl = document.getElementById('pin-warning');
    const lockoutEl = document.getElementById('pin-lockout');

    if (pinMode === 'setup') {
        titleEl.textContent = 'Создайте PIN-код';
        subEl.textContent = 'Для доступа к профилю придумайте 4-значный PIN-код';
        warningEl.classList.add('hidden');
        lockoutEl.classList.add('hidden');
        return;
    }

    if (pinMode === 'confirm') {
        titleEl.textContent = 'Повторите PIN-код';
        subEl.textContent = 'Введите тот же 4-значный PIN для подтверждения';
        warningEl.classList.add('hidden');
        lockoutEl.classList.add('hidden');
        return;
    }

    titleEl.textContent = 'Введите PIN-код';
    subEl.textContent = 'Для доступа к вашему профилю введите 4-значный PIN-код, который вы задали ранее';
    warningEl.classList.remove('hidden');
}

// ── Screen helper ─────────────────────────────────────────────────────────
function showScreen(id) {
    document.getElementById('pin-screen').classList.toggle('hidden', id !== 'pin-screen');
    document.getElementById('app-screen').classList.toggle('hidden', id !== 'app-screen');
}

// ── PIN: key press ────────────────────────────────────────────────────────
function pinPress(digit) {
    // Blocked during lockout
    if (!document.getElementById('pin-lockout').classList.contains('hidden')) return;
    if (pinBuffer.length >= 4) return;

    pinBuffer += digit;
    updateDots();

    if (pinBuffer.length === 4) {
        setTimeout(handlePinComplete, 120);
    }
}

function pinBackspace() {
    if (pinBuffer.length === 0) return;
    pinBuffer = pinBuffer.slice(0, -1);
    updateDots();
    document.getElementById('pin-error').classList.add('hidden');
}

function updateDots() {
    for (let i = 0; i < 4; i++) {
        document.getElementById(`pin-d${i}`).classList.toggle('filled', i < pinBuffer.length);
    }
}

// ── PIN: verify ───────────────────────────────────────────────────────────
function handlePinComplete() {
    const errEl = document.getElementById('pin-error');

    if (pinMode === 'setup') {
        setupDraftPin = pinBuffer;
        pinBuffer = '';
        updateDots();
        errEl.classList.add('hidden');
        pinMode = 'confirm';
        updatePinTexts();
        return;
    }

    if (pinMode === 'confirm') {
        if (pinBuffer === setupDraftPin) {
            localStorage.setItem(KEY_PIN, pinBuffer);
            localStorage.removeItem(KEY_ATTEMPTS);
            localStorage.removeItem(KEY_LOCKOUT);
            pinBuffer = '';
            setupDraftPin = '';
            pinMode = 'enter';
            updateDots();
            updatePinTexts();
            showScreen('app-screen');
            onAppReady();
            return;
        }

        errEl.textContent = 'PIN не совпал. Создайте PIN заново.';
        errEl.classList.remove('hidden');
        pinBuffer = '';
        setupDraftPin = '';
        pinMode = 'setup';
        updateDots();
        updatePinTexts();
        return;
    }

    checkStoredPin();
}

function checkStoredPin() {
    const stored = localStorage.getItem(KEY_PIN);
    if (pinBuffer === stored) {
        localStorage.removeItem(KEY_ATTEMPTS);
        pinBuffer = '';
        updateDots();
        showScreen('app-screen');
        onAppReady();
    } else {
        let attempts = parseInt(localStorage.getItem(KEY_ATTEMPTS) || '0') + 1;
        localStorage.setItem(KEY_ATTEMPTS, String(attempts));

        if (attempts >= MAX_ATTEMPTS) {
            const until = Date.now() + LOCKOUT_MS;
            localStorage.setItem(KEY_LOCKOUT, String(until));
            localStorage.removeItem(KEY_ATTEMPTS);
            startLockoutTimer(until);
        } else {
            const left = MAX_ATTEMPTS - attempts;
            const errEl = document.getElementById('pin-error');
            errEl.textContent = `Неверный PIN-код. Осталось попыток: ${left}`;
            errEl.classList.remove('hidden');
        }

        pinBuffer = '';
        updateDots();
    }
}

// ── PIN: lockout timer ────────────────────────────────────────────────────
function startLockoutTimer(until) {
    const errEl     = document.getElementById('pin-error');
    const lockoutEl = document.getElementById('pin-lockout');
    const timerEl   = document.getElementById('lockout-timer');

    if (errEl)     errEl.classList.add('hidden');
    if (lockoutEl) lockoutEl.classList.remove('hidden');

    setNumpadEnabled(false);

    const tick = () => {
        const remaining = until - Date.now();
        if (remaining <= 0) {
            localStorage.removeItem(KEY_LOCKOUT);
            lockoutEl.classList.add('hidden');
            setNumpadEnabled(true);
            pinBuffer = '';
            pinMode = localStorage.getItem(KEY_PIN) ? 'enter' : 'setup';
            updatePinTexts();
            updateDots();
            return;
        }
        const m = Math.floor(remaining / 60000);
        const s = Math.floor((remaining % 60000) / 1000);
        timerEl.textContent = `${m}:${String(s).padStart(2, '0')}`;
        setTimeout(tick, 1000);
    };
    tick();
}

function setNumpadEnabled(enabled) {
    document.querySelectorAll('.numpad-btn').forEach(btn => {
        btn.disabled = !enabled;
        btn.style.opacity = enabled ? '' : '0.35';
    });
}

// ── App ready ─────────────────────────────────────────────────────────────
function onAppReady() {
    // Hide legend permanently if user chose so
    if (localStorage.getItem(KEY_LEGEND) === 'true') {
        document.getElementById('legend-card').classList.add('hidden');
    } else {
        // Dynamically position arrows after layout is complete
        setTimeout(positionLegendArrows, 80);
    }
    loadSearchUsers('');
    // pre-load data for other pages in background
    loadProfile();
    loadHelp();
    loadDeals();

    // Обработка URL-параметров page= и tab=
    const urlParams = new URLSearchParams(window.location.search);
    const startPage = urlParams.get('page');
    const startTab  = urlParams.get('tab');

    if (startPage && startPage !== 'search') {
        // Найти нужную nav-кнопку и кликнуть
        const navBtn = document.querySelector(`.nav-btn[onclick*="'${startPage}'"]`);
        if (navBtn) {
            navTo(startPage, navBtn);
        } else {
            // Страницы без nav-кнопки (deposit, settings и т.д.)
            setTimeout(() => openSubpage(startPage), 100);
        }
    }

    // Переключить вкладку после загрузки данных
    if (startTab) {
        setTimeout(() => {
            if (startPage === 'help') {
                const helpTabBtn = document.querySelector(`#page-help .tab[onclick*="'${startTab}'"]`);
                if (helpTabBtn) switchHelpTab(helpTabBtn, startTab);
            } else if (startPage === 'profile') {
                if (startTab === 'deposit') {
                    openSubpage('deposit-menu');
                } else if (startTab === 'settings') {
                    openSubpage('settings');
                } else {
                    const profileTabBtn = document.querySelector(`#page-profile .tab[onclick*="'${startTab}'"]`);
                    if (profileTabBtn) switchProfileTab(profileTabBtn, startTab);
                }
            } else if (startPage === 'search') {
                const searchTabBtn = document.querySelector(`#page-search .tab[onclick*="'${startTab}'"]`);
                if (searchTabBtn) switchTab(searchTabBtn, startTab);
            } else if (startPage === 'deals') {
                switchDealsTab(startTab);
            }
        }, 300);
    }

    // Открыть сделку если её ID был передан в URL параметре
    if (_pendingDealId) {
        setTimeout(() => {
            openDealView(_pendingDealId);
            _pendingDealId = null;
        }, 500);
    }
}

// ── Navigation ────────────────────────────────────────────────────────────
function navTo(pageId, btn) {
    const prev = document.querySelector('.page.active');
    const next = document.getElementById(`page-${pageId}`);
    if (prev && prev === next) return;

    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    if (prev) prev.classList.remove('active');
    if (next) next.classList.add('active');

    // Scroll content to top on tab switch
    document.querySelector('.app-main').scrollTop = 0;

    if (pageId === 'profile') loadProfile();
    if (pageId === 'help') loadHelp();
    if (pageId === 'deals' && document.getElementById('deals-list')?.dataset.live === '1') loadDeals(_dealsFilter);
}

async function loadSearchUsers(query) {
    const q = (query || '').trim();
    const data = await apiGet(`/api/users/search?q=${encodeURIComponent(q)}&limit=50`);
    _searchUsers = Array.isArray(data) ? data : [];
    renderUserList(_searchUsers);
}

function getTgUser() {
    const unsafeUser = tg?.initDataUnsafe?.user;
    if (unsafeUser) return unsafeUser;

    const rawInitData = tg?.initData;
    if (!rawInitData) return null;
    try {
        const params = new URLSearchParams(rawInitData);
        const userRaw = params.get('user');
        return userRaw ? JSON.parse(userRaw) : null;
    } catch {
        return null;
    }
}

// ── Get current Telegram user id ──────────────────────────────
    function getTgUid() {
        const tgUser = getTgUser();
        const fromTg = tgUser?.id;
        if (fromTg) {
            localStorage.setItem(KEY_UID, String(fromTg));
            return Number(fromTg);
        }
        const fromQuery = new URLSearchParams(window.location.search).get('uid');
        if (fromQuery) {
            localStorage.setItem(KEY_UID, String(fromQuery));
            return Number(fromQuery);
        }
        const fromStorage = localStorage.getItem(KEY_UID);
        return fromStorage ? Number(fromStorage) : null;
    }

    // ── Generic API fetch ─────────────────────────────────────────
    async function apiGet(path) {
        try {
            const sep = path.includes('?') ? '&' : '?';
            const resp = await fetch(`${path}${sep}_t=${Date.now()}`, { cache: 'no-store' });
            if (!resp.ok) return null;
            return await resp.json();
        } catch {
            return null;
        }
    }

    // ══════════════════════ PROFILE ═══════════════════════════════

    let _profileLoaded = false;

    function renderProfileBase(data, avatarUrl) {
        const char = (data.first_name || data.username || '?')[0].toUpperCase();
        document.getElementById('profile-cover-char').textContent = char;
        const hasAvatar = avatarUrl && !avatarUrl.endsWith('/no-avatar');

        // Перерисовываем аватар-блок только если URL изменился — иначе мигание при двойном вызове
        const avatarEl = document.getElementById('profile-avatar');
        if (avatarEl.dataset.avatarUrl !== avatarUrl) {
            avatarEl.dataset.avatarUrl = avatarUrl;
            avatarEl.innerHTML = `
                <div class="profile-avatar-photo-wrap">
                    <img class="profile-avatar-photo" src="/api/assets/no-avatar" alt="avatar" />
                </div>
            `;
        }
        document.getElementById('profile-name').textContent = data.first_name || data.username || 'Аноним';
        document.getElementById('profile-username').textContent = data.username ? `@${data.username}` : '';
        const _pid = document.getElementById('profile-tgid');
        if (_pid) _pid.textContent = (data.telegram_id || getTgUid()) ? `ID: ${data.telegram_id || getTgUid()}` : '';
        const _pdesc = document.getElementById('profile-desc');
        if (_pdesc) _pdesc.textContent = data.description || 'Нет описания';

        const statusMap = { admin: 'Администратор', arbiter: 'Арбитр', moderator: 'Модератор', user: 'Пользователь' };
        document.getElementById('profile-status-badge').textContent = statusMap[data.status] || 'Пользователь';

        const rating = data.rating_count > 0 ? (data.rating_sum / data.rating_count).toFixed(1) : '0';
        const starSvg = Number(rating) > 0
            ? '<svg class="rating-star" width="15" height="14" viewBox="0 0 17 16" fill="none"><path d="M8.49993 1.33398C8.76619 1.33398 9.00692 1.49242 9.11223 1.73697L10.7582 5.55907L14.9019 5.94339C15.167 5.96798 15.3921 6.14796 15.4743 6.40119C15.5566 6.65442 15.4803 6.93233 15.2803 7.10806L12.1539 9.85456L13.0689 13.9142C13.1274 14.1739 13.0258 14.4436 12.8104 14.6001C12.5949 14.7566 12.3071 14.7699 12.0781 14.634L8.49993 12.5093L4.92173 14.634C4.69279 14.7699 4.40491 14.7566 4.1895 14.6001C3.97409 14.4436 3.87247 14.1739 3.93101 13.9142L4.84597 9.85456L1.71956 7.10806C1.51953 6.93233 1.44324 6.65442 1.52551 6.40119C1.60779 6.14796 1.83286 5.96798 2.09799 5.94339L6.24166 5.55907L7.88763 1.73697C7.99294 1.49242 8.23367 1.33398 8.49993 1.33398Z" fill="#FEE600"/></svg>'
            : '<svg class="rating-star" width="15" height="14" viewBox="0 0 19 18" fill="none"><path fill-rule="evenodd" clip-rule="evenodd" d="M9.75 1.5C10.0495 1.5 10.3204 1.67824 10.4388 1.95335L12.2906 6.25322L16.9522 6.68558C17.2505 6.71324 17.5037 6.91573 17.5962 7.20061C17.6888 7.48549 17.603 7.79813 17.3779 7.99583L13.8607 11.0856L14.89 15.6527C14.9559 15.9449 14.8416 16.2483 14.5992 16.4244C14.3569 16.6005 14.033 16.6154 13.7755 16.4625L9.75 14.0723L5.72453 16.4625C5.46697 16.6154 5.14311 16.6005 4.90077 16.4244C4.65844 16.2483 4.5441 15.9449 4.60996 15.6527L5.63929 11.0856L2.12209 7.99583C1.89705 7.79813 1.81122 7.48549 1.90378 7.20061C1.99635 6.91573 2.24955 6.71324 2.54781 6.68558L7.20944 6.25322L9.06116 1.95335C9.17964 1.67824 9.45046 1.5 9.75 1.5ZM9.75 4.1462L8.41098 7.25554C8.3024 7.50767 8.06475 7.68033 7.7914 7.70569L4.42047 8.01833L6.96385 10.2527C7.17008 10.4338 7.26086 10.7132 7.2005 10.981L6.45617 14.2836L9.36708 12.5551C9.60312 12.415 9.89688 12.415 10.1329 12.5551L13.0438 14.2836L12.2995 10.981C12.2391 10.7132 12.3299 10.4338 12.5362 10.2527L15.0795 8.01833L11.7086 7.70569C11.4353 7.68033 11.1976 7.50767 11.089 7.25554L9.75 4.1462Z" fill="#FEE600"/></svg>';
        document.getElementById('profile-rating').innerHTML = `${starSvg} ${rating}`;
        document.getElementById('profile-deposit').textContent = data.deposit > 0 ? `$${Math.round(data.deposit).toLocaleString('ru-RU')}` : '0';
        document.getElementById('profile-deals').textContent = data.total_deals || 0;
        document.getElementById('profile-sum').textContent = data.total_sum > 0 ? `$${Math.round(data.total_sum).toLocaleString('ru-RU')}` : '$0';
        document.getElementById('profile-rev-cnt').textContent = data.reviews_count || 0;
    }

    async function loadProfile() {
        const tgUser = getTgUser();
        const uid = getTgUid();
        let data = null;

        if (tgUser) {
            renderProfileBase({
                first_name: tgUser.first_name || '',
                username: tgUser.username || '',
                status: 'user',
                rating_count: 0,
                rating_sum: 0,
                deposit: 0,
                total_deals: 0,
                total_sum: 0,
                reviews_count: 0,
            }, uid ? `/api/assets/tg-avatar-framed/${uid}` : '/api/assets/no-avatar');
        }

        if (uid) {
            const params = new URLSearchParams({ uid: String(uid) });
            if (tgUser?.username) params.set('username', tgUser.username);
            if (tgUser?.first_name) params.set('first_name', tgUser.first_name);
            if (tgUser?.last_name) params.set('last_name', tgUser.last_name);
            data = await apiGet(`/api/me?${params.toString()}`);
            if (data && data.error) data = null;
        }

        if (!data && tgUser) {
            data = {
                first_name: tgUser.first_name || '',
                username: tgUser.username || '',
                status: 'user',
                rating_count: 0,
                rating_sum: 0,
                deposit: 0,
                total_deals: 0,
                total_sum: 0,
                reviews_count: 0,
            };
        }

        if (!data) return;

        renderProfileBase(data, uid ? `/api/assets/tg-avatar-framed/${uid}` : '/api/assets/no-avatar');

        // Показываем кнопку "Админ панель" только для администраторов
        const adminBtnWrap = document.getElementById('profile-admin-btn-wrap');
        if (adminBtnWrap) {
            const isAdmin = data.is_admin || data.status === 'admin' || data.status === 'moderator' || data.status === 'arbiter';
            adminBtnWrap.style.display = isAdmin ? 'block' : 'none';
        }

        _profileLoaded = true;
    }

    function switchProfileTab(btn, tab) {
        document.querySelectorAll('#page-profile .tabs .tab').forEach(t => t.classList.remove('active'));
        btn.classList.add('active');
        const content = document.getElementById('profile-content');
        if (tab === 'reviews') {
            content.innerHTML = `<div class="empty-card"><p class="empty-title">Нет отзывов</p><p class="empty-sub">Отзывы появятся здесь после завершения сделок</p></div>`;
        }
    }

    // ══════════════════════ DEALS ═════════════════════════════════

    let _dealsFilter = 'all';

    async function loadDeals(filter = 'all') {
        _dealsFilter = filter;
        const uid = getTgUid();
        const container = document.getElementById('deals-list');
        container.innerHTML = `<div class="empty-card"><p class="empty-title">Загрузка...</p></div>`;
        if (!uid) {
            container.innerHTML = renderDealsEmpty();
            return;
        }
        const data = await apiGet(`/api/deals?uid=${uid}&filter=${filter}`);
        if (!data || !data.length) {
            container.innerHTML = renderDealsEmpty();
            return;
        }
        container.innerHTML = data.map(d => renderDealItem(d)).join('');
    }

    function renderDealsEmpty() {
        return `<div class="empty-card"><p class="empty-title">У вас пока нет сделок</p><p class="empty-sub">Здесь будут отображаться все ваши сделки</p></div>`;
    }

    function renderDealItem(d) {
        const statusMap = {
            pending:          { label: 'Ожидает подтверждения', cls: 'ds-pending' },
            awaiting_payment: { label: 'Ожидает оплаты',        cls: 'ds-awaiting' },
            in_progress:      { label: 'В процессе',             cls: 'ds-progress' },
            completed:        { label: 'Завершена',              cls: 'ds-completed', svgIcon: 'icons/14.svg' },
            cancelled:        { label: 'Отменена',               cls: 'ds-cancelled' },
            rejected:         { label: 'Отклонена',              cls: 'ds-cancelled' },
        };
        const st = statusMap[d.status] || { label: d.status, cls: 'ds-other' };
        const sideText = d.side === 'sell' ? 'Продажа' : 'Покупка';
        const otherName = d.other_name || d.other_username || '—';
        const otherUser = d.other_username ? `@${d.other_username}` : '';
        const date = d.created_at ? new Date(d.created_at).toLocaleDateString('ru-RU') : '';
        const avatarUrl = d.other_id ? `/api/assets/tg-avatar/${d.other_id}` : '/api/assets/no-avatar-small';
        const amount = `$${(d.amount || 0).toFixed(2)}`;
        const completedSvg = `<svg width="14" height="14" viewBox="0 0 14 15" fill="none" style="margin-right:4px;vertical-align:middle;flex-shrink:0"><path fill-rule="evenodd" clip-rule="evenodd" d="M6.99999 1.66699C3.77833 1.66699 1.16666 4.27866 1.16666 7.50033C1.16666 10.722 3.77833 13.3337 6.99999 13.3337C10.2217 13.3337 12.8333 10.722 12.8333 7.50033C12.8333 4.27866 10.2217 1.66699 6.99999 1.66699ZM6.82911 9.37111L9.74577 6.45444L8.92082 5.62949L6.41663 8.13367L4.78744 6.50449L3.96248 7.32944L6.00415 9.37111C6.23196 9.59892 6.6013 9.59892 6.82911 9.37111Z" fill="#3DB43A"/></svg>`;
        const statusIcon = st.svgIcon ? completedSvg : '';
        return `
            <div class="deal-item" onclick="openDealView(${d.id})">
                <div class="deal-item-top">
                    <span class="deal-status-badge ${escHtml(st.cls)}">${statusIcon}${escHtml(st.label)} #${d.id}</span>
                    <span class="deal-item-date">${escHtml(date)}</span>
                </div>
                <div class="deal-item-title">${escHtml(d.title || sideText)}</div>
                <div class="deal-item-user">
                    <div class="deal-item-ava">
                        <img src="${avatarUrl}" alt="" onerror="this.onerror=null;this.src='/api/assets/no-avatar-small';" />
                    </div>
                    <div class="deal-item-name-wrap">
                        <span class="deal-item-name">${escHtml(otherName)}</span>
                        <span class="online-dot"></span>
                    </div>
                    <span class="deal-item-amount">${escHtml(amount)}</span>
                </div>
            </div>`;
    }

    function switchDealsTab(btn, filter) {
        document.querySelectorAll('#page-deals .tab, #page-deals .ref-seg-btn').forEach(t => t.classList.remove('active'));
        btn.classList.add('active');
        if (filter === 'all') {
            document.getElementById('deals-filter-label').textContent = 'Все';
            document.getElementById('deals-filter-clear').style.display = 'none';
        }
        loadDeals(filter);
    }

    function clearDealsFilter() {
        document.getElementById('deals-filter-label').textContent = 'Все';
        document.getElementById('deals-filter-clear').style.display = 'none';
        loadDeals(_dealsFilter);
    }

    // ══════════════════════ HELP / SUPPORT ════════════════════════

    let _helpData = null;

    async function loadHelp() {
        if (_helpData) { renderHelpTab('admins'); return; }
        const data = await apiGet('/api/admins');
        _helpData = data || [];
        renderHelpTab('admins');
    }

    function renderHelpTab(tab) {
        const container = document.getElementById('help-list');
        const list = tab === 'arbiters'
            ? _helpData.filter(u => u.status === 'arbiter' || u.status === 'moderator')
            : _helpData.filter(u => u.status === 'admin');

        if (!list.length) {
            container.innerHTML = `<div class="empty-card"><p class="empty-title">Список пуст</p><p class="empty-sub">Участники не найдены</p></div>`;
            return;
        }
        container.innerHTML = list.map(u => {
            const char = (u.first_name || u.username || '?')[0].toUpperCase();
            const name = escHtml(u.first_name || u.username || 'Без имени');
            const uname = u.username ? `@${escHtml(u.username)}` : '';
            const isArbiter = u.status === 'arbiter' || u.status === 'moderator';
            const badgeCls = isArbiter ? 'badge-arbiter' : 'badge-admin';
            const badgeText = isArbiter ? 'Арбитр' : 'Админ';
            const avatarUrl = `/api/assets/tg-avatar/${u.telegram_id}`;
            return `
            <div class="support-item" onclick="openSupportUser(${u.telegram_id})">
                <div class="avatar avatar-photo">
                    <img src="${avatarUrl}" alt="" onerror="this.onerror=null;this.src='/api/assets/no-avatar-small';" />
                </div>
                <div class="support-info">
                    <div class="name-row">
                        <span class="badge ${badgeCls}">${badgeText}</span>
                        <span class="support-name">${name}</span>
                    </div>
                    <span class="support-username">${uname}</span>
                </div>
            </div>`;
        }).join('');
    }

    function switchHelpTab(btn, tab) {
        document.querySelectorAll('#page-help .tabs .tab').forEach(t => t.classList.remove('active'));
        btn.classList.add('active');
        if (_helpData) renderHelpTab(tab);
    }

    function openSupportUser(id) {
        const user = (_helpData || []).find(u => u.telegram_id === id);
        if (!user) return;
        const username = user.username || '';
        if (username && tg?.openTelegramLink) {
            tg.openTelegramLink(`https://t.me/${username}`);
        } else if (username) {
            window.open(`https://t.me/${username}`, '_blank');
        }
    }

    // ══════════════════════ NOTIFICATIONS ════════════════════════

    function switchNotifsTab(btn, _tab) {
        document.querySelectorAll('#page-notifs .tabs .tab').forEach(t => t.classList.remove('active'));
        btn.classList.add('active');
        // все пустые — данные придут позже
    }

    // Inline onclick в index.html требует глобальных функций при type="module".
    window.pinPress = pinPress;
    window.pinBackspace = pinBackspace;
    window.switchTab = switchTab;
    window.doSearch = doSearch;
    window.closeLegend = closeLegend;
    window.switchDealsTab = switchDealsTab;
    window.clearDealsFilter = clearDealsFilter;
    window.switchHelpTab = switchHelpTab;
    window.switchNotifsTab = switchNotifsTab;
    window.switchProfileTab = switchProfileTab;
    window.navTo = navTo;
    window.openChatCreate = openChatCreate;
    window.closeChatCreate = closeChatCreate;
    window.selectChatType = selectChatType;
    window.openUser = openUser;
    window.openSupportUser = openSupportUser;
    window.openDepositMenu = openDepositMenu;
    window.openDepositIn = openDepositIn;
    window.openDepositOut = openDepositOut;
    window.openSubpage = openSubpage;
    window.goBackToProfile = goBackToProfile;
    window.toggleNetworkDropdown = toggleNetworkDropdown;
    window.copyDepositAddr = copyDepositAddr;
    window.checkDepositManual = checkDepositManual;
    window.openSettingsPage = openSettingsPage;
    window.toggleProfileHidden = toggleProfileHidden;
    window.saveDescription = saveDescription;
    window.startPinChange = startPinChange;
    window.showForumsInDev = showForumsInDev;
    window.switchViewedProfileTab = switchViewedProfileTab;
    window.goBackToSearch = goBackToSearch;
    window.openViewedUserTelegram = openViewedUserTelegram;
    window.openDealInDev = openDealInDev;
    window.openDealPage = openDealPage;
    window.goBackFromDealCreate = goBackFromDealCreate;
    window.updateDealCreateCounters = updateDealCreateCounters;
    window.onDealCurrencyChange = onDealCurrencyChange;
    window.submitDealCreate = submitDealCreate;
    window.openDealView = openDealView;
    window.goBackFromDealView = goBackFromDealView;
    window.handleDealAction = handleDealAction;
    window.checkDealPayment = checkDealPayment;
    window.copyPaymentAddress = copyPaymentAddress;
    window.confirmDealCompletion = confirmDealCompletion;
    window.submitWithdrawal = submitWithdrawal;
    window.loadWithdrawals = loadWithdrawals;
    // Admin panel
    window.adminTab = adminTab;
    window.adminSearchUsers = adminSearchUsers;
    window.adminFilterDeals = adminFilterDeals;
    window.adminSendBroadcast = adminSendBroadcast;
    window.adminRefreshRates = adminRefreshRates;
    window.openAdminUser = openAdminUser;
    window.closeAdminModal = closeAdminModal;
    window.saveAdminUser = saveAdminUser;
    window.openAdminPanel = openAdminPanel;
    window.loadAdminUsers = loadAdminUsers;
    window.loadAdminDeals = loadAdminDeals;


const MOCK_CHAT_USERS = [
    { id: 1, name: 'techadmin', username: '@techadmin', role: 'Администратор', online: false },
    { id: 2, name: 'admin', username: '@admin', role: 'Администратор', online: true },
    { id: 3, name: 'Arbitr', username: '@ClArbitration', role: 'Арбитр', extra: '(id: 610041271)', online: true },
    { id: 4, name: 'Lexa CL', username: '@LexaArb', role: 'Арбитр', extra: '(id: 8509230066)', online: false },
    { id: 5, name: 'Товарищ Берия', username: '@beria', role: 'Арбитр', online: false },
    { id: 6, name: 'Pervoklassnik', username: '@PervokLassn1kk', role: 'Арбитр', extra: '(id: 8707787185)', online: false },
    { id: 7, name: 'tfs', username: '@tfs', role: 'Арбитр', online: false }
];

let chatCreateType = 'personal';
let selectedChatUsers = [];

function openChatCreate() {
    const list = document.getElementById('chat-list-view');
    const create = document.getElementById('chat-create-view');
    if (list) list.classList.remove('active');
    if (create) create.classList.add('active');
    selectedChatUsers = [];
    const search = document.getElementById('chat-user-search');
    if (search) search.value = '';
    selectChatType('personal');
    renderSelectedChatUsers();
    hideChatUserDropdown();
}

function closeChatCreate() {
    const list = document.getElementById('chat-list-view');
    const create = document.getElementById('chat-create-view');
    if (create) create.classList.remove('active');
    if (list) list.classList.add('active');
    hideChatUserDropdown();
}

function selectChatType(type) {
    chatCreateType = type;
    const personal = document.getElementById('chat-type-personal');
    const group = document.getElementById('chat-type-group');
    const nameWrap = document.getElementById('group-name-wrap');
    const hint = document.getElementById('group-limit-hint');
    const history = document.getElementById('chat-history-option');
    personal?.classList.toggle('active', type === 'personal');
    group?.classList.toggle('active', type === 'group');
    nameWrap?.classList.toggle('hidden', type !== 'group');
    hint?.classList.toggle('hidden', type !== 'group');
    history?.classList.toggle('hidden', type !== 'group');
    if (type === 'personal' && selectedChatUsers.length > 1) selectedChatUsers = selectedChatUsers.slice(0, 1);
    renderSelectedChatUsers();
}

function showChatUserDropdown() {
    renderChatUserDropdown(document.getElementById('chat-user-search')?.value || '');
}

function hideChatUserDropdown() {
    document.getElementById('chat-user-dropdown')?.classList.add('hidden');
}

function filterChatUsers() {
    renderChatUserDropdown(document.getElementById('chat-user-search')?.value || '');
}

function renderChatUserDropdown(query = '') {
    const box = document.getElementById('chat-user-dropdown');
    if (!box) return;
    const q = query.trim().toLowerCase();
    const users = MOCK_CHAT_USERS.filter(u =>
        !selectedChatUsers.some(s => s.id === u.id) &&
        (!q || `${u.name} ${u.username} ${u.role}`.toLowerCase().includes(q))
    );
    box.innerHTML = users.length ? users.map(u => `
        <button class="chat-user-option" type="button" onclick="selectMockChatUser(${u.id})">
            <span class="chat-user-avatar">${escHtml((u.name || '?').slice(0, 1).toUpperCase())}</span>
            <span class="chat-user-option-main">
                <span class="chat-user-option-name">${escHtml(u.name)} ${u.online ? '<i class="chat-online-dot"></i>' : ''} <span class="chat-user-role">${escHtml(u.role)}</span></span>
                <span class="chat-user-option-sub">${escHtml(u.username)} ${escHtml(u.extra || '')}</span>
            </span>
        </button>`).join('') : '<div style="padding:14px;color:#888;text-align:center">Ничего не найдено</div>';
    box.classList.remove('hidden');
}

function selectMockChatUser(id) {
    const user = MOCK_CHAT_USERS.find(u => u.id === id);
    if (!user) return;
    if (chatCreateType === 'personal') selectedChatUsers = [user];
    else if (!selectedChatUsers.some(u => u.id === id)) selectedChatUsers.push(user);
    const search = document.getElementById('chat-user-search');
    if (search) search.value = '';
    renderSelectedChatUsers();
    hideChatUserDropdown();
}

function removeMockChatUser(id) {
    selectedChatUsers = selectedChatUsers.filter(u => u.id !== id);
    renderSelectedChatUsers();
}

function renderSelectedChatUsers() {
    const wrap = document.getElementById('chat-selected-users');
    if (!wrap) return;
    wrap.innerHTML = selectedChatUsers.map(u => `
        <div class="chat-selected-user">
            <span class="chat-user-avatar">${escHtml((u.name || '?').slice(0, 1).toUpperCase())}</span>
            <span class="chat-selected-user-main">
                <div class="chat-selected-user-name">${escHtml(u.name)} ${u.online ? '<i class="chat-online-dot"></i>' : ''}</div>
                <div class="chat-selected-user-sub">${escHtml(u.username)} ${escHtml(u.extra || '')}</div>
            </span>
            <button class="chat-selected-remove" type="button" onclick="removeMockChatUser(${u.id})">×</button>
        </div>`).join('');
    updateChatCreateButton();
}

function updateChatCreateButton() {
    const btn = document.getElementById('chat-create-submit');
    if (!btn) return;
    const groupName = (document.getElementById('group-chat-name')?.value || '').trim();
    btn.disabled = chatCreateType === 'group' ? !(selectedChatUsers.length && groupName) : selectedChatUsers.length !== 1;
}

document.addEventListener('input', (e) => {
    if (e.target?.id === 'group-chat-name') updateChatCreateButton();
});

document.addEventListener('click', (e) => {
    const picker = document.querySelector('.chat-user-picker');
    if (picker && !picker.contains(e.target)) hideChatUserDropdown();
});

window.showChatUserDropdown = showChatUserDropdown;
window.filterChatUsers = filterChatUsers;
window.selectMockChatUser = selectMockChatUser;
window.removeMockChatUser = removeMockChatUser;

// ── Search Tabs ───────────────────────────────────────────────────────────
let currentTab = 'users';

function switchTab(btn, tab) {
    currentTab = tab;
    document.querySelectorAll('#page-search .tabs .tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');

    const input = document.getElementById('search-input');
    input.placeholder = tab === 'users' ? 'Поиск пользователей' : 'Поиск услуг';
    input.value = '';

    if (tab === 'users') {
        loadSearchUsers('');
    } else {
        renderServiceList(MOCK_SERVICES);
    }
}

// ── Legend ────────────────────────────────────────────────────────────────
function positionLegendArrows() {
    const svg = document.querySelector('.legend-arrow-svg');
    if (!svg) return;
    const svgRect = svg.getBoundingClientRect();
    if (svgRect.width === 0) return;

    svg.setAttribute('viewBox', `0 0 ${svgRect.width} ${svgRect.height}`);

    const getBottom = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2 - svgRect.left, y: r.bottom - svgRect.top };
    };
    const getTop = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2 - svgRect.left, y: r.top - svgRect.top };
    };

    const example = document.querySelector('.legend-example');
    const pairs = [
        [document.querySelector('.ann-prefix'),  example?.querySelector('.badge-yellow')],
        [document.querySelector('.ann-online'),  example?.querySelector('.online-dot')],
        [document.querySelector('.ann-deposit'), example?.querySelector('.user-deposit')],
        [document.querySelector('.ann-rating'),  example?.querySelector('.user-rating')],
    ];

    svg.querySelectorAll('path').forEach((path, i) => {
        const src = getBottom(pairs[i][0]);
        const tgt = getTop(pairs[i][1]);
        if (src && tgt) {
            path.setAttribute('d', `M${src.x.toFixed(1)} ${src.y.toFixed(1)} L${tgt.x.toFixed(1)} ${tgt.y.toFixed(1)}`);
        }
    });
}

function closeLegend(forever) {
    document.getElementById('legend-card').classList.add('hidden');
    if (forever) {
        localStorage.setItem(KEY_LEGEND, 'true');
    }
}

// ── Search ────────────────────────────────────────────────────────────────
async function doSearch() {
    const query = document.getElementById('search-input').value.trim().toLowerCase();

    if (currentTab === 'users') {
        await loadSearchUsers(query);
    } else {
        const result = query
            ? MOCK_SERVICES.filter(s =>
                s.title.toLowerCase().includes(query) ||
                s.description.toLowerCase().includes(query))
            : MOCK_SERVICES;
        renderServiceList(result);
    }
}

// ── Render User List ──────────────────────────────────────────────────────
function renderUserList(users) {
    const container = document.getElementById('user-list');

    if (!users.length) {
        container.innerHTML = '<p style="color:#666;text-align:center;padding:24px 0;font-size:14px">Ничего не найдено</p>';
        return;
    }

    container.innerHTML = users.map(u => {
        const userId = u.telegram_id ?? u.id;
        const firstName = u.first_name || u.name || 'Пользователь';
        const unameRaw = u.username || '';
        const uname = unameRaw ? (unameRaw.startsWith('@') ? unameRaw : `@${unameRaw}`) : '';
        const avatarChar = (firstName || unameRaw || '?')[0].toUpperCase();
        const ratingCount = Number(u.rating_count || 0);
        const rating = ratingCount > 0 ? (Number(u.rating_sum || 0) / ratingCount) : Number(u.rating || 0);
        const deals = Number(u.total_deals || u.deals || 0);
        const deposit = Number(u.deposit || 0);
        const status = String(u.status || 'user');
        const badge = status === 'admin' ? 'Админ' : status === 'arbiter' ? 'Арбитр' : status === 'moderator' ? 'Модератор' : '';

        const avatarUrl = `/api/assets/tg-avatar/${userId}`;

        return `
        <div class="user-item" onclick="openUser(${userId})">
            <div class="avatar avatar-photo">
                <img src="${avatarUrl}" alt="" onerror="this.onerror=null;this.src='/api/assets/no-avatar-small';" />
            </div>
            <div class="user-info">
                <div class="name-row">
                    ${badge ? `<span class="badge badge-yellow">${badge}</span>` : ''}
                    <span class="user-name">${escHtml(firstName)}</span>
                </div>
                <span class="user-username">${escHtml(uname)}</span>
            </div>
            <div class="user-right">
                <div class="user-right-top">
                    <span class="user-deposit">$${deposit.toFixed(0)}</span>
                    <span class="user-rating"><svg class="rating-star" width="12" height="11" viewBox="0 0 19 18" fill="none"><path fill-rule="evenodd" clip-rule="evenodd" d="M9.75 1.5C10.0495 1.5 10.3204 1.67824 10.4388 1.95335L12.2906 6.25322L16.9522 6.68558C17.2505 6.71324 17.5037 6.91573 17.5962 7.20061C17.6888 7.48549 17.603 7.79813 17.3779 7.99583L13.8607 11.0856L14.89 15.6527C14.9559 15.9449 14.8416 16.2483 14.5992 16.4244C14.3569 16.6005 14.033 16.6154 13.7755 16.4625L9.75 14.0723L5.72453 16.4625C5.46697 16.6154 5.14311 16.6005 4.90077 16.4244C4.65844 16.2483 4.5441 15.9449 4.60996 15.6527L5.63929 11.0856L2.12209 7.99583C1.89705 7.79813 1.81122 7.48549 1.90378 7.20061C1.99635 6.91573 2.24955 6.71324 2.54781 6.68558L7.20944 6.25322L9.06116 1.95335C9.17964 1.67824 9.45046 1.5 9.75 1.5ZM9.75 4.1462L8.41098 7.25554C8.3024 7.50767 8.06475 7.68033 7.7914 7.70569L4.42047 8.01833L6.96385 10.2527C7.17008 10.4338 7.26086 10.7132 7.2005 10.981L6.45617 14.2836L9.36708 12.5551C9.60312 12.415 9.89688 12.415 10.1329 12.5551L13.0438 14.2836L12.2995 10.981C12.2391 10.7132 12.3299 10.4338 12.5362 10.2527L15.0795 8.01833L11.7086 7.70569C11.4353 7.68033 11.1976 7.50767 11.089 7.25554L9.75 4.1462Z" fill="#FEE600"/></svg> ${rating.toFixed(1)}</span>
                </div>
                <span class="user-deals">${deals} сделок</span>
            </div>
        </div>
    `;
    }).join('');
}

// ── Render Service List ───────────────────────────────────────────────────
function renderServiceList(services) {
    const container = document.getElementById('user-list');

    if (!services.length) {
        container.innerHTML = '<p style="color:#666;text-align:center;padding:24px 0;font-size:14px">Ничего не найдено</p>';
        return;
    }

    container.innerHTML = services.map(s => `
        <div class="user-item" style="flex-direction:column;align-items:flex-start;gap:6px">
            <div style="display:flex;align-items:center;gap:10px;width:100%">
                <div class="avatar">${s.sellerChar}</div>
                <div class="user-info">
                    <div class="name-row">
                        <span class="user-name">${escHtml(s.title)}</span>
                    </div>
                    <span class="user-username">${escHtml(s.seller)}</span>
                </div>
                <div class="user-right">
                    <span class="user-deposit">${escHtml(s.price)}</span>
                </div>
            </div>
            ${s.description ? `<p style="font-size:12px;color:#888;padding-left:54px;line-height:1.4">${escHtml(s.description)}</p>` : ''}
        </div>
    `).join('');
}

    // ── Deposit / Subpages ────────────────────────────────────────────────────

    let _walletsData = null;
    let _networkDropdownOpen = false;

    async function loadWalletsData() {
        if (_walletsData) return _walletsData;
        _walletsData = await apiGet('/api/wallets');
        return Array.isArray(_walletsData) ? _walletsData : [];
    }

    function openSubpage(id) {
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        const page = document.getElementById(`page-${id}`);
        if (page) {
            page.classList.add('active');
            document.querySelector('.app-main').scrollTop = 0;
        }
    }

    function goBackToProfile() {
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        document.getElementById('page-profile').classList.add('active');
        document.querySelector('.app-main').scrollTop = 0;
    }

    function openDepositMenu() {
        openSubpage('deposit-menu');
    }

    async function openDepositIn() {
        openSubpage('deposit-in');
        // Reset state
        _networkDropdownOpen = false;
        document.getElementById('network-dropdown').classList.add('hidden');
        document.getElementById('network-caret').classList.remove('open');
        document.getElementById('selected-network-label').textContent = 'Выберите сеть';
        document.getElementById('deposit-in-details').classList.add('hidden');
        document.getElementById('deposit-in-details').innerHTML = '';

        const wallets = await loadWalletsData();
        const dropdown = document.getElementById('network-dropdown');
        dropdown.innerHTML = '';
        if (!wallets.length) {
            const opt = document.createElement('div');
            opt.className = 'custom-select-option';
            opt.textContent = 'Сети не загружены';
            dropdown.appendChild(opt);
            return;
        }
        wallets.forEach(w => {
            const opt = document.createElement('div');
            opt.className = 'custom-select-option';
            opt.textContent = w.id;
            opt.onclick = () => selectNetwork(w);
            dropdown.appendChild(opt);
        });
    }

    async function openDepositOut() {
        openSubpage('deposit-out');
        // Загружаем актуальный баланс
        const uid = getTgUid();
        try {
            const me = await fetch(`/api/me?uid=${uid}`).then(r => r.json());
            const balance = parseFloat(me.deposit || 0).toFixed(2);
            const balEl = document.getElementById('withdraw-balance');
            if (balEl) balEl.textContent = `${balance} USDT`;
            const amtEl = document.getElementById('withdraw-amount');
            if (amtEl) amtEl.max = balance;
        } catch (e) { console.warn('openDepositOut balance load:', e); }
        // Загружаем историю выводов
        loadWithdrawals();
    }

    async function loadWithdrawals() {
        const uid = getTgUid();
        try {
            const rows = await fetch(`/api/withdrawals?uid=${uid}`).then(r => r.json());
            const container = document.getElementById('withdraw-history-list');
            if (!container) return;
            if (!Array.isArray(rows) || rows.length === 0) {
                container.innerHTML = '<p class="withdraw-empty">Нет заявок на вывод</p>';
                return;
            }
            const statusLabel = { pending: '⏳ В обработке', completed: '✅ Завершён', failed: '❌ Отклонён' };
            container.innerHTML = rows.map(r => `
                <div class="withdraw-history-item">
                    <div class="whi-row">
                        <span class="whi-amount">${parseFloat(r.amount).toFixed(2)} ${escHtml(r.currency)}</span>
                        <span class="whi-status whi-${escHtml(r.status)}">${statusLabel[r.status] || r.status}</span>
                    </div>
                    <div class="whi-meta">
                        <span class="whi-network">${escHtml(r.network)}</span>
                        <span class="whi-addr">${escHtml(r.address)}</span>
                    </div>
                    <div class="whi-date">${new Date(r.created_at).toLocaleString('ru')}</div>
                </div>
            `).join('');
        } catch (e) { console.warn('loadWithdrawals:', e); }
    }

    async function submitWithdrawal() {
        const uid = getTgUid();
        const amount = parseFloat(document.getElementById('withdraw-amount')?.value || 0);
        const network = document.getElementById('withdraw-network')?.value?.trim() || '';
        const address = document.getElementById('withdraw-address')?.value?.trim() || '';
        const btn = document.getElementById('withdraw-submit-btn');

        if (!amount || amount <= 0) { alert('Введите корректную сумму'); return; }
        if (!network) { alert('Выберите сеть'); return; }
        if (!address) { alert('Введите адрес'); return; }

        if (btn) { btn.disabled = true; btn.textContent = 'Отправка…'; }
        try {
            const resp = await fetch('/api/withdrawals/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ uid, amount, currency: 'USDT', network, address }),
            });
            const data = await resp.json();
            if (data.ok) {
                alert(`✅ Заявка на вывод #${data.withdrawal_id} принята!\nОбработка займёт некоторое время.`);
                // Сбросить форму
                if (document.getElementById('withdraw-amount')) document.getElementById('withdraw-amount').value = '';
                if (document.getElementById('withdraw-address')) document.getElementById('withdraw-address').value = '';
                // Обновить баланс и историю
                openDepositOut();
            } else {
                alert(`❌ Ошибка: ${data.error || 'Попробуйте ещё раз'}`);
            }
        } catch (e) {
            alert('❌ Ошибка сети');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = 'Вывести'; }
        }
    }

    function toggleNetworkDropdown() {
        _networkDropdownOpen = !_networkDropdownOpen;
        document.getElementById('network-dropdown').classList.toggle('hidden', !_networkDropdownOpen);
        document.getElementById('network-caret').classList.toggle('open', _networkDropdownOpen);
    }

    function selectNetwork(wallet) {
        _networkDropdownOpen = false;
        document.getElementById('network-dropdown').classList.add('hidden');
        document.getElementById('network-caret').classList.remove('open');
        document.getElementById('selected-network-label').textContent = wallet.id;

        const details = document.getElementById('deposit-in-details');
        details.classList.remove('hidden');
        details.innerHTML = `
            <div class="card deposit-qr-card">
                <img class="deposit-qr-img"
                     src="/api/assets/qr/${escHtml(wallet.qr)}"
                     alt="QR ${escHtml(wallet.id)}"
                     onerror="this.style.opacity='0.2'"/>
                <p class="deposit-qr-warn">Отправьте только ${escHtml(wallet.id)} через выбранную сеть.<br>Любые другие активы будут потеряны.</p>
                <p class="deposit-qr-info">Минимальный депозит — от 300 долларов.<br>Депозит не служит для оплаты сделок.</p>
                <div class="deposit-addr-block">
                    <div class="deposit-addr-label">Адрес кошелька</div>
                    <div class="deposit-addr-wrap">
                        <span class="deposit-addr-text" id="deposit-addr-text">${escHtml(wallet.address)}</span>
                        <button class="deposit-addr-copy" onclick="copyDepositAddr()" title="Копировать">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                                <rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2"/>
                                <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" stroke-width="2"/>
                            </svg>
                        </button>
                    </div>
                </div>
                <div class="deposit-autocheck">
                    <svg class="deposit-autocheck-icon" width="18" height="18" viewBox="0 0 24 24" fill="none">
                        <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
                        <path d="M12 8v4M12 16h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                    </svg>
                    <div class="deposit-autocheck-text">Автопроверка активна.<br>Уведомления о пополнениях приходят автоматически</div>
                </div>
                <button class="btn-dark deposit-check-btn" onclick="checkDepositManual()">Проверить</button>
            </div>
        `;
    }

    function copyDepositAddr() {
        const addr = document.getElementById('deposit-addr-text')?.textContent;
        if (!addr) return;
        if (navigator.clipboard) {
            navigator.clipboard.writeText(addr).then(() => {
                const btn = document.querySelector('.deposit-addr-copy');
                if (btn) {
                    btn.style.color = 'var(--accent-bright)';
                    setTimeout(() => { btn.style.color = ''; }, 1500);
                }
            }).catch(() => {});
        }
    }

    async function checkDepositManual() {
        const btn = document.querySelector('.deposit-check-btn');
        if (btn) { btn.disabled = true; btn.textContent = 'Проверяем...'; }
        const uid = getTgUid();
        const res = await apiGet(`/api/deposits/check?uid=${uid}`);
        if (btn) { btn.disabled = false; btn.textContent = 'Проверить'; }
        const msg = res?.credited ? `Зачислено: +${res.credited} USDT` : (рестатус || 'Новых пополнений не найдено');
        if (tg?.showAlert) tg.showAlert(msg); else alert(msg);
    }

// ── User tap ──────────────────────────────────────────────────────────────
function openUser(id) {
    openUserProfile(id);
}

async function openUserProfile(id) {
    const data = await apiGet(`/api/users/${id}`);
    if (!data || data.error) {
        if (tg?.showAlert) tg.showAlert('Профиль пользователя не найден');
        else alert('Профиль пользователя не найден');
        return;
    }
    _viewedUser = data;
    renderViewedProfile(data);
    openSubpage('user-profile');
}

function renderViewedProfile(data) {
    const char = (data.first_name || data.username || '?')[0].toUpperCase();
    document.getElementById('view-profile-cover-char').textContent = char;
    const userId = data.telegram_id ?? data.id ?? data.uid;
    document.getElementById('view-profile-avatar').innerHTML = '';
    document.getElementById('view-profile-name').textContent = data.first_name || data.username || 'Аноним';
    document.getElementById('view-profile-username').textContent = data.username ? `@${data.username}` : '';
    const _vpid = document.getElementById('view-profile-tgid');
    if (_vpid) _vpid.textContent = userId ? `ID: ${userId}` : '';

    const statusMap = { admin: 'Администратор', arbiter: 'Арбитр', moderator: 'Модератор', user: 'Пользователь' };
    document.getElementById('view-profile-status').textContent = statusMap[data.status] || 'Пользователь';
    document.getElementById('view-profile-desc').textContent = data.description || 'Нет описания';

    const rating = data.rating_count > 0 ? (Number(data.rating_sum || 0) / Number(data.rating_count || 1)).toFixed(1) : '0';
    const viewStarSvg = Number(rating) > 0
        ? '<svg class="rating-star" width="15" height="14" viewBox="0 0 17 16" fill="none"><path d="M8.49993 1.33398C8.76619 1.33398 9.00692 1.49242 9.11223 1.73697L10.7582 5.55907L14.9019 5.94339C15.167 5.96798 15.3921 6.14796 15.4743 6.40119C15.5566 6.65442 15.4803 6.93233 15.2803 7.10806L12.1539 9.85456L13.0689 13.9142C13.1274 14.1739 13.0258 14.4436 12.8104 14.6001C12.5949 14.7566 12.3071 14.7699 12.0781 14.634L8.49993 12.5093L4.92173 14.634C4.69279 14.7699 4.40491 14.7566 4.1895 14.6001C3.97409 14.4436 3.87247 14.1739 3.93101 13.9142L4.84597 9.85456L1.71956 7.10806C1.51953 6.93233 1.44324 6.65442 1.52551 6.40119C1.60779 6.14796 1.83286 5.96798 2.09799 5.94339L6.24166 5.55907L7.88763 1.73697C7.99294 1.49242 8.23367 1.33398 8.49993 1.33398Z" fill="#FEE600"/></svg>'
        : '<svg class="rating-star" width="15" height="14" viewBox="0 0 19 18" fill="none"><path fill-rule="evenodd" clip-rule="evenodd" d="M9.75 1.5C10.0495 1.5 10.3204 1.67824 10.4388 1.95335L12.2906 6.25322L16.9522 6.68558C17.2505 6.71324 17.5037 6.91573 17.5962 7.20061C17.6888 7.48549 17.603 7.79813 17.3779 7.99583L13.8607 11.0856L14.89 15.6527C14.9559 15.9449 14.8416 16.2483 14.5992 16.4244C14.3569 16.6005 14.033 16.6154 13.7755 16.4625L9.75 14.0723L5.72453 16.4625C5.46697 16.6154 5.14311 16.6005 4.90077 16.4244C4.65844 16.2483 4.5441 15.9449 4.60996 15.6527L5.63929 11.0856L2.12209 7.99583C1.89705 7.79813 1.81122 7.48549 1.90378 7.20061C1.99635 6.91573 2.24955 6.71324 2.54781 6.68558L7.20944 6.25322L9.06116 1.95335C9.17964 1.67824 9.45046 1.5 9.75 1.5ZM9.75 4.1462L8.41098 7.25554C8.3024 7.50767 8.06475 7.68033 7.7914 7.70569L4.42047 8.01833L6.96385 10.2527C7.17008 10.4338 7.26086 10.7132 7.2005 10.981L6.45617 14.2836L9.36708 12.5551C9.60312 12.415 9.89688 12.415 10.1329 12.5551L13.0438 14.2836L12.2995 10.981C12.2391 10.7132 12.3299 10.4338 12.5362 10.2527L15.0795 8.01833L11.7086 7.70569C11.4353 7.68033 11.1976 7.50767 11.089 7.25554L9.75 4.1462Z" fill="#FEE600"/></svg>';
    document.getElementById('view-profile-rating').innerHTML = `${viewStarSvg} ${rating}`;
    document.getElementById('view-profile-deposit').textContent = data.deposit > 0 ? `$${Math.round(Number(data.deposit)).toLocaleString('ru-RU')}` : '0';
    document.getElementById('view-profile-deals').textContent = data.total_deals || 0;
    document.getElementById('view-profile-sum').textContent = data.total_sum > 0 ? `$${Math.round(Number(data.total_sum)).toLocaleString('ru-RU')}` : '$0';
    document.getElementById('view-profile-services-cnt').textContent = data.services_count || 0;
    document.getElementById('view-profile-rev-cnt').textContent = data.reviews_count || 0;

    switchViewedProfileTab(document.querySelector('#page-user-profile .tabs .tab.active') || document.querySelector('#page-user-profile .tabs .tab'), 'services');
}

function switchViewedProfileTab(btn, tab) {
    document.querySelectorAll('#page-user-profile .tabs .tab').forEach(t => t.classList.remove('active'));
    if (btn) btn.classList.add('active');
    const content = document.getElementById('view-profile-content');
    if (tab === 'reviews') {
        content.innerHTML = `<div class="empty-card"><p class="empty-title">Нет отзывов</p><p class="empty-sub">Отзывы о пользователе появятся после сделок</p></div>`;
    } else {
        content.innerHTML = `<div class="empty-card"><p class="empty-title">Услуги отсутствуют</p><p class="empty-sub">Пользователь пока не добавил услуги</p></div>`;
    }
}

function goBackToSearch() {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const page = document.getElementById('page-search');
    page.classList.add('active');
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    const searchBtn = document.querySelector('.bottom-nav .nav-btn');
    if (searchBtn) searchBtn.classList.add('active');
    document.querySelector('.app-main').scrollTop = 0;
}

function openViewedUserTelegram() {
    const username = _viewedUser?.username || '';
    if (!username) {
        if (tg?.showAlert) tg.showAlert('У пользователя не указан username');
        else alert('У пользователя не указан username');
        return;
    }
    if (tg?.openTelegramLink) tg.openTelegramLink(`https://t.me/${username}`);
    else window.open(`https://t.me/${username}`, '_blank');
}

function openDealInDev() {
    const msg = 'Функция находится в разработке';
    if (tg?.showAlert) tg.showAlert(msg);
    else alert(msg);
}

function openDealPage() {
    if (!_viewedUser) {
        const msg = 'Сначала откройте профиль пользователя';
        if (tg?.showAlert) tg.showAlert(msg);
        else alert(msg);
        return;
    }
    openSubpage('deal-create');

    const uname = _viewedUser.username ? `@${_viewedUser.username}` : '@user';
    const targetEl = document.getElementById('deal-target-username');
    if (targetEl) targetEl.textContent = uname;

    const titleInput = document.getElementById('deal-title-input');
    const termsInput = document.getElementById('deal-terms-input');
    const currency = document.getElementById('deal-currency');
    const amount = document.getElementById('deal-amount');
    const role = document.getElementById('deal-role');

    if (titleInput) titleInput.value = '';
    if (termsInput) termsInput.value = '';
    if (currency) currency.value = 'TRX';
    if (amount) amount.value = '0';
    if (role) role.value = 'buyer';

    onDealCurrencyChange();
    updateDealCreateCounters();
}

function goBackFromDealCreate() {
    openSubpage('user-profile');
}

function updateDealCreateCounters() {
    const title = document.getElementById('deal-title-input')?.value || '';
    const terms = document.getElementById('deal-terms-input')?.value || '';
    const titleCounter = document.getElementById('deal-title-counter');
    const termsCounter = document.getElementById('deal-terms-counter');
    if (titleCounter) titleCounter.textContent = `${title.length}/52`;
    if (termsCounter) termsCounter.textContent = `${terms.length}/6400`;
}

function onDealCurrencyChange() {
    const selected = document.getElementById('deal-currency')?.value || 'BTC';
    const amountCurrency = document.getElementById('deal-amount-currency');
    if (amountCurrency) amountCurrency.textContent = selected || 'BTC';
}

async function submitDealCreate() {
    const title = (document.getElementById('deal-title-input')?.value || '').trim();
    const currency = document.getElementById('deal-currency')?.value || '';
    const amount = Number(document.getElementById('deal-amount')?.value || '0');
    const terms = (document.getElementById('deal-terms-input')?.value || '').trim();
    const role = document.getElementById('deal-role')?.value || 'buyer';

    if (!title) {
        const msg = 'Введите название сделки';
        if (tg?.showAlert) tg.showAlert(msg); else alert(msg);
        return;
    }
    if (!currency) {
        const msg = 'Выберите валюту';
        if (tg?.showAlert) tg.showAlert(msg); else alert(msg);
        return;
    }
    if (!(amount > 0)) {
        const msg = 'Введите сумму больше 0';
        if (tg?.showAlert) tg.showAlert(msg); else alert(msg);
        return;
    }
    if (!terms) {
        const msg = 'Введите условия сделки';
        if (tg?.showAlert) tg.showAlert(msg); else alert(msg);
        return;
    }

    const myId = getTgUid();
    const viewedId = Number(_viewedUser?.telegram_id || 0);
    if (!myId || !viewedId) {
        const msg = 'Не удалось определить участников сделки';
        if (tg?.showAlert) tg.showAlert(msg); else alert(msg);
        return;
    }

    const buyerId = role === 'buyer' ? myId : viewedId;
    const sellerId = role === 'buyer' ? viewedId : myId;

    try {
        const resp = await fetch('/api/deals/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                buyer_id: buyerId,
                seller_id: sellerId,
                amount,
                currency,
                title,
                terms,
                role,
            }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data?.ok) {
            const msg = data?.error ? `Ошибка: ${data.error}` : 'Не удалось создать сделку';
            if (tg?.showAlert) tg.showAlert(msg); else alert(msg);
            return;
        }

        const msg = `✅ Сделка #${data.deal_id} отправлена на подтверждение второй стороне`;
        if (tg?.showAlert) tg.showAlert(msg); else alert(msg);
        goBackFromDealCreate();
    } catch {
        const msg = 'Ошибка сети при создании сделки';
        if (tg?.showAlert) tg.showAlert(msg); else alert(msg);
    }
}

async function openDealView(dealId) {
    if (!dealId) {
        console.error('❌ openDealView: dealId is missing');
        return;
    }
    
    console.log(`📍 openDealView: Opening deal #${dealId}`);
    
    try {
        const url = `/api/deals/${dealId}`;
        console.log(`🔗 Fetching: ${url}`);
        
        const resp = await fetch(url);
        console.log(`📊 Response status: ${resp.status}`);
        
        const deal = await resp.json().catch(() => null);
        console.log('📦 Response data:', deal);
        
        if (!deal || resp.status === 404) {
            const msg = `Сделка #${dealId} не найдена (статус ${resp.status})`;
            console.error(`❌ ${msg}`);
            if (tg?.showAlert) tg.showAlert(msg); else alert(msg);
            return;
        }

        // Load wallets for payment
        _currentWallets = await apiGet('/api/wallets') || [];
        
        console.log('✅ Deal loaded, rendering...');
        renderDealView(deal, _currentWallets);
        openSubpage('deal-view');
    } catch (e) {
        const msg = `Ошибка при загрузке сделки: ${e.message}`;
        console.error(`❌ ${msg}`, e);
        if (tg?.showAlert) tg.showAlert(msg); else alert(msg);
    }
}

function renderDealView(deal, wallets = []) {
    const myId = getTgUid();
    const isCurrentUserBuyer = Number(deal.buyer_id) === Number(myId);

    // Always show deal details first; payment page opens via "Оплатить" button
    document.getElementById('deal-payment-mode').classList.add('hidden');
    document.getElementById('deal-details-mode').classList.remove('hidden');
    renderDealDetailsPage(deal, isCurrentUserBuyer);
}

function renderDealPaymentPage(deal, wallets) {
    // Для USDT приоритет: TRC20 > ERC20 > BEP20
    let wallet = wallets.find(w => w.id === deal.currency);
    if (!wallet && deal.currency === 'USDT') {
        wallet = wallets.find(w => w.id === 'USDT TRC20')
               || wallets.find(w => w.id === 'USDT ERC20')
               || wallets.find(w => w.id === 'USDT BEP20')
               || wallets.find(w => w.id.startsWith('USDT'));
    }
    if (!wallet) wallet = wallets.find(w => w.id.startsWith(deal.currency));
    const qrUrl = wallet ? `/api/assets/qr/${wallet.qr}` : null;
    // Sanitize address for use in inline onclick (no single-quotes)
    const address = wallet ? wallet.address : null;
    const addrSafe = address ? address.replace(/'/g, '') : null;

    const payMode = document.getElementById('deal-payment-mode');
    document.getElementById('deal-details-mode')?.classList.add('hidden');
    payMode.classList.remove('hidden');
    payMode.innerHTML = `
        <div class="payment-page-header">Оплата сделки</div>

        <div class="card payment-info-card">
            <div class="payment-info-title">${escHtml(deal.title || 'Сделка #' + deal.id)}</div>
            <div class="payment-info-amount">Сумма к оплате: <strong>${parseFloat(deal.amount).toFixed(2)} ${escHtml(deal.currency)}</strong></div>
            <div class="payment-info-usd">≈${deal.usd_amount || 0} $</div>
        </div>

        <div class="card payment-qr-card">
            ${qrUrl
                ? `<img src="${qrUrl}" class="payment-qr-img" alt="QR">`
                : `<div class="payment-qr-missing">QR недоступен для ${escHtml(deal.currency)}</div>`}
            <p class="payment-qr-hint">Отсканируйте QR код для автоматической оплаты.<br>Отправьте только ${escHtml(deal.currency)} через выбранную сеть.</p>
        </div>

        <div class="card payment-address-card">
            <div class="payment-address-label">Адрес для оплаты</div>
            <div class="payment-address-box">
                <div class="payment-address-text">${addrSafe || '—'}</div>
                ${addrSafe ? `<button class="payment-copy-btn" id="pay-copy-btn" onclick="copyPaymentAddress('${addrSafe}',this)">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="9" y="9" width="13" height="13" rx="2"/>
                        <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke-linecap="round"/>
                    </svg>
                </button>` : ''}
            </div>
        </div>

        <div class="payment-autocheck-block">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style="color:#6b7280;flex-shrink:0;margin-top:1px"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>
            <span>Автопроверка активна. После поступления средств статус сделки изменится автоматически. Используйте кнопку «Проверить» для принудительного обновления.</span>
        </div>

        <button class="btn-gray payment-check-btn" id="pay-check-btn" onclick="checkDealPayment(${deal.id})">Проверить</button>
    `;
}

function renderDealDetailsPage(deal, isCurrentUserBuyer = false) {
    // Toggle modes
    const payMode = document.getElementById('deal-payment-mode');
    const detailsMode = document.getElementById('deal-details-mode');
    if (payMode) payMode.classList.add('hidden');
    if (detailsMode) detailsMode.classList.remove('hidden');
    
    // Parse date
    const dateStr = deal.created_at ? new Date(deal.created_at).toLocaleDateString('ru-RU') : '—';
    
    // Status text mapping
    // For awaiting_payment: if deal was created by buyer (role='buyer') → seller confirmed;
    // if created by seller (role='seller') → buyer confirmed
    const confirmedLabel = deal.role === 'seller'
        ? 'Подтверждена покупателем'
        : 'Подтверждена продавцом';
    const statusMap = {
        'pending': 'Ожидание подтверждения',
        'awaiting_payment': confirmedLabel,
        'paid': 'Оплачено',
        'completed': 'Завершено',
        'rejected': 'Отклонено',
    };
    
    const paymentStatusMap = {
        'new': 'Ожидает оплаты покупателем',
        'awaiting': 'Ожидает оплаты покупателем',
        'checking': 'Проверяется администратором',
        'paid': 'Оплачено',
        'rejected': 'Отклонено',
    };
    
    const dealStatus = statusMap[deal.status] || deal.status;
    const isCompletedDeal = deal.status === 'completed' || deal.status === 'paid';
    
    // Update page
    document.getElementById('deal-view-id').textContent = deal.id;
    document.getElementById('deal-view-date').textContent = dateStr;
    document.getElementById('deal-view-username').textContent = deal.title || `Сделка #${deal.id}`;
    
    // Amount
    const amountDisplay = `${deal.amount.toFixed(2)} ${deal.currency}`;
    document.getElementById('deal-view-amount').textContent = amountDisplay;
    document.getElementById('deal-view-amount-usd').textContent = `≈${deal.usd_amount}$`;
    const completeBadge = document.getElementById('deal-view-complete-badge');
    const completeBadgeText = document.getElementById('deal-view-complete-badge-text');
    if (completeBadge) completeBadge.classList.toggle('hidden', !isCompletedDeal);
    if (completeBadgeText) completeBadgeText.textContent = deal.status === 'paid' ? 'Сделка оплачена' : 'Сделка завершена';
    if (detailsMode) detailsMode.classList.toggle('deal-view-completed', isCompletedDeal);
    
    // Status
    document.getElementById('deal-view-deal-status').textContent = dealStatus;
    const rawPaymentStatus = deal.payment_status || 'new';
    document.getElementById('deal-view-payment-status').textContent = paymentStatusMap[rawPaymentStatus] || 'В ожидании оплаты';
    
    // Terms
    document.getElementById('deal-view-terms').textContent = deal.terms;
    
    // Seller info
    const seller = deal.seller;
    const sellerAv = document.getElementById('deal-view-seller-avatar');
    if (sellerAv) {
        sellerAv.innerHTML = `<img src="/api/assets/tg-avatar/${seller.telegram_id}" alt="" onerror="this.onerror=null;this.src='/api/assets/no-avatar-small';" />`;
    }
    document.getElementById('deal-view-seller-name').textContent = 'Продавец';
    document.getElementById('deal-view-seller-username').textContent = seller.username ? (seller.username.startsWith('@') ? seller.username : `@${seller.username}`) : (seller.first_name || '—');
    const avgRatingSeller = seller.rating_count > 0 ? (seller.rating_sum / seller.rating_count).toFixed(1) : '0';
    document.getElementById('deal-view-seller-rating').textContent = avgRatingSeller;
    document.getElementById('deal-view-seller-deposit').textContent = `$${seller.deposit || 0}`;

    // Buyer info
    const buyer = deal.buyer;
    const buyerAv = document.getElementById('deal-view-buyer-avatar');
    if (buyerAv) {
        buyerAv.innerHTML = `<img src="/api/assets/tg-avatar/${buyer.telegram_id}" alt="" onerror="this.onerror=null;this.src='/api/assets/no-avatar-small';" />`;
    }
    document.getElementById('deal-view-buyer-name').textContent = 'Покупатель';
    document.getElementById('deal-view-buyer-username').textContent = buyer.username ? (buyer.username.startsWith('@') ? buyer.username : `@${buyer.username}`) : (buyer.first_name || '—');
    const avgRatingBuyer = buyer.rating_count > 0 ? (buyer.rating_sum / buyer.rating_count).toFixed(1) : '0';
    document.getElementById('deal-view-buyer-rating').textContent = avgRatingBuyer;
    document.getElementById('deal-view-buyer-deposit').textContent = `$${buyer.deposit || 0}`;
    
    // Update action button based on state
    const actionBtn = document.getElementById('deal-view-action-btn');
    if (actionBtn) actionBtn.style.display = '';
    if (isCompletedDeal) {
        actionBtn.disabled = true;
        actionBtn.textContent = 'Завершена';
        actionBtn.onclick = null;
        return;
    }
    if (deal.status === 'awaiting_payment' && isCurrentUserBuyer) {
        actionBtn.disabled = false;
        actionBtn.textContent = 'Оплатить';
        actionBtn.onclick = () => renderDealPaymentPage(deal, _currentWallets);
    } else if (deal.status === 'awaiting_payment' && !isCurrentUserBuyer) {
        actionBtn.style.display = 'none';
    } else if (deal.status === 'pending') {
        actionBtn.style.display = 'none';
    } else if (deal.status === 'in_progress' && isCurrentUserBuyer) {
        actionBtn.disabled = false;
        actionBtn.textContent = '✅ Подтвердить получение';
        actionBtn.onclick = () => confirmDealCompletion(deal.id);
    } else if (deal.status === 'in_progress' && !isCurrentUserBuyer) {
        actionBtn.disabled = true;
        actionBtn.textContent = '⏳ Ожидание подтверждения покупателя';
        actionBtn.onclick = null;
    } else if (deal.status === 'cancelled' || deal.status === 'rejected') {
        actionBtn.disabled = true;
        actionBtn.textContent = '❌ Отменена';
        actionBtn.onclick = null;
    } else {
        actionBtn.disabled = true;
        actionBtn.textContent = deal.status || '—';
        actionBtn.onclick = null;
    }
}

function copyPaymentAddress(address, btn) {
    navigator.clipboard?.writeText(address).then(() => {
        btn.classList.add('copied');
        setTimeout(() => btn.classList.remove('copied'), 2000);
    });
}

async function confirmDealCompletion(dealId) {
    if (!dealId) return;
    const uid = getTgUid();
    const btn = document.getElementById('deal-view-action-btn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Отправка…'; }
    try {
        const resp = await fetch(`/api/deals/${dealId}/buyer_confirm`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uid }),
        });
        const data = await resp.json();
        if (data.ok) {
            if (btn) { btn.textContent = '✅ Завершена'; }
            alert('✅ Сделка завершена! Продавец получил оплату.');
            openDealView(dealId);
        } else {
            if (btn) { btn.disabled = false; btn.textContent = '✅ Подтвердить получение'; }
            alert(`❌ Ошибка: ${data.error || 'Попробуйте ещё раз'}`);
        }
    } catch (e) {
        if (btn) { btn.disabled = false; btn.textContent = '✅ Подтвердить получение'; }
        alert('❌ Ошибка сети');
    }
}

async function checkDealPayment(dealId) {
    
    try {
        // Notify admin
        const uid = getTgUid();
        const resp = await fetch(`/api/deals/${dealId}/check`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uid }),
        });

        let result = {};
        try { result = await resp.json(); } catch(_) {}

        if (!resp.ok) {
            const errText = result.error || `HTTP ${resp.status}`;
            console.error('❌ check error:', resp.status, result);
            const msg = `Ошибка: ${errText}`;
            if (tg?.showAlert) tg.showAlert(msg); else alert(msg);
            return;
        }

        const msg = '✅ Запрос отправлен. Администраторы проверят оплату в течение нескольких минут.';
        if (tg?.showAlert) tg.showAlert(msg); else alert(msg);
        // Деактивировать кнопку чтобы не отправляли повторно
        const btn = document.getElementById('pay-check-btn') || document.getElementById('deal-view-action-btn');
        if (btn) { btn.textContent = '✅ Запрос отправлен'; btn.disabled = true; }
    } catch (e) {
        const msg = `Ошибка: ${e.message}`;
        console.error(msg, e);
        if (tg?.showAlert) tg.showAlert(msg); else alert(msg);
    }
}

function goBackFromDealView() {
    const payMode = document.getElementById('deal-payment-mode');
    // If payment page is open — go back to deal details, not to deals list
    if (payMode && !payMode.classList.contains('hidden')) {
        payMode.classList.add('hidden');
        document.getElementById('deal-details-mode').classList.remove('hidden');
        return;
    }
    openSubpage('deals');
}

function handleDealAction() {
    const msg = 'Функция находится в разработке';
    if (tg?.showAlert) tg.showAlert(msg); else alert(msg);
}

function openSettingsPage() {
    openSubpage('settings');
    const hide = localStorage.getItem(KEY_PROFILE_HIDDEN) === 'true';
    const toggle = document.getElementById('settings-hide-profile');
    if (toggle) toggle.checked = hide;
    // Загрузить текущее описание через fetch (apiGet недоступна снаружи DOMContentLoaded)
    const uid = getTgUid();
    if (uid) {
        fetch(`/api/me?uid=${uid}&_t=${Date.now()}`, { cache: 'no-store' })
            .then(r => r.json())
            .then(data => {
                const ta = document.getElementById('settings-desc');
                if (ta && data && !data.error) ta.value = data.description || '';
            })
            .catch(() => {});
    }
}

async function saveDescription() {
    const uid = getTgUid();
    if (!uid) {
        alert('Ошибка: не удалось определить ID пользователя');
        return;
    }
    const ta = document.getElementById('settings-desc');
    const desc = (ta?.value || '').trim();
    try {
        const res = await fetch(`/api/me/description?uid=${uid}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ description: desc }),
        });
        const data = await res.json();
        if (data && data.ok) {
            const el = document.getElementById('profile-desc');
            if (el) el.textContent = desc || 'Нет описания';
            if (tg?.showAlert) tg.showAlert('Описание сохранено');
            else alert('Описание сохранено');
        } else {
            alert('Ошибка сервера: ' + JSON.stringify(data));
        }
    } catch (e) {
        alert('Ошибка запроса: ' + e.message);
    }
}

function toggleProfileHidden(isHidden) {
    localStorage.setItem(KEY_PROFILE_HIDDEN, isHidden ? 'true' : 'false');
}

function startPinChange() {
    pinBuffer = '';
    setupDraftPin = '';
    pinMode = 'setup';
    updatePinTexts();
    updateDots();
    document.getElementById('pin-error').classList.add('hidden');
    document.getElementById('pin-lockout').classList.add('hidden');
    showScreen('pin-screen');
}

function showForumsInDev() {
    const msg = 'Функция находится в разработке';
    if (tg?.showAlert) tg.showAlert(msg);
    else alert(msg);
}

// ── Helpers ───────────────────────────────────────────────────────────────
function escHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ══════════════════════════════════════════════════════════════════════════════
// ADMIN PANEL
// ══════════════════════════════════════════════════════════════════════════════

let _adminUsersPage = 1;
let _adminDealsPage = 1;
let _adminDealsFilter = '';
let _adminEditUid = null;

function adminTab(tab, btn) {
    document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.admin-tab-content').forEach(c => c.classList.add('hidden'));
    btn.classList.add('active');
    document.getElementById(`admin-tab-${tab}`).classList.remove('hidden');
    if (tab === 'stats') loadAdminStats();
    if (tab === 'users') { _adminUsersPage = 1; loadAdminUsers(); }
    if (tab === 'deals') { _adminDealsPage = 1; loadAdminDeals(); }
}

async function loadAdminStats() {
    const uid = getTgUid();
    const data = await apiGet(`/api/admin/stats?uid=${uid}`);
    if (!data || data.error) return;
    document.getElementById('ast-users').textContent = data.total_users;
    document.getElementById('ast-deals').textContent = data.total_deals;
    document.getElementById('ast-completed').textContent = data.completed_deals;
    document.getElementById('ast-pending').textContent = data.pending_deals + data.awaiting_deals;
    document.getElementById('ast-new-users').textContent = data.new_users_today;
    document.getElementById('ast-new-deals').textContent = data.new_deals_today;

    // Rates
    const rates = await apiGet('/api/rates');
    if (rates) {
        const grid = document.getElementById('admin-rates-grid');
        grid.innerHTML = Object.entries(rates).map(([sym, val]) =>
            `<div class="admin-rate-item">
                <div class="admin-rate-sym">${escHtml(sym)}</div>
                <div class="admin-rate-val">$${parseFloat(val).toFixed(sym === 'BTC' ? 0 : sym === 'ETH' || sym === 'BNB' ? 0 : 4)}</div>
            </div>`
        ).join('');
    }
}

async function adminRefreshRates() {
    const uid = getTgUid();
    const data = await apiGet(`/api/admin/rates/refresh?uid=${uid}`);
    if (data?.ok) {
        const grid = document.getElementById('admin-rates-grid');
        if (grid && data.rates) {
            grid.innerHTML = Object.entries(data.rates).map(([sym, val]) =>
                `<div class="admin-rate-item">
                    <div class="admin-rate-sym">${escHtml(sym)}</div>
                    <div class="admin-rate-val">$${parseFloat(val).toFixed(sym === 'BTC' ? 0 : sym === 'ETH' || sym === 'BNB' ? 0 : 4)}</div>
                </div>`
            ).join('');
        }
    }
}

let _adminUserSearchTimer = null;
function adminSearchUsers() {
    clearTimeout(_adminUserSearchTimer);
    _adminUserSearchTimer = setTimeout(() => {
        _adminUsersPage = 1;
        loadAdminUsers();
    }, 350);
}

async function loadAdminUsers(page = _adminUsersPage) {
    _adminUsersPage = page;
    const uid = getTgUid();
    const q = (document.getElementById('admin-user-search')?.value || '').trim();
    const data = await apiGet(`/api/admin/users?uid=${uid}&q=${encodeURIComponent(q)}&page=${page}`);
    const container = document.getElementById('admin-users-list');
    const pagination = document.getElementById('admin-users-pagination');
    if (!data || data.error) {
        container.innerHTML = '<div style="color:var(--subtext);font-size:13px;padding:16px 0">Нет доступа или ошибка загрузки</div>';
        return;
    }
    if (!data.users?.length) {
        container.innerHTML = '<div style="color:var(--subtext);font-size:13px;padding:16px 0">Пользователи не найдены</div>';
        pagination.innerHTML = '';
        return;
    }
    container.innerHTML = data.users.map(u => {
        const char = (u.first_name || u.username || '?')[0].toUpperCase();
        const name = escHtml(u.first_name || u.username || 'Без имени');
        const uname = u.username ? `@${escHtml(u.username)}` : `ID:${u.telegram_id}`;
        const badgeCls = `badge-${u.status || 'user'}`;
        const rating = u.rating_count > 0 ? (u.rating_sum / u.rating_count).toFixed(1) : '0';
        return `
        <div class="admin-user-row" onclick="openAdminUser(${u.telegram_id})">
            <div class="admin-user-av">${char}</div>
            <div class="admin-user-info">
                <div class="admin-user-name">${name}</div>
                <div class="admin-user-sub">${uname} · ☆${rating} · ${u.completed_deals||0} сделок · $${parseFloat(u.deposit||0).toFixed(0)}</div>
            </div>
            <span class="admin-user-badge ${badgeCls}">${u.status||'user'}</span>
        </div>`;
    }).join('');

    // Pagination
    const totalPages = Math.ceil(data.total / data.per_page);
    pagination.innerHTML = `
        <button class="admin-page-btn" onclick="loadAdminUsers(${page-1})" ${page<=1?'disabled':''}>◀</button>
        <span style="font-size:12px;color:var(--subtext);align-self:center">${page}/${totalPages||1}</span>
        <button class="admin-page-btn" onclick="loadAdminUsers(${page+1})" ${page>=totalPages?'disabled':''}>▶</button>
    `;
}

async function openAdminUser(targetUid) {
    const uid = getTgUid();
    const data = await apiGet(`/api/admin/users/${targetUid}?uid=${uid}`);
    if (!data || data.error) return;
    _adminEditUid = targetUid;
    const uname = data.username ? `@${data.username}` : `ID:${targetUid}`;
    document.getElementById('admin-modal-username').textContent = `${data.first_name || ''} ${uname} · сделок: ${data.completed_deals||0} · отзывов: ${data.reviews_count||0}`;
    document.getElementById('amod-deposit').value = parseFloat(data.deposit || 0).toFixed(2);
    document.getElementById('amod-rating-sum').value = parseFloat(data.rating_sum || 0).toFixed(1);
    document.getElementById('amod-rating-count').value = parseInt(data.rating_count || 0);
    document.getElementById('amod-add-deals').value = 0;
    document.getElementById('amod-status').value = data.status || 'user';
    document.getElementById('admin-user-modal').classList.remove('hidden');
}

function closeAdminModal() {
    document.getElementById('admin-user-modal').classList.add('hidden');
    _adminEditUid = null;
}

async function saveAdminUser() {
    if (!_adminEditUid) return;
    const uid = getTgUid();
    const payload = {
        deposit: parseFloat(document.getElementById('amod-deposit').value) || 0,
        rating_sum: parseFloat(document.getElementById('amod-rating-sum').value) || 0,
        rating_count: parseInt(document.getElementById('amod-rating-count').value) || 0,
        status: document.getElementById('amod-status').value,
        add_completed_deals: parseInt(document.getElementById('amod-add-deals').value) || 0,
    };
    try {
        const resp = await fetch(`/api/admin/users/${_adminEditUid}?uid=${uid}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const result = await resp.json();
        if (result.ok) {
            closeAdminModal();
            loadAdminUsers(_adminUsersPage);
        } else {
            alert('Ошибка: ' + (result.error || 'неизвестная'));
        }
    } catch (e) {
        alert('Ошибка сети: ' + e.message);
    }
}

function adminFilterDeals(status, btn) {
    document.querySelectorAll('.admin-filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    _adminDealsFilter = status;
    _adminDealsPage = 1;
    loadAdminDeals();
}

function openAdminPanel() {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const page = document.getElementById('page-admin');
    page.classList.add('active');
    loadAdminStats();
}

async function loadAdminDeals(page = _adminDealsPage) {
    _adminDealsPage = page;
    const uid = getTgUid();
    const sf = _adminDealsFilter ? `&status=${_adminDealsFilter}` : '';
    const data = await apiGet(`/api/admin/deals?uid=${uid}&page=${page}${sf}`);
    const container = document.getElementById('admin-deals-list');
    const pagination = document.getElementById('admin-deals-pagination');
    if (!data || data.error) {
        container.innerHTML = '<div style="color:var(--subtext);font-size:13px;padding:16px 0">Нет доступа или ошибка</div>';
        return;
    }
    if (!data.deals?.length) {
        container.innerHTML = '<div style="color:var(--subtext);font-size:13px;padding:16px 0">Сделки не найдены</div>';
        pagination.innerHTML = '';
        return;
    }
    const statusLabels = { pending: 'Ожидает', awaiting_payment: 'На оплате', in_progress: 'В работе', completed: 'Завершена', cancelled: 'Отменена' };
    const statusCls = { pending: 'ds-pending', awaiting_payment: 'ds-awaiting_payment', in_progress: 'ds-in_progress', completed: 'ds-completed', cancelled: 'ds-cancelled' };
    container.innerHTML = data.deals.map(d => {
        const buyer = d.buyer_username ? `@${d.buyer_username}` : (d.buyer_first_name || '—');
        const seller = d.seller_username ? `@${d.seller_username}` : (d.seller_first_name || '—');
        const cls = statusCls[d.status] || 'ds-other';
        return `
        <div class="admin-deal-row">
            <div>
                <div class="admin-deal-id">#${d.id} · ${buyer} → ${seller}</div>
                <div class="admin-deal-title">${escHtml(d.title || 'Без названия')}</div>
            </div>
            <div style="text-align:right;flex-shrink:0">
                <div class="admin-deal-amount">${parseFloat(d.amount||0).toFixed(2)} ${escHtml(d.currency||'')}</div>
                <span class="admin-deal-status ${cls}">${statusLabels[d.status]||d.status}</span>
            </div>
        </div>`;
    }).join('');

    const totalPages = Math.ceil(data.total / data.per_page);
    pagination.innerHTML = `
        <button class="admin-page-btn" onclick="loadAdminDeals(${page-1})" ${page<=1?'disabled':''}>◀</button>
        <span style="font-size:12px;color:var(--subtext);align-self:center">${page}/${totalPages||1}</span>
        <button class="admin-page-btn" onclick="loadAdminDeals(${page+1})" ${page>=totalPages?'disabled':''}>▶</button>
    `;
}

async function adminSendBroadcast() {
    const uid = getTgUid();
    const text = (document.getElementById('admin-broadcast-text')?.value || '').trim();
    const target = document.getElementById('admin-bc-target')?.value || 'all';
    const result = document.getElementById('admin-bc-result');
    if (!text) { result.textContent = '⚠️ Введите текст рассылки'; return; }
    result.textContent = '⏳ Отправка...';
    try {
        const resp = await fetch(`/api/admin/broadcast?uid=${uid}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, target }),
        });
        const data = await resp.json();
        if (data.ok) {
            result.textContent = `✅ Отправлено: ${data.sent}, ошибок: ${data.failed}`;
            document.getElementById('admin-broadcast-text').value = '';
        } else {
            result.textContent = '❌ Ошибка: ' + (data.error || 'неизвестная');
        }
    } catch (e) {
        result.textContent = '❌ Сетевая ошибка: ' + e.message;
    }
}

// Счётчик символов для рассылки
document.addEventListener('DOMContentLoaded', () => {
    const ta = document.getElementById('admin-broadcast-text');
    const counter = document.getElementById('admin-bc-counter');
    if (ta && counter) {
        ta.addEventListener('input', () => { counter.textContent = `${ta.value.length}/4096`; });
    }
});
