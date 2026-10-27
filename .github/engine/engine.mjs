// Moteur VitaCS Replays : découvre les matchs de Team Vitality (PandaScore), calcule les liens de replay
// Twitch (API officielle Helix) et met à jour data.json. Lancé par GitHub Actions toutes les 5 minutes.
//
// RÈGLE ANTI-SPOILER : ce dépôt et ses journaux sont publics. Rien de ce qui est écrit (data.json,
// journaux, messages de commit) ne doit révéler score, vainqueur, adversaire, phase ou nombre de cartes
// jouées. L'état privé (suivi des leurres) est stocké dans Firestore, pas dans le dépôt.
import fs from "node:fs";
import admin from "firebase-admin";

const DRY = process.env.ENGINE_DRY_RUN === "true" || !!process.env.ENGINE_RECHECK;
const VITALITY = 3455;
const MIN = 60000, H = 60 * MIN;
const now = Date.now();
const PS = process.env.PANDASCORE_TOKEN, TW_ID = process.env.TWITCH_CLIENT_ID, TW_SECRET = process.env.TWITCH_CLIENT_SECRET;
if (!PS || !TW_ID || !TW_SECRET || !process.env.FIREBASE_SA) { console.log("::warning::Secrets manquants, moteur inactif"); fs.writeFileSync(".engine-next", "1800"); process.exit(0); }

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SA)) });
const db = admin.firestore();
const stateRef = db.doc("meta/engine");
const state = (await stateRef.get()).data() || {};
state.decoys = state.decoys || {}; // serieId -> { follow: teamId, after: ISO }

const data = JSON.parse(fs.readFileSync("data.json", "utf8"));
data.matches = data.matches || []; data.links = data.links || [];
// Contrôle : recalcule les liens d'un match déjà traité (sans rien écrire) pour comparer avec ceux publiés
const RECHECK = process.env.ENGINE_RECHECK || "";
const published = data.links.filter((l) => l.match === RECHECK).map((l) => l.id + " " + l.url);
if (RECHECK) {
  const m = data.matches.find((x) => x.key === RECHECK);
  if (m) { delete m.done; m.start = new Date(Date.now() - 3600e3).toISOString(); }
  data.links = data.links.filter((l) => l.match !== RECHECK);
}
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

// ---------- 0. Embargo anti-spoiler ----------
// Tout ce qui dépend de la FIN d'un match (match suivant, liens par carte, leurres) attend l'heure où le match
// est forcément terminé quel que soit le score : début + durée maximale du format. Sinon l'heure d'apparition
// révélerait la durée du match, donc le score (2-0 ou 2-1).
const maxDur = (bo) => (bo <= 1 ? 2 : bo <= 3 ? 5 : 8) * H;
const embargo = (x) => Date.parse(x.begin_at || x.scheduled_at) + maxDur(x.number_of_games || 1);
const live = {};
for (const m of data.matches) {
  // Matchs actifs, et matchs clos depuis moins de 12 h (ils peuvent encore être sous embargo)
  if (!m.pid || (m.done && now - Date.parse(m.start) > 12 * H)) continue;
  try { live[m.pid] = (await ps("/csgo/matches?filter[id]=" + m.pid))[0] || null; } catch (e) { console.log(m.key + " : " + e.message); }
}
let holdUntil = 0;
for (const x of Object.values(live)) if (x && x.status !== "not_started" && x.begin_at && now < embargo(x)) holdUntil = Math.max(holdUntil, embargo(x));

// ---------- 1. Découverte ----------
const known = new Map(data.matches.filter((m) => m.pid).map((m) => [m.pid, m]));
function addMatch(x) {
  if (known.has(x.id)) return;
  // Pendant l'embargo, un nouveau match n'apparaît pas (sauf s'il commence dans moins de 90 min)
  if (now < holdUntil && Date.parse(x.scheduled_at || x.begin_at) - now > 90 * MIN) return;
  const day = parisDate(x.scheduled_at || x.begin_at);
  let key = day, n = 2;
  while (data.matches.some((m) => m.key === key)) key = day + "-" + n++;
  const m = { key, start: x.scheduled_at || x.begin_at, event: eventName(x), pid: x.id, ch: channel(x) };
  data.matches.push(m); known.set(x.id, m); changes.push("match " + key);
}
const mine = [...(await ps("/csgo/matches/running?filter[opponent_id]=" + VITALITY)), ...(await ps("/csgo/matches/upcoming?filter[opponent_id]=" + VITALITY + "&per_page=20"))];
for (const x of mine) if (x.scheduled_at || x.begin_at) addMatch(x);

