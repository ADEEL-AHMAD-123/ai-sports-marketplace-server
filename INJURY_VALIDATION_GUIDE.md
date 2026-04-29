# Real-World Injury Validation & Accuracy Improvement

## 1. HOW INJURIES WORK IN REAL NBA GAMES

### Pre-Game Timeline

```
T-48h: Injury reports issued
  Status: Day-to-Day, Questionable, Doubtful, Out
  Source: Team official announcements + medical staff

T-24h: Updated injury reports
  Status may change as more info emerges
  Sportsbooks adjust lines based on injury likelihood

T-2h: 48-hour update
  More concrete status, odds adjust again
  Sharp bettors react to this news

T-1h: Game-time decision (GTD)
  Final status announced
  If "Out" → prop markets close immediately
  If "Questionable" → line may spike/plummet

T-0: Game starts
  Official rosters confirmed
  No changes allowed mid-game
```

### How Sportsbooks React

```
SCENARIO 1: Star player Out
  Before: Points Over/Under 25.5 (-110/-110)
  News: Player ruled Out
  After: Market CLOSES (no props offered)
  
  Reality: DraftKings immediately pulls all props for that player
           The Odds API stops returning them
           We receive empty response → props disappear from DB

SCENARIO 2: Star player Questionable → plays
  Before: Points Over/Under 25.5 (-110/-110)
  Status: Questionable (uncertain)
  Decision: Player passes warm-up
  After: Line adjusted ↑ to 26.5 (because players playing injured often underperform)
  
  Reality: Line movement detected by propWatcher
           Our insight becomes STALE (line changed too much)
           System marks insight for regeneration

SCENARIO 3: Backup player plays instead of starter
  Before: Starter's props at normal lines (e.g., 18.5 pts)
  Status: Starter Out
  Decision: Backup gets 35+ minutes instead of 15
  After: Backup props available, starter props close
  
  Reality: Completely different players to analyze
           Our insights for starter are wasted
           Backup has fresh props (no historical model)
```

---

## 2. CURRENT SYSTEM ACCURACY PROBLEMS

### Problem 1: We Show Props for Out Players (Briefly)

```javascript
// Timeline of what happens NOW:
T-48h: Injury report says "Out" (API-Sports has it)
       → injuryService returns { status: "Out", ... }
       → We inject "PLAYER OUT" in AI prompt
       → AI generates insight ✓ (with injury context)
       → Insight stored with injury context in aiLog.prompt

T-24h: PropWatcher fetches latest props from The Odds API
       → Market may not be closed yet (sportsbooks slow to react)
       → Props still exist with original line
       → We update PlayerProp isAvailable=true
       → User sees prop and can unlock insight ⚠️

T-1h:  PropWatcher runs again
       → The Odds API finally closed the market
       → fetchProps returns empty array
       → We set isAvailable=false on all props ✓
       → But user already unlocked the insight for a player who won't play ❌

RESULT: User wastes credit on insight for Out player
```

### Problem 2: We Don't Validate Insights Against Game Outcomes

```javascript
// After game finishes:

Player: LeBron James
Line: 25.5 points
AI Prediction: 28.3 (OVER edge)
Confidence: 87%
User: Bets OVER

Game happens...
Actual result: LeBron played 18 minutes (injured during game)
Actual stat: 19 points (UNDER)
User: Lost the bet

But we don't know:
  - Was LeBron listed as "Out" pre-game? (We should have excluded him)
  - Or was he healthy but injured mid-game? (Legitimate bad luck)
  - Was our prediction wrong? Or was the injury the cause?

We have NO WAY to correlate:
  - Injury status at prediction time
  - Actual game participation
  - Insight accuracy
```

### Problem 3: Backup Players With No Historical Data

```javascript
// Common scenario:

Scenario: Starter is Out, backup gets unexpected minutes

BEFORE our system:
  Backup player's props never generated before
  PropWatcher can't resolve player ID (no game log history)
  Historical models don't exist yet
  dataQuality = WEAK (no game log)

OUR SYSTEM:
  Generates insight with WEAK data quality
  AI notes: "Caution: very limited data on this player"
  But 35+ minutes vs. normal 8 minutes plays completely different
  
REALITY:
  Every advanced bettor knows backup data is unreliable
  Expected value calculation completely different
  Line adjusts to account for role uncertainty
```

---

## 3. HOW TO VALIDATE ACCURACY IN REAL TIME

### Step 1: Track Game Participation (After Game Ends)

