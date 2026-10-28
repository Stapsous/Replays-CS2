// Notifications push (Firebase Cloud Messaging), lancé par la boucle GitHub Actions après le moteur.
// Multi-équipes : chaque compte reçoit les alertes des équipes qu'il suit (Vitality par défaut).
// Ne révèle jamais score, adversaire, phase ni nombre de cartes.
import fs from "node:fs";
import admin from "firebase-admin";

const SITE = "https://stapsous.github.io/Replays-CS2/";
const MIN = 60000, H = 60 * MIN;
const now = Date.now();

if (!process.env.FIREBASE_SA || !process.env.PANDASCORE_TOKEN) { console.log("::warning::Secrets FIREBASE_SA / PANDASCORE_TOKEN absents"); process.exit(0); }
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SA)) });
const db = admin.firestore();
const fcm = admin.messaging();
const PS = process.env.PANDASCORE_TOKEN;
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return d; } };

const registry = readJson("data/teams.json", { teams: [] });
if (!registry.teams.some((t) => t.slug === "vitality")) registry.teams.unshift({ id: 3455, slug: "vitality", name: "Team Vitality" });
const teams = registry.teams.map((t) => {
  const d = readJson("data/teams/" + t.slug + ".json", null) || (t.slug === "vitality" ? readJson("data.json", null) : null) || { matches: [], links: [] };
  return { ...t, data: d };
});

const metaRef = db.doc("meta/notify");
const meta = (await metaRef.get()).data() || {};
const sent = meta.sent || {};
const teamsInit = meta.teamsInit || {};
if (meta.init && !teamsInit.vitality) teamsInit.vitality = 1; // Vitality était déjà suivie avant le passage en multi-équipes
const queue = [];
let dirty = !meta.init;

const short = (t) => String(t.name || t.slug).replace(/^Team\s+/i, "");
// Clés d'envoi : celles de Vitality gardent l'ancien format (pas de doublons après la mise à jour)
const K = (t, k) => (t.slug === "vitality" ? k : t.slug + ":" + k);
function once(t, key, msg) {
  const k = K(t, key);
  if (sent[k]) return false;
  sent[k] = now; dirty = true;
  if (msg && meta.init && teamsInit[t.slug]) queue.push({ ...msg, team: t.slug });
  return true;
}
function playerLink(t, url) {
  const v = (url.match(/\/videos\/(\d+)/) || [])[1], tt = (url.match(/[?&]t=([0-9hms]+)/) || [])[1];
  return v ? SITE + "?play=" + v + "&t=" + (tt || "0s") + (t.slug === "vitality" ? "" : "&team=" + encodeURIComponent(t.slug)) : SITE;
}

// 1. Nouveaux liens de replay
for (const t of teams) {
  const n = short(t);
  for (const l of t.data.links || []) {
    if (!l || !l.id || !l.url) continue;
    const fresh = !l.createdAt || now - Date.parse(l.createdAt) < 12 * H;
    if (l.kind === "map") {
      once(t, "maps:" + l.match, fresh && { type: "maps", body: "Liens par carte d'un replay " + n + " disponibles", link: SITE, tag: t.slug + "-maps-" + l.match });
    } else {
      const body = l.kind === "definitif" ? "Lien définitif d'un replay " + n + " disponible" : "Nouveau replay " + n + " (lien à l'horaire prévu)";
      once(t, "link:" + l.id, fresh && { type: "link", body, link: playerLink(t, l.url), tag: t.slug + "-link-" + l.match });
    }
  }
}