// ---------- 2. Leurres ----------
// Après chaque match de Vitality, il y a TOUJOURS un « match suivant » dans la série : le vrai s'il existe,
// sinon un leurre (Vitality éliminée, ou qualifiée et en attente, comme en format suisse). Même règle de temps
// pour les deux : il apparaît après l'embargo du match précédent, ou plus tôt s'il commence dans moins de 90 min.
// Ainsi, ni la présence, ni le jour, ni l'heure d'apparition du match suivant ne révèlent le résultat.
// Prudence : un leurre n'est choisi que si tous les matchs de son tour (± 6 h) sont tirés et sans Vitality.
try {
  const past = await ps("/csgo/matches/past?filter[opponent_id]=" + VITALITY + "&sort=-scheduled_at&per_page=5");
  const last = past.find((x) => x.status === "finished" && x.serie_id);
  if (last) {
    const serie = last.serie_id;
    const all = await ps("/csgo/matches?filter[serie_id]=" + serie + "&per_page=100&sort=scheduled_at");
    const byId = new Map(all.map((x) => [x.id, x]));
    const ids = (x) => (x.opponents || []).map((o) => o.opponent && o.opponent.id).filter(Boolean);
    const T = (x) => Date.parse(x.scheduled_at || x.begin_at);
    const st = state.decoys[serie] || (state.decoys[serie] = {});
    st.ids = st.ids || [];
    if (!st.follow) st.follow = ids(last).find((id) => id !== VITALITY) || null;
    for (let guard = 0; guard < 6; guard++) {
      // Point de départ : le plus récent entre le dernier vrai match terminé et le dernier leurre publié
      const anchor = [last, ...st.ids.map((id) => byId.get(id)).filter(Boolean)].sort((a, b) => T(b) - T(a))[0];
      // Un vrai match de Vitality prévu après ce point : c'est lui le match suivant, pas de leurre
      if (mine.some((x) => x.serie_id === serie && T(x) > T(anchor))) break;
      if (all.some((x) => ids(x).includes(VITALITY) && x.status !== "finished" && T(x) > T(anchor))) break;
      const cands = all.filter((x) => x.status !== "canceled" && x.scheduled_at && T(x) > T(anchor) + 30 * MIN && !ids(x).includes(VITALITY)
        && T(x) < now + 3 * 24 * H).sort((a, b) => T(a) - T(b));
      if (!cands.length) break; // série terminée
      const first = T(cands[0]);
      const round = all.filter((x) => x.status !== "canceled" && x.scheduled_at && T(x) > T(anchor) + 30 * MIN && T(x) - first <= 6 * H);
      if (round.some((x) => ids(x).length < 2)) break; // tour pas entièrement tiré (une place peut être celle de Vitality)
      // Après la fin d'un leurre : si l'équipe suivie l'a perdu, on suit son vainqueur
      if (anchor !== last && anchor.status === "finished" && anchor.winner_id && anchor.winner_id !== st.follow && ids(anchor).includes(st.follow)) st.follow = anchor.winner_id;
      const inRound = cands.filter((x) => T(x) - first <= 6 * H);
      const pick = inRound.find((x) => ids(x).includes(st.follow)) || inRound[0];
      // Même règle de temps qu'un vrai match suivant
      if (!(now >= embargo(anchor) || T(pick) - now <= 90 * MIN)) break;
      if (!ids(pick).includes(st.follow)) st.follow = ids(pick)[0];
      const before = known.has(pick.id);
      addMatch(pick);
      if (!known.has(pick.id)) break;
      if (!st.ids.includes(pick.id)) st.ids.push(pick.id);
      if (before && st.ids.length > 20) break;
    }
  }
} catch (e) { console.log("leurres : " + e.message); }

// ---------- 3. Liens ----------
const hasLink = (id) => data.links.some((l) => l.id === id);
function addLink(l) { if (hasLink(l.id)) return false; data.links.push({ ...l, createdAt: new Date(now).toISOString() }); changes.push("lien " + l.id); return true; }
function setMap(key, i, u, unplayed) {
  const id = key + "-map" + i, l = data.links.find((x) => x.id === id);
  if (!l) { addLink({ id, match: key, kind: "map", map: i, url: u, ...(unplayed ? { unplayed: true } : {}) }); return; }
  if (l.url !== u || !!l.unplayed !== unplayed) {
    l.url = u; if (unplayed) l.unplayed = true; else delete l.unplayed;
    changes.push("carte " + id);
  }
}
const url = (vod, sec) => "https://www.twitch.tv/videos/" + vod + "?t=" + hms(sec);

