// Passage unique : liens sans spoiler de la finale des Worlds LoL 2026 (5 parties) sur une vidéo Twitch donnée.
// Écrit data/teams/lol-worlds.json et l'ajoute à data/teams.json. Ne journalise aucun résultat.
import fs from "node:fs";
const VOD = "2928653119";
const PS = process.env.PANDASCORE_TOKEN, TW_ID = process.env.TWITCH_CLIENT_ID, TW_SECRET = process.env.TWITCH_CLIENT_SECRET;
const ps = async (p) => { const r = await fetch("https://api.pandascore.co" + p, { headers: { Authorization: "Bearer " + PS } }); if (!r.ok) throw new Error("PandaScore " + r.status + " " + p.split("?")[0]); return r.json(); };
const tok = (await (await fetch("https://id.twitch.tv/oauth2/token?client_id=" + TW_ID + "&client_secret=" + TW_SECRET + "&grant_type=client_credentials", { method: "POST" })).json()).access_token;
const v = (await (await fetch("https://api.twitch.tv/helix/videos?id=" + VOD, { headers: { "Client-Id": TW_ID, Authorization: "Bearer " + tok } })).json()).data[0];
if (!v) throw new Error("vidéo introuvable");
const dur = (s) => { const m = String(s).match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/); return (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0)); };
const vStart = Date.parse(v.created_at), vLen = dur(v.duration);
console.log("::notice::Vidéo " + v.user_login + " commencée " + v.created_at + ", durée " + v.duration);

const leagues = await ps("/lol/leagues?search[name]=World&per_page=50");
const lg = leagues.find((l) => /world/i.test(l.name) && /champ/i.test(l.name + " " + l.slug)) || leagues.find((l) => /worlds?/i.test(l.name));
if (!lg) throw new Error("ligue Worlds introuvable");
const ms = await ps("/lol/matches/past?filter[league_id]=" + lg.id + "&sort=-scheduled_at&per_page=20");
// La finale : le match Bo5 le plus récent dont le début tombe dans la vidéo
const inVod = (x) => { const b = Date.parse(x.begin_at || x.scheduled_at); return b >= vStart && b <= vStart + vLen * 1000; };
const fin = ms.find((x) => x.number_of_games === 5 && inVod(x)) || ms.find((x) => x.number_of_games === 5);
if (!fin) throw new Error("finale introuvable");
console.log("::notice::Match retenu : id " + fin.id + ", prévu " + fin.scheduled_at);

const hms = (sec) => { sec = Math.max(0, Math.round(sec)); return Math.floor(sec / 3600) + "h" + String(Math.floor(sec / 60) % 60).padStart(2, "0") + "m" + String(sec % 60).padStart(2, "0") + "s"; };
const url = (sec) => "https://www.twitch.tv/videos/" + VOD + "?t=" + hms(sec);
const begin = Date.parse(fin.begin_at || fin.scheduled_at);
const played = (fin.games || []).filter((g) => g.begin_at).sort((a, b) => a.position - b.position);
const lastG = played[played.length - 1];
const lastEnd = Date.parse((lastG && lastG.end_at) || fin.end_at || fin.begin_at);
const key = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(begin));
const now = new Date().toISOString();
const links = [{ id: key + "-definitif", match: key, kind: "definitif", url: url((begin - vStart) / 1000 - 90), end: hms((lastEnd - vStart) / 1000), createdAt: now }];
for (let i = 1; i <= 5; i++) {
  const g = played.find((p) => p.position === i);
  links.push({ id: key + "-map" + i, match: key, kind: "map", map: i, unit: "Partie", url: g ? url((Date.parse(g.begin_at) - vStart) / 1000 - 60) : url((lastEnd - vStart) / 1000 + 30), ...(g ? {} : { unplayed: true }), createdAt: now });
}
const team = { id: 999999001, slug: "lol-worlds", name: "LoL Worlds 2026", acronym: "LOL", image: "" };
const data = { team, matches: [{ key, start: fin.scheduled_at || fin.begin_at, event: "LoL Worlds 2026", done: true }], links };
fs.mkdirSync("data/teams", { recursive: true });
fs.writeFileSync("data/teams/lol-worlds.json", JSON.stringify(data, null, 2) + "\n");
const reg = JSON.parse(fs.readFileSync("data/teams.json", "utf8"));
if (!reg.teams.some((t) => t.slug === "lol-worlds")) { reg.teams.splice(1, 0, team); fs.writeFileSync("data/teams.json", JSON.stringify(reg, null, 2) + "\n"); }
console.log("::notice::Liens écrits (6)");
