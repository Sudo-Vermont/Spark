// profile.js — local profile (localStorage) exchanged peer-to-peer on match

const Profile = (() => {
  const KEY = 'spark_profile';
  const AVATARS = ['😀','😎','🦊','🐼','🦄','👾','🌟','🍕'];

  // Clamp any profile-shaped object (also used on untrusted partner data)
  function sanitize(raw) {
    return {
      name:   String(raw?.name || '').replace(/\s+/g, ' ').trim().slice(0, 24),
      bio:    String(raw?.bio  || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      avatar: AVATARS.includes(raw?.avatar) ? raw.avatar : '😀',
    };
  }

  function load() {
    try {
      const p = JSON.parse(localStorage.getItem(KEY));
      if (p && typeof p === 'object') return sanitize(p);
    } catch {}
    return { name: '', bio: '', avatar: '😀' };
  }

  function save(p) {
    try { localStorage.setItem(KEY, JSON.stringify(sanitize(p))); } catch {}
  }

  // Splash-screen UI: avatar picker + name/bio inputs, prefilled from storage
  function init() {
    const row    = document.getElementById('avatarRow');
    const nameEl = document.getElementById('profileName');
    const bioEl  = document.getElementById('profileBio');
    const p = load();
    if (nameEl) nameEl.value = p.name;
    if (bioEl)  bioEl.value  = p.bio;
    if (row) {
      row.innerHTML = AVATARS.map(a =>
        `<button type="button" class="avatar-btn${a === p.avatar ? ' selected' : ''}" data-a="${a}">${a}</button>`
      ).join('');
      row.addEventListener('click', e => {
        const b = e.target.closest('.avatar-btn');
        if (!b) return;
        row.querySelectorAll('.avatar-btn').forEach(x => x.classList.remove('selected'));
        b.classList.add('selected');
      });
    }
  }

  // Read the splash inputs, persist, and return the profile
  function commit() {
    const row = document.getElementById('avatarRow');
    const p = sanitize({
      name:   document.getElementById('profileName')?.value,
      bio:    document.getElementById('profileBio')?.value,
      avatar: row?.querySelector('.avatar-btn.selected')?.dataset.a,
    });
    save(p);
    return p;
  }

  return { init, load, commit, sanitize };
})();