for (const m of data.matches) {
  if (!m.pid || m.done) continue;
  let x = live[m.pid];
  if (x === undefined) { try { x = (await ps("/csgo/matches?filter[id]=" + m.pid))[0]; } catch (e) { console.log(m.key + " : " + e.message); continue; } }
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
    // c) liens par carte, affichés dès le début du match : toujours le nombre maximal de cartes du format.
    //    Cartes forcément jouées (1-2 en Bo3, 1-3 en Bo5) : vrai début dès qu'elles commencent.
    //    Cartes incertaines : début du match jusqu'à la fin, puis vrai début ou « pas jouée ».
    const def = data.links.find((l) => l.id === m.key + "-definitif");
    if (begun && def) {
      const defId = (def.url.match(/\/videos\/(\d+)/) || [])[1];
      const v = (defId && await vodById(m.ch, defId)) || await vodFor(m.ch, Date.parse(x.begin_at));
      if (v) {
        const bo = x.number_of_games || 1, sure = Math.ceil(bo / 2), fin = x.status === "finished";
        const played = (x.games || []).filter((g) => g.begin_at).sort((a, b) => a.position - b.position);
        const lastG = played[played.length - 1];
        const lastEnd = Date.parse((lastG && lastG.end_at) || x.end_at || x.begin_at);
        const defUrl = url(v.id, (Date.parse(x.begin_at) - v.start) / 1000 - 90);
        for (let i = 1; i <= bo; i++) {
          const g = played.find((p) => p.position === i);
          let u, unplayed = false;
          if (g && (i <= sure || fin)) u = url(v.id, (Date.parse(g.begin_at) - v.start) / 1000 - 60);
          else if (fin) { u = url(v.id, (lastEnd - v.start) / 1000 + 30); unplayed = true; }
          else u = defUrl;
          setMap(m.key, i, u, unplayed);
        }
        // Fin du match (repère dans la vidéo) : sert seulement à savoir si le replay a été vu jusqu'au bout
        if (fin && !def.end) { def.end = hms((lastEnd - v.start) / 1000); changes.push("fin " + m.key); }
        if (fin) m.done = true;
      }
    }
  } catch (e) { console.log(m.key + " : " + e.message); }
}

// Diagnostic en simulation : vérifie l'accès à l'API Twitch pour les chaînes des matchs actifs
if (DRY) {
  for (const ch of [...new Set(data.matches.filter((m) => m.pid && !m.done && m.ch).map((m) => m.ch))]) {
    try { const v = await vods(ch); console.log("::notice::Twitch " + ch + " : " + v.length + " vidéo(s), la plus récente commencée " + (v[0] ? new Date(v[0].start).toISOString() : "?")); }
    catch (e) { console.log("::warning::Twitch " + ch + " : " + e.message); }
  }
}

// Rattrapage : repère de fin pour les matchs déjà clos (30 derniers jours)
for (const m of data.matches) {
  const def = data.links.find((l) => l.id === m.key + "-definitif");
  if (!m.pid || !m.done || !def || def.end || now - Date.parse(m.start) > 30 * 24 * H || !m.ch) continue;
  try {
    const x = (await ps("/csgo/matches?filter[id]=" + m.pid))[0];
    if (!x || x.status !== "finished") continue;
    const defId = (def.url.match(/\/videos\/(\d+)/) || [])[1];
    const v = defId && await vodById(m.ch, defId);
    if (!v) continue;
    const played = (x.games || []).filter((g) => g.begin_at).sort((a, b) => a.position - b.position);
    const lastG = played[played.length - 1];
    const lastEnd = Date.parse((lastG && lastG.end_at) || x.end_at || x.begin_at);
    def.end = hms((lastEnd - v.start) / 1000); changes.push("fin " + m.key);
  } catch (e) { console.log(m.key + " : " + e.message); }
}

// ---------- 4. Écriture ----------
if (changes.length) {
  if (DRY) {
    console.log("::notice::Simulation, rien n'est écrit : " + changes.join(", "));
    for (const l of data.links.filter((l) => Date.parse(l.createdAt) >= now)) console.log("::notice::" + l.id + " " + l.url);
    if (RECHECK) console.log("::notice::Publiés : " + published.join(" | "));
  } else {
    fs.writeFileSync("data.json", JSON.stringify(data, null, 2) + "\n");
    console.log("::notice::" + changes.length + " changement(s)");
  }
}
if (!DRY) await stateRef.set(state);
fs.writeFileSync(process.env.GITHUB_OUTPUT || "/dev/null", "changed=" + (changes.length && !DRY ? "true" : "false") + "\n", { flag: "a" });
// Rythme conseillé pour le prochain passage : 5 min autour des matchs (de 6 h avant à la fin), sinon 30 min
const busy = data.matches.some((m) => m.pid && !m.done && Date.parse(m.start) - now < 6 * H);
fs.writeFileSync(".engine-next", String(busy ? 300 : 1800));
fs.writeFileSync(".engine-changed", changes.length && !DRY ? "1" : "0");
