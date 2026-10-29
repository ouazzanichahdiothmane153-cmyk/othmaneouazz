# WhatsApp Automation

Application web qui permet à votre client de :

1. **intégrer sa base de données de contacts** (import CSV, ou envoi automatique depuis son système via l'API) ;
2. **créer des modèles de messages** et **lancer des campagnes WhatsApp automatisées** (immédiates ou programmées), ciblées par tag ;
3. **suivre les envois** : en attente, envoyés, lus, échecs, et gérer les demandes d'arrêt (« STOP »).

Pas de dépendances npm : Node.js uniquement.

## Démarrage

Prérequis : **Node.js 22.13+**.

```bash
cd whatsapp-app
cp .env.example .env      # puis éditez .env (ADMIN_TOKEN au minimum)
npm start
```

Ouvrez <http://localhost:3000> et saisissez le `ADMIN_TOKEN`.

Sans `WHATSAPP_TOKEN`, l'application fonctionne en **mode simulation** : rien n'est envoyé, les messages sont journalisés dans la console. Idéal pour tester.

## Connecter WhatsApp (Meta Cloud API)

1. Créez une application sur <https://developers.facebook.com> et ajoutez le produit **WhatsApp**.
2. Récupérez le **Phone number ID** et un **jeton d'accès permanent** (utilisateur système) → `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TOKEN`.
3. Dans WhatsApp Manager, faites approuver vos **modèles de message**. Les messages envoyés hors fenêtre de 24 h doivent utiliser un modèle approuvé.
4. Configurez le webhook : URL `https://votre-domaine/webhook`, jeton de vérification = `WHATSAPP_VERIFY_TOKEN`, abonnement à l'événement `messages`. Renseignez `WHATSAPP_APP_SECRET` pour vérifier la signature des requêtes.

Le webhook met à jour les statuts (envoyé → délivré → lu) et enregistre les opt-out lorsqu'un contact répond « STOP ».

> Le webhook et le tableau de bord doivent être servis en **HTTPS** (Meta l'exige).

## Intégrer la base de données du client

Trois options, de la plus simple à la plus technique :

**a) Import manuel (CSV)** : dans le tableau de bord, bouton « Importer CSV ».
La première ligne contient les en-têtes. Colonnes : `phone` (obligatoire), `name`, `tags` (séparés par `|`), plus toute colonne réutilisable dans les modèles (ex. `city`).

**b) Synchronisation automatique par API** : depuis le système du client (script, cron, n8n, Zapier, Make…).

```bash
curl -X POST https://votre-domaine/api/contacts/import \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"contacts":[{"phone":"0655047042","name":"Ali","tags":"vip|promo","city":"Fès"}]}'
```

Les numéros locaux (`0655…`) sont convertis au format international grâce à `DEFAULT_COUNTRY_CODE`. Un contact déjà connu est mis à jour (clé : numéro).

**c) Lecture directe d'une base SQL** : non incluse, car elle dépend du système du client. Un petit script qui lit sa base (MySQL, PostgreSQL…) et appelle l'endpoint (b) suffit, et c'est la solution recommandée.

## API

Toutes les routes `/api/*` exigent `Authorization: Bearer <ADMIN_TOKEN>`.

| Méthode | Route | Rôle |
|---|---|---|
| GET | `/api/stats` | Compteurs (contacts, opt-out, messages par statut) |
| GET | `/api/contacts?q=&tag=` | Liste et recherche de contacts |
| POST | `/api/contacts` | Ajouter ou mettre à jour un contact |
| POST | `/api/contacts/import` | Import JSON en masse |
| POST | `/api/contacts/csv` | Import CSV (corps de la requête = fichier) |
| DELETE | `/api/contacts/:id` | Supprimer un contact |
| GET / POST | `/api/templates` | Lister / créer un modèle |
| GET / POST | `/api/campaigns` | Lister / créer une campagne |
| GET | `/api/campaigns/:id` | Détail et compteurs d'une campagne |
| POST | `/api/campaigns/:id/cancel` | Annuler les messages restants |

Créer une campagne :

```json
{ "name": "Rappel RDV", "template_id": 1, "tag": "vip", "scheduled_at": "2026-11-02T09:00:00+01:00" }
```

Sans `scheduled_at`, la campagne part immédiatement. Sans `tag`, elle cible tous les contacts. Les contacts ayant refusé (STOP) sont toujours exclus.

## Fonctionnement de l'envoi

- Un **worker** tourne en arrière-plan (toutes les `WORKER_INTERVAL_MS`) et envoie les messages espacés de `SEND_DELAY_MS` pour rester raisonnable vis-à-vis des limites de Meta.
- Chaque message est **rendu à la création de la campagne** : l'aperçu correspond exactement à ce qui sera envoyé.
- En cas d'erreur, le message est retenté jusqu'à `MAX_ATTEMPTS` fois, puis marqué `failed`.

## Tests

```bash
npm test
```

## Sécurité : à faire avant la mise en production

- Remplacer `ADMIN_TOKEN` et `WHATSAPP_VERIFY_TOKEN` par des valeurs longues et aléatoires.
- Servir l'application derrière HTTPS (reverse proxy comme Caddy ou Nginx, ou hébergeur avec TLS).
- Ne jamais committer le fichier `.env` (déjà ignoré par `.gitignore`).
- Sauvegarder régulièrement `data/app.sqlite`.
- Vérifier que le client dispose du consentement de ses contacts (RGPD, loi 09-08 au Maroc, politique WhatsApp Business).

## Limites connues et pistes d'évolution

- Un seul compte administrateur (un jeton). Pour plusieurs utilisateurs : comptes avec identifiants et rôles.
- Les messages entrants ne sont pas affichés (seul « STOP » est traité).
- Pas de connecteur direct MySQL/PostgreSQL intégré : à ajouter selon la base du client.
