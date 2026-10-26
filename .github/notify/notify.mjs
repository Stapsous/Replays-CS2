// Notifications push (Firebase Cloud Messaging), lancé par GitHub Actions toutes les 5 minutes
// et à chaque mise à jour de data.json. Ne révèle jamais score, adversaire, phase ni nombre de cartes.
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

const data = JSON.parse(fs.readFileSync("data.json", "utf8"));
const metaRef = db.doc("meta/notify");
const meta = (await metaRef.get()).data() || {};
const sent = meta.sent || {};
const firstRun = !meta.init;
const queue = [];
let dirty = firstRun;

function once(key, msg) {
  if (sent[key]) return false;
  sent[key] = now; dirty = true;
  if (msg && !firstRun) queue.push(msg);
  return true;
}
function playerLink(url) {
  const v = (url.match(/\/videos\/(\d+)/) || [])[1], t = (url.match(/[?&]t=([0-9hms]+)/) || [])[1];
  return v ? SITE + "?play=" + v + "&t=" + (t || "0s") : SITE;
}

// 1. Nouveaux liens de replay
for (const l of data.links || []) {
  if (!l || !l.id || !l.url) continue;
  const fresh = !l.createdAt || now - Date.parse(l.createdAt) < 12 * H;
  if (l.kind === "map") {
    once("maps:" + l.match, fresh && { type: "maps", body: "Liens par carte d'un replay Vitality disponibles", link: SITE, tag: "maps-" + l.match });
  } else {
    const body = l.kind === "definitif" ? "Lien définitif d'un replay Vitality disponible" : "Nouveau replay Vitality (lien à l'horaire prévu)";
    once("link:" + l.id, fresh && { type: "link", body, link: playerLink(l.url), tag: "link-" + l.match });
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
const active = (data.matches || []).filter((m) => m.pid && !m.done && Math.abs(Date.parse(m.start) - now) < 36 * H);
const tourCache = {};
for (const m of active) {
  let M;
  try { M = (await ps("/csgo/matches?filter[id]=" + m.pid))[0]; } catch (e) { console.log("skip", m.key, e.message); continue; }
  if (!M) continue;
  const pid = m.pid, sched = Date.parse(M.scheduled_at || m.start), left = sched - now;
  const announced = () => sent["m15:" + pid] || sent["prev:" + pid];

  if (M.status === "running" || M.status === "finished") {
    const recent = M.begin_at && now - Date.parse(M.begin_at) < 45 * MIN;
    if (!announced() && recent) once("start:" + pid, { type: "started", body: "Un match Vitality a commencé", link: SITE, tag: "match-" + pid });
    else once("start:" + pid);
    continue;
  }
  if (M.status !== "not_started") continue;

  if (left <= 20 * MIN && left > -2 * H && !sent["prev:" + pid]) {
    const body = left > MIN ? "Un match Vitality commence dans " + Math.round(left / MIN) + " min" : "Un match Vitality devrait commencer d'un instant à l'autre";
    once("m15:" + pid, { type: "m15", body, link: SITE, tag: "match-" + pid });
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
  // Si le match précédent est lui-même un match suivi (vrai ou leurre), sa fin révélerait sa durée : pas d'alerte
  if ((data.matches || []).some((mm) => mm.pid === prev.id)) continue;

  if (prev.status === "finished" && left > 20 * MIN && !sent["m15:" + pid]) {
    const recentEnd = prev.end_at && now - Date.parse(prev.end_at) < 90 * MIN;
    if (recentEnd) once("prev:" + pid, { type: "prev", body: "Le match précédent est terminé : un match Vitality devrait commencer bientôt", link: SITE, tag: "match-" + pid });
  }
  if (prev.status === "running" && left > 25 * MIN) {
    const bo = prev.number_of_games || 1, need = Math.floor(bo / 2) + 1;
    const wins = {};
    for (const g of prev.games || []) if (g.status === "finished" && g.winner && g.winner.id != null) wins[g.winner.id] = (wins[g.winner.id] || 0) + 1;
    const maxw = Math.max(0, ...Object.values(wins));
    const live = (prev.games || []).find((g) => g.status === "running");
    if (live && (live.position === bo || maxw === need - 1)) once("soon:" + pid, { type: "soon", body: "Un match Vitality devrait commencer dans environ 1 h", link: SITE, tag: "match-" + pid });
  }
}

// Test manuel (workflow_dispatch avec test=true) : une notification à tous les appareils abonnés
if (process.env.NOTIFY_TEST === "true") queue.push({ type: "test", body: "Test : les notifications fonctionnent", link: SITE, tag: "test" });

// 3. Envoi aux appareils abonnés, selon les choix de chaque compte
let devices = 0, sentCount = 0, failCount = 0;
if (queue.length) {
  const users = await db.collection("users").get();
  for (const doc of users.docs) {
    const d = doc.data(), prefs = d.notif || {}, tokens = Object.keys(d.tokens || {});
    devices += tokens.length;
    for (const msg of queue) {
      if (prefs[msg.type] === false) continue;
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
          if (/registration-token-not-registered|invalid-registration-token|invalid-argument/.test(code)) {
            await doc.ref.update(new admin.firestore.FieldPath("tokens", token), admin.firestore.FieldValue.delete()).catch(() => {});
          }
        }
      }
    }
  }
}
console.log("::notice::ok · premier passage " + firstRun + " · appareils " + devices + " · envoyés " + sentCount + " · échecs " + failCount + " · file " + queue.map((q) => q.type).join(","));

if (dirty) {
  for (const k of Object.keys(sent)) if (now - sent[k] > 60 * 24 * H) delete sent[k];
  await metaRef.set({ init: true, sent });
}
