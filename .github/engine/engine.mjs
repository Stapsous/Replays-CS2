// Moteur VitaCS Replays : découvre les matchs de Team Vitality (PandaScore), calcule les liens de replay
// Twitch (API officielle Helix) et met à jour data.json. Lancé par GitHub Actions toutes les 5 minutes.
//
// RÈGLE ANTI-SPOILER : ce dépôt et ses journaux sont publics. Rien de ce qui est écrit (data.json,
// journaux, messages de commit) ne doit révéler score, vainqueur, adversaire, phase ou nombre de cartes
// jouées. L'état privé (suivi des leurres) est stocké dans Firestore, pas dans le dépôt.
import fs from "node:fs";
import admin from "firebase-admin";

const DRY = process.env.ENGINE_DRY_RUN === "true";
const VITALITY = 3455;
const MIN = 60000, H = 60 * MIN;
const now = Date.now();
const PS = process.env.PANDASCORE_TOKEN, TW_ID = process.env.TWITCH_CLIENT_ID, TW_SECRET = process.env.TWITCH_CLIENT_SECRET;
if (!PS || !TW_ID || !TW_SECRET || !process.env.FIREBASE_SA) { console.log("::warning::Secrets manquants, moteur inactif"); process.exit(0); }

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SA)) });
const db = admin.firestore();
const stateRef = db.doc("meta/engine");
const state = (await stateRef.get()).data() || {};
state.decoys = state.decoys || {}; // serieId -> { follow: teamId, after: ISO }

const data = JSON.parse(fs.readFileSync("data.json", "utf8"));
data.matches = data.matches || []; data.links = data.links || [];
const changes = [];

// ---------- Outils ----------
async function ps(path) {
  const r = await fetch("https://api.pandascore.co" + path, { headers: { Authorization: "Bearer " + PS } });
  if (!r.ok) throw new Error("PandaScore " + r.status + " " + path.split("?")[0]);
  return r.json();
}
let twToken = null;
async function tw(path) {
  if (!twToken) {
    const r = await fetch("https://id.twitch.tv/oauth2/token?client_id=" + TW_ID + "&client_secret=" + TW_SECRET + "&grant_type=client_credentials", { method: "POST" });
    if (!r.ok) throw new Error("Twitch token " + r.status);
    twToken = (await r.json()).access_token;
  }
  const r = await fetch("https://api.twitch.tv/helix" + path, { headers: { "Client-Id": TW_ID, Authorization: "Bearer " + twToken } });
  if (!r.ok) throw new Error("Twitch " + r.status);
  return r.json();
}
function channel(x) {
  const l = x.streams_list || [];
  const s = l.find((s) => s.main && s.official) || l.find((s) => s.main) || l.find((s) => s.official) || l[0];
  if (!s || !s.raw_url || !/twitch\.tv/i.test(s.raw_url)) return "";
  return s.raw_url.toLowerCase().replace(/[?#].*$/, "").replace(/\/+$/, "").split("/").pop();
}
const parisDate = (iso) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
function hms(sec) { sec = Math.max(0, Math.round(sec)); return Math.floor(sec / 3600) + "h" + String(Math.floor(sec / 60) % 60).padStart(2, "0") + "m" + String(sec % 60).padStart(2, "0") + "s"; }
function dur(s) { const m = String(s || "").match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/); return m ? (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0)) : 0; }
const eventName = (x) => [x.league && x.league.name, x.serie && (x.serie.full_name || x.serie.name)].filter(Boolean).join(" ").trim() || "CS2";

const vodCache = {};
async function vods(login) {
  if (vodCache[login]) return vodCache[login];
  const u = await tw("/users?login=" + encodeURIComponent(login));
  const id = u.data && u.data[0] && u.data[0].id;
  if (!id) return (vodCache[login] = []);
  const v = await tw("/videos?user_id=" + id + "&type=archive&first=20");
  return (vodCache[login] = (v.data || []).map((x) => ({ id: x.id, start: Date.parse(x.created_at), len: dur(x.duration) })));
}
// La vidéo qui couvre l'instant ref (stream relancé = plusieurs vidéos), sinon la plus récente commencée avant
async function vodFor(login, ref) {
  const list = (await vods(login)).filter((v) => v.start <= ref);
  return list.find((v) => ref <= v.start + v.len * 1000 + 5 * MIN) || list.sort((a, b) => b.start - a.start)[0] || null;
}
async function vodById(login, id) { return (await vods(login)).find((v) => v.id === id) || null; }

