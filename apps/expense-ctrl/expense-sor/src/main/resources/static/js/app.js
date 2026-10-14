/* 费控报销 Web UI
 * 认证链路(部署级 SSO_PROVIDER 三选一,见 SSO 设计文档):
 * - supabase 模式:supabase-js 直连 Supabase Auth 登录,access_token 写入本地存储;
 * - oidc 模式(casdoor/customer-oidc):Modal 内嵌 iframe 加载 /api/auth/oidc/authorize
 *   (后端授权代理,授权码 + PKCE S256,popup=iframe),登录成功认证中心 postMessage
 *   code/state 给父页面,前端调 /api/auth/oidc/token 换 id_token;第三方扫码等不发
 *   postMessage 的路径由 iframe onLoad 兜底读回环地址提取。
 * 所有 /api 调用带 Authorization: Bearer <token>,由 SOR 端 JWKS 验签(ES256/RS256);
 * oidc 模式 401 时先尝试 refresh_token 刷新并重放一次,失败才要求重新登录。
 * 人工审批写入的幂等键:processInstanceId = "manual-ui-<reportId>",activityId = "manual-ui"
 * (数据库唯一约束为 (process_instance_id, activity_id, approver_id),不带 report_id,
 *  因此 pid 必须带上单据 id,否则同一审批人全库只能写一条审批记录)。
 */
