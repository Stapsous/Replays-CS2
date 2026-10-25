// Synchronisation des réglages entre appareils (Firebase : connexion Google + Firestore).
// Le site continue de tout lire et écrire dans localStorage ; ce module recopie ces clés
// dans le document users/<uid> du compte connecté, et inversement.
// La configuration Firebase n'est pas un secret : l'accès est protégé par les règles Firestore
// (chacun ne lit et n'écrit que son propre document).
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCUZc33r0RzJA0S0v64DApDgTacE7O7Khg",
  authDomain: "replays-cs2.firebaseapp.com",
  projectId: "replays-cs2",
  storageBucket: "replays-cs2.firebasestorage.app",
  messagingSenderId: "1026475466360",
  appId: "1:1026475466360:web:3369ffd372ffd561b0578d"
};

const V = "10.12.2";
const KEYS = {
  seen: "replays-vitality-seen",
  resume: "replays-resume",
  volume: "replays-volume",
  quality: "replays-quality",
  theater: "replays-theater"
};
const RESUME_EVERY = 20000; // la position de lecture change toutes les 5 s : on ne l'envoie qu'une fois toutes les 20 s

const accountEl = document.getElementById("account");
function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function put(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }
function obj(raw) { try { return JSON.parse(raw || "{}") || {}; } catch (e) { return {}; } }

function renderAccount(state, user) {
  if (!accountEl) return;
  accountEl.textContent = "";
  const span = (cls, t) => { const s = document.createElement("span"); s.className = cls; s.textContent = t; return s; };
  const btn = (t, fn) => { const b = document.createElement("button"); b.type = "button"; b.textContent = t; b.addEventListener("click", fn); return b; };
  if (state === "out") {
    accountEl.append(btn("Se connecter avec Google", login), span("hint", "pour retrouver tes « vu » et ta position de lecture sur tous tes appareils"));
  } else if (state === "in") {
    accountEl.append(span("ok", "Synchronisé · " + (user.email || user.displayName || "compte connecté")), btn("Se déconnecter", logout));
  } else if (state === "error") {
    accountEl.append(span("hint", "Synchronisation indisponible pour le moment"));
  }
}

let auth, db, fb = {};
async function login() {
  try { await fb.signInWithPopup(auth, new fb.GoogleAuthProvider()); }
  catch (e) { if (e && e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") renderAccount("error"); }
}
async function logout() { try { await fb.signOut(auth); } catch (e) {} }

// Le lecteur intégré à la liste partage le localStorage de la page : seule la page principale synchronise.
const TOP = window.top === window;

if (FIREBASE_CONFIG && TOP) {
  (async () => {
    try {
      const [appM, authM, fsM] = await Promise.all([
        import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`),
        import(`https://www.gstatic.com/firebasejs/${V}/firebase-auth.js`),
        import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`)
      ]);
      fb = { ...authM, ...fsM };
      const app = appM.initializeApp(FIREBASE_CONFIG);
      auth = authM.getAuth(app);
      db = fsM.getFirestore(app);
      let stop = null, timer = null;
      authM.onAuthStateChanged(auth, async (user) => {
        if (stop) { stop(); stop = null; }
        if (timer) { clearInterval(timer); timer = null; }
        if (!user) { renderAccount("out"); return; }
        renderAccount("in", user);
        try { ({ stop, timer } = await startSync(user)); } catch (e) { renderAccount("error"); }
      });
    } catch (e) { renderAccount("error"); }
  })();
} else if (accountEl) {
  accountEl.hidden = true;
}

async function startSync(user) {
  const ref = fb.doc(db, "users", user.uid);
  const snap = await fb.getDoc(ref);
  const remote = snap.exists() ? snap.data() : {};

  // Fusion à la connexion : « vu » = union, positions = la plus récente, réglages = ceux du compte s'ils existent
  const merged = {};
  merged.seen = JSON.stringify(Object.assign({}, obj(remote.seen), obj(get(KEYS.seen))));
  const res = obj(remote.resume), loc = obj(get(KEYS.resume));
  Object.keys(loc).forEach((k) => { if (!res[k] || (loc[k] && loc[k].at > res[k].at)) res[k] = loc[k]; });
  merged.resume = JSON.stringify(res);
  ["volume", "quality", "theater"].forEach((f) => { merged[f] = remote[f] != null ? remote[f] : get(KEYS[f]); });

  const last = {};
  Object.keys(KEYS).forEach((f) => { if (merged[f] != null) put(KEYS[f], merged[f]); last[f] = get(KEYS[f]); });
  const upload = {};
  Object.keys(KEYS).forEach((f) => { if (last[f] != null) upload[f] = last[f]; });
  await fb.setDoc(ref, upload, { merge: true });
  window.dispatchEvent(new Event("replays-sync"));

  // Compte → appareil
  const stop = fb.onSnapshot(ref, (s) => {
    const d = s.data() || {};
    let changed = false;
    Object.keys(KEYS).forEach((f) => {
      if (d[f] != null && d[f] !== last[f]) { put(KEYS[f], d[f]); last[f] = d[f]; changed = true; }
    });
    if (changed) window.dispatchEvent(new Event("replays-sync"));
  });

  // Appareil → compte (le site écrit dans localStorage ; on relève les changements)
  let resumeAt = 0;
  function push(force) {
    const out = {};
    Object.keys(KEYS).forEach((f) => {
      const raw = get(KEYS[f]);
      if (raw === last[f] || raw == null) return;
      if (f === "resume" && !force && Date.now() - resumeAt < RESUME_EVERY) return;
      if (f === "resume") resumeAt = Date.now();
      out[f] = raw; last[f] = raw;
    });
    if (Object.keys(out).length) fb.setDoc(ref, out, { merge: true }).catch(() => {});
  }
  const timer = setInterval(() => push(false), 1500);
  document.addEventListener("visibilitychange", () => { if (document.hidden) push(true); });
  window.addEventListener("pagehide", () => push(true));
  return { stop, timer };
}
