#!/usr/bin/env bash
# Boucle du moteur : un passage toutes les 5 min près des matchs (sinon 30 min), pendant ~5 h 40,
# puis relance du workflow pour assurer la continuité (les tâches planifiées de GitHub sont trop irrégulières).
set -u
END=$((SECONDS + 5*3600 + 40*60))
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
while [ $SECONDS -lt $END ]; do
  git pull -q --rebase || git reset -q --hard origin/main
  node .github/engine/engine.mjs || echo "moteur en erreur"
  if [ "$(cat .engine-changed 2>/dev/null)" = "1" ]; then
    git add data.json data && git commit -qm "Mise à jour des liens" && { for i in 1 2 3; do git push -q && break; git pull -q --rebase; done; }
  fi
  node .github/notify/notify.mjs || echo "notifications en erreur"
  NEXT=$(cat .engine-next 2>/dev/null || echo 1800)
  [ $((SECONDS + NEXT)) -ge $END ] && break
  sleep "$NEXT"
done
gh workflow run automate.yml --ref main -R "$GITHUB_REPOSITORY" && echo "relancé"