// ---------- 1. Découverte ----------
const known = new Map(data.matches.filter((m) => m.pid).map((m) => [m.pid, m]));
function addMatch(x) {
  if (known.has(x.id)) return;
  const day = parisDate(x.scheduled_at || x.begin_at);
  let key = day, n = 2;
  while (data.matches.some((m) => m.key === key)) key = day + "-" + n++;
  const m = { key, start: x.scheduled_at || x.begin_at, event: eventName(x), pid: x.id, ch: channel(x) };
  data.matches.push(m); known.set(x.id, m); changes.push("match " + key);
}
const mine = [...(await ps("/csgo/matches/running?filter[opponent_id]=" + VITALITY)), ...(await ps("/csgo/matches/upcoming?filter[opponent_id]=" + VITALITY + "&per_page=20"))];
for (const x of mine) if (x.scheduled_at || x.begin_at) addMatch(x);

// ---------- 2. Leurres après élimination ----------
// On suit « la chaîne des vainqueurs » : l'équipe qui a éliminé Vitality, puis celle qui l'élimine à son tour,
// jusqu'à la finale de la série. Un leurre est ajouté exactement comme un vrai match.
try {
  const past = await ps("/csgo/matches/past?filter[opponent_id]=" + VITALITY + "&sort=-scheduled_at&per_page=5");
  const last = past.find((x) => x.status === "finished");
  if (last && last.serie_id) {
    const serie = last.serie_id;
    const stillIn = mine.some((x) => x.serie_id === serie);
    const lost = last.winner_id && last.winner_id !== VITALITY;
    const all = await ps("/csgo/matches?filter[serie_id]=" + serie + "&per_page=100&sort=scheduled_at");
    const future = all.filter((x) => x.status !== "finished" && x.status !== "canceled");
    const ids = (x) => (x.opponents || []).map((o) => o.opponent && o.opponent.id).filter(Boolean);
    const drawnAfter = future.filter((x) => ids(x).length === 2 && Date.parse(x.scheduled_at || 0) > Date.parse(last.end_at));
    // Éliminée : défaite, plus aucun match prévu dans la série, au moins 2 h écoulées et des matchs suivants déjà tirés sans elle
    if (!state.decoys[serie] && lost && !stillIn && future.length && now - Date.parse(last.end_at) > 2 * H && drawnAfter.length >= 1) {
      state.decoys[serie] = { follow: last.winner_id, after: last.end_at };
    }
    const d = state.decoys[serie];
    if (d && future.length + all.length) {
      // Fait avancer la chaîne : si l'équipe suivie a perdu un match terminé après « after », on suit son vainqueur
      for (let guard = 0; guard < 10; guard++) {
        const done = all.filter((x) => x.status === "finished" && ids(x).includes(d.follow) && Date.parse(x.end_at) > Date.parse(d.after))
          .sort((a, b) => Date.parse(a.end_at) - Date.parse(b.end_at));
        if (!done.length) break;
        const g = done[0];
        if (!known.has(g.id)) addMatch(g);
        d.after = g.end_at;
        if (g.winner_id && g.winner_id !== d.follow) d.follow = g.winner_id;
      }
      const next = future.filter((x) => ids(x).includes(d.follow) && (x.scheduled_at || x.begin_at)).sort((a, b) => Date.parse(a.scheduled_at) - Date.parse(b.scheduled_at))[0];
      if (next) addMatch(next);
    }
  }
} catch (e) { console.log("leurres : " + e.message); }

