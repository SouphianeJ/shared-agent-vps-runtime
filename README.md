# shared-agent-vps-runtime

Runtime VPS partage pour les clients agents (`vps-personal-codex`, `weekly-ideator-control-plane`).

## Ce repo contient

- l'image Docker commune `codex + copilot`
- le bridge HTTP signe expose sur `/codex/*`
- l'upload direct de fichiers expose sur `/codex/files/*`
- la recolte des fichiers generes depuis `__generated_files__/` en fin de run
- l'emission d'evenements NDJSON `generated_file` avec metadonnees persistables (`fileId`, `originalName`, `contentType`, `size`, `sha256`)
- l'injection d'un token Copilot dedie par application pour les runs non interactifs
- la configuration multi-app du runtime
- les scripts de bootstrap/deploiement VPS
- le workflow GitHub Actions de deploiement

## Principes

- une seule source Git pour le runtime deploye
- un `appId` obligatoire pour chaque requete bridge
- etats `Codex`, `Copilot` et workspaces separes par application
- configuration MCP Copilot uniquement dans le workspace via `.mcp.json`
- convention de sortie utilisateur via `__generated_files__/` dans le workspace
- bibliotheque de fichiers persistants par app/chat dans `file-library`

## Applications declarees

- `vps-personal-codex`
- `weekly-ideator-control-plane`
- `moodle-actions`

## Structure runtime sur le VPS

```text
~/shared-agent-vps-runtime
  docker-compose.yml
  .env
  config/apps.json
  runtime/apps/
    vps-personal-codex/
      codex-home/
      copilot-home/
      workspaces/
    moodle-actions/
      codex-home/
      copilot-home/
      workspaces/
    weekly-ideator-control-plane/
      codex-home/
      copilot-home/
      workspaces/
```

## Variables d'environnement

Voir [.env.example](./.env.example).

Pour `moodle-actions`, utiliser l'app id `moodle-actions` et, si besoin, surcharger les URLs MCP Copilot avec le prefix `MOODLE_ACTIONS_`.
Pour limiter le nombre de tools exposes a Copilot, utiliser `MOODLE_ACTIONS_COPILOT_ENABLED_SERVERS=Moodle`.
Pour limiter la taille des uploads fichiers, utiliser `CHAT_UPLOAD_MAX_BYTES`.

## Auth Copilot CLI

Pour les runs `copilot` non interactifs, utiliser un fine-grained PAT GitHub avec la permission `Copilot Requests`.

Variables supportees:

- `COPILOT_GITHUB_TOKEN`
  - fallback global
- `VPS_PERSONAL_CODEX_COPILOT_GITHUB_TOKEN`
  - prioritaire pour l'app `vps-personal-codex`
- `WEEKLY_IDEATOR_COPILOT_GITHUB_TOKEN`
  - prioritaire pour l'app `weekly-ideator-control-plane`
- `MOODLE_ACTIONS_COPILOT_GITHUB_TOKEN`
  - prioritaire pour l'app `moodle-actions`

Le runtime supprime volontairement `GH_TOKEN` et `GITHUB_TOKEN` de l'environnement du process `copilot` pour eviter qu'un token stale ou non supporte prenne le dessus par erreur.

## Auth Codex via R2

Le runtime partage peut restaurer et republier `auth.json` pour chaque app directement depuis R2, sans dependre du control-plane `weekly-ideator-control-plane`.

Variables requises dans `.env`:

- `R2_BUCKET`
- `R2_ENDPOINT`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`

Configuration optionnelle:

- `R2_CODEX_AUTH_PREFIX`
  - prefix par defaut pour les objets, par exemple `codex-auth`
- `<APP_PREFIX>_CODEX_AUTH_OBJECT_KEY`
  - surcharge explicite par app, par exemple `VPS_PERSONAL_CODEX_CODEX_AUTH_OBJECT_KEY`

Convention par defaut:

- `codex-auth/vps-personal-codex/auth.json`
- `codex-auth/weekly-ideator-control-plane/auth.json`
- `codex-auth/moodle-actions/auth.json`

Scripts:

- `bash scripts/restore-auth-from-r2.sh <app_id>`
- `bash scripts/upload-auth-to-r2.sh <app_id>`

Le bootstrap appelle automatiquement le restore R2 pour chaque app declaree dans `config/apps.json` lorsque la configuration R2 est presente.

## Deploiement

Le workflow GitHub Actions `deploy-runtime.yml` pousse la branche `main` sur le VPS cible et relance `docker compose up -d --build`.

Secrets attendus dans le repo GitHub:

- `VPS_SSH_HOST`
- `VPS_SSH_USER`
- `VPS_SSH_PRIVATE_KEY`

## Bootstrap initial

1. Cloner le repo sur le VPS dans `~/shared-agent-vps-runtime`.
2. Copier `.env.example` vers `.env` et renseigner les secrets.
3. Lancer `bash scripts/bootstrap-vps.sh`.
4. Verifier `curl` signe sur `/codex/health`.

## Migration legacy

Les anciens etats `weekly-ideator-control-plane/.codex-vps` et `.copilot-vps` peuvent etre recopies via [scripts/migrate-legacy-state.sh](./scripts/migrate-legacy-state.sh).