```javascript
// New data we should collect:

After GAME_STATUS = FINISHED:

1. Query API-Sports v2 Box Score
   GET https://v2.nba.api-sports.io/games?season=2025&date=2026-04-27
   
   For each player:
     - minutes_played (extract from box score)
     - field_goals_made, field_goals_attempted
     - rebounds, assists, three_pointers, etc.
     - Did player appear? (minutes_played > 0)

2. Store in new GameResult collection:
   {
     sport: 'nba',
     eventId: '...',
     playerName: 'LeBron James',
     statType: 'points',
     lineAtPrediction: 25.5,
     aiPredictedValue: 28.3,
     insightConfidence: 87,
     aiRecommendation: 'over',
     
     // ACTUAL GAME RESULT:
     playerParticipated: true,
     minutesPlayed: 38,
     actualStatValue: 26,
     
     // VALIDATION:
     didPlayerPlay: true,
     predictionCorrect: false,  // predicted 28.3 over 25.5, actual 26 (barely over)
     wasInjuryRelated: false,
     
     // IF INJURY RELATED:
     preGameInjuryStatus: null,  // Would be "Out" or "Doubtful" if injured
     injuryImpactedPerformance: false,
   }

3. Calculate accuracy metrics:
   - Overall: % correct predictions
   - By confidence level: 87% confidence → what actual accuracy?
   - By dataQuality: Strong=X%, Moderate=Y%, Weak=Z%
   - By injury status: Healthy players vs. Injured-but-played
```

### Step 2: Pre-Game Validation (Before Generating Insight)

```javascript
// NEW: Check injury status BEFORE generating insight

InsightService.generateInsight():
  
  // Step 1: Check injury status
  const injuryData = await getPlayerInjuryStatus(playerName, teams);
  
  // NEW LOGIC:
  if (injuryData?.status === 'Out') {
    return {
      insight: null,
      error: 'PLAYER_OUT',
      reason: `${playerName} ruled OUT. No insight generated.`,
      injuryInfo: injuryData,
    };
  }
  
  if (injuryData?.status === 'Doubtful') {
    logger.warn('[InsightService] Player doubtful, proceeding with caution', {
      playerName,
      severity: injuryData.severity,
    });
    // Generate insight but flag it as HIGH RISK
  }
  
  // Continue generating insight...
```

### Step 3: Track Role Changes (Backup vs Starter)

```javascript
// New fields to track:

PlayerProp:
  expectedMinutes: 20,      // Historical average
  rolesCurrently: ['starter', 'bench'],  // Inferred from recent games
  
After prop update:
  
  if (newMinutesRoleFull) {
    const backupThisGame = detectRoleChange(playerName, game);
    
    if (backupThisGame && expectedMinutes < 25) {
      // Role change detected
      const insight = await Insight.findOne({ playerName, eventId, statType });
      
      if (insight && insight.dataQuality === 'strong') {
        // Data quality should be downgraded
        await Insight.updateOne(
          { _id: insight._id },
          { 
            $set: { 
              dataQuality: 'weak',
              roleChangeFlag: true,
              roleChangeReason: 'Expected minutes differ significantly from historical role'
            }
          }
        );
      }
    }
  }
```

---

## 4. IMPROVING ACCURACY WITH REAL-WORLD DATA

### Strategy 1: Exclude "Out" Players Pre-Game

```javascript
// File: InsightService.js
// Add before Step 2 (fetch stats):

const _preGameInjuryCheck = async (playerName, teams) => {
  try {
    const injuryStatus = await getPlayerInjuryStatus(playerName, teams);
    
    if (injuryStatus?.status === 'Out') {
      logger.warn('[InsightService] Skipping Out player', {
        playerName,
        status: injuryStatus.status,
        reason: injuryStatus.reason,
      });
      return { skip: true, status: 'Out', reason: injuryStatus.reason };
    }
    
    if (injuryStatus?.status === 'Doubtful') {
      logger.info('[InsightService] Doubtful player - proceeding with caution', { playerName });
      return { skip: false, status: 'Doubtful', caution: true };
    }
    
    return { skip: false, status: 'Healthy' };
  } catch (err) {
    logger.error('[InsightService] Injury check failed', { playerName, error: err.message });
    // Default to not skipping if API fails (don't break generation)
    return { skip: false, status: 'Unknown', apiError: true };
  }
};

// Usage in generateInsight():
const injuryCheck = await this._preGameInjuryCheck(playerName, teams);

if (injuryCheck.skip) {
  return {
    insight: null,
    creditDeducted: false,
    error: `Player listed as ${injuryCheck.status}. Insight not generated.`,
    injuryInfo: injuryCheck,
  };
}

if (injuryCheck.caution) {
  logger.info('[InsightService] Generating insight with injury caution flag');
  // Continue, but AI will already see caution in prompt
}
```

