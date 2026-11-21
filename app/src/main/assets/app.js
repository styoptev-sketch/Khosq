(function () {
  'use strict';

  /* ---------- helpers ---------- */
  function $(s) { return document.querySelector(s); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function load(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function hhmm(ts) {
    try { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; }
  }
  var ID_RE = /^[A-Za-z0-9]+(?:[_-][A-Za-z0-9]+)*$/;
  function validId(id) { return id.length >= 3 && id.length <= 30 && ID_RE.test(id); }

  var toastTimer = null;
  function toast(text) {
    var t = $('#toast');
    t.textContent = text; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 3500);
  }

  /* ---------- Android bridge (absent when the page runs in a normal browser) ---------- */
  var NATIVE = window.Android || null;
  function native(fn, a, b, c) {
    try {
      if (!NATIVE || typeof NATIVE[fn] !== 'function') return undefined;
      if (arguments.length === 1) return NATIVE[fn]();
      if (arguments.length === 2) return NATIVE[fn](a);
      if (arguments.length === 3) return NATIVE[fn](a, b);
      return NATIVE[fn](a, b, c);
    } catch (e) { return undefined; }
  }
  function hasNative(fn) { return !!NATIVE && typeof NATIVE[fn] === 'function'; }
  function missedCall(id) { native('notifyMessage', id, nameOf(id), 'Բաց թողնված զանգ'); }

  /* ---------- network relay servers ---------- */
  // Mobile networks often block direct phone-to-phone links, so relay (TURN) servers are listed too.
  var ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' },
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp',
        'turns:openrelay.metered.ca:443?transport=tcp'
      ],
      username: 'openrelayproject', credential: 'openrelayproject'
    }
  ];

  /* ---------- ring tones (generated, no audio files) ---------- */
  var audioCtx = null, ringInt = null;
  function tone(freq, dur) {
    if (!audioCtx) return;
    try {
      var o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = freq;
      o.connect(g); g.connect(audioCtx.destination);
      var t = audioCtx.currentTime;
      g.gain.setValueAtTime(0.3, t);
      g.gain.setValueAtTime(0, t + dur);
      o.start(t); o.stop(t + dur + 0.05);
    } catch (e) {}
  }
  function stopRing() {
    if (ringInt) { clearInterval(ringInt); ringInt = null; }
    native('stopCall'); // also stops the phone's own ringtone and clears the call notification
  }
  function startRing(isIncoming) {
    stopRing();
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) { return; }
    function once() {
      if (isIncoming) {
        tone(880, 0.18);
        setTimeout(function () { tone(660, 0.18); }, 230);
        setTimeout(function () { tone(880, 0.18); }, 700);
        setTimeout(function () { tone(660, 0.18); }, 930);
      } else {
        tone(425, 1.0);
      }
    }
    once();
    ringInt = setInterval(once, isIncoming ? 2400 : 3500);
  }

  /* ---------- state ---------- */
  var me = load('me', null);              // { id, name }
  var contacts = load('contacts', {});    // id -> { id, name, custom, unread }
  var msgs = load('msgs', {});            // id -> [ { i, m, x, ts, s } ]  s: 'p' pending, 'd' delivered
  var peer = null, online = false, idRetry = 0;
  var conns = {};
  var current = null;
  var call = null, callId = null, callVideo = false, callState = '', callTimer = null, callStart = 0, ringTimer = null;
  var localStream = null;
  var incoming = null, incomingTimer = null;
  var typingAt = {}, typingKind = {}, typingSent = 0, replyTo = null, searchQ = '', urlCache = {}, busyMedia = {}, incomingMedia = {};

  function saveContacts() { save('contacts', contacts); }
  function saveMsgs() {
    Object.keys(msgs).forEach(function (k) { if (msgs[k].length > 500) { msgs[k].slice(0, -500).forEach(function (m) { if (m.k) dropMedia(m.i); }); msgs[k] = msgs[k].slice(-500); } });
    save('msgs', msgs);
  }
  function ensureContact(id) {
    if (!contacts[id]) { contacts[id] = { id: id, name: id, custom: false, unread: 0 }; saveContacts(); }
    return contacts[id];
  }
  function chatOf(id) { if (!msgs[id]) msgs[id] = []; return msgs[id]; }
  function lastTs(id) { var m = msgs[id]; return m && m.length ? m[m.length - 1].ts : 0; }
  function pending(id) { return (msgs[id] || []).filter(function (m) { return m.m && !m.d && m.s === 'p'; }); }

  /* ---------- screens ---------- */
  function showScreen(name) {
    ['setup', 'home', 'chat'].forEach(function (s) { $('#' + s).hidden = s !== name; });
  }
  function setStatus(on, text) {
    online = on;
    $('#status').className = 'status' + (on ? ' on' : '');
    $('#status-text').textContent = text;
    if (current) renderChatHeader();
  }

  /* ---------- setup ---------- */
  function setupError(text) {
    var e = $('#setup-err');
    e.textContent = text || ''; e.hidden = !text;
  }
  function openSetup(errText) {
    $('#in-name').value = me ? me.name : '';
    $('#in-id').value = me ? me.id : 'u' + Math.random().toString(36).slice(2, 8);
    setupError(errText);
    showScreen('setup');
  }
  $('#btn-start').addEventListener('click', function () {
    var name = $('#in-name').value.trim();
    var id = $('#in-id').value.trim().toLowerCase();
    if (!name) { setupError('Գրիր քո անունը։'); return; }
    if (!validId(id)) {
      setupError('ID-ն պետք է լինի 3–30 նիշ. լատինատառ, թվեր, «_» կամ «-», սկսվի և ավարտվի տառով կամ թվով։');
      return;
    }
    me = { id: id, name: name };
    save('me', me);
    enterApp();
  });

  /* ---------- home ---------- */
  // A photo is a small square JPEG (data URL). Anything else is ignored.
  var PHOTO_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+\/=]{20,20000}$/;
  function okPhoto(p) { return typeof p === 'string' && PHOTO_RE.test(p); }
  // Paints an avatar: the contact's photo, or the first letter on one of six shapes chosen from the id.
  function paintAvatar(a, c) {
    var h = 0, s = c.id || '';
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    a.setAttribute('data-k', String(h % 6));
    if (okPhoto(c.photo)) {
      a.textContent = '';
      a.style.backgroundImage = 'url("' + c.photo + '")';
      a.classList.add('photo');
    } else {
      a.textContent = (c.name || c.id || '?').charAt(0).toUpperCase();
      a.style.backgroundImage = '';
      a.classList.remove('photo');
    }
  }
  function avatarEl(c) {
    var a = el('span', 'avatar');
    a.setAttribute('aria-hidden', 'true');
    paintAvatar(a, c);
    return a;
  }
  function renderHomeList() {
    var list = $('#chats');
    list.textContent = '';
    var ids = Object.keys(contacts).sort(function (a, b) { return lastTs(b) - lastTs(a); });
    $('#empty').hidden = ids.length > 0;
    list.hidden = ids.length === 0;
    ids.forEach(function (id) {
      var c = contacts[id], m = msgs[id] || [], last = m[m.length - 1];
      var li = el('li');
      var b = el('button', 'chat-item');
      b.type = 'button';
      b.appendChild(avatarEl(c));
      var body = el('span', 'ci-body');
      body.appendChild(el('span', 'ci-name', c.name || id));
      body.appendChild(el('span', 'ci-last', last ? (last.m ? 'Դու՝ ' : '') + previewOf(last) : c.id));
      b.appendChild(body);
      var side = el('span', 'ci-side');
      if (last) side.appendChild(el('span', 'ci-time', hhmm(last.ts)));
      if (c.unread > 0) side.appendChild(el('span', 'badge', String(c.unread)));
      b.appendChild(side);
      b.addEventListener('click', function () { openChat(id); });
      li.appendChild(b);
      var more = el('button', 'more');
      more.type = 'button';
      more.setAttribute('aria-label', 'Ընտրանքներ՝ ' + (c.name || id));
      more.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>';
      more.addEventListener('click', function () { openContact(id); });
      li.appendChild(more);
      list.appendChild(li);
    });
  }

    /* ---------- chat ---------- */
  function clip(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function sameDay(a, b) {
    var x = new Date(a), y = new Date(b);
    return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
  }
  function dayLabel(ts) {
    var now = Date.now();
    if (sameDay(ts, now)) return 'Այսօր';
    if (sameDay(ts, now - 86400000)) return 'Երեկ';
    try { return new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' }); } catch (e) { return ''; }
  }
  function previewOf(m) {
    if (m.d) return '🚫 Հաղորդագրությունը ջնջվել է';
    if (m.k === 'img') return '📷 Նկար';
    if (m.k === 'aud') return '🎤 Ձայնային նամակ';
    return m.x;
  }
  function findMsg(id, i) {
    var l = msgs[id] || [];
    for (var k = 0; k < l.length; k++) { if (l[k].i === i) return l[k]; }
    return null;
  }

  function chatStatus(id) {
    var c = ensureContact(id);
    if (!online) return 'Կապ չկա';
    if (typingAt[id] && Date.now() - typingAt[id] < 4500) return typingKind[id] === 'a' ? 'ձայնագրում է…' : 'գրում է…';
    if (openConn(id)) return 'առցանց';
    var p = pending(id).length;
    if (p) return 'Չառաքված՝ ' + p;
    if (c.seen) return 'վերջին անգամ՝ ' + (sameDay(c.seen, Date.now()) ? '' : dayLabel(c.seen) + ' ') + hhmm(c.seen);
    return c.id;
  }
  function renderChatHeader() {
    if (!current) return;
    var c = ensureContact(current);
    $('#chat-name').textContent = c.name || c.id;
    paintAvatar($('#chat-avatar'), c);
    $('#chat-sub').textContent = chatStatus(current);
  }

  function msgEl(m) {
    var d = el('div', 'msg' + (m.m ? ' mine' : '') + (m.d ? ' gone' : ''));
    d.setAttribute('data-i', m.i);
    if (m.d) {
      d.appendChild(el('span', 'gone-t', '🚫 Հաղորդագրությունը ջնջվել է'));
    } else {
      if (m.q) {
        var q = el('div', 'quote');
        q.appendChild(el('b', null, m.q.m ? 'Դու' : nameOf(current)));
        q.appendChild(el('span', null, clip(m.q.x, 90)));
        q.addEventListener('click', function (e) { e.stopPropagation(); jumpTo(m.q.i); });
        d.appendChild(q);
      }
      if (m.k === 'img') {
        var img = el('img', 'pic');
        img.alt = 'Նկար';
        if (m.w && m.h) img.style.aspectRatio = m.w + ' / ' + m.h;
        setMedia(m.i, function (u) { img.src = u; });
        img.addEventListener('click', function (e) { e.stopPropagation(); if (img.src) openViewer(img.src); });
        d.appendChild(img);
      } else if (m.k === 'aud') {
        d.appendChild(voiceEl(m));
      } else {
        d.appendChild(document.createTextNode(m.x));
      }
      if (m.rx && (m.rx.a || m.rx.b)) d.appendChild(el('span', 'rx', (m.rx.a || '') + (m.rx.b || '')));
    }
    var meta = el('span', 'meta');
    meta.appendChild(document.createTextNode(hhmm(m.ts) + ' '));
    if (m.m && !m.d) {
      var t = el('span', 'tick' + (m.s === 'r' ? ' read' : ''),
        m.s === 'r' ? '✓✓' : m.s === 'd' ? '✓' : m.s === 'x' ? '⚠' : '🕓');
      t.setAttribute('aria-label', m.s === 'r' ? 'Կարդացվեց' : m.s === 'd' ? 'Հասավ' : m.s === 'x' ? 'Չհաջողվեց ուղարկել' : 'Ուղարկվում է');
      meta.appendChild(t);
    }
    if (!m.d) {
      var more = el('button', 'mbtn', '⋯');
      more.type = 'button';
      more.setAttribute('aria-label', 'Նամակի ընտրանքներ');
      more.addEventListener('click', function (e) { e.stopPropagation(); openMsgMenu(m.i); });
      meta.appendChild(more);
    }
    d.appendChild(meta);
    if (!m.d && !m.k) {
      d.addEventListener('click', function (e) {
        if (e.target && e.target.closest && e.target.closest('audio,img,.quote,.mbtn')) return;
        openMsgMenu(m.i);
      });
    }
    return d;
  }
  function fmtDur(s) { s = Math.round(s); var m = Math.floor(s / 60), r = s % 60; return m + ':' + (r < 10 ? '0' : '') + r; }

  function renderChat(forceBottom) {
    if (!current) return;
    var log = $('#log');
    var near = forceBottom === true || (log.scrollHeight - log.scrollTop - log.clientHeight < 90);
    var prevTop = log.scrollTop;
    log.textContent = '';
    var list = msgs[current] || [], q = searchQ.toLowerCase(), last = 0, shown = 0;
    list.forEach(function (m) {
      if (q && (m.d || m.k || (m.x || '').toLowerCase().indexOf(q) === -1)) return;
      if (!sameDay(m.ts, last)) log.appendChild(el('div', 'date-sep', dayLabel(m.ts)));
      last = m.ts;
      log.appendChild(msgEl(m));
      shown++;
    });
    if (q && !shown) log.appendChild(el('div', 'date-sep', 'Ոչինչ չգտնվեց'));
    log.scrollTop = near ? log.scrollHeight : prevTop;
    vpPaint();
    renderChatHeader();
    sendRead(current);
  }
  function jumpTo(i) {
    var n = document.querySelector('#log .msg[data-i="' + String(i).replace(/[^A-Za-z0-9_-]/g, '') + '"]');
    if (!n) { toast('Նամակը չի գտնվել'); return; }
    n.scrollIntoView({ block: 'center' });
    n.classList.add('flash');
    setTimeout(function () { n.classList.remove('flash'); }, 1200);
  }

  function openChat(id) {
    current = id;
    var c = ensureContact(id);
    c.unread = 0; saveContacts();
    native('clearNotification', id);
    searchQ = ''; $('#in-search').value = ''; $('#searchbar').hidden = true;
    setEmoji(false);
    setReply(null);
    $('#in-msg').value = ''; autoGrow(); updateComposerMode();
    showScreen('chat');
    autoGrow();
    renderChat(true);
    connectTo(id);
    flush(id);
  }
  function closeChat() {
    if (rec) cancelRec();
    stopAud();
    current = null;
    setEmoji(false);
    renderHome();
    showScreen('home');
  }
  function sendText() {
    var ta = $('#in-msg');
    var t = ta.value.trim();
    if (!t || !current) return;
    var m = { i: uid(), m: true, x: t.slice(0, 4000), ts: Date.now(), s: 'p' };
    if (replyTo) m.q = replyTo;
    chatOf(current).push(m);
    setReply(null);
    saveMsgs();
    ta.value = ''; autoGrow(); updateComposerMode();
    renderChat(true);
    flush(current);
  }
  function autoGrow() {
    var ta = $('#in-msg');
    ta.style.height = 'auto';
    var h = ta.scrollHeight;
    ta.style.height = h ? Math.min(h, 120) + 'px' : '';
  }
  function updateComposerMode() {
    var has = $('#in-msg').value.trim().length > 0;
    $('#btn-send').hidden = !has;
    $('#btn-mic').hidden = has;
  }
  $('#composer').addEventListener('submit', function (e) { e.preventDefault(); sendText(); $('#in-msg').focus(); });
  $('#in-msg').addEventListener('input', function () {
    autoGrow(); updateComposerMode();
    var now = Date.now();
    if (current && $('#in-msg').value && now - typingSent > 2500) { typingSent = now; sendCtl(current, { t: 'typing' }); }
  });
  $('#btn-back').addEventListener('click', closeChat);
  $('#btn-acall').addEventListener('click', function () { if (current) startCall(current, false); });
  $('#btn-vcall').addEventListener('click', function () { if (current) startCall(current, true); });

  /* ---------- read receipts ---------- */
  function sendRead(id) {
    if (!id || current !== id || document.hidden) return;
    var ids = [], l = msgs[id] || [];
    for (var k = 0; k < l.length; k++) { if (!l[k].m && !l[k].d && !l[k].rs) ids.push(l[k].i); }
    if (!ids.length || !openConn(id)) return;
    sendCtl(id, { t: 'read', ids: ids.slice(-200) });
    l.forEach(function (m) { if (!m.m && !m.d) m.rs = true; });
    saveMsgs();
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden && current) sendRead(current); });

  /* ---------- media storage (IndexedDB, voice + photos) ---------- */
  var idb = null, idbWait = null, memMedia = {};
  function idbOpen(cb) {
    if (idb) { cb(idb); return; }
    if (idbWait) { idbWait.push(cb); return; }
    idbWait = [cb];
    function done(db) { idb = db; var w = idbWait; idbWait = null; w.forEach(function (f) { f(db); }); }
    try {
      var r = indexedDB.open('khosq', 1);
      r.onupgradeneeded = function () { try { r.result.createObjectStore('media'); } catch (e) {} };
      r.onsuccess = function () { done(r.result); };
      r.onerror = function () { done(null); };
    } catch (e) { done(null); }
  }
  function idbPut(k, blob, cb) {
    var fin = false;
    function end() { if (fin) return; fin = true; cb(); }
    idbOpen(function (db) {
      if (!db) { memMedia[k] = blob; end(); return; }
      try {
        var tx = db.transaction('media', 'readwrite');
        tx.objectStore('media').put(blob, k);
        tx.oncomplete = end;
        tx.onerror = tx.onabort = function () { memMedia[k] = blob; end(); };
      } catch (e) { memMedia[k] = blob; end(); }
    });
  }
  function idbGet(k, cb) {
    if (memMedia[k]) { cb(memMedia[k]); return; }
    idbOpen(function (db) {
      if (!db) { cb(null); return; }
      try {
        var rq = db.transaction('media', 'readonly').objectStore('media').get(k);
        rq.onsuccess = function () { cb(rq.result || null); };
        rq.onerror = function () { cb(null); };
      } catch (e) { cb(null); }
    });
  }
  function idbDel(k) {
    delete memMedia[k];
    idbOpen(function (db) {
      if (!db) return;
      try { db.transaction('media', 'readwrite').objectStore('media').delete(k); } catch (e) {}
    });
  }
  function setMedia(i, cb, miss) {
    if (urlCache[i]) { cb(urlCache[i]); return; }
    idbGet(i, function (blob) {
      if (!blob) { if (miss) miss(); return; }
      if (!urlCache[i]) urlCache[i] = URL.createObjectURL(blob);
      cb(urlCache[i]);
    });
  }
  function dropMedia(i) {
    if (curAud && curAud.i === i) stopAud();
    if (urlCache[i]) { try { URL.revokeObjectURL(urlCache[i]); } catch (e) {} delete urlCache[i]; }
    idbDel(i);
  }

  /* ---------- voice note player (WhatsApp style: tap play, no menus) ---------- */
  var curAud = null, vpRate = 1;
  function voiceEl(m) {
    var vp = el('div', 'vp');
    vp.setAttribute('data-i', m.i);
    var btn = el('button', 'vp-btn', '▶');
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Նվագարկել');
    btn.addEventListener('click', function (e) { e.stopPropagation(); vpToggle(m); });
    var mid = el('div', 'vp-mid');
    var bar = el('div', 'vp-bar');
    bar.appendChild(el('div', 'vp-fill'));
    mid.appendChild(bar);
    mid.appendChild(el('span', 'vp-t', fmtDur(m.dur || 0)));
    var spd = el('button', 'vp-spd', vpRate + '×');
    spd.type = 'button';
    spd.setAttribute('aria-label', 'Արագություն');
    spd.addEventListener('click', function (e) {
      e.stopPropagation();
      vpRate = vpRate === 1 ? 1.5 : vpRate === 1.5 ? 2 : 1;
      if (curAud) curAud.a.playbackRate = vpRate;
      vpPaint();
    });
    vp.appendChild(btn); vp.appendChild(mid); vp.appendChild(spd);
    return vp;
  }
  function vpPaint() {
    var all = document.querySelectorAll('#log .vp');
    for (var k = 0; k < all.length; k++) {
      var n = all[k], i = n.getAttribute('data-i');
      var on = curAud && curAud.i === i;
      var playing = on && !curAud.a.paused;
      var cur = on ? curAud.a.currentTime : 0, dur = on ? curAud.dur : 0;
      n.querySelector('.vp-btn').textContent = playing ? '⏸' : '▶';
      n.querySelector('.vp-btn').setAttribute('aria-label', playing ? 'Դադար' : 'Նվագարկել');
      n.querySelector('.vp-fill').style.width = (on && dur ? Math.min(100, cur / dur * 100) : 0) + '%';
      var m = findMsg(current, i), total = m && m.dur ? m.dur : 0;
      n.querySelector('.vp-t').textContent = fmtDur(on && playing ? cur : total);
      n.querySelector('.vp-spd').textContent = vpRate + '×';
    }
  }
  function stopAud() {
    if (curAud) {
      try { curAud.a.pause(); curAud.a.removeAttribute('src'); curAud.a.load(); } catch (e) {}
      curAud = null;
    }
    vpPaint();
  }
  function vpToggle(m) {
    if (curAud && curAud.i === m.i) {
      if (curAud.a.paused) { var pr = curAud.a.play(); if (pr && pr.catch) pr.catch(function () {}); }
      else curAud.a.pause();
      vpPaint();
      return;
    }
    stopAud();
    setMedia(m.i, function (u) {
      var a = new Audio();
      a.preload = 'auto';
      a.src = u;
      a.playbackRate = vpRate;
      var me2 = { i: m.i, a: a, dur: m.dur || 0 };
      curAud = me2;
      a.addEventListener('timeupdate', vpPaint);
      a.addEventListener('play', vpPaint);
      a.addEventListener('pause', vpPaint);
      a.addEventListener('ended', function () { if (curAud === me2) stopAud(); });
      a.addEventListener('error', function () { if (curAud === me2) { toast('Ձայնը չհաջողվեց նվագարկել'); stopAud(); } });
      var p = a.play();
      if (p && p.catch) p.catch(function (e) { if (curAud === me2) { toast('Նվագարկման սխալ՝ ' + ((e && e.name) || '')); stopAud(); } });
      vpPaint();
    }, function () { toast('Ձայնային ֆայլը չի գտնվել'); });
  }

  /* ---------- networking (PeerJS) ---------- */
  function startPeer() {
    if (!me) return;
    if (typeof Peer === 'undefined') { setStatus(false, 'Գրադարանը բացակայում է'); return; }
    if (peer && !peer.destroyed) return;
    setStatus(false, 'Միանում է…');
    var p = new Peer(me.id, { config: { iceServers: ICE_SERVERS } });
    peer = p;

    p.on('open', function () {
      if (p !== peer) return;
      idRetry = 0;
      setStatus(true, 'Կապի մեջ է');
      Object.keys(msgs).forEach(flush);
    });
    p.on('disconnected', function () {
      if (p !== peer) return;
      setStatus(false, 'Կապ չկա');
      setTimeout(function () { if (p === peer && !p.destroyed && p.disconnected) { try { p.reconnect(); } catch (e) {} } }, 1500);
    });
    p.on('close', function () {
      if (p !== peer) return;
      setStatus(false, 'Կապ չկա');
    });
    p.on('connection', function (c) { if (p === peer) setupConn(c); });
    p.on('call', function (c) { if (p === peer) onIncomingCall(c); });
    p.on('error', function (err) {
      if (p !== peer) return;
      var type = err && err.type;
      if (type === 'unavailable-id') {
        try { p.destroy(); } catch (e) {}
        peer = null;
        idRetry++;
        if (idRetry <= 20) { setStatus(false, 'Միանում է…'); setTimeout(startPeer, 4000); }
        else { idRetry = 0; openSetup('Այս ID-ն արդեն զբաղված է։ Ընտրիր ուրիշ ID։'); }
      } else if (type === 'peer-unavailable') {
        // Failed message retries to other offline contacts also raise this error, so match the callee.
        var target = String((err && err.message) || '');
        if (lookupPending && target.indexOf(lookupPending.id) !== -1) lookupPending.finish(null);
        if (call && callState === 'ringing' && callId && target.indexOf(callId) !== -1) {
          toast('Կոնտակտը հասանելի չէ (հավանաբար օֆլայն է)');
          endCall(false);
        }
      } else if (type === 'invalid-id' || type === 'browser-incompatible') {
        openSetup('ID-ն ընդունված չէ։ Փորձիր ուրիշ ID։');
      } else {
        setStatus(false, 'Կապ չկա');
      }
    });
  }

  // Asks an online person for their name and photo without adding them as a contact.
  var lookupPending = null;
  function lookupProfile(id, cb) {
    if (!peer || !online) { cb(null); return; }
    var done = false, conn = null, timer = null;
    function finish(r) {
      if (done) return;
      done = true; clearTimeout(timer);
      if (lookupPending && lookupPending.id === id) lookupPending = null;
      try { if (conn) conn.close(); } catch (e) {}
      cb(r);
    }
    lookupPending = { id: id, finish: finish };
    timer = setTimeout(function () { finish(null); }, 12000);
    try { conn = peer.connect(id, { reliable: true }); } catch (e) { finish(null); return; }
    conn.on('data', function (d) {
      if (d && d.t === 'hello') {
        finish({ name: typeof d.name === 'string' ? d.name.trim().slice(0, 30) : '', photo: okPhoto(d.p) ? d.p : '' });
      }
    });
    conn.on('error', function () { finish(null); });
  }

  function tick() {
    if (!me || !$('#setup').hidden) return;
    if (!peer || peer.destroyed) { startPeer(); return; }
    if (peer.disconnected) { try { peer.reconnect(); } catch (e) {} return; }
    if (online) Object.keys(msgs).forEach(flush);
    if (current) { sendRead(current); renderChatHeader(); }
    purgeStories();
  }
  setInterval(tick, 8000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) tick(); });
  window.addEventListener('online', tick);
  // Called from the native service every ~15 s so the link stays alive even when the page is throttled in the background.
  window.__keepAlive = function () {
    try { if (peer && peer.socket && peer.socket.send && !peer.disconnected) peer.socket.send({ type: 'HEARTBEAT' }); } catch (e) {}
    tick();
  };

  // conns[id] is a list: a contact can have several links at once (one we opened, one they opened).
  var CONNECT_PATIENCE = 40000; // how long a link may stay "connecting" before we try a fresh one
  function setupConn(conn) {
    var id = conn.peer;
    if (!conns[id]) conns[id] = [];
    if (!conn._t) conn._t = Date.now();
    conns[id].push(conn);
    conn.on('open', function () {
      try { conn.send({ t: 'hello', name: me.name, p: me.photo || '' }); } catch (e) {}
      flush(id);
      if (current === id) { renderChatHeader(); sendRead(id); }
    });
    conn.on('data', function (d) { onData(id, d); });
    function drop() {
      var l = conns[id] || [];
      var k = l.indexOf(conn);
      if (k !== -1) l.splice(k, 1);
      var cc = contacts[id];
      if (cc) { cc.seen = Date.now(); saveContacts(); }
      if (current === id) renderChatHeader();
    }
    conn.on('close', drop);
    conn.on('error', drop);
  }
  function openConn(id) {
    var l = conns[id] || [];
    for (var k = l.length - 1; k >= 0; k--) { if (l[k].open) return l[k]; }
    return null;
  }
  function connectTo(id) {
    var ready = openConn(id);
    if (ready) return ready;
    var l = conns[id] || [];
    for (var k = 0; k < l.length; k++) {
      if (Date.now() - l[k]._t < CONNECT_PATIENCE) return l[k]; // still trying, do not restart it
    }
    l.slice().forEach(function (c) { try { c.close(); } catch (e) {} });
    conns[id] = [];
    if (!peer || !online) return null;
    var nc = peer.connect(id, { reliable: true });
    nc._t = Date.now();
    setupConn(nc);
    return nc;
  }
  function sendCtl(id, obj) {
    var c = openConn(id);
    if (c) { try { c.send(obj); } catch (e) {} }
  }
  function flush(id) {
    if (!online) return;
    flushStories(id);
    var list = pending(id);
    var dels = (msgs[id] || []).filter(function (m) { return m.m && m.d && m.dp; });
    if (!list.length && !dels.length) return;
    var c = connectTo(id);
    if (!c || !c.open) return;
    // A link can look open but be dead after a network change. If messages stay unconfirmed, start a fresh link.
    var stuck = list.some(function (m) { return (m.n || 0) >= 3; });
    if (stuck) {
      list.forEach(function (m) { m.n = 0; });
      saveMsgs();
      (conns[id] || []).slice().forEach(function (x) { try { x.close(); } catch (e) {} });
      conns[id] = [];
      connectTo(id);
      return;
    }
    dels.forEach(function (m) { try { c.send({ t: 'del', i: m.i }); } catch (e) {} });
    list.forEach(function (m) {
      if (m.k) {
        if (busyMedia[m.i]) return;
        m.n = (m.n || 0) + 1;
        sendMedia(c, m);
        return;
      }
      m.n = (m.n || 0) + 1;
      var p = { t: 'msg', i: m.i, x: m.x, ts: m.ts };
      if (m.q) p.q = { i: m.q.i, x: m.q.x, m: !!m.q.m };
      try { c.send(p); } catch (e) {}
    });
  }

  /* ---------- photos and voice notes over the same link ---------- */
  var CHUNK = 14000, MAX_CHUNKS = 600;
  var AUD_OK = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/aac'];
  function cleanQuote(q) {
    if (q && typeof q.i === 'string' && typeof q.x === 'string') return { i: q.i.slice(0, 40), x: q.x.slice(0, 200), m: !q.m };
    return null;
  }
  function clampInt(v, lo, hi) { v = Math.round(Number(v)); if (!isFinite(v)) return 0; return Math.max(lo, Math.min(hi, v)); }

  function sendMedia(c, m) {
    busyMedia[m.i] = true;
    idbGet(m.i, function (blob) {
      if (!blob) { busyMedia[m.i] = false; m.s = 'x'; saveMsgs(); if (current === currentOf(m)) renderChat(); return; }
      var fr = new FileReader();
      fr.onerror = function () { busyMedia[m.i] = false; };
      fr.onload = function () {
        var s = String(fr.result), b64 = s.slice(s.indexOf(',') + 1), n = Math.ceil(b64.length / CHUNK);
        try {
          var h = { t: 'mh', i: m.i, k: m.k, mime: blob.type || '', n: n, ts: m.ts };
          if (m.w) h.w = m.w;
          if (m.h) h.h = m.h;
          if (m.dur) h.dur = m.dur;
          if (m.q) h.q = { i: m.q.i, x: m.q.x, m: !!m.q.m };
          c.send(h);
          for (var j = 0; j < n; j++) c.send({ t: 'mc', i: m.i, s: j, d: b64.slice(j * CHUNK, (j + 1) * CHUNK) });
        } catch (e) {}
        busyMedia[m.i] = false;
      };
      fr.readAsDataURL(blob);
    });
  }
  function currentOf(m) {
    var ids = Object.keys(msgs);
    for (var k = 0; k < ids.length; k++) { if (msgs[ids[k]].indexOf(m) !== -1) return ids[k]; }
    return null;
  }
  function onMediaHeader(id, d) {
    if (typeof d.i !== 'string' || d.i.length > 40) return;
    if (d.k !== 'img' && d.k !== 'aud' && d.k !== 'story') return;
    var n = d.n | 0;
    if (n < 1 || n > MAX_CHUNKS) return;
    if (d.k === 'story') { if (hasStory(d.i)) { sendCtl(id, { t: 'sack', i: d.i }); return; } }
    else if (findMsg(id, d.i)) { sendCtl(id, { t: 'ack', i: d.i }); return; }
    var key = id + ':' + d.i;
    if (incomingMedia[key]) return;
    incomingMedia[key] = { h: d, parts: new Array(n), got: 0 };
    setTimeout(function () { delete incomingMedia[key]; }, 90000);
  }
  function onMediaChunk(id, d) {
    var key = id + ':' + d.i, rec = incomingMedia[key];
    if (!rec) return;
    var s = d.s | 0;
    if (s < 0 || s >= rec.parts.length || typeof d.d !== 'string' || d.d.length > CHUNK + 100) return;
    if (rec.parts[s] === undefined) { rec.parts[s] = d.d; rec.got++; }
    if (rec.got < rec.parts.length) return;
    delete incomingMedia[key];
    finishMedia(id, rec.h, rec.parts.join(''));
  }
  function finishMedia(id, h, b64) {
    var bytes;
    try {
      var bin = atob(b64);
      bytes = new Uint8Array(bin.length);
      for (var k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
    } catch (e) { return; }
    var base = String(h.mime || '').split(';')[0];
    var mime = (h.k === 'img' || h.k === 'story') ? 'image/jpeg' : (AUD_OK.indexOf(base) !== -1 ? String(h.mime) : 'audio/webm');
    var blob = new Blob([bytes], { type: mime });
    if (h.k === 'story') {
      idbPut('s:' + h.i, blob, function () { addStory(id, { i: h.i, k: 'img', x: h.x, ttl: h.ttl }); });
      return;
    }
    idbPut(h.i, blob, function () {
      if (findMsg(id, h.i)) { sendCtl(id, { t: 'ack', i: h.i }); return; }
      var m = { i: h.i, m: false, k: h.k, x: '', ts: Date.now() };
      if (h.k === 'img') { m.w = clampInt(h.w, 0, 4000); m.h = clampInt(h.h, 0, 4000); }
      else m.dur = Math.min(600, Math.max(0, Number(h.dur) || 0));
      var q = cleanQuote(h.q); if (q) m.q = q;
      chatOf(id).push(m);
      var ct = ensureContact(id);
      if (current === id) ct.unread = 0; else ct.unread = (ct.unread || 0) + 1;
      saveMsgs(); saveContacts();
      sendCtl(id, { t: 'ack', i: h.i });
      native('notifyMessage', id, nameOf(id), previewOf(m));
      if (current === id) renderChat(); else if (!current) renderHome();
    });
  }

  function onData(id, d) {
    if (!d || typeof d !== 'object') return;
    if (contacts[id]) contacts[id].seen = Date.now();
    if (d.t === 'hello') {
      var c = ensureContact(id), changed = false;
      if (typeof d.name === 'string' && d.name.trim() && !c.custom) {
        c.name = d.name.trim().slice(0, 30);
        changed = true;
      }
      if (typeof d.p === 'string') {
        var np = okPhoto(d.p) ? d.p : '';
        if (np !== (c.photo || '')) { c.photo = np; changed = true; }
      }
      if (changed) {
        saveContacts();
        if (current === id) renderChatHeader(); else if (!current) renderHome();
      }
    } else if (d.t === 'msg') {
      if (typeof d.i !== 'string' || d.i.length > 40 || typeof d.x !== 'string') return;
      sendCtl(id, { t: 'ack', i: d.i });
      if (findMsg(id, d.i)) return;
      var ct = ensureContact(id);
      var nm = { i: d.i, m: false, x: d.x.slice(0, 4000), ts: Date.now() };
      var q0 = cleanQuote(d.q); if (q0) nm.q = q0;
      chatOf(id).push(nm);
      if (current === id) { ct.unread = 0; } else { ct.unread = (ct.unread || 0) + 1; }
      typingAt[id] = 0;
      saveMsgs(); saveContacts();
      native('notifyMessage', id, nameOf(id), d.x.slice(0, 300)); // shown only when the app is not on screen
      if (current === id) renderChat(); else if (!current) renderHome();
    } else if (d.t === 'mh') {
      onMediaHeader(id, d);
    } else if (d.t === 'mc') {
      onMediaChunk(id, d);
    } else if (d.t === 'ack') {
      var l2 = msgs[id] || [], ch2 = false;
      for (var j = 0; j < l2.length; j++) {
        if (l2[j].i === d.i && l2[j].m && l2[j].s !== 'd' && l2[j].s !== 'r') { l2[j].s = 'd'; ch2 = true; }
      }
      if (ch2) { saveMsgs(); if (current === id) renderChat(); }
    } else if (d.t === 'read') {
      if (!Array.isArray(d.ids)) return;
      var set = {};
      d.ids.slice(0, 300).forEach(function (x) { if (typeof x === 'string') set[x] = 1; });
      var ch3 = false;
      (msgs[id] || []).forEach(function (m) { if (m.m && !m.d && set[m.i] && m.s !== 'r') { m.s = 'r'; ch3 = true; } });
      if (ch3) { saveMsgs(); if (current === id) renderChat(); }
    } else if (d.t === 'typing') {
      typingAt[id] = Date.now(); typingKind[id] = d.a ? 'a' : 't';
      if (current === id) {
        renderChatHeader();
        setTimeout(function () { if (current === id) renderChatHeader(); }, 4700);
      }
    } else if (d.t === 'react') {
      var rm = typeof d.i === 'string' ? findMsg(id, d.i) : null;
      if (!rm || rm.d) return;
      rm.rx = rm.rx || {};
      rm.rx.b = typeof d.e === 'string' ? d.e.slice(0, 8) : '';
      saveMsgs();
      if (current === id) renderChat();
    } else if (d.t === 'del') {
      var dm = typeof d.i === 'string' ? findMsg(id, d.i) : null;
      if (dm && !dm.m && !dm.d) {
        if (dm.k) dropMedia(dm.i);
        dm.d = true; dm.x = ''; dm.k = undefined; dm.q = undefined; dm.rx = undefined;
        saveMsgs();
        if (current === id) renderChat(); else if (!current) renderHome();
      }
      if (typeof d.i === 'string') sendCtl(id, { t: 'delack', i: d.i });
    } else if (d.t === 'delack') {
      var am = typeof d.i === 'string' ? findMsg(id, d.i) : null;
      if (am && am.dp) { delete am.dp; saveMsgs(); }
    } else if (d.t === 'story' || d.t === 'sack' || d.t === 'sview') {
      onStoryData(id, d);
    } else if (d.t === 'bye') {
      if (incoming && incoming.peer === id) { dismissIncoming(); toast('Բաց թողնված զանգ'); missedCall(id); native('callEnded'); }
      if (call && callId === id) endCall(false);
    }
  }

  /* ---------- calls ---------- */
  function mediaConstraints(video) {
    return {
      audio: { echoCancellation: true, noiseSuppression: true },
      video: video ? { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } : false
    };
  }
  function nameOf(id) { var c = contacts[id]; return c ? (c.name || id) : id; }

  function showCall(id, video) {
    callId = id; callVideo = video;
    $('#call-name').textContent = nameOf(id);
    paintAvatar($('#call-initial'), contacts[id] || { id: id, name: nameOf(id) });
    $('#c-cam').parentNode.hidden = !video;
    $('#c-mic').className = 'round';
    $('#c-cam').className = 'round';
    var local = $('#local');
    local.srcObject = video ? localStream : null;
    local.hidden = !video;
    $('#call-avatar').hidden = false;
    $('#remote').srcObject = null;
    setCallState('ringing', 'Զանգում ենք…');
    $('#call').hidden = false;
    native('keepScreenOn', true);
  }
  function setCallState(state, text) {
    callState = state;
    $('#call-state').textContent = text;
  }

  function startCall(id, video) {
    if (call || incoming) { toast('Արդեն զանգ կա'); return; }
    if (!peer || !online) { toast('Կապ չկա, փորձիր մի փոքր հետո'); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast('Այս սարքում զանգը հասանելի չէ'); return; }
    navigator.mediaDevices.getUserMedia(mediaConstraints(video)).then(function (stream) {
      if (call || incoming) { stopStream(stream); return; }
      localStream = stream;
      showCall(id, video);
      connectTo(id);
      var c = peer.call(id, stream, { metadata: { video: video, name: me.name } });
      if (!c) { toast('Չհաջողվեց զանգել'); endCall(false); return; }
      bindCall(c);
      startRing(false);
      setTimeout(function () { watchIce(c); }, 0);
      clearTimeout(ringTimer);
      ringTimer = setTimeout(function () {
        if (call && callState === 'ringing') { toast('Պատասխան չեղավ'); endCall(true); }
      }, 45000);
    }).catch(function () {
      toast('Տեսախցիկի կամ խոսափողի թույլտվությունը չի տրվել');
    });
  }

  function bindCall(c) {
    call = c;
    c.on('stream', function (rs) {
      if (call !== c) return;
      clearTimeout(ringTimer);
      stopRing();
      var r = $('#remote');
      r.muted = false; r.volume = 1;
      r.srcObject = rs;
      var p = r.play(); if (p && p.catch) p.catch(function () {});
      $('#call-avatar').hidden = rs.getVideoTracks().length > 0;
      if (callState !== 'active') {
        callStart = Date.now();
        clearInterval(callTimer);
        callTimer = setInterval(updateTimer, 1000);
        updateTimer();
        callState = 'active';
      }
    });
    c.on('close', function () { if (call === c) endCall(false); });
    c.on('error', function () { if (call === c) endCall(false); });
  }
  // Shows how the network link is doing while connecting, and gives up cleanly if it fails.
  function watchIce(c) {
    var pc = c.peerConnection;
    if (!pc || !pc.addEventListener) return;
    pc.addEventListener('iceconnectionstatechange', function () {
      if (call !== c) return;
      var s = pc.iceConnectionState;
      if (callState !== 'active') {
        $('#call-state').textContent = (callState === 'ringing' ? 'Զանգում ենք…' : 'Կապվում ենք…') + ' (' + s + ')';
      }
      if (s === 'failed') {
        toast('Կապը չհաստատվեց։ Ցանցը չի թողնում ուղիղ կապ');
        endCall(true);
      }
    });
  }
  function updateTimer() {
    var s = Math.floor((Date.now() - callStart) / 1000);
    var m = Math.floor(s / 60), r = s % 60;
    $('#call-state').textContent = (m < 10 ? '0' : '') + m + ':' + (r < 10 ? '0' : '') + r;
  }
  function stopStream(s) { if (s) s.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} }); }

  function endCall(notify) {
    if (!call && !localStream && $('#call').hidden) return;
    var c = call, id = callId;
    call = null; callId = null; callState = '';
    clearInterval(callTimer); clearTimeout(ringTimer);
    stopRing();
    if (notify && id) sendCtl(id, { t: 'bye' });
    if (c) { try { c.close(); } catch (e) {} }
    stopStream(localStream); localStream = null;
    $('#remote').srcObject = null; $('#local').srcObject = null;
    $('#call').hidden = true;
    native('keepScreenOn', false);
    native('callEnded');
  }

  function onIncomingCall(c) {
    if (call || incoming) { try { c.close(); } catch (e) {} return; }
    incoming = c;
    var id = c.peer;
    var c0 = ensureContact(id);
    var meta = c.metadata || {};
    if (typeof meta.name === 'string' && meta.name.trim() && !c0.custom && c0.name === id) {
      c0.name = meta.name.trim().slice(0, 30); saveContacts();
    }
    var video = !!meta.video;
    $('#inc-title').textContent = nameOf(id) + ' քեզ զանգում է';
    $('#inc-kind').textContent = video ? 'Տեսազանգ' : 'Ձայնային զանգ';
    $('#dlg-incoming').dataset.video = video ? '1' : '';
    openDialog('#dlg-incoming');
    if (hasNative('incomingCall')) native('incomingCall', id, nameOf(id), video); else startRing(true);
    connectTo(id);
    clearTimeout(incomingTimer);
    incomingTimer = setTimeout(function () {
      if (incoming === c) { rejectIncoming(); missedCall(id); }
    }, 45000);
    c.on('close', function () {
      if (incoming === c) { dismissIncoming(); toast('Բաց թողնված զանգ'); missedCall(id); native('callEnded'); }
    });
  }
  function dismissIncoming() {
    clearTimeout(incomingTimer);
    stopRing();
    incoming = null;
    closeDialog('#dlg-incoming');
  }
  function rejectIncoming() {
    var c = incoming;
    if (!c) return;
    sendCtl(c.peer, { t: 'bye' });
    dismissIncoming();
    native('callEnded');
    try { c.close(); } catch (e) {}
  }
  function acceptIncoming() {
    var c = incoming;
    if (!c) return;
    var video = $('#dlg-incoming').dataset.video === '1';
    var id = c.peer;
    clearTimeout(incomingTimer);
    stopRing();
    navigator.mediaDevices.getUserMedia(mediaConstraints(video)).then(function (stream) {
      if (incoming !== c) { stopStream(stream); return; }
      incoming = null;
      closeDialog('#dlg-incoming');
      localStream = stream;
      showCall(id, video);
      setCallState('connecting', 'Կապվում ենք…');
      bindCall(c);
      c.answer(stream);
      setTimeout(function () { watchIce(c); }, 0);
      clearTimeout(ringTimer);
      ringTimer = setTimeout(function () {
        if (call === c && callState !== 'active') { toast('Կապը չհաստատվեց'); endCall(true); }
      }, 40000);
    }).catch(function () {
      toast('Տեսախցիկի կամ խոսափողի թույլտվությունը չի տրվել');
      rejectIncoming();
    });
  }
  $('#inc-yes').addEventListener('click', acceptIncoming);
  $('#inc-no').addEventListener('click', rejectIncoming);
  $('#dlg-incoming').addEventListener('cancel', function (e) { e.preventDefault(); });

  $('#c-end').addEventListener('click', function () { endCall(true); });
  $('#c-mic').addEventListener('click', function () {
    if (!localStream) return;
    var off = false;
    localStream.getAudioTracks().forEach(function (t) { t.enabled = !t.enabled; off = !t.enabled; });
    $('#c-mic').className = 'round' + (off ? ' off' : '');
    $('#c-mic').setAttribute('aria-label', off ? 'Խոսափողը միացնել' : 'Խոսափողն անջատել');
  });
  $('#c-cam').addEventListener('click', function () {
    if (!localStream) return;
    var off = false;
    localStream.getVideoTracks().forEach(function (t) { t.enabled = !t.enabled; off = !t.enabled; });
    $('#c-cam').className = 'round' + (off ? ' off' : '');
    $('#c-cam').setAttribute('aria-label', off ? 'Տեսախցիկը միացնել' : 'Տեսախցիկն անջատել');
  });

  /* ---------- dialogs ---------- */
  function openDialog(sel) { var d = $(sel); if (!d.open) { try { d.showModal(); } catch (e) { d.setAttribute('open', ''); } } }
  function closeDialog(sel) { var d = $(sel); if (d.open) { try { d.close(); } catch (e) { d.removeAttribute('open'); } } }

  // add contact
  $('#btn-add').addEventListener('click', function () {
    $('#add-id').value = ''; $('#add-name').value = '';
    $('#add-err').hidden = true;
    found = null; findSeq++; $('#add-found').hidden = true;
    openDialog('#dlg-add');
  });
  $('#add-cancel').addEventListener('click', function () { closeDialog('#dlg-add'); });
  $('#form-add').addEventListener('submit', function (e) {
    e.preventDefault();
    var id = $('#add-id').value.trim().toLowerCase();
    var name = $('#add-name').value.trim();
    var err = $('#add-err');
    if (!validId(id)) { err.textContent = 'ID-ն սխալ է։ Այն պետք է լինի 3–30 նիշ՝ լատինատառ, թվեր, «_» կամ «-»։'; err.hidden = false; return; }
    if (me && id === me.id) { err.textContent = 'Սա քո սեփական ID-ն է։'; err.hidden = false; return; }
    var c = ensureContact(id);
    if (found && found.id === id) {
      if (found.photo) c.photo = found.photo;
      if (!name && found.name && !c.custom) c.name = found.name;
    }
    if (name) { c.name = name; c.custom = true; }
    saveContacts();
    closeDialog('#dlg-add');
    renderHome();
    openChat(id);
  });

  var found = null, findSeq = 0;
  function showFound(msg, profile, id) {
    var box = $('#add-found');
    box.hidden = false;
    $('#found-text').textContent = msg;
    var av = $('#found-avatar');
    av.hidden = !profile;
    if (profile) paintAvatar(av, { id: id, name: profile.name || id, photo: profile.photo });
  }
  $('#add-id').addEventListener('input', function () { found = null; findSeq++; $('#add-found').hidden = true; });
  $('#add-find').addEventListener('click', function () {
    var id = $('#add-id').value.trim().toLowerCase();
    var err = $('#add-err');
    err.hidden = true;
    if (!validId(id)) { err.textContent = 'ID-ն սխալ է։ Այն պետք է լինի 3–30 նիշ՝ լատինատառ, թվեր, «_» կամ «-»։'; err.hidden = false; return; }
    if (me && id === me.id) { err.textContent = 'Սա քո սեփական ID-ն է։'; err.hidden = false; return; }
    var seq = ++findSeq;
    found = null;
    showFound('Փնտրում եմ…', null, id);
    lookupProfile(id, function (r) {
      if (seq !== findSeq) return;
      if (r) { found = { id: id, name: r.name, photo: r.photo }; showFound(r.name ? 'Գտնվեց՝ ' + r.name : 'Գտնվեց', r, id); }
      else showFound('Այս պահին առցանց չէ, կամ այդպիսի ID չկա։ Կարող ես ավելացնել, և նամակը կհասնի, երբ նա առցանց լինի։', null, id);
    });
  });

  // notification settings
  $('#btn-notif').addEventListener('click', function () {
    var fs = native('canFullScreen');
    $('#n-full').textContent = '3. Թույլատրել զանգը լրիվ էկրանով' + (fs === true ? ' (միացված է)' : fs === false ? ' (անջատված է)' : '');
    openDialog('#dlg-notif');
  });
  $('#n-close').addEventListener('click', function () { closeDialog('#dlg-notif'); });
  $('#n-notif').addEventListener('click', function () { native('openSettings', 'notifications'); });
  $('#n-batt').addEventListener('click', function () { native('openSettings', 'battery'); });
  $('#n-full').addEventListener('click', function () { native('openSettings', 'fullscreen'); });

  // my id
  function renderMyProfile() {
    if (!me) return;
    $('#myid-box').textContent = me.id;
    paintAvatar($('#me-avatar'), me);
    $('#photo-clear').hidden = !okPhoto(me.photo);
    var hasLock = hasNative('setAppLock');
    $('#lock-row').hidden = !hasLock;
    if (hasLock) $('#lock-toggle').textContent = native('isAppLock') === true ? 'Անջատել հավելվածի կողպումը' : 'Կողպել հավելվածը հեռախոսի ծածկագրով';
  }
  function broadcastProfile() {
    Object.keys(conns).forEach(function (id) { sendCtl(id, { t: 'hello', name: me.name, p: me.photo || '' }); });
  }
  function resizePhoto(file, cb) {
    var url = URL.createObjectURL(file), img = new Image();
    img.onload = function () {
      var S = 160, cv = document.createElement('canvas');
      cv.width = cv.height = S;
      var w = img.naturalWidth, h = img.naturalHeight, m = Math.min(w, h);
      cv.getContext('2d').drawImage(img, (w - m) / 2, (h - m) / 2, m, m, 0, 0, S, S);
      URL.revokeObjectURL(url);
      var q = 0.75, out = cv.toDataURL('image/jpeg', q);
      while (out.length > 18000 && q > 0.3) { q -= 0.1; out = cv.toDataURL('image/jpeg', q); }
      cb(okPhoto(out) ? out : null);
    };
    img.onerror = function () { URL.revokeObjectURL(url); cb(null); };
    img.src = url;
  }
  function setMyPhoto(p) {
    me.photo = p || '';
    save('me', me);
    renderMyProfile();
    broadcastProfile();
  }
  $('#photo-pick').addEventListener('click', function () { $('#photo-file').click(); });
  $('#photo-file').addEventListener('change', function () {
    var f = this.files && this.files[0];
    this.value = '';
    if (!f) return;
    resizePhoto(f, function (p) {
      if (p) { setMyPhoto(p); toast('Լուսանկարը պահվեց'); } else toast('Այս նկարը չհաջողվեց բացել');
    });
  });
  $('#photo-clear').addEventListener('click', function () { setMyPhoto(''); toast('Լուսանկարը հեռացվեց'); });
  $('#lock-toggle').addEventListener('click', function () {
    var on = native('isAppLock') === true;
    var r = native('setAppLock', !on);
    if (r === false) toast('Նախ հեռախոսի կարգավորումներում սահմանիր էկրանի կողպում (ծածկագիր, գրաֆիկական բանալի կամ մատնահետք)');
    else toast(on ? 'Կողպումն անջատվեց' : 'Կողպումը միացվեց');
    renderMyProfile();
  });
  $('#btn-myid').addEventListener('click', function () {
    $('#myid-share').hidden = !(window.Android && window.Android.share);
    renderMyProfile();
    openDialog('#dlg-myid');
  });
  $('#myid-close').addEventListener('click', function () { closeDialog('#dlg-myid'); });
  $('#myid-share').addEventListener('click', function () {
    if (window.Android && window.Android.share && me) {
      window.Android.share('Գրիր ինձ KHOSQ-ով։ Իմ ID-ն՝ ' + me.id);
    }
  });
  $('#myid-copy').addEventListener('click', function () {
    var text = me ? me.id : '';
    function fallback() {
      var ta = el('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(ta);
      toast(ok ? 'Պատճենվեց' : 'Երկար սեղմիր ID-ի վրա և պատճենիր');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('Պատճենվեց'); }, fallback);
    } else { fallback(); }
  });

  // contact details
  var delArmed = false, contactId = null;
  function openContact(id) {
    id = (typeof id === 'string' && id) ? id : current;
    if (!id) return;
    contactId = id;
    var c = ensureContact(id);
    $('#contact-title').textContent = c.name || c.id;
    $('#contact-id').textContent = c.id;
    $('#contact-name').value = c.name || '';
    delArmed = false;
    $('#contact-del').textContent = 'Ջնջել կոնտակտը';
    $('#contact-hint').hidden = true;
    $('#contact-search').hidden = !current;
    openDialog('#dlg-contact');
  }
  $('#chat-title').addEventListener('click', function () { openContact(); });
  $('#btn-more').addEventListener('click', function () { openContact(); });
  $('#chat-title').addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openContact(); } });
  $('#contact-close').addEventListener('click', function () { closeDialog('#dlg-contact'); });
  $('#contact-save').addEventListener('click', function () {
    var c = ensureContact(contactId);
    var n = $('#contact-name').value.trim();
    if (n) { c.name = n; c.custom = true; saveContacts(); if (current === contactId) renderChatHeader(); renderHome(); }
    closeDialog('#dlg-contact');
  });
  $('#contact-del').addEventListener('click', function () {
    if (!delArmed) { delArmed = true; $('#contact-del').textContent = 'Այո, ջնջել'; $('#contact-hint').hidden = false; return; }
    var id = contactId;
    (msgs[id] || []).forEach(function (m) { if (m.k) dropMedia(m.i); });
    removeStoriesOf(id);
    delete contacts[id]; delete msgs[id];
    saveContacts(); saveMsgs();
    closeDialog('#dlg-contact');
    if (current === id) closeChat(); else renderHome();
    toast('Կոնտակտը ջնջվեց');
  });

    /* ---------- reply bar ---------- */
  function setReply(m) {
    replyTo = m ? { i: m.i, x: clip(previewOf(m), 120), m: !!m.m } : null;
    $('#replybar').hidden = !replyTo;
    if (replyTo) {
      $('#rb-who').textContent = replyTo.m ? 'Դու' : nameOf(current);
      $('#rb-text').textContent = replyTo.x;
      $('#in-msg').focus();
    }
  }
  $('#rb-x').addEventListener('click', function () { setReply(null); });

  /* ---------- message menu: reply, react, copy, delete ---------- */
  var menuId = null;
  var REACTS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
  (function () {
    var row = $('#react-row');
    REACTS.forEach(function (e) {
      var b = el('button', 'react-btn', e);
      b.type = 'button';
      b.addEventListener('click', function () { if (menuId) setReaction(menuId, e); closeDialog('#dlg-msg'); });
      row.appendChild(b);
    });
  })();
  function openMsgMenu(i) {
    var m = current && findMsg(current, i);
    if (!m || m.d) return;
    menuId = i;
    $('#mm-copy').hidden = !!m.k;
    $('#mm-del-all').hidden = !m.m;
    openDialog('#dlg-msg');
  }
  function setReaction(i, e) {
    var m = current && findMsg(current, i);
    if (!m || m.d) return;
    m.rx = m.rx || {};
    m.rx.a = m.rx.a === e ? '' : e;
    saveMsgs();
    if (openConn(current)) sendCtl(current, { t: 'react', i: i, e: m.rx.a });
    else toast('Ռեակցիան կերևա, երբ կապը վերականգնվի');
    renderChat();
  }
  $('#mm-reply').addEventListener('click', function () {
    var m = current && findMsg(current, menuId);
    closeDialog('#dlg-msg');
    if (m) setReply(m);
  });
  $('#mm-copy').addEventListener('click', function () {
    var m = current && findMsg(current, menuId);
    closeDialog('#dlg-msg');
    if (!m || !m.x) return;
    function fb() {
      var ta = el('textarea'); ta.value = m.x; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(ta);
      toast(ok ? 'Պատճենվեց' : 'Չհաջողվեց պատճենել');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(m.x).then(function () { toast('Պատճենվեց'); }, fb);
    else fb();
  });
  $('#mm-del-me').addEventListener('click', function () {
    var l = msgs[current] || [], k;
    for (k = 0; k < l.length; k++) { if (l[k].i === menuId) break; }
    closeDialog('#dlg-msg');
    if (k === l.length) return;
    if (l[k].k) dropMedia(l[k].i);
    l.splice(k, 1);
    saveMsgs();
    renderChat();
  });
  $('#mm-del-all').addEventListener('click', function () {
    var m = current && findMsg(current, menuId);
    closeDialog('#dlg-msg');
    if (!m || !m.m || m.d) return;
    if (m.k) dropMedia(m.i);
    m.d = true; m.dp = true; m.x = ''; m.k = undefined; m.q = undefined; m.rx = undefined;
    saveMsgs();
    renderChat();
    flush(current);
  });
  $('#mm-close').addEventListener('click', function () { closeDialog('#dlg-msg'); });

  /* ---------- emoji panel ---------- */
  var EMOJIS = ('😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 😉 😍 🥰 😘 😋 😎 🤩 🥳 😏 😒 😞 😔 😢 😭 😤 😡 🤯 😱 😴 🤔 🙄 😬 🤗 🤭 🫡 ' +
    '👍 👎 👌 ✌️ 🤞 🙏 👏 🙌 💪 👋 🤝 ❤️ 🧡 💛 💚 💙 💜 🖤 💔 🔥 ✨ 🎉 🎂 🎁 ⭐ 💯 ✅ ❌ 👀 🌹 ☀️ 🌙 ☕ 🍕 🍰 ⚽ 🎵 🚗 ✈️ 🏠 📞 💬').split(' ');
  (function () {
    var box = $('#emoji');
    EMOJIS.forEach(function (e) {
      var b = el('button', 'emo', e);
      b.type = 'button';
      b.addEventListener('click', function () {
        var ta = $('#in-msg');
        var a = typeof ta.selectionStart === 'number' ? ta.selectionStart : ta.value.length;
        var z = typeof ta.selectionEnd === 'number' ? ta.selectionEnd : a;
        ta.value = ta.value.slice(0, a) + e + ta.value.slice(z);
        ta.selectionStart = ta.selectionEnd = a + e.length;
        autoGrow(); updateComposerMode();
      });
      box.appendChild(b);
    });
  })();
  function setEmoji(on) {
    $('#emoji').hidden = !on;
    $('#btn-emoji').textContent = on ? '⌨️' : '😊';
    $('#btn-emoji').setAttribute('aria-label', on ? 'Ստեղնաշար' : 'Էմոջի');
  }
  $('#btn-emoji').addEventListener('click', function () {
    if ($('#emoji').hidden) { $('#in-msg').blur(); setEmoji(true); }
    else { setEmoji(false); $('#in-msg').focus(); }
  });
  $('#in-msg').addEventListener('focus', function () { setEmoji(false); });
  $('#log').addEventListener('click', function () { if (!$('#emoji').hidden) setEmoji(false); });

  /* ---------- photos ---------- */
  function compressImage(file, cb) {
    var url = URL.createObjectURL(file), img = new Image();
    img.onload = function () {
      var w = img.naturalWidth, h = img.naturalHeight;
      var k = Math.min(1, 1280 / Math.max(w, h));
      var cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(h * k));
      var cv = document.createElement('canvas');
      cv.width = cw; cv.height = ch;
      var cx = cv.getContext('2d');
      cx.fillStyle = '#fff'; cx.fillRect(0, 0, cw, ch);
      cx.drawImage(img, 0, 0, cw, ch);
      URL.revokeObjectURL(url);
      var q = 0.78;
      (function tryQ() {
        cv.toBlob(function (b) {
          if (!b) { cb(null); return; }
          if (b.size > 450000 && q > 0.35) { q -= 0.12; tryQ(); return; }
          cb({ blob: b, w: cw, h: ch });
        }, 'image/jpeg', q);
      })();
    };
    img.onerror = function () { URL.revokeObjectURL(url); cb(null); };
    img.src = url;
  }
  function pushMedia(to, m, blob) {
    idbPut(m.i, blob, function () {
      if (replyTo && current === to) { m.q = replyTo; setReply(null); }
      chatOf(to).push(m);
      saveMsgs();
      if (current === to) renderChat(true);
      flush(to);
    });
  }
  $('#btn-attach').addEventListener('click', function () { $('#img-file').click(); });
  $('#img-file').addEventListener('change', function () {
    var f = this.files && this.files[0];
    this.value = '';
    if (!f || !current) return;
    var to = current;
    compressImage(f, function (r) {
      if (!r) { toast('Այս նկարը չհաջողվեց բացել'); return; }
      pushMedia(to, { i: uid(), m: true, k: 'img', x: '', ts: Date.now(), s: 'p', w: r.w, h: r.h }, r.blob);
    });
  });
  function openViewer(src) { $('#viewer-img').src = src; openDialog('#dlg-img'); }
  $('#viewer-close').addEventListener('click', function () { closeDialog('#dlg-img'); });

  /* ---------- voice notes ---------- */
  var rec = null;
  function pickMime() {
    var c = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
    for (var k = 0; k < c.length; k++) { try { if (MediaRecorder.isTypeSupported(c[k])) return c[k]; } catch (e) {} }
    return '';
  }
  function showRecUI(on) {
    $('#composer').hidden = on;
    $('#rec').hidden = !on;
    if (on) setEmoji(false);
  }
  function startRec() {
    if (!current || rec) return;
    if (call || incoming) { toast('Զանգի ժամանակ ձայնագրել հնարավոր չէ'); return; }
    if (!window.MediaRecorder || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast('Այս սարքում ձայնագրությունը հասանելի չէ'); return; }
    var to = current;
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }).then(function (stream) {
      if (rec || current !== to) { stopStream(stream); return; }
      var mime = pickMime(), mr;
      try { mr = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); }
      catch (e) { stopStream(stream); toast('Ձայնագրությունը չսկսվեց'); return; }
      var r = { mr: mr, chunks: [], t0: Date.now(), stream: stream, to: to, cancel: false, timer: null };
      rec = r;
      mr.ondataavailable = function (e) { if (e.data && e.data.size) r.chunks.push(e.data); };
      mr.onstop = function () {
        clearInterval(r.timer);
        stopStream(r.stream);
        if (rec === r) rec = null;
        showRecUI(false);
        if (r.cancel) return;
        var dur = (Date.now() - r.t0) / 1000;
        if (dur < 0.7 || !r.chunks.length) { toast('Շատ կարճ է'); return; }
        var blob = new Blob(r.chunks, { type: (r.mr.mimeType || mime || 'audio/webm') });
        pushMedia(r.to, { i: uid(), m: true, k: 'aud', x: '', ts: Date.now(), s: 'p', dur: Math.round(dur) }, blob);
      };
      mr.start(1000);
      showRecUI(true);
      $('#rec-t').textContent = '0:00';
      var last = 0;
      r.timer = setInterval(function () {
        var s = (Date.now() - r.t0) / 1000;
        $('#rec-t').textContent = fmtDur(s);
        if (Date.now() - last > 2500) { last = Date.now(); sendCtl(r.to, { t: 'typing', a: 1 }); }
        if (s >= 120) stopRec(false);
      }, 500);
    }).catch(function () { toast('Խոսափողի թույլտվությունը չի տրվել'); });
  }
  function stopRec(cancel) {
    if (!rec) return;
    rec.cancel = !!cancel;
    try { rec.mr.stop(); } catch (e) { clearInterval(rec.timer); stopStream(rec.stream); rec = null; showRecUI(false); }
  }
  function cancelRec() { stopRec(true); }
  $('#btn-mic').addEventListener('click', startRec);
  $('#rec-cancel').addEventListener('click', function () { stopRec(true); });
  $('#rec-send').addEventListener('click', function () { stopRec(false); });

  /* ---------- search inside a chat ---------- */
  function closeSearch() {
    searchQ = ''; $('#in-search').value = ''; $('#searchbar').hidden = true;
    if (current) renderChat(true);
  }
  $('#contact-search').addEventListener('click', function () {
    closeDialog('#dlg-contact');
    if (!current) return;
    $('#searchbar').hidden = false;
    $('#in-search').focus();
  });
  $('#in-search').addEventListener('input', function () { searchQ = this.value.trim(); renderChat(true); });
  $('#search-x').addEventListener('click', closeSearch);

  /* ---------- stories: 24-hour posts for contacts, sent while they are online ---------- */
  var STORY_TTL = 24 * 3600 * 1000;
  var STORY_BG = [
    'linear-gradient(160deg,#FFC84A,#FF6B57)', 'linear-gradient(160deg,#4F7BFF,#9B4BFF)',
    'linear-gradient(160deg,#12C2A3,#2E5BFF)', 'linear-gradient(160deg,#FF5E8A,#FF9A3D)',
    'linear-gradient(160deg,#1B2466,#5B2A86)', 'linear-gradient(160deg,#0F2027,#2C5364)'
  ];
  var stories = load('stories', []);   // { i, from ('me' or contact id), k:'img'|'txt', x, bg, ts, exp, seen, sentTo[], views[] }
  var busyStory = {}, storyOpen = false, sv = null;

  function saveStories() { save('stories', stories); }
  function hasStory(i) {
    for (var k = 0; k < stories.length; k++) { if (stories[k].i === i) return true; }
    return false;
  }
  function purgeStories() {
    var now = Date.now(), keep = [], dropped = false;
    stories.forEach(function (s) {
      if (s.exp > now && (s.from === 'me' || contacts[s.from])) keep.push(s);
      else { dropped = true; if (s.k === 'img') dropMedia('s:' + s.i); }
    });
    if (dropped) { stories = keep; saveStories(); if (!current && !storyOpen) renderStories(); }
  }
  function removeStoriesOf(id) {
    stories = stories.filter(function (s) {
      if (s.from !== id) return true;
      if (s.k === 'img') dropMedia('s:' + s.i);
      return false;
    });
    saveStories();
  }

  /* receiving */
  function addStory(from, o) {
    if (!contacts[from] || typeof o.i !== 'string' || o.i.length > 40 || hasStory(o.i)) {
      if (contacts[from] && typeof o.i === 'string') sendCtl(from, { t: 'sack', i: o.i });
      return;
    }
    var ttl = Math.max(60000, Math.min(STORY_TTL, Number(o.ttl) || STORY_TTL));
    var s = {
      i: o.i, from: from, k: o.k === 'img' ? 'img' : 'txt',
      x: clip(String(o.x || ''), 280), bg: clampInt(o.bg, 0, STORY_BG.length - 1),
      ts: Date.now(), exp: Date.now() + ttl, seen: false
    };
    stories.push(s);
    saveStories();
    sendCtl(from, { t: 'sack', i: s.i });
    if (!current && !storyOpen) renderStories();
  }
  function onStoryData(id, d) {
    if (!contacts[id]) return;
    if (d.t === 'story') {
      if (typeof d.i !== 'string' || typeof d.x !== 'string') return;
      addStory(id, { i: d.i, k: 'txt', x: d.x, bg: d.bg, ttl: d.ttl });
    } else if (d.t === 'sack') {
      stories.forEach(function (s) {
        if (s.from === 'me' && s.i === d.i) { s.sentTo = s.sentTo || []; if (s.sentTo.indexOf(id) === -1) { s.sentTo.push(id); saveStories(); } }
      });
    } else if (d.t === 'sview') {
      stories.forEach(function (s) {
        if (s.from === 'me' && s.i === d.i) {
          s.views = s.views || [];
          if (s.views.indexOf(id) === -1) { s.views.push(id); saveStories(); if (storyOpen && sv && sv.from === 'me') paintStoryFoot(); }
        }
      });
    }
  }

  /* sending: every contact that is online and has not confirmed yet */
  function flushStories(id) {
    var c = openConn(id);
    if (!c) return;
    var now = Date.now();
    stories.forEach(function (s) {
      if (s.from !== 'me' || s.exp <= now || (s.sentTo || []).indexOf(id) !== -1) return;
      var key = id + ':' + s.i;
      if (busyStory[key]) return;
      if (s.k === 'txt') {
        try { c.send({ t: 'story', i: s.i, x: s.x, bg: s.bg, ttl: s.exp - now }); } catch (e) {}
        return;
      }
      busyStory[key] = true;
      idbGet('s:' + s.i, function (blob) {
        if (!blob) { busyStory[key] = false; return; }
        var fr = new FileReader();
        fr.onerror = function () { busyStory[key] = false; };
        fr.onload = function () {
          var str = String(fr.result), b64 = str.slice(str.indexOf(',') + 1), n = Math.ceil(b64.length / CHUNK);
          try {
            c.send({ t: 'mh', i: s.i, k: 'story', mime: 'image/jpeg', n: n, x: s.x, ttl: s.exp - Date.now() });
            for (var j = 0; j < n; j++) c.send({ t: 'mc', i: s.i, s: j, d: b64.slice(j * CHUNK, (j + 1) * CHUNK) });
          } catch (e) {}
          setTimeout(function () { busyStory[key] = false; }, 20000);
        };
        fr.readAsDataURL(blob);
      });
    });
  }
  function broadcastStories() { Object.keys(contacts).forEach(flushStories); }

  /* the rail on the home screen */
  function storyTile(label, who, state, onTap, plusTap) {
    var b = el('button', 'story-tile');
    b.type = 'button';
    var ring = el('span', 'story-ring ' + state);
    ring.appendChild(avatarEl(who));
    if (plusTap) {
      var p = el('span', 'plus', '+');
      p.setAttribute('role', 'button');
      p.setAttribute('aria-label', 'Նոր սթորի');
      p.addEventListener('click', function (e) { e.stopPropagation(); plusTap(); });
      ring.appendChild(p);
    }
    b.appendChild(ring);
    b.appendChild(el('span', 'story-name', label));
    b.addEventListener('click', onTap);
    return b;
  }
  function renderStories() {
    var box = $('#stories');
    if (!box) return;
    box.textContent = '';
    var now = Date.now();
    var mine = stories.filter(function (s) { return s.from === 'me' && s.exp > now; });
    box.appendChild(storyTile('Իմ սթորին', me, mine.length ? 'new' : 'none',
      function () { if (mine.length) openStory('me'); else openStoryComposer(); }, openStoryComposer));
    var by = {};
    stories.forEach(function (s) { if (s.from !== 'me' && s.exp > now && contacts[s.from]) (by[s.from] = by[s.from] || []).push(s); });
    Object.keys(by).map(function (id) {
      var l = by[id];
      return { id: id, unseen: l.some(function (s) { return !s.seen; }), ts: Math.max.apply(null, l.map(function (s) { return s.ts; })) };
    }).sort(function (a, b) { return (b.unseen - a.unseen) || (b.ts - a.ts); }).forEach(function (o) {
      var c = contacts[o.id];
      box.appendChild(storyTile(c.name || o.id, c, o.unseen ? 'new' : 'seen', function () { openStory(o.id); }));
    });
    $('#stories').classList.toggle('lonely', box.children.length === 1);
  }
  function renderHome() { renderHomeList(); renderStories(); }

  /* the viewer */
  function storyDur(s) { return s.k === 'txt' ? Math.min(9000, 4500 + s.x.length * 40) : 5500; }
  function openStory(from) {
    var now = Date.now();
    var list = stories.filter(function (s) { return s.from === from && s.exp > now; }).sort(function (a, b) { return a.ts - b.ts; });
    if (!list.length) return;
    var idx = 0;
    if (from !== 'me') { for (var k = 0; k < list.length; k++) { if (!list[k].seen) { idx = k; break; } } }
    sv = { from: from, list: list, idx: idx, el: 0, last: 0, hold: false, raf: 0, typing: false };
    storyOpen = true;
    $('#story').hidden = false;
    showStoryItem();
  }
  function closeStory() {
    if (sv) cancelAnimationFrame(sv.raf);
    sv = null; storyOpen = false;
    $('#story').hidden = true;
    $('#story-stage').textContent = '';
    renderStories();
  }
  function curStory() { return sv && sv.list[sv.idx]; }
  function showStoryItem() {
    var s = curStory();
    if (!s) { closeStory(); return; }
    cancelAnimationFrame(sv.raf);
    sv.el = 0; sv.last = performance.now();
    var bars = $('#story-bars');
    bars.textContent = '';
    sv.list.forEach(function (x, k) {
      var b = el('span', 'sbar'), f = el('span', 'sfill');
      f.style.width = k < sv.idx ? '100%' : '0%';
      b.appendChild(f); bars.appendChild(b);
    });
    var who = sv.from === 'me' ? me : contacts[sv.from];
    var head = $('#story-who');
    head.textContent = '';
    head.appendChild(avatarEl(who));
    var t = el('span', 'sw-t');
    t.appendChild(el('b', null, sv.from === 'me' ? 'Իմ սթորին' : (who.name || who.id)));
    t.appendChild(el('span', null, hhmm(s.ts)));
    head.appendChild(t);
    var st = $('#story-stage');
    st.textContent = '';
    st.style.background = STORY_BG[s.bg] || STORY_BG[0];
    if (s.k === 'img') {
      var im = el('img', 'story-pic');
      im.alt = 'Սթորի';
      setMedia('s:' + s.i, function (u) { im.src = u; }, function () { toast('Պատկերը չի գտնվել'); });
      st.appendChild(im);
      if (s.x) st.appendChild(el('div', 'story-cap', s.x));
    } else {
      st.appendChild(el('div', 'story-text', s.x));
    }
    if (sv.from !== 'me' && !s.seen) {
      s.seen = true; saveStories();
      sendCtl(sv.from, { t: 'sview', i: s.i });
    }
    paintStoryFoot();
    sv.raf = requestAnimationFrame(storyTick);
  }
  function paintStoryFoot() {
    var s = curStory(), foot = $('#story-foot');
    if (!s) return;
    var mineFoot = sv.from === 'me';
    $('#story-reply').hidden = mineFoot;
    $('#story-mine').hidden = !mineFoot;
    if (mineFoot) {
      var n = (s.views || []).length;
      $('#story-views').textContent = '👁 ' + n + (n === 1 ? ' դիտում' : ' դիտում');
    }
    foot.hidden = false;
  }
  function storyTick(now) {
    if (!sv) return;
    var s = curStory();
    if (!s) return;
    var dt = now - sv.last; sv.last = now;
    if (!sv.hold && !sv.typing) sv.el += dt;
    var p = Math.min(1, sv.el / storyDur(s));
    var fills = $('#story-bars').querySelectorAll('.sfill');
    if (fills[sv.idx]) fills[sv.idx].style.width = (p * 100) + '%';
    if (p >= 1) { storyNext(); return; }
    sv.raf = requestAnimationFrame(storyTick);
  }
  function storyNext() {
    if (!sv) return;
    if (sv.idx < sv.list.length - 1) { sv.idx++; showStoryItem(); } else closeStory();
  }
  function storyPrev() {
    if (!sv) return;
    if (sv.idx > 0) sv.idx--;
    showStoryItem();
  }
  (function () {
    var st = $('#story-stage'), t0 = 0, holdTimer = null, held = false;
    st.addEventListener('pointerdown', function () {
      t0 = Date.now(); held = false;
      holdTimer = setTimeout(function () { held = true; if (sv) sv.hold = true; }, 220);
    });
    function up(e) {
      clearTimeout(holdTimer);
      if (sv) sv.hold = false;
      if (e.type === 'pointercancel' || held || !sv) return;
      var r = st.getBoundingClientRect();
      if (e.clientX - r.left < r.width * 0.32) storyPrev(); else storyNext();
    }
    st.addEventListener('pointerup', up);
    st.addEventListener('pointercancel', up);
  })();
  $('#story-close').addEventListener('click', closeStory);
  $('#story-del').addEventListener('click', function () {
    var s = curStory();
    if (!s || s.from !== 'me') return;
    if (s.k === 'img') dropMedia('s:' + s.i);
    stories = stories.filter(function (x) { return x !== s; });
    saveStories();
    sv.list.splice(sv.idx, 1);
    if (!sv.list.length) closeStory();
    else { if (sv.idx >= sv.list.length) sv.idx = sv.list.length - 1; showStoryItem(); }
    toast('Սթորին ջնջվեց');
  });
  $('#story-in').addEventListener('focus', function () { if (sv) sv.typing = true; });
  $('#story-in').addEventListener('blur', function () { if (sv) sv.typing = false; });
  $('#story-reply').addEventListener('submit', function (e) {
    e.preventDefault();
    var s = curStory(), inp = $('#story-in'), text = inp.value.trim();
    if (!s || !text || sv.from === 'me') return;
    var to = sv.from;
    var m = { i: uid(), m: true, x: text.slice(0, 4000), ts: Date.now(), s: 'p', q: { i: s.i, x: '📖 Սթորի' + (s.x ? '՝ ' + clip(s.x, 40) : ''), m: false } };
    chatOf(to).push(m);
    saveMsgs();
    inp.value = ''; inp.blur();
    toast('Պատասխանը ուղարկվեց');
    flush(to);
  });

  /* the composer */
  var scMode = 'txt', scBg = 0, scImg = null, scUrl = '';
  function scPaint() {
    var prev = $('#sc-prev');
    prev.style.background = scMode === 'txt' ? STORY_BG[scBg] : '#000';
    $('#sc-text').hidden = scMode !== 'txt';
    $('#sc-img').hidden = scMode !== 'img';
    $('#sc-cap').hidden = scMode !== 'img';
    $('#sc-bgs').hidden = scMode !== 'txt';
    $('#sc-txt').classList.toggle('on', scMode === 'txt');
    $('#sc-photo').classList.toggle('on', scMode === 'img');
    var chips = $('#sc-bgs').children;
    for (var k = 0; k < chips.length; k++) chips[k].classList.toggle('on', k === scBg);
  }
  (function () {
    var box = $('#sc-bgs');
    STORY_BG.forEach(function (g, k) {
      var b = el('button', 'sc-chip');
      b.type = 'button';
      b.style.background = g;
      b.setAttribute('aria-label', 'Ֆոն ' + (k + 1));
      b.addEventListener('click', function () { scBg = k; scPaint(); });
      box.appendChild(b);
    });
  })();
  function openStoryComposer() {
    scMode = 'txt'; scBg = Math.floor(Math.random() * STORY_BG.length); scImg = null;
    if (scUrl) { URL.revokeObjectURL(scUrl); scUrl = ''; }
    $('#sc-text').value = ''; $('#sc-cap').value = ''; $('#sc-img').removeAttribute('src');
    scPaint();
    openDialog('#dlg-story');
  }
  $('#sc-txt').addEventListener('click', function () { scMode = 'txt'; scPaint(); $('#sc-text').focus(); });
  $('#sc-photo').addEventListener('click', function () { $('#sc-file').click(); });
  $('#sc-file').addEventListener('change', function () {
    var f = this.files && this.files[0];
    this.value = '';
    if (!f) return;
    compressImage(f, function (r) {
      if (!r) { toast('Այս նկարը չհաջողվեց բացել'); return; }
      scImg = r; scMode = 'img';
      if (scUrl) URL.revokeObjectURL(scUrl);
      scUrl = URL.createObjectURL(r.blob);
      $('#sc-img').src = scUrl;
      scPaint();
    });
  });
  $('#sc-cancel').addEventListener('click', function () { closeDialog('#dlg-story'); });
  $('#sc-post').addEventListener('click', function () {
    var now = Date.now();
    var s = { i: uid(), from: 'me', k: scMode, x: '', bg: scBg, ts: now, exp: now + STORY_TTL, sentTo: [], views: [] };
    if (scMode === 'txt') {
      s.x = $('#sc-text').value.trim().slice(0, 280);
      if (!s.x) { toast('Գրիր տեքստ կամ ընտրիր նկար'); return; }
    } else {
      if (!scImg) { toast('Ընտրիր նկար'); return; }
      s.x = $('#sc-cap').value.trim().slice(0, 120);
    }
    function done() {
      stories.push(s); saveStories();
      closeDialog('#dlg-story');
      renderStories();
      broadcastStories();
      toast('Սթորին հրապարակվեց');
    }
    if (s.k === 'img') idbPut('s:' + s.i, scImg.blob, done); else done();
  });


  /* ---------- Android back button ---------- */
  window.__back = function () {
    if (!$('#call').hidden) return true;
    if (incoming) return true;
    var open = document.querySelector('dialog[open]');
    if (open) { try { open.close(); } catch (e) { open.removeAttribute('open'); } return true; }
    if (storyOpen) { closeStory(); return true; }
    if (rec) { cancelRec(); return true; }
    if (!$('#emoji').hidden) { setEmoji(false); return true; }
    if (!$('#searchbar').hidden) { closeSearch(); return true; }
    if (!$('#chat').hidden) { closeChat(); return true; }
    return false;
  };

  /* ---------- start ---------- */
  // Called by the Android shell when a notification is tapped while the page is running.
  window.__open = function (id) {
    if (!me || typeof id !== 'string' || !id) return false;
    ensureContact(id);
    openChat(id);
    return true;
  };

  function enterApp() {
    showScreen('home');
    renderHome();
    startPeer();
    var pc = native('consumePendingChat'); // a notification tapped before the page was ready
    if (pc) window.__open(String(pc));
  }
  if (me && me.id) enterApp(); else openSetup('');
})();