// 2. Débuts de match (vrais matchs et leurres, traités de la même façon)
async function ps(path) {
  const r = await fetch("https://api.pandascore.co" + path, { headers: { Authorization: "Bearer " + PS } });
  if (!r.ok) throw new Error("PandaScore " + r.status);
  return r.json();
}
function channel(x) {
  const l = x.streams_list || [];
  const s = l.find((s) => s.main && s.official) || l.find((s) => s.main) || l[0];
  return s && s.raw_url ? s.raw_url.toLowerCase().replace(/\/+$/, "").split("/").pop() : "";
}
const actives = [];
for (const t of teams) for (const m of t.data.matches || []) if (m.pid && !m.done && Math.abs(Date.parse(m.start) - now) < 36 * H) actives.push({ t, m });
const status = new Map();
const pids = [...new Set(actives.map((a) => a.m.pid))];
for (let i = 0; i < pids.length; i += 50) {
  try { for (const x of await ps("/csgo/matches?per_page=100&filter[id]=" + pids.slice(i, i + 50).join(","))) status.set(x.id, x); } catch (e) { console.log("statuts : " + e.message); }
}
const tourCache = {};
for (const { t, m } of actives) {
  const M = status.get(m.pid);
  if (!M) continue;
  const n = short(t), pid = m.pid, sched = Date.parse(M.scheduled_at || m.start), left = sched - now;
  const announced = () => sent[K(t, "m15:" + pid)] || sent[K(t, "prev:" + pid)];

  if (M.status === "running" || M.status === "finished") {
    const recent = M.begin_at && now - Date.parse(M.begin_at) < 45 * MIN;
    if (!announced() && recent) once(t, "start:" + pid, { type: "started", body: "Un match " + n + " a commencé", link: SITE, tag: t.slug + "-match-" + pid });
    else once(t, "start:" + pid);
    continue;
  }
  if (M.status !== "not_started") continue;

  if (left <= 20 * MIN && left > -2 * H && !sent[K(t, "prev:" + pid)]) {
    const body = left > MIN ? "Un match " + n + " commence dans " + Math.round(left / MIN) + " min" : "Un match " + n + " devrait commencer d'un instant à l'autre";
    once(t, "m15:" + pid, { type: "m15", body, link: SITE, tag: t.slug + "-match-" + pid });
  }

  // Match précédent sur la même chaîne le même jour
  const ch = channel(M);
  if (!ch || !M.tournament_id) continue;
  let T = tourCache[M.tournament_id];
  if (!T) {
    try { T = tourCache[M.tournament_id] = await ps("/csgo/matches?filter[tournament_id]=" + M.tournament_id + "&per_page=100"); } catch (e) { continue; }
  }
  const prev = T.filter((x) => x.id !== M.id && channel(x) === ch && x.scheduled_at && Date.parse(x.scheduled_at) < sched && sched - Date.parse(x.scheduled_at) < 12 * H)
    .sort((a, b) => Date.parse(b.scheduled_at) - Date.parse(a.scheduled_at))[0];
  if (!prev) continue;
  // Si le match précédent est lui-même un match suivi de cette équipe (vrai ou leurre), sa fin révélerait sa durée
  if ((t.data.matches || []).some((mm) => mm.pid === prev.id)) continue;

  if (prev.status === "finished" && left > 20 * MIN && !sent[K(t, "m15:" + pid)]) {
    const recentEnd = prev.end_at && now - Date.parse(prev.end_at) < 90 * MIN;
    if (recentEnd) once(t, "prev:" + pid, { type: "prev", body: "Le match précédent est terminé : un match " + n + " devrait commencer bientôt", link: SITE, tag: t.slug + "-match-" + pid });
  }
  if (prev.status === "running" && left > 25 * MIN) {
    const bo = prev.number_of_games || 1, need = Math.floor(bo / 2) + 1;
    const wins = {};
    for (const g of prev.games || []) if (g.status === "finished" && g.winner && g.winner.id != null) wins[g.winner.id] = (wins[g.winner.id] || 0) + 1;
    const maxw = Math.max(0, ...Object.values(wins));
    const live = (prev.games || []).find((g) => g.status === "running");
    if (live && (live.position === bo || maxw === need - 1)) once(t, "soon:" + pid, { type: "soon", body: "Un match " + n + " devrait commencer dans environ 1 h", link: SITE, tag: t.slug + "-match-" + pid });
  }
}
// Une équipe vue pour la première fois : ses liens existants sont notés comme déjà envoyés, sans notification
for (const t of teams) if (!teamsInit[t.slug]) { teamsInit[t.slug] = now; dirty = true; }

// Test manuel (workflow_dispatch avec test=true) : une notification à tous les appareils abonnés
if (process.env.NOTIFY_TEST === "true") queue.push({ type: "test", body: "Test : les notifications fonctionnent", link: SITE, tag: "test", team: "*" });

// 3. Envoi aux appareils abonnés, selon les équipes suivies et les choix de chaque compte
let devices = 0, sentCount = 0, failCount = 0;
if (queue.length) {
  const users = await db.collection("users").get();
  for (const doc of users.docs) {
    const d = doc.data(), prefs = d.notif || {}, tokens = Object.keys(d.tokens || {});
    let follow = ["vitality"];
    try { const f = JSON.parse(d.teams || "null"); if (Array.isArray(f) && f.length) follow = f; } catch (e) {}
    devices += tokens.length;
    const done = new Set();
    for (const msg of queue) {
      if (prefs[msg.type] === false) continue;
      if (msg.team !== "*" && !follow.includes(msg.team)) continue;
      if (done.has(msg.tag + msg.type)) continue;
      done.add(msg.tag + msg.type);
      for (const token of tokens) {
        try {
          await fcm.send({
            token,
            data: { title: "VitaCS Replays", body: msg.body, link: msg.link, tag: msg.tag },
            webpush: { headers: { Urgency: "high", TTL: msg.type === "link" || msg.type === "maps" ? "86400" : "3600" } }
          });
          sentCount++;
        } catch (e) {
          failCount++;
          const code = e.code || (e.errorInfo && e.errorInfo.code) || "";
          console.log("send failed", code);
          if (/registration-token-not-registered|invalid-registration-token/.test(code)) {
            await doc.ref.update(new admin.firestore.FieldPath("tokens", token), admin.firestore.FieldValue.delete()).catch(() => {});
          }
        }
      }
    }
  }
}
console.log("::notice::ok · équipes " + teams.length + " · appareils " + devices + " · envoyés " + sentCount + " · échecs " + failCount + " · file " + queue.map((q) => q.type).join(","));

if (dirty) {
  for (const k of Object.keys(sent)) if (now - sent[k] > 60 * 24 * H) delete sent[k];
  await metaRef.set({ init: true, sent, teamsInit });
}
