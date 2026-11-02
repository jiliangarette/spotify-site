(() => {
  const $ = s => document.querySelector(s);
  const body = document.body;
  const SCOPE = 'user-read-currently-playing';
  const RPM = 8;
  const STYLES = { picture: 'Picture', vinyl: 'Vinyl', cd: 'CD' };
  const ORDER = ['picture', 'vinyl', 'cd'];
  const REDIRECT = location.origin + '/';
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem('now-spinning.' + k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem('now-spinning.' + k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem('now-spinning.' + k); } catch {} }
  };

  class AuthError extends Error {}

  const clientId = '68f6c2334af84871b6e5efba89fa66f9';
  let token = store.get('token');
  let disc = ORDER.includes(store.get('disc')) ? store.get('disc') : 'picture';
  let source = store.get('source') === 'artist' ? 'artist' : 'album';
  let refreshing = null;

  let noteT, noteSticky = false;
  const note = (msg, ms = 4000) => {
    const el = $('#note');
    if (msg) el.textContent = msg;
    el.classList.toggle('show', !!msg);
    noteSticky = !!msg && !ms;
    clearTimeout(noteT);
    if (msg && ms) noteT = setTimeout(() => el.classList.remove('show'), ms);
  };

  const setState = s => {
    body.dataset.state = s;
    $('#connect').hidden = s !== 'connect';
    $('#controls').hidden = s !== 'live';
    if (s !== 'live') body.classList.remove('idle');
  };

  const anim = $('#spin').animate([{ transform: 'rotate(0turn)' }, { transform: 'rotate(1turn)' }], { duration: 60000, iterations: Infinity });
  anim.playbackRate = 0;
  let rampId = 0, spinning = false;
  const rampTo = (target, ms) => {
    const id = ++rampId, from = anim.playbackRate, t0 = performance.now();
    if (reduced) { anim.playbackRate = target; return; }
    const step = now => {
      if (id !== rampId) return;
      const k = Math.min(1, (now - t0) / ms);
      anim.playbackRate = from + (target - from) * (1 - Math.pow(1 - k, 3));
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  const setSpinning = v => {
    if (v === spinning) return;
    spinning = v;
    rampTo(v ? RPM : 0, v ? 1800 : 2600);
  };
  const setDisc = s => {
    disc = s;
    body.dataset.disc = s;
    $('#discBtn').textContent = STYLES[s];
    $('#discBtn').setAttribute('aria-label', `Disc style: ${STYLES[s]}. Press to change.`);
    store.set('disc', s);
  };

  const layers = [$('#artA'), $('#artB')];
  let front = 0, swapId = 0, swapT, artUrl = null;
  const setArt = url => {
    if (url === artUrl) return;
    artUrl = url;
    const id = ++swapId, back = layers[1 - front], cur = layers[front];
    clearTimeout(swapT);
    layers.forEach(l => l.classList.remove('under'));
    if (!url) { cur.classList.remove('on'); return; }
    const done = () => {
      if (id !== swapId) return;
      back.onload = back.onerror = null;
      const wasOn = cur.classList.contains('on');
      cur.classList.remove('on');
      if (wasOn) cur.classList.add('under');
      void back.offsetWidth;
      back.classList.add('on');
      front = 1 - front;
      swapT = setTimeout(() => cur.classList.remove('under'), reduced ? 0 : 1250);
    };
    if (back.getAttribute('src') === url && back.complete && back.naturalWidth) { done(); return; }
    back.onload = done;
    back.onerror = () => { if (id === swapId) { back.onload = back.onerror = null; artUrl = null; } };
    back.src = url;
  };

  const tokenRequest = async params => {
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, ...params })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 400 || res.status === 401) throw new AuthError(data.error_description || data.error || 'refused');
      throw new Error('token ' + res.status);
    }
    token = { access: data.access_token, refresh: data.refresh_token || token?.refresh, expiresAt: Date.now() + (data.expires_in - 120) * 1000 };
    store.set('token', token);
    return token;
  };

  const refresh = () => {
    if (!token?.refresh) return Promise.reject(new AuthError('no refresh token'));
    return refreshing ||= tokenRequest({ grant_type: 'refresh_token', refresh_token: token.refresh }).finally(() => { refreshing = null; });
  };

  const accessToken = async () => {
    if (!token) throw new AuthError('not connected');
    if (Date.now() >= token.expiresAt) await refresh();
    return token.access;
  };

  const api = async (path, retry = true) => {
    const res = await fetch('https://api.spotify.com/v1' + path, { headers: { Authorization: 'Bearer ' + await accessToken() } });
    if (res.status === 401 && retry) { await refresh(); return api(path, false); }
    return res;
  };

  const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const random = n => b64url(crypto.getRandomValues(new Uint8Array(n)));

  const login = async () => {
    const verifier = random(64), state = random(16);
    store.set('pkce', { verifier, state });
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    location.assign('https://accounts.spotify.com/authorize?' + new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      scope: SCOPE,
      redirect_uri: REDIRECT,
      state,
      code_challenge_method: 'S256',
      code_challenge: challenge
    }));
  };

  const handleCallback = async () => {
    const q = new URLSearchParams(location.search);
    if (!q.has('code') && !q.has('error')) return;
    history.replaceState(null, '', '/');
    const pkce = store.get('pkce');
    store.del('pkce');
    if (q.get('error')) { note(q.get('error') === 'access_denied' ? 'Spotify sign-in was cancelled.' : 'Spotify sign-in failed. Try again.', 6000); return; }
    if (!pkce || pkce.state !== q.get('state')) { note('That sign-in expired. Connect again.', 6000); return; }
    try {
      await tokenRequest({ grant_type: 'authorization_code', code: q.get('code'), redirect_uri: REDIRECT, code_verifier: pkce.verifier });
    } catch (e) {
      note(e instanceof AuthError ? 'Spotify refused the sign-in. Try connecting again.' : 'Could not reach Spotify. Check the connection and try again.', 0);
    }
  };

  const imageOf = item => {
    const imgs = item.album?.images?.length ? item.album.images : item.images?.length ? item.images : item.show?.images || [];
    return [...imgs].sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url || null;
  };
  const describe = item => item.name + (item.artists?.length ? ' by ' + item.artists.map(a => a.name).join(', ') : item.show?.name ? ' from ' + item.show.name : '');

  const artists = new Map();
  const artistImage = async id => {
    if (artists.has(id)) return artists.get(id);
    const res = await api('/artists/' + encodeURIComponent(id));
    if (!res.ok) return null;
    const url = imageOf({ images: (await res.json()).images || [] });
    artists.set(id, url);
    return url;
  };

  let currentKey = null, currentItem = null, artReq = 0;
  const refreshArt = async () => {
    const item = currentItem, req = ++artReq;
    if (!item) return;
    let url = imageOf(item);
    const id = item.artists?.[0]?.id;
    if (source === 'artist' && id) url = await artistImage(id).catch(() => null) || url;
    if (req === artReq && item === currentItem) setArt(url);
  };
  const setSource = s => {
    source = s;
    $('#srcBtn').textContent = s === 'artist' ? 'Artist' : 'Album';
    $('#srcBtn').setAttribute('aria-label', `Picture: ${s === 'artist' ? 'artist photo' : 'album cover'}. Press to change.`);
    store.set('source', s);
    refreshArt();
  };

  const show = data => {
    if (body.dataset.state !== 'live') return;
    const item = data?.item;
    if (item) {
      const key = item.uri || item.id || item.name;
      if (key !== currentKey) {
        currentKey = key;
        currentItem = item;
        refreshArt();
        $('#disc').setAttribute('aria-label', 'Now playing: ' + describe(item));
      }
    }
    setSpinning(!!data?.is_playing);
  };

  let pollT, busy = false;
  const schedule = ms => { clearTimeout(pollT); pollT = setTimeout(poll, ms); };
  const poll = async () => {
    if (busy) return;
    clearTimeout(pollT);
    if (document.hidden || body.dataset.state !== 'live') return;
    busy = true;
    try { schedule(await check()); } catch { disconnect('Spotify disconnected. Connect again.'); } finally { busy = false; }
  };
  const check = async () => {
    let wait = 4000;
    try {
      const res = await api('/me/player/currently-playing?additional_types=episode');
      if (res.status === 200) {
        const data = await res.json();
        show(data);
        if (noteSticky) note('');
        const left = data.item?.duration_ms ? data.item.duration_ms - (data.progress_ms || 0) : Infinity;
        wait = data.is_playing ? Math.min(4000, Math.max(1000, left + 700)) : 6000;
      } else if (res.status === 204) {
        show(null);
        if (noteSticky) note('');
        wait = 8000;
      } else if (res.status === 429) {
        wait = Math.max(5, Number(res.headers.get('Retry-After')) || 30) * 1000;
      } else if (res.status === 403) {
        note('This Spotify account is not on the allowed list yet. Ask the owner to add your Spotify email.', 0);
        wait = 60000;
      } else {
        wait = 15000;
      }
    } catch (e) {
      if (e instanceof AuthError) throw e;
      wait = 10000;
    }
    return wait;
  };

  const disconnect = msg => {
    clearTimeout(pollT);
    token = null;
    store.del('token');
    currentKey = null;
    currentItem = null;
    setArt(null);
    setSpinning(false);
    $('#disc').setAttribute('aria-label', 'Nothing playing');
    setState('connect');
    note(msg || '', msg ? 0 : undefined);
  };

  let lock = null;
  const keepAwake = async () => {
    try {
      if ('wakeLock' in navigator && document.visibilityState === 'visible' && !lock) {
        lock = await navigator.wakeLock.request('screen');
        lock.addEventListener('release', () => { lock = null; });
      }
    } catch {}
  };

  let idleT;
  const controls = $('#controls');
  const wake = (ms = 2200) => {
    body.classList.remove('idle');
    clearTimeout(idleT);
    idleT = setTimeout(() => {
      if (controls.matches(':hover, :focus-within')) wake();
      else if (body.dataset.state === 'live') body.classList.add('idle');
    }, ms);
  };

  const fsBtn = $('#fsBtn');
  const root = document.documentElement;
  const reqFs = root.requestFullscreen || root.webkitRequestFullscreen;
  if (!reqFs) fsBtn.hidden = true;
  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement || document.webkitFullscreenElement) await (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      else if (reqFs) await reqFs.call(root);
    } catch { note('This browser blocked fullscreen. Use its own fullscreen option.'); }
  };
  fsBtn.onclick = toggleFullscreen;
  $('#disc').ondblclick = toggleFullscreen;

  let armed = 0;
  $('#signOut').onclick = () => {
    if (Date.now() - armed < 4000) { armed = 0; disconnect(); note('Disconnected.', 2500); }
    else { armed = Date.now(); note('Press again to disconnect Spotify.', 4000); }
  };

  $('#discBtn').onclick = () => setDisc(ORDER[(ORDER.indexOf(disc) + 1) % ORDER.length]);
  $('#srcBtn').onclick = () => setSource(source === 'artist' ? 'album' : 'artist');
  setDisc(disc);
  setSource(source);

  $('#connectBtn').onclick = () => login().catch(() => note('This browser cannot sign in to Spotify. Use a recent Chrome, Safari or Edge.', 0));

  addEventListener('keydown', e => {
    wake();
    if ((e.key === 'f' || e.key === 'F') && body.dataset.state === 'live' && e.target.tagName !== 'INPUT') toggleFullscreen();
  });
  ['pointermove', 'pointerdown', 'focusin'].forEach(ev => addEventListener(ev, () => wake(), { passive: true }));
  addEventListener('pointerdown', keepAwake, { passive: true });
  addEventListener('online', () => poll());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    keepAwake();
    poll();
  });

  (async () => {
    await handleCallback();
    if (!token) { setState('connect'); return; }
    setState('live');
    keepAwake();
    wake(3000);
    poll();
  })();
})();