(function () {
  'use strict';

  const { createApp, reactive, computed, ref, watch } = Vue;

  const STATUSES = ['opened', 'ongoing', 'approved', 'paid', 'rejected', 'cancelled'];
  const STATUS_TEXT = {
    opened: '待审批', ongoing: '审批中', approved: '已批准',
    paid: '已支付', rejected: '已拒绝', cancelled: '已撤回'
  };
  const CATEGORIES = ['交通', '住宿', '餐饮', '办公', '其他'];
  const AMOUNT_RE = /^\d{1,10}(\.\d{1,2})?$/;

  // ---------- token 存储 key ----------
  const TOKEN_KEY = 'expense.sor.token';
  const REFRESH_KEY = 'expense.sor.refresh';
  const OIDC_VERIFIER_KEY = 'expense.sor.oidc.verifier';
  const OIDC_STATE_KEY = 'expense.sor.oidc.state';

  function readToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
  function writeToken(token, refreshToken) {
    localStorage.setItem(TOKEN_KEY, token);
    if (refreshToken) localStorage.setItem(REFRESH_KEY, refreshToken);
    else localStorage.removeItem(REFRESH_KEY);
  }
  function clearAuth() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
    sessionStorage.removeItem(OIDC_VERIFIER_KEY);
    sessionStorage.removeItem(OIDC_STATE_KEY);
  }

  // ---------- PKCE 工具(S256) ----------
  function base64urlEncode(buffer) {
    const bytes = new Uint8Array(buffer);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function randomBase64url(len) {
    const bytes = new Uint8Array(len);
    crypto.getRandomValues(bytes);
    return base64urlEncode(bytes.buffer);
  }

  createApp({
    setup() {
      // ---------- 全局状态 ----------
      const booting = ref(true);
      const uiConfig = reactive({
        mode: '',            // 'supabase' | 'oidc'(后端下传,未配置为 '')
        supabaseUrl: '', supabaseAnonKey: '',
        issuer: '', clientId: '', scopes: ''
      });
      const me = ref(null);            // {sub, email, displayName}
      const route = ref('list');
      const detailId = ref(null);
      const toast = ref('');

      let supabase = null;

      const displayName = computed(() => {
        const m = me.value;
        return m ? (m.displayName || m.email || m.sub) : '';
      });

      function showToast(msg) {
        toast.value = msg;
        setTimeout(() => { toast.value = ''; }, 3500);
      }

      // ---------- 路由(hash,免构建) ----------
      function parseHash() {
        const h = (location.hash || '#/list').slice(2);
        if (h.startsWith('detail/')) {
          route.value = 'detail';
          detailId.value = h.slice(7);
          loadDetail();
        } else if (['list', 'create'].includes(h)) {
          route.value = h;
          if (h === 'list') loadList();
        } else {
          route.value = 'list';
          loadList();
        }
      }
      window.addEventListener('hashchange', parseHash);

      // ---------- API 封装(统一信封解包) ----------
      async function api(path, options, retried) {
        const opts = Object.assign({ headers: {} }, options || {});
        const token = readToken();
        if (token) opts.headers['Authorization'] = 'Bearer ' + token;
        if (opts.body && !(opts.body instanceof FormData)) {
          opts.headers['Content-Type'] = 'application/json';
        }
        const res = await fetch(path, opts);
        let payload = null;
        try { payload = await res.json(); } catch (e) { /* 附件等原始响应 */ }
        if (!res.ok || (payload && typeof payload.code === 'number' && payload.code !== 0)) {
          const msg = (payload && payload.message) ? payload.message : ('请求失败(HTTP ' + res.status + ')');
          if (res.status === 401) {
            // oidc 模式:先尝试 refresh_token 刷新并重放一次;失败则要求重新登录
            if (uiConfig.mode === 'oidc' && !retried) {
              const refreshed = await tryOidcRefresh();
              if (refreshed) return api(path, options, true);
            }
            forceRelogin();
          }
          const err = new Error(msg);
          err.payload = payload;
          throw err;
        }
        return payload && typeof payload.code === 'number' ? payload.data : payload;
      }

      function forceRelogin() {
        clearAuth();
        me.value = null;
        loginError.value = '登录已过期,请重新登录';
      }

      // ---------- OIDC 授权码流程(后端代理,前端不直连认证中心) ----------
      function readOidcCallback() {
        const params = new URLSearchParams(location.search);
        const code = params.get('code');
        const state = params.get('state');
        if (!code && !params.get('error')) return null;
        return {
          code: code, state: state,
          error: params.get('error'),
          errorDescription: params.get('error_description')
        };
      }

      // 解析认证中心 iframe 内嵌登录的 postMessage(Casdoor 原生 loginSuccess:
      // {type:"loginSuccess", data:{code,state}})。仅接受 origin 与 issuer 同源且
      // type 匹配的事件;SilentSignin 等其他消息返回 null
      function readOidcLoginSuccessMessage(event) {
        if (!uiConfig.issuer || event.origin !== new URL(uiConfig.issuer).origin) return null;
        const data = event.data;
        if (!data || typeof data !== 'object' || data.type !== 'loginSuccess') return null;
        const inner = data.data || {};
        if (typeof inner.code !== 'string' || typeof inner.state !== 'string') return null;
        return { code: inner.code, state: inner.state };
      }

      // 完成授权码交换:先取先删 sessionStorage 一次性凭据(刷新或重复投递不重放已
      // 用过的 code),校验 state 后经后端代理换令牌并推进登录态;postMessage 与
      // iframe load 兜底两条路径共用
      async function completeOidcLogin(cb) {
        const savedState = sessionStorage.getItem(OIDC_STATE_KEY);
        const verifier = sessionStorage.getItem(OIDC_VERIFIER_KEY);
        sessionStorage.removeItem(OIDC_STATE_KEY);
        sessionStorage.removeItem(OIDC_VERIFIER_KEY);
        if (!savedState || savedState !== cb.state) throw new Error('登录失败:state 校验不通过,请重试');
        if (!verifier) throw new Error('登录失败:会话数据缺失,请重试');
        const res = await fetch('/api/auth/oidc/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: cb.code, codeVerifier: verifier, redirectUri: location.origin + '/' })
        });
        const payload = await res.json().catch(() => null);
        const data = payload && typeof payload.code === 'number' ? payload.data : payload;
        if (!res.ok || !data || !data.token) {
          throw new Error((payload && payload.message) || '登录失败(令牌交换失败)');
        }
        writeToken(data.token, data.refreshToken || '');
        await afterLogin();
      }

      // 整页回环消费:认证中心 302 回本页(URL 带 code&state 或 error)时清 query 并续程
      async function completeOidcCallback() {
        const cb = readOidcCallback();
        if (!cb) return false;
        history.replaceState(null, '', location.pathname + location.hash);
        if (cb.error) {
          sessionStorage.removeItem(OIDC_STATE_KEY);
          sessionStorage.removeItem(OIDC_VERIFIER_KEY);
          throw new Error('登录失败:' + (cb.errorDescription || cb.error));
        }
        await completeOidcLogin(cb);
        return true;
      }

      // ---------- iframe 内嵌登录(Modal) ----------
      const oidcFrameUrl = ref(null);   // 非 null 时弹 Modal 内嵌认证中心登录页
      const oidcFrame = ref(null);      // iframe 引用:onLoad 兜底读其地址提取授权码
      let detachOidcMessage = null;     // message 监听摘除器(Modal 打开期间挂载)

      // Modal 打开期间监听认证中心 loginSuccess 消息,关闭(含登录成败收尾)即摘除
      watch(oidcFrameUrl, (url) => {
        if (url !== null) {
          const onMessage = (event) => {
            const cb = readOidcLoginSuccessMessage(event);
            if (cb) handleOidcCode(cb);
          };
          window.addEventListener('message', onMessage);
          detachOidcMessage = () => window.removeEventListener('message', onMessage);
        } else if (detachOidcMessage) {
          detachOidcMessage();
          detachOidcMessage = null;
        }
      });

      // 打开 Modal 发起授权:不在本页 fetch 认证中心(客户 IdP CORS 无保证),授权
      // 经后端代理 302;popup=iframe 使认证中心登录成功不 302 而是 postMessage code/state
      async function openOidcFrame() {
        loginError.value = '';
        const verifier = randomBase64url(32);
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
        const challenge = base64urlEncode(digest);
        const state = randomBase64url(16);
        sessionStorage.setItem(OIDC_VERIFIER_KEY, verifier);
        sessionStorage.setItem(OIDC_STATE_KEY, state);
        const q = new URLSearchParams({
          redirect_uri: location.origin + '/',
          code_challenge: challenge,
          state: state,
          popup: 'iframe'
        });
        oidcFrameUrl.value = '/api/auth/oidc/authorize?' + q.toString();
      }

      function closeOidcFrame() {
        oidcFrameUrl.value = null;
      }

      // 拿到授权码后的公共续程:换令牌推进登录态,成功收起 Modal,失败展示错误并收起
      function handleOidcCode(cb) {
        completeOidcLogin(cb).then(() => {
          oidcFrameUrl.value = null;
        }).catch((e) => {
          loginError.value = e.message;
          oidcFrameUrl.value = null;
        });
      }

      // iframe load 兜底:账号密码路径认证中心会 postMessage(走 message 监听),但
      // 钉钉等第三方 Provider 扫码路径拿到 code 后直接把 iframe 导航到 redirect_uri、
      // 不发消息。导航回本站后与父页面同源,读其地址提取 code/state;仍停在认证中心
      // (跨源)或加载失败页时读取抛 SecurityError,静默等下一跳。load 派发早于 iframe
      // 内 SPA 的 boot() 网络往返(回环消费已挪到 ui-config 拉取之后),sessionStorage
      // 一次性凭据由本页先取先删
      function onFrameLoad() {
        const frame = oidcFrame.value;
        if (!frame) return;
        let href;
        try {
          href = frame.contentWindow.location.href;
        } catch (e) {
          return;   // 跨源:iframe 仍在认证中心域名,静默等下一跳
        }
        const params = new URLSearchParams(new URL(href, location.origin).search);
        const code = params.get('code');
        const state = params.get('state');
        if (code && state) handleOidcCode({ code: code, state: state });
      }

      async function tryOidcRefresh() {
        const refreshToken = localStorage.getItem(REFRESH_KEY);
        if (!refreshToken) return false;
        try {
          const res = await fetch('/api/auth/oidc/refresh', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken: refreshToken })
          });
          if (!res.ok) return false;
          const payload = await res.json().catch(() => null);
          const data = payload && typeof payload.code === 'number' ? payload.data : payload;
          if (!data || !data.token) return false;
          writeToken(data.token, data.refreshToken || refreshToken);
          return true;
        } catch (e) {
          return false;
        }
      }

      // ---------- 登录/登出 ----------
      const loginForm = reactive({ email: '', password: '' });
      const loggingIn = ref(false);
      const loginError = ref('');

      // 仅 supabase 模式使用(oidc 模式走 startOidcAuthorize 整页跳转)
      async function login() {
        loginError.value = '';
        loggingIn.value = true;
        try {
          const { error } = await supabase.auth.signInWithPassword({
            email: loginForm.email, password: loginForm.password
          });
          if (error) throw new Error(error.message);
          await afterLogin();           // onAuthStateChange 也会触发,双保险不冲突
          loginForm.password = '';
        } catch (e) {
          loginError.value = '登录失败:' + e.message;
        } finally {
          loggingIn.value = false;
        }
      }

      async function logout() {
        if (uiConfig.mode !== 'oidc') {
          try { await supabase.auth.signOut(); } catch (e) { /* 忽略 */ }
        }
        clearAuth();
        me.value = null;
        location.hash = '#/list';
      }

      async function afterLogin() {
        const data = await api('/api/me');
        me.value = data;
        parseHash();
      }

      // ---------- 列表 ----------
      const list = ref([]);
      const loadingList = ref(false);
      const listFilter = reactive({ status: '', mine: false });

      async function loadList() {
        if (!me.value) return;
        loadingList.value = true;
        try {
          const params = new URLSearchParams();
          if (listFilter.status) params.set('status', listFilter.status);
          if (listFilter.mine) params.set('submitterId', me.value.sub);
          params.set('limit', '100');
          list.value = await api('/api/expenses?' + params.toString());
        } catch (e) {
          showToast(e.message);
        } finally {
          loadingList.value = false;
        }
      }

      // ---------- 创建报销单 ----------
      const createForm = reactive({
        title: '', reason: '',
        items: [newItem()],
        attachments: []   // 已上传附件 {id, fileName, sizeBytes, uploading}
      });
      const creating = ref(false);
      const createError = ref('');

      function newItem() {
        return { category: '交通', amount: '', occurredDate: today(), description: '' };
      }
      function today() {
        return new Date().toISOString().slice(0, 10);
      }
      function addItem() { createForm.items.push(newItem()); }
      function removeItem(i) { createForm.items.splice(i, 1); }

      const createTotal = computed(() => {
        return createForm.items.reduce((sum, it) => {
          return sum + (AMOUNT_RE.test(it.amount) ? parseFloat(it.amount) : 0);
        }, 0);
      });

      async function onPickFiles(ev) {
        const files = Array.from(ev.target.files || []);
        ev.target.value = '';
        for (const file of files) {
          const entry = reactive({ id: 'pending-' + Math.random().toString(36).slice(2),
            fileName: file.name, sizeBytes: file.size, uploading: true });
          createForm.attachments.push(entry);
          try {
            const fd = new FormData();
            fd.append('file', file);
            const meta = await api('/api/expenses/attachments', { method: 'POST', body: fd });
            Object.assign(entry, { id: meta.id, sizeBytes: meta.sizeBytes, uploading: false });
          } catch (e) {
            createForm.attachments = createForm.attachments.filter(a => a !== entry);
            showToast('附件「' + file.name + '」上传失败:' + e.message);
          }
        }
      }

      function removeAttachment(id) {
        createForm.attachments = createForm.attachments.filter(a => a.id !== id);
      }

      async function submitCreate() {
        createError.value = '';
        for (const it of createForm.items) {
          if (!AMOUNT_RE.test(it.amount)) {
            createError.value = '明细金额格式非法(最多两位小数的正数,如 1500.00)';
            return;
          }
        }
        creating.value = true;
        try {
          const created = await api('/api/expenses', {
            method: 'POST',
            body: JSON.stringify({
              title: createForm.title,
              reason: createForm.reason,
              submitterName: displayName.value,
              items: createForm.items.map(it => ({
                category: it.category, amount: it.amount,
                occurredDate: it.occurredDate, description: it.description
              })),
              attachmentIds: createForm.attachments.filter(a => !a.uploading).map(a => a.id)
            })
          });
          resetCreateForm();
          location.hash = '#/detail/' + created.id;
          showToast('报销单已提交');
        } catch (e) {
          createError.value = e.message;
        } finally {
          creating.value = false;
        }
      }

      function resetCreateForm() {
        createForm.title = ''; createForm.reason = '';
        createForm.items = [newItem()];
        createForm.attachments = [];
      }

      // ---------- 详情 ----------
      const detail = ref(null);
      const approving = ref(false);
      const paying = ref(false);
      const cancelling = ref(false);
      const approvalForm = reactive({ comment: '' });
      const paymentForm = reactive({ amount: '', channel: '银行转账', comment: '' });

      async function loadDetail() {
        if (!me.value || !detailId.value) return;
        try {
          detail.value = await api('/api/expenses/' + detailId.value);
          if (!paymentForm.amount) paymentForm.amount = String(detail.value.totalAmount);
        } catch (e) {
          showToast(e.message);
          detail.value = null;
        }
      }

      const isMine = computed(() =>
        detail.value && me.value && detail.value.submitterId === me.value.sub);
      const canApprove = computed(() =>
        detail.value && ['opened', 'ongoing'].includes(detail.value.status));
      const canCancel = computed(() =>
        isMine.value && detail.value && ['ongoing', 'approved'].includes(detail.value.status));

      // 审批三选项:reject=拒绝;agree=同意(保持 ongoing);final=审批通过(approved)
      async function doApprove(kind) {
        approving.value = true;
        try {
          const decision = kind === 'reject' ? 'reject' : 'approve';
          const body = {
            processInstanceId: 'manual-ui-' + detailId.value,
            activityId: 'manual-ui',
            decision: decision,
            comment: approvalForm.comment || null,
            approverId: me.value.sub,
            approverName: displayName.value
          };
          if (kind === 'final') body.targetStatus = 'approved';
          const result = await api('/api/expenses/' + detailId.value + '/approval-records', {
            method: 'POST', body: JSON.stringify(body)
          });
          if (result && result.duplicated) {
            showToast('您已审批过该单据,本次操作被幂等去重(状态未变化)');
          } else {
            showToast(kind === 'reject' ? '已拒绝' : (kind === 'final' ? '已审批通过' : '已同意'));
          }
          approvalForm.comment = '';
          await loadDetail();
        } catch (e) {
          showToast(e.message);
        } finally {
          approving.value = false;
        }
      }

      async function doPay() {
        if (!AMOUNT_RE.test(paymentForm.amount)) {
          showToast('支付金额格式非法(最多两位小数的正数)');
          return;
        }
        paying.value = true;
        try {
          await api('/api/expenses/' + detailId.value + '/payment', {
            method: 'POST',
            body: JSON.stringify({
              amount: paymentForm.amount,
              channel: paymentForm.channel,
              comment: paymentForm.comment || null,
              paidBy: me.value.sub,
              paidName: displayName.value
            })
          });
          showToast('支付完成,单据已置为已支付');
          await loadDetail();
        } catch (e) {
          showToast(e.message);
        } finally {
          paying.value = false;
        }
      }

      async function doCancel() {
        if (!window.confirm('确认撤回该报销单?撤回后不可恢复。')) return;
        cancelling.value = true;
        try {
          await api('/api/expenses/' + detailId.value + '/cancel', { method: 'POST' });
          showToast('已撤回');
          await loadDetail();
        } catch (e) {
          showToast(e.message);
        } finally {
          cancelling.value = false;
        }
      }

      // 附件下载(需带 Bearer 头,<a href> 无法携带,故走 blob)
      async function downloadAttachment(att) {
        try {
          const opts = {};
          const token = readToken();
          if (token) opts.headers = { 'Authorization': 'Bearer ' + token };
          const res = await fetch('/api/expenses/' + detailId.value + '/attachments/' + att.id, opts);
          if (!res.ok) throw new Error('下载失败(HTTP ' + res.status + ')');
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url; a.download = att.fileName;
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 5000);
        } catch (e) {
          showToast(e.message);
        }
      }

      // ---------- 展示工具 ----------
      function statusText(s) { return STATUS_TEXT[s] || s; }
      function money(v) {
        const n = Number(v);
        return isNaN(n) ? String(v) : '¥ ' + n.toLocaleString('zh-CN', { minimumFractionDigits: 2 });
      }
      function fileSize(bytes) {
        if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
        if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
        return bytes + ' B';
      }
      function fmtTime(v) {
        if (!v) return '—';
        const d = new Date(v);
        return isNaN(d.getTime()) ? v : d.toLocaleString('zh-CN', { hour12: false });
      }
      function goDetail(id) { location.hash = '#/detail/' + id; }

      // ---------- 启动 ----------
      (async function boot() {
        try {
          // 1. 拉取 SSO 连接配置(匿名端点)。必须先于回环消费:iframe 内嵌登录时本页
          //    即父页面,iframe 回环导航触发的 onLoad 与 iframe 内 SPA 启动几乎同时,
          //    这段网络往返让父页面 onLoad 先行取删 sessionStorage 一次性凭据(iframe
          //    内随后回环消费会因凭据缺失报 state 校验失败,但 Modal 即将关闭,无害)
          const cfg = await api('/api/ui-config');
          uiConfig.mode = cfg.mode || '';
          uiConfig.supabaseUrl = cfg.supabaseUrl || '';
          uiConfig.supabaseAnonKey = cfg.supabaseAnonKey || '';
          uiConfig.issuer = cfg.issuer || '';
          uiConfig.clientId = cfg.clientId || '';
          uiConfig.scopes = cfg.scopes || '';

          // 2. 处理 OIDC 登录回环(认证中心重定向回来,URL 带 code&state)
          let oidcHandled = false;
          try { oidcHandled = await completeOidcCallback(); }
          catch (e) { showToast(e.message); }

          if (oidcHandled) return;   // 回环已登录完成

          if (uiConfig.mode === 'supabase' && uiConfig.supabaseUrl) {
            supabase = window.supabase.createClient(uiConfig.supabaseUrl, uiConfig.supabaseAnonKey);
            supabase.auth.onAuthStateChange((event, session) => {
              if (event === 'SIGNED_OUT') {
                clearAuth();
                me.value = null;
              } else if (session && (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED')) {
                writeToken(session.access_token, session.refresh_token);
                if (!me.value) afterLogin().catch(() => {});
              }
            });
            const { data } = await supabase.auth.getSession();
            if (data && data.session) {
              writeToken(data.session.access_token, data.session.refresh_token);
              await afterLogin();
            }
          } else if (uiConfig.mode === 'oidc' && readToken()) {
            // oidc 模式:已有令牌则拉取当前用户;失效由 401 刷新链路兜底
            try { await afterLogin(); } catch (e) { clearAuth(); }
          }
        } catch (e) {
          showToast('初始化失败:' + e.message);
        } finally {
          booting.value = false;
          parseHash();
        }
      })();

      return {
        booting, uiConfig, me, route, toast, displayName,
        STATUSES, CATEGORIES,
        loginForm, loggingIn, loginError, login, logout,
        oidcFrameUrl, oidcFrame, openOidcFrame, closeOidcFrame, onFrameLoad,
        list, loadingList, listFilter, loadList,
        createForm, creating, createError, createTotal,
        addItem, removeItem, onPickFiles, removeAttachment, submitCreate,
        detail, approving, paying, cancelling,
        approvalForm, paymentForm,
        isMine, canApprove, canCancel,
        doApprove, doPay, doCancel, downloadAttachment,
        statusText, money, fileSize, fmtTime, goDetail
      };
    }
  }).mount('#app');
})();