### Strategy 2: Flag High-Risk Props Before User Sees Them

```javascript
// File: PlayerProp.model.js
// Add new fields:

playerPropSchema.add({
  // Injury/Risk flags
  hasInjuryRisk: {
    type: Boolean,
    default: false,
    index: true,
  },
  
  injuryRiskLevel: {
    type: String,
    enum: ['low', 'medium', 'high', null],
    default: null,
  },
  
  injuryNote: {
    type: String,
    default: null,
  },
  
  // Role change flags
  roleChangeDetected: {
    type: Boolean,
    default: false,
  },
  
  expectedMinutesHistorical: {
    type: Number,
    default: null,
  },
  
  backupPlayerRoleExpected: {
    type: Boolean,
    default: false,
  },
});

// File: odds.controller.js
// Update getProps to flag high-risk:

const props = await PlayerProp.find(query)
  .select('-__v -apiSportsPlayerId')
  .lean();

const withRiskFlags = props.map(p => ({
  ...p,
  riskLevel: p.injuryRiskLevel || (p.roleChangeDetected ? 'medium' : 'low'),
  riskMessage: p.injuryNote || (p.roleChangeDetected ? 'Player may be in backup role' : null),
}));

// Frontend can show badge: 🚩 INJURY RISK or 🔄 ROLE CHANGE
```

### Strategy 3: Validate Historical Accuracy

```javascript
// New file: server/jobs/accuracyValidator.job.js

const validateFinishedGameInsights = async (sport) => {
  // Get games that finished 1-2 hours ago (enough time for final stats)
  const recentlyFinished = await Game.find({
    sport,
    status: GAME_STATUS.FINISHED,
    startTime: {
      $lte: new Date(),
      $gte: new Date(Date.now() - 2 * 60 * 60 * 1000), // Last 2 hours
    },
  }).lean();

  for (const game of recentlyFinished) {
    // Fetch final box scores
    const adapter = getAdapter(sport);
    const boxScores = await adapter.fetchBoxScore(game.oddsEventId);
    
    for (const player of boxScores.players) {
      // Find all insights for this player in this game
      const insights = await Insight.find({
        eventId: game.oddsEventId,
        playerName: player.name,
        status: 'generated',
      }).lean();

      for (const insight of insights) {
        const actual = player[insight.statType]; // e.g., player.points
        const predicted = insight.focusStatAvg;
        
        // Validate
        const correct = 
          (insight.recommendation === 'over' && actual >= insight.bettingLine) ||
          (insight.recommendation === 'under' && actual < insight.bettingLine);
        
        // Store result
        await GameResult.create({
          eventId: game.oddsEventId,
          insightId: insight._id,
          playerName: player.name,
          statType: insight.statType,
          
          lineAtPrediction: insight.bettingLine,
          aiPredictedValue: predicted,
          aiRecommendation: insight.recommendation,
          confidence: insight.confidenceScore,
          dataQuality: insight.dataQuality,
          
          actualValue: actual,
          playerMinutesPlayed: player.minutes,
          predictionCorrect: correct,
        });
      }
    }
  }
};

// Analyze patterns
const analyzeAccuracy = async () => {
  const results = await GameResult.aggregate([
    {
      $group: {
        _id: '$dataQuality',
        totalPredictions: { $sum: 1 },
        correctPredictions: {
          $sum: { $cond: ['$predictionCorrect', 1, 0] }
        },
        accuracy: {
          $avg: { $cond: ['$predictionCorrect', 1, 0] }
        },
      }
    }
  ]);
  
  console.log('Accuracy by Data Quality:');
  results.forEach(r => {
    console.log(`  ${r._id}: ${(r.accuracy * 100).toFixed(1)}% (${r.correctPredictions}/${r.totalPredictions})`);
  });
};
```

### Strategy 4: Machine Learning Model Update

