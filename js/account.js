// account.js — email-code accounts, friends, and private chat (Supabase backend).
// All authority lives in server-side Row Level Security; this file is just UI + queries.

const Account = (() => {
  let sb = null;            // supabase client
  let session = null;
  let me = null;            // my profile row { id, username, avatar, bio }
  let pendingEmail = '';
  let chatFriend = null;    // profile of the friend in the open chat
  let chatChannel = null;   // realtime subscription
  let chatPoll = null;      // fallback poll while chat is open
  let lastMsgId = 0;

  const $ = id => document.getElementById(id);

  function isReady() {
    return !!(typeof SPARK_CONFIG !== 'undefined' && SPARK_CONFIG.supabaseUrl && SPARK_CONFIG.supabaseAnonKey && typeof supabase !== 'undefined');
  }
  function signedIn() { return !!(session && me); }
  function userId()   { return me?.id || null; }
  function username() { return me?.username || null; }

  // ── Init ──
  async function init() {
    const btn = $('accountBtn');
    if (!isReady()) {
      // No backend configured — hide the account button entirely
      if (btn) btn.style.display = 'none';
      return;
    }
    sb = supabase.createClient(SPARK_CONFIG.supabaseUrl, SPARK_CONFIG.supabaseAnonKey);
    if (btn) btn.addEventListener('click', openModal);
    $('accountClose')?.addEventListener('click', closeModal);
    $('accountModal')?.addEventListener('click', e => { if (e.target.id === 'accountModal') closeModal(); });

    const { data } = await sb.auth.getSession();
    session = data?.session || null;
    if (session) await loadMyProfile();
    updateHeaderBtn();

    sb.auth.onAuthStateChange((_evt, s) => { session = s; });
  }

  async function loadMyProfile() {
    if (!session) { me = null; return; }
    const { data } = await sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
    me = data || null;
  }

  function updateHeaderBtn() {
    const btn = $('accountBtn');
    if (!btn) return;
    btn.textContent = signedIn() ? `${me.avatar} ${me.username}` : '👤 Sign up / in';
    refreshRequestDot();
  }

  async function refreshRequestDot() {
    const btn = $('accountBtn');
    if (!btn) return;
    let has = false;
    if (signedIn()) {
      const { count } = await sb.from('friendships')
        .select('id', { count: 'exact', head: true })
        .eq('addressee', me.id).eq('status', 'pending');
      has = (count || 0) > 0;
    }
    btn.classList.toggle('notify', has);
  }

  // ── Modal / view switching ──
  function show(view) {
    ['signin', 'code', 'username', 'main', 'chat'].forEach(v => {
      const el = $('av-' + v);
      if (el) el.style.display = v === view ? 'block' : 'none';
    });
    if (view !== 'chat') stopChatLive();
  }

  function openModal() {
    $('accountModal').style.display = 'flex';
    if (!session)      show('signin');
    else if (!me)      show('username');
    else { show('main'); renderMain(); }
  }

  function closeModal() {
    $('accountModal').style.display = 'none';
    stopChatLive();
  }

  function setMsg(id, text, isError) {
    const el = $(id);
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('acct-err', !!isError);
  }

  // ── Sign in: email → 6-digit code ──
  async function sendCode() {
    const email = $('acctEmail')?.value.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setMsg('signinMsg', 'Enter a valid email address', true); return; }
    setMsg('signinMsg', 'Sending code…');
    const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
    if (error) { setMsg('signinMsg', error.message, true); return; }
    pendingEmail = email;
    $('codeEmailEcho').textContent = email;
    setMsg('codeMsg', '');
    show('code');
  }

  async function verifyCode() {
    const token = $('acctCode')?.value.trim();
    if (!token || token.length < 6) { setMsg('codeMsg', 'Enter the 6-digit code from your email', true); return; }
    setMsg('codeMsg', 'Verifying…');
    const { data, error } = await sb.auth.verifyOtp({ email: pendingEmail, token, type: 'email' });
    if (error) { setMsg('codeMsg', error.message, true); return; }
    session = data.session;
    await loadMyProfile();
    updateHeaderBtn();
    if (!me) show('username');
    else { show('main'); renderMain(); }
  }

  // ── First-time username ──
  async function saveUsername() {
    const name = $('acctUsername')?.value.trim();
    if (!/^[a-zA-Z0-9_]{3,24}$/.test(name || '')) {
      setMsg('usernameMsg', '3–24 letters, numbers or underscores', true); return;
    }
    const local = (typeof Profile !== 'undefined') ? Profile.load() : { avatar: '😀', bio: '' };
    setMsg('usernameMsg', 'Saving…');
    const { error } = await sb.from('profiles').insert({
      id: session.user.id, username: name, avatar: local.avatar, bio: local.bio
    });
    if (error) {
      setMsg('usernameMsg', error.code === '23505' ? 'That username is taken' : error.message, true);
      return;
    }
    await loadMyProfile();
    updateHeaderBtn();
    show('main'); renderMain();
  }

  async function signOut() {
    await sb.auth.signOut();
    session = null; me = null;
    updateHeaderBtn();
    show('signin');
  }

  // ── Friends hub ──
  async function renderMain() {
    $('acctWhoami').textContent = `${me.avatar} @${me.username}`;
    setMsg('mainMsg', '');
    const { data: rows } = await sb.from('friendships').select(`
      id, requester, addressee, status,
      reqP:profiles!friendships_requester_fkey(id, username, avatar),
      addP:profiles!friendships_addressee_fkey(id, username, avatar)
    `);
    const incoming = [], friends = [], outgoing = [];
    (rows || []).forEach(r => {
      const other = r.requester === me.id ? r.addP : r.reqP;
      if (!other) return;
      if (r.status === 'accepted') friends.push({ row: r, other });
      else if (r.addressee === me.id) incoming.push({ row: r, other });
      else outgoing.push({ row: r, other });
    });

    // Incoming requests
    const reqEl = $('acctRequests');
    reqEl.innerHTML = '';
    if (incoming.length) {
      incoming.forEach(({ row, other }) => {
        const li = document.createElement('div');
        li.className = 'acct-row';
        const name = document.createElement('span');
        name.className = 'acct-row-name';
        name.textContent = `${other.avatar} @${other.username}`;
        const ok = document.createElement('button');
        ok.className = 'acct-mini-btn';
        ok.textContent = 'Accept';
        ok.addEventListener('click', async () => {
          await sb.from('friendships').update({ status: 'accepted' }).eq('id', row.id);
          renderMain(); refreshRequestDot();
        });
        const no = document.createElement('button');
        no.className = 'acct-mini-btn acct-mini-danger';
        no.textContent = '✕';
        no.addEventListener('click', async () => {
          await sb.from('friendships').delete().eq('id', row.id);
          renderMain(); refreshRequestDot();
        });
        li.append(name, ok, no);
        reqEl.appendChild(li);
      });
      $('acctRequestsWrap').style.display = 'block';
    } else {
      $('acctRequestsWrap').style.display = 'none';
    }

    // Friends list
    const frEl = $('acctFriends');
    frEl.innerHTML = '';
    if (!friends.length && !outgoing.length) {
      frEl.innerHTML = '<div class="acct-empty">No friends yet — add someone below or during a video chat</div>';
    }
    friends.forEach(({ row, other }) => {
      const li = document.createElement('div');
      li.className = 'acct-row acct-row-click';
      const name = document.createElement('span');
      name.className = 'acct-row-name';
      name.textContent = `${other.avatar} @${other.username}`;
      const chat = document.createElement('button');
      chat.className = 'acct-mini-btn';
      chat.textContent = '💬 Chat';
      chat.addEventListener('click', () => openChat(other));
      const rm = document.createElement('button');
      rm.className = 'acct-mini-btn acct-mini-danger';
      rm.textContent = '✕';
      rm.title = 'Remove friend';
      rm.addEventListener('click', async (e) => {
        e.stopPropagation();
        await sb.from('friendships').delete().eq('id', row.id);
        renderMain();
      });
      li.append(name, chat, rm);
      li.addEventListener('click', () => openChat(other));
      frEl.appendChild(li);
    });
    outgoing.forEach(({ other }) => {
      const li = document.createElement('div');
      li.className = 'acct-row';
      const name = document.createElement('span');
      name.className = 'acct-row-name acct-dim';
      name.textContent = `${other.avatar} @${other.username} — request sent`;
      li.appendChild(name);
      frEl.appendChild(li);
    });
  }

  async function addByUsername() {
    const name = ($('acctAddInput')?.value || '').trim().replace(/^@/, '').replace(/[^a-zA-Z0-9_]/g, '');
    if (!name) return;
    if (signedIn() && name.toLowerCase() === me.username.toLowerCase()) { setMsg('mainMsg', "That's you :)", true); return; }
    const { data: p } = await sb.from('profiles').select('id, username').ilike('username', name).maybeSingle();
    if (!p) { setMsg('mainMsg', 'No user with that username', true); return; }
    const { error } = await sb.from('friendships').insert({ requester: me.id, addressee: p.id });
    if (error) {
      setMsg('mainMsg', error.code === '23505' ? 'Request already exists' : error.message, true);
      return;
    }
    $('acctAddInput').value = '';
    setMsg('mainMsg', `Request sent to @${p.username}`);
    renderMain();
  }

  // Called from app.js when you tap "add friend" during a video call
  async function sendFriendRequestTo(uuid) {
    if (!signedIn() || !/^[0-9a-f-]{36}$/i.test(uuid || '')) return { ok: false, msg: 'not signed in' };
    const { error } = await sb.from('friendships').insert({ requester: me.id, addressee: uuid });
    if (error && error.code !== '23505') return { ok: false, msg: error.message };
    return { ok: true };
  }

  // ── Direct messages ──
  async function openChat(friend) {
    chatFriend = friend;
    $('chatFriendName').textContent = `${friend.avatar} @${friend.username}`;
    $('acctChatLog').innerHTML = '';
    lastMsgId = 0;
    show('chat');
    await loadMessages();
    startChatLive();
    $('acctChatInput')?.focus();
  }

  async function loadMessages() {
    if (!chatFriend) return;
    const fid = chatFriend.id;
    const { data: msgs } = await sb.from('messages')
      .select('id, sender, body, created_at')
      .or(`and(sender.eq.${me.id},recipient.eq.${fid}),and(sender.eq.${fid},recipient.eq.${me.id})`)
      .order('id', { ascending: true })
      .gt('id', lastMsgId)
      .limit(100);
    (msgs || []).forEach(m => appendMsg(m));
  }

  function appendMsg(m) {
    if (m.id <= lastMsgId) return;
    lastMsgId = Math.max(lastMsgId, m.id);
    const log = $('acctChatLog');
    const b = document.createElement('div');
    b.className = 'dm-bubble ' + (m.sender === me.id ? 'you' : 'them');
    b.textContent = m.body;
    log.appendChild(b);
    log.scrollTop = log.scrollHeight;
  }

  async function sendDM() {
    const input = $('acctChatInput');
    const body = input?.value.trim();
    if (!body || !chatFriend) return;
    input.value = '';
    const { data, error } = await sb.from('messages')
      .insert({ sender: me.id, recipient: chatFriend.id, body: body.slice(0, 1000) })
      .select('id, sender, body').single();
    if (error) { setMsg('chatMsg', 'Could not send — are you still friends?', true); return; }
    setMsg('chatMsg', '');
    appendMsg(data);
  }

  function startChatLive() {
    stopChatLive();
    // Realtime push for incoming messages…
    chatChannel = sb.channel('dm-' + chatFriend.id)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `recipient=eq.${me.id}` },
        payload => {
          if (payload.new?.sender === chatFriend?.id) appendMsg(payload.new);
        })
      .subscribe();
    // …plus a light poll fallback in case realtime is unavailable
    chatPoll = setInterval(loadMessages, 8000);
  }

  function stopChatLive() {
    if (chatChannel) { try { sb.removeChannel(chatChannel); } catch (e) {} chatChannel = null; }
    if (chatPoll) { clearInterval(chatPoll); chatPoll = null; }
    chatFriend = null;
  }

  // ── Wire static buttons once DOM is ready ──
  function wire() {
    $('acctSendCode')?.addEventListener('click', sendCode);
    $('acctEmail')?.addEventListener('keydown', e => { if (e.key === 'Enter') sendCode(); });
    $('acctVerify')?.addEventListener('click', verifyCode);
    $('acctCode')?.addEventListener('keydown', e => { if (e.key === 'Enter') verifyCode(); });
    $('acctResend')?.addEventListener('click', () => { show('signin'); });
    $('acctSaveUsername')?.addEventListener('click', saveUsername);
    $('acctUsername')?.addEventListener('keydown', e => { if (e.key === 'Enter') saveUsername(); });
    $('acctSignOut')?.addEventListener('click', signOut);
    $('acctAddBtn')?.addEventListener('click', addByUsername);
    $('acctAddInput')?.addEventListener('keydown', e => { if (e.key === 'Enter') addByUsername(); });
    $('chatBack')?.addEventListener('click', () => { show('main'); renderMain(); });
    $('acctChatSend')?.addEventListener('click', sendDM);
    $('acctChatInput')?.addEventListener('keydown', e => { if (e.key === 'Enter') sendDM(); });
  }

  return { init, wire, isReady, signedIn, userId, username, openModal, sendFriendRequestTo };
})();
