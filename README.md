# shared-agent-vps-runtime

Runtime VPS partage pour les clients agents (`vps-personal-codex`, `weekly-ideator-control-plane`).

## Ce repo contient

- l'image Docker commune `codex + copilot`
- le bridge HTTP signe expose sur `/codex/*`
- la configuration multi-app du runtime
- les scripts de bootstrap/deploiement VPS
- le workflow GitHub Actions de deploiement

## Principes

- une seule source Git pour le runtime deploye
- un `appId` obligatoire pour chaque requete bridge
- etats `Codex`, `Copilot` et workspaces separes par application
- configuration MCP Copilot uniquement dans le workspace via `.mcp.json`

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