// ---------- 3. Liens ----------
const hasLink = (id) => data.links.some((l) => l.id === id);
function addLink(l) { if (hasLink(l.id)) return false; data.links.push({ ...l, createdAt: new Date(now).toISOString() }); changes.push("lien " + l.id); return true; }
const url = (vod, sec) => "https://www.twitch.tv/videos/" + vod + "?t=" + hms(sec);

for (const m of data.matches) {
  if (!m.pid || m.done) continue;
  let x;
  try { x = (await ps("/csgo/matches?filter[id]=" + m.pid))[0]; } catch (e) { console.log(m.key + " : " + e.message); continue; }
  if (!x) continue;
  if (!m.ch) { const c = channel(x); if (c) { m.ch = c; changes.push("chaîne " + m.key); } }
  if (x.scheduled_at && x.scheduled_at !== m.start && x.status === "not_started") { m.start = x.scheduled_at; changes.push("horaire " + m.key); }
  const start = Date.parse(m.start);
  if (now > start + 30 * H) { m.done = true; changes.push("clos " + m.key); continue; }
  if (!m.ch) continue;
  try {
    const begun = x.status !== "not_started" && x.begin_at;
    // a) lien à l'horaire prévu (ou directement définitif si le match a déjà commencé)
    if (!hasLink(m.key + "-prevu") && !hasLink(m.key + "-definitif")) {
      if (begun) {
        const v = await vodFor(m.ch, Date.parse(x.begin_at));
        if (v) addLink({ id: m.key + "-definitif", match: m.key, kind: "definitif", url: url(v.id, (Date.parse(x.begin_at) - v.start) / 1000 - 90) });
      } else if (now >= start) {
        const v = await vodFor(m.ch, start);
        if (v) addLink({ id: m.key + "-prevu", match: m.key, kind: "prevu", url: url(v.id, (start - v.start) / 1000 - 90) });
      }
    }
    // b) lien définitif
    if (begun && !hasLink(m.key + "-definitif")) {
      const v = await vodFor(m.ch, Date.parse(x.begin_at));
      if (v) addLink({ id: m.key + "-definitif", match: m.key, kind: "definitif", url: url(v.id, (Date.parse(x.begin_at) - v.start) / 1000 - 90) });
    }
    // c) liens par carte, une fois le match terminé : toujours le nombre maximal de cartes du format
    if (x.status === "finished" && !hasLink(m.key + "-map1")) {
      const def = data.links.find((l) => l.id === m.key + "-definitif");
      const defId = def && (def.url.match(/\/videos\/(\d+)/) || [])[1];
      const v = (defId && await vodById(m.ch, defId)) || await vodFor(m.ch, Date.parse(x.begin_at));
      if (v) {
        const bo = x.number_of_games || 1;
        const played = (x.games || []).filter((g) => g.begin_at).sort((a, b) => a.position - b.position);
        const lastG = played[played.length - 1];
        const lastEnd = Date.parse((lastG && lastG.end_at) || x.end_at || x.begin_at);
        for (let i = 1; i <= bo; i++) {
          const g = played.find((p) => p.position === i);
          const t = g ? (Date.parse(g.begin_at) - v.start) / 1000 - 60 : (lastEnd - v.start) / 1000 + 30;
          addLink({ id: m.key + "-map" + i, match: m.key, kind: "map", map: i, url: url(v.id, t) });
        }
        m.done = true;
      }
    }
  } catch (e) { console.log(m.key + " : " + e.message); }
}

// ---------- 4. Écriture ----------
if (changes.length) {
  if (DRY) {
    console.log("::notice::Simulation, rien n'est écrit : " + changes.join(", "));
    for (const l of data.links.filter((l) => Date.parse(l.createdAt) >= now)) console.log("::notice::" + l.id + " " + l.url);
  } else {
    fs.writeFileSync("data.json", JSON.stringify(data, null, 2) + "\n");
    console.log("::notice::" + changes.length + " changement(s)");
  }
}
if (!DRY) await stateRef.set(state);
fs.writeFileSync(process.env.GITHUB_OUTPUT || "/dev/null", "changed=" + (changes.length && !DRY ? "true" : "false") + "\n", { flag: "a" });
