# AI Sports Insight Marketplace — Backend

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Set up environment
cp .env.example .env
# Fill in all values in .env

# 3. Start development server
npm run dev
```

## File Structure

```
server/
├── server.js                    # Entry point — starts server + crons
├── src/
│   ├── app.js                   # Express setup — middleware + routes
│   ├── config/
│   │   ├── constants.js         # All app-wide enums and config values
│   │   ├── database.js          # MongoDB connection
│   │   ├── logger.js            # Winston logger with daily rotation
│   │   └── redis.js             # Redis client + helper wrappers
│   ├── models/
│   │   ├── User.model.js        # User accounts, credits, unlocked insights
│   │   ├── Insight.model.js     # AI-generated insights (cold cache)
│   │   ├── PlayerProp.model.js  # Player props with strategy scores
│   │   ├── Game.model.js        # Game schedule
│   │   └── Transaction.model.js # Credit ledger (audit trail)
│   ├── services/
│   │   ├── InsightService.js    # Core AI pipeline (preflight→formula→AI→cache)
│   │   ├── StrategyService.js   # Confidence + edge scoring engine
│   │   ├── CreditService.js     # Credits + Stripe webhook handling
│   │   └── adapters/
│   │       ├── BaseAdapter.js           # Abstract interface for all sports
│   │       ├── adapterRegistry.js       # Central adapter registry
│   │       └── nba/NBAAdapter.js        # NBA implementation (Phase 1)
│   ├── controllers/
│   │   ├── auth.controller.js
│   │   ├── insight.controller.js
│   │   ├── odds.controller.js
│   │   └── credit.controller.js
│   ├── routes/
│   │   ├── auth.routes.js
│   │   ├── odds.routes.js
│   │   ├── insight.routes.js
│   │   └── credit.routes.js
│   ├── middleware/
│   │   ├── auth.middleware.js       # JWT protect + restrictTo + optionalAuth
│   │   ├── errorHandler.middleware.js
│   │   └── validate.middleware.js
│   └── jobs/
│       ├── morningScraper.job.js    # 8 AM — fetch daily schedule
│       ├── propWatcher.job.js       # Every 30 min — fetch/score props
│       └── postGameSync.job.js      # Every 30 min — sync finished games + AI log cleanup
```

## Adding a New Sport

1. Create `/src/services/adapters/{sport}/{Sport}Adapter.js` extending `BaseAdapter`
2. Implement: `fetchSchedule`, `fetchProps`, `fetchPlayerStats`, `fetchCurrentLine`, `applyFormulas`, `buildPrompt`, `normalizeGame`, `normalizeProp`
3. Register it in `adapterRegistry.js`
4. Add it to `ACTIVE_SPORTS` in `constants.js`

## API Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/auth/register` | No | Create account |
| POST | `/api/auth/login` | No | Login |
| GET | `/api/auth/me` | Yes | Get profile |
| GET | `/api/odds/sports` | No | List sports |
| GET | `/api/odds/:sport/games` | No | Today's games |
| GET | `/api/odds/:sport/games/:eventId/props` | No | Game props |
| POST | `/api/insights/unlock` | Yes | Unlock insight (costs 1 credit) |
| GET | `/api/insights` | Yes | List insights |
| GET | `/api/credits/balance` | Yes | Credit balance |
| GET | `/api/credits/packs` | Yes | Available packs |
| POST | `/api/credits/checkout` | Yes | Create Stripe checkout |
| POST | `/api/credits/webhook` | Stripe | Stripe webhook (grants credits) |
| GET | `/api/credits/transactions` | Yes | Transaction history |

## Logs

- `logs/combined-YYYY-MM-DD.log` — All logs
- `logs/error-YYYY-MM-DD.log` — Errors only
- Auto-deleted after `LOG_RETENTION_DAYS` (default: 14 days)
- AI input/output stored in MongoDB, auto-cleaned after `AI_LOG_RETENTION_DAYS` (default: 30 days)