```javascript
// Track which factors correlate with prediction accuracy

const mlInput = {
  // Structural
  dataQuality: insight.dataQuality,           // strong/moderate/weak
  confidenceScore: insight.confidenceScore,   // 0-100
  edgePercentage: insight.edgePercentage,     // magnitude of signal
  
  // Injury context
  hasInjuryRisk: prop.hasInjuryRisk,         // bool
  injuryRiskLevel: prop.injuryRiskLevel,     // low/medium/high
  
  // Role context
  roleChangeDetected: prop.roleChangeDetected,
  backupRole: prop.backupPlayerRoleExpected,
  minuteExpectancy: prop.expectedMinutesHistorical,
  
  // Market context
  lineSize: insight.bettingLine,              // small lines harder to hit
  bookmakerSportSharp: detectSharpMoney(insight), // Did sharp bettors pile on?
  
  // Game context
  daysRest: calculateTeamRest(game),
  homeAway: game.homeTeam === playerTeam,
  opponent: game.opponentTeamTier,            // elite defense vs weak
};

// After game results come in:
const prediction = {
  correct: gameResult.predictionCorrect,      // 1 = correct, 0 = wrong
};

// Update model weights
// Insight: insights with weak dataQuality and role changes
// should have lower expected accuracy (lower confidence recommended)
```

---

## 5. IMPLEMENTATION ROADMAP

### Phase 1: Pre-Game Injury Filtering (CRITICAL)
- [ ] Add `_preGameInjuryCheck()` to InsightService
- [ ] Skip generating insights for "Out" players
- [ ] Flag "Doubtful" players with warning
- [ ] Test: Verify no insights generated for Out players

### Phase 2: Data Collection (HIGH)
- [ ] Create GameResult collection schema
- [ ] Add accuracy validation job (runs every 2 hours after games)
- [ ] Collect box scores and player stats after games finish
- [ ] Store validation metadata with each result

### Phase 3: Risk Flagging (HIGH)
- [ ] Add injuryRisk fields to PlayerProp schema
- [ ] Update propWatcher to detect injury status changes
- [ ] Flag props with role changes (minutes expectancy mismatch)
- [ ] Frontend displays risk badges 🚩 INJURY RISK / 🔄 ROLE CHANGE

### Phase 4: Accuracy Analytics (MEDIUM)
- [ ] Dashboard showing accuracy by data quality
- [ ] Accuracy by confidence level (70-80% conf → actual accuracy?)
- [ ] Accuracy by injury status (healthy vs doubtful)
- [ ] Identify which factors predict failures

### Phase 5: ML Model Updates (FUTURE)
- [ ] Adjust confidence calculations based on learned accuracy patterns
- [ ] Reduce confidence for weak dataQuality + injury props
- [ ] Boost confidence for strong dataQuality with no risk
- [ ] A/B test new confidence formula

---

## 6. REAL-WORLD EXAMPLE

### Scenario: Star Player Injury Timing

```
TUESDAY 2pm:
  Status: LeBron James is Day-to-Day (ankle soreness)
  Action: PropWatcher runs, props still available
  Our system: Generates insight with injury context
  
TUESDAY 6pm:
  Status: LeBron James upgraded to Questionable (improving)
  Action: PropWatcher runs, props still available, line adjustment detected
  Our system: Insight marked STALE (line moved too much)
  
WEDNESDAY 6am:
  Status: LeBron James upgraded to Out (re-imaging shows Grade 2 sprain)
  Action: PropWatcher runs, The Odds API closed market
  Our system: isAvailable → false for all LeBron props
  Frontend: Props disappear
  
ISSUE if we had no pre-game check:
  Some users generated insights on TUESDAY
  Props were available on TUESDAY
  But LeBron ruled Out by WEDNESDAY
  Those users wasted credits on props that closed
  
SOLUTION with pre-game check:
  Before WEDNESDAY insights generated: Check injury status first
  Status = Out → Skip generation with error message
  No wasted credits
  More accurate system
```

---

## 7. SUMMARY: How to Improve Accuracy

| Problem | Solution | Impact |
|---------|----------|--------|
| Show props for Out players | Pre-game injury check (skip generation) | Prevent wasted credits |
| Don't know if predictions right | Validate against game results | Learn from accuracy patterns |
| Backup players hard to predict | Detect role changes, flag as risky | Better UX warnings |
| Low quality data not obvious | Track dataQuality → accuracy correlation | Adjust confidence for weak data |
| No injury impact tracking | Store injury status with results | Identify injury effect magnitude |
| Can't improve over time | Collect validation data systematically | Feed into ML model updates |

The key insight: **Real accuracy comes from validation against actual game outcomes, not just building a good predictor upfront.**
