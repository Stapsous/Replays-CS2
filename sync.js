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

const VAPID_KEY = "BKWAR112tulGwShAGMg_1C7cG9mE2SWICcuGOtcCLiKD5qYC2jLKzJik3AuMS2RqYeY6Fe9VBLn3a_eXwoF31fY"; // clé « Web Push certificates » du projet Firebase
const V = "10.12.2";
// Types de notifications, au choix de chaque compte (tous activés par défaut)
const NOTIF_TYPES = [
  ["soon", "Environ 1 h avant un match (estimation)"],
  ["prev", "Match précédent terminé : le match va bientôt commencer"],
  ["m15", "15 min avant l'horaire prévu"],
  ["started", "Début du match, si rien n'a prévenu avant"],
  ["link", "Nouveau lien de replay"],
  ["maps", "Liens par carte disponibles"]
];
const TOKEN_KEY = "replays-push-token";
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
    if (VAPID_KEY) {
      const det = document.createElement("details"); det.className = "notif"; det.id = "notif";
      const sum = document.createElement("summary"); sum.textContent = "Notifications"; det.append(sum);
      const box = document.createElement("div"); box.id = "notif-box"; det.append(box);
      accountEl.append(det); renderNotif();
    }
  } else if (state === "error") {
    accountEl.append(span("hint", "Synchronisation indisponible pour le moment"));
  }
}

let auth, db, fb = {};
async function login() {
  try { await fb.signInWithPopup(auth, new fb.GoogleAuthProvider()); }
  catch (e) { if (e && e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") renderAccount("error"); }
}
async function logout() { try { if (get(TOKEN_KEY)) await disablePush(); } catch (e) {} try { await fb.signOut(auth); } catch (e) {} }

// ----- Notifications -----
let userRef = null, notifPrefs = {}, messaging = null, pushOk = false, swReg = null;
async function initMessaging(app) {
  if (!VAPID_KEY || !("serviceWorker" in navigator) || !("Notification" in window)) return;
  try {
    const mM = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-messaging.js`);
    if (!(await mM.isSupported())) return;
    Object.assign(fb, { getToken: mM.getToken, deleteToken: mM.deleteToken, onMessage: mM.onMessage });
    messaging = mM.getMessaging(app); pushOk = true;
    // Page ouverte : Firebase ne montre rien tout seul, on affiche la notification nous-mêmes
    mM.onMessage(messaging, async (p) => {
      const d = p.data || {}; const reg = await swRegister();
      if (reg && Notification.permission === "granted") reg.showNotification(d.title || "Replays Vitality", { body: d.body || "", tag: d.tag || undefined, data: { link: d.link || location.href } });
    });
  } catch (e) {}
}
async function swRegister() {
  if (swReg) return swReg;
  try { swReg = await navigator.serviceWorker.register("firebase-messaging-sw.js"); await navigator.serviceWorker.ready; } catch (e) { swReg = null; }
  return swReg;
}
async function saveToken() {
  const reg = await swRegister(); if (!reg) throw new Error("sw");
  const token = await fb.getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
  if (!token) throw new Error("token");
  const old = get(TOKEN_KEY);
  if (old && old !== token) await fb.updateDoc(userRef, new fb.FieldPath("tokens", old), fb.deleteField()).catch(() => {});
  await fb.setDoc(userRef, { tokens: { [token]: { at: Date.now(), ua: navigator.userAgent.slice(0, 150) } } }, { merge: true });
  put(TOKEN_KEY, token);
}
async function enablePush() {
  const perm = await Notification.requestPermission();
  if (perm !== "granted") { renderNotif(); return; }
  try { await saveToken(); } catch (e) { renderNotif("Impossible d'activer les notifications sur cet appareil"); return; }
  renderNotif();
}
async function disablePush() {
  const token = get(TOKEN_KEY);
  try { await fb.deleteToken(messaging); } catch (e) {}
  if (token && userRef) await fb.updateDoc(userRef, new fb.FieldPath("tokens", token), fb.deleteField()).catch(() => {});
  put(TOKEN_KEY, null);
  renderNotif();
}
function renderNotif(err) {
  const box = document.getElementById("notif-box"); if (!box) return;
  box.textContent = "";
  const line = document.createElement("div"); line.className = "notif-device";
  const b = (t, fn) => { const x = document.createElement("button"); x.type = "button"; x.textContent = t; x.addEventListener("click", fn); return x; };
  const txt = (t) => { const x = document.createElement("span"); x.textContent = t; return x; };
  if (!pushOk) line.append(txt("Ce navigateur ne gère pas les notifications (sur iPhone : ajoute d'abord le site à l'écran d'accueil)."));
  else if (Notification.permission === "denied") line.append(txt("Notifications bloquées dans les réglages du navigateur pour ce site."));
  else if (get(TOKEN_KEY) && Notification.permission === "granted") line.append(txt("Activées sur cet appareil"), b("Désactiver sur cet appareil", disablePush));
  else line.append(b("Activer sur cet appareil", enablePush));
  if (err) line.append(txt(err));
  box.append(line);
  const list = document.createElement("div"); list.className = "notif-types";
  const head = document.createElement("div"); head.className = "notif-head"; head.textContent = "Pour ce compte, sur tous ses appareils :"; list.append(head);
  NOTIF_TYPES.forEach(([k, label]) => {
    const l = document.createElement("label"); const c = document.createElement("input"); c.type = "checkbox";
    c.checked = notifPrefs[k] !== false;
    c.addEventListener("change", () => { notifPrefs[k] = c.checked; if (userRef) fb.setDoc(userRef, { notif: { [k]: c.checked } }, { merge: true }).catch(() => {}); });
    l.append(c, document.createTextNode(" " + label)); list.append(l);
  });
  box.append(list);
}

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
      await initMessaging(app);
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
  userRef = ref;
  const snap = await fb.getDoc(ref);
  const remote = snap.exists() ? snap.data() : {};
  notifPrefs = remote.notif || {}; renderNotif();
  // Le jeton d'un appareil peut changer : on le rafraîchit à chaque visite
  if (pushOk && get(TOKEN_KEY) && Notification.permission === "granted") saveToken().catch(() => {});

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
    if (JSON.stringify(d.notif || {}) !== JSON.stringify(notifPrefs)) { notifPrefs = d.notif || {}; renderNotif(); }
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
