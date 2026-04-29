# Complete Calculation & Storage Flow

## Quick Reference: Where Each Field is Calculated and Stored

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ FIELD                  │ CALCULATED IN              │ CALCULATION METHOD         │ STORED IN        │ RECALC FREQUENCY  │
├─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ edgePercentage         │ StrategyService._compute   │ (focusStatAvg-line)/line   │ Insight.edge     │ Every insight gen │
│ confidenceScore        │ StrategyService._compute   │ Weighted hit rate OR       │ Insight.conf     │ Every insight gen │
│                        │                            │ edge-to-confidence fallback│                  │                   │
│ isHighConfidence       │ StrategyService._compute   │ confidenceScore >= 70      │ Insight.isHC     │ Every insight gen │
│ isBestValue            │ StrategyService._compute   │ |edgePercentage| >= 6%     │ Insight.isBV     │ Every insight gen │
│ dataQuality            │ NBAFormulas.applyFormulas  │ Window completeness flags  │ Insight.dQ       │ Every insight gen │
│                        │ + AI parsed response       │ (strong/moderate/weak)     │                  │                   │
│ hasFullFormWindow      │ NBAFormulas.applyFormulas  │ formGames.length >= 5      │ aiLog.processed  │ Every insight gen │
│ hasFullEdgeWindow      │ NBAFormulas.applyFormulas  │ edgeGames.length >= 10     │ aiLog.processed  │ Every insight gen │
│ hasFullBaselineWindow  │ NBAFormulas.applyFormulas  │ baselineGames.length >= 30 │ aiLog.processed  │ Every insight gen │
│ formGamesCount         │ NBAFormulas.applyFormulas  │ formGames.length (ACTUAL)  │ Insight.form     │ Every insight gen │
│ edgeGamesCount         │ NBAFormulas.applyFormulas  │ edgeGames.length (ACTUAL)  │ Insight.edge     │ Every insight gen │
│ baselineGamesCount     │ NBAFormulas.applyFormulas  │ baselineGames.length       │ Insight.base     │ Every insight gen │
│ injuryStatus           │ injuryService.getPlayer    │ API-Sports /injuries EP    │ ❌ NOT STORED    │ Every insight gen │
│                        │ InjuryStatus()             │ Cache 6h by team+date      │                  │                   │
│ injuryReason           │ injuryService.getPlayer    │ API-Sports /injuries EP    │ ❌ NOT STORED    │ Every insight gen │
│                        │ InjuryStatus()             │ Return date + reason       │                  │                   │
│ injuryContext          │ injuryService.getInjury    │ If status exists → warning │ In AI prompt     │ Every insight gen │
│                        │ PromptContext()            │ If null → empty string     │ (not persisted)  │                   │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 1. INJURY CONTEXT USAGE

### Calculation Chain
```
Player Name + Team Names
       ↓
injuryService.getPlayerInjuryStatus()
       ↓
API-Sports GET /injuries?league=12&season=2025
       ↓
Cache check (6h TTL by team+date)
       ↓
Returns: { status: "Out"|"Doubtful"|"Questionable"|"Day-to-Day", 
           severity: "critical"|"high"|"medium"|"low",
           reason: "Player out since April 20, return May 1" }
       OR null
       ↓
injuryService.getInjuryPromptContext()
       ↓
Maps to prompt string: "PLAYER OUT due to injury" or "" (empty)
```

### Where It's Used
1. **In NBAFormulas.buildPrompt()** (line 255):
   ```javascript
   ${injuryContext ? `\n  INJURY: ${injuryContext}` : ''}
   ```
   - AI sees injury warning and adjusts reasoning
   - May lower confidence if star player is out
   - May raise edge if backup is outperforming

2. **Stored in InsightService** (line 171-175):
   ```javascript
   const injData = await getPlayerInjuryStatus(playerName, teams);
   storedInjuryStatus = injData?.status;
   storedInjuryReason = injData?.reason;
   // Then tries to store in Insight.create():
   insight.create({
     injuryStatus: storedInjuryStatus,      // ⚠️ Field not in schema
     injuryReason: storedInjuryReason,      // ⚠️ Field not in schema
   });
   ```

### **ISSUE: Injury Fields Not in Insight Schema**
- **Problem**: Insight model doesn't define `injuryStatus` or `injuryReason` fields
- **Result**: Mongoose silently ignores these fields (no error thrown)
- **Impact**: Frontend cannot retrieve injury status from stored insights
- **Workaround**: Frontend must call injuryService API on every insight view (inefficient, extra API calls)

---

## 2. EDGE PERCENTAGE CALCULATION

### Location: StrategyService._computeScores() (line 167-180)

```javascript
const rawEdge = bettingLine > 0 && focusStatAvgNum > 0
  ? ((focusStatAvgNum - bettingLine) / bettingLine) * 100
  : 0;
const edgePercentage = isNaN(rawEdge) ? 0 : parseFloat(rawEdge.toFixed(2));
const absEdge = Math.abs(edgePercentage);
```

### Formula
```
Edge % = (AI_Predicted_Avg - Betting_Line) / Betting_Line × 100

POSITIVE = OVER edge (player avg exceeds line)
NEGATIVE = UNDER edge (player avg falls short of line)
0 = No edge (perfectly fair line)

Example 1 (Points):
  Predicted avg: 26.5 points
  Line: 25.5 points
  Edge = (26.5 - 25.5) / 25.5 × 100 = +3.92%
  Interpretation: Player OVER edge of ~4%

Example 2 (Rebounds):
  Predicted avg: 8.2 rebounds
  Line: 8.5 rebounds
  Edge = (8.2 - 8.5) / 8.5 × 100 = -3.53%
  Interpretation: Player UNDER edge of ~3.5%
```

### Storage
- **Insight.edgePercentage** (float, stored in MongoDB)
- **PlayerProp.edgePercentage** (updated by propWatcher cron)
- **Frontend filtering**: `isBestValue = |edge| >= 6%`

### Recalculation
- **Every time** `generateInsight()` is called
- **Input**: processedStats from NBAFormulas (contains focusStatAvg)
- **Input**: bettingLine from user request
- **Output**: edgePercentage (stored), isBestValue (derived boolean)

---

## 3. CONFIDENCE SCORE CALCULATION

### Location: StrategyService._computeScores() (line 175-193)

### Path A: With Game Log (Preferred)
```javascript
const direction = focusStatAvgNum >= bettingLine ? 'over' : 'under';
const total = recentStatValues.length;
const maxWeight = 1.4;
const strongMargin = Math.min(2.0, bettingLine);      // Min 2pts, or line if small
const normalMargin = Math.min(0.5, bettingLine * 0.5); // Min 0.5pts or 50% of line

const weightedHits = recentStatValues.reduce((sum, val) => {
  const margin = direction === 'over' ? val - bettingLine : bettingLine - val;
  if (margin <= 0) return sum;  // Hit missed
  return sum + (margin >= strongMargin ? 1.4 : margin >= normalMargin ? 1.0 : 0.7);
}, 0);

confidenceScore = Math.min(100, Math.round((weightedHits / (total * maxWeight)) * 100));
```

### Formula Explanation
1. **Direction**: Are we betting OVER or UNDER?
2. **Game Log Review**: Check each recent game
3. **Weighted Hit Rating**:
   - Strong hit (margin ≥ 2pts): weight = 1.4
   - Normal hit (margin ≥ 0.5pts): weight = 1.0
   - Weak hit (margin < 0.5pts): weight = 0.7
   - Miss (margin ≤ 0): weight = 0
4. **Confidence**: (totalWeight / maxPossibleWeight) × 100

### Path B: Fallback (No Game Log)
```javascript
const absEdge = Math.abs(edgePercentage);

if (absEdge >= 20) return 80;      // Strong edge
if (absEdge >= 12) return 65;      // Moderate edge
if (absEdge >= 6) return 50;       // Weak edge
return 30;                          // Minimal edge
```

### Example Calculation
```
Recent games: [20, 28, 22, 26, 21] points
Line: 25.5 points
Direction: OVER (avg=23.4 < 25.5, so checking under misses)

Actually let's flip: Line 22 (player avg =23.4, so OVER)
Strong margin: min(2.0, 22) = 2.0
Normal margin: min(0.5, 22 * 0.5) = 0.5

Game 1: 20 pts, margin = 20-22 = -2 (miss) → 0
Game 2: 28 pts, margin = 28-22 = 6 ≥ 2.0 (strong hit) → 1.4
Game 3: 22 pts, margin = 22-22 = 0 (miss) → 0
Game 4: 26 pts, margin = 26-22 = 4 ≥ 2.0 (strong hit) → 1.4
Game 5: 21 pts, margin = 21-22 = -1 (miss) → 0

weightedHits = 1.4 + 1.4 = 2.8
maxPossibleWeight = 5 × 1.4 = 7.0
confidence = round(2.8 / 7.0 × 100) = round(40) = 40
```

### Storage
- **Insight.confidenceScore** (0-100 integer)
- **PlayerProp.confidenceScore** (updated by propWatcher)
- **Derived**: `isHighConfidence = confidenceScore >= 70`

### Recalculation
- **Every time** `generateInsight()` is called
- **Input**: recentStatValues from processedStats (game log)
- **Fallback**: Uses edgePercentage if no game log
- **Output**: confidenceScore (0-100), isHighConfidence (bool)

---

## 4. DATA QUALITY CALCULATION

### Location: NBAFormulas.applyFormulas() (lines 76-189)

### Calculation Steps
```javascript
// Step 1: Slice game log into three windows
const formWindow = 5;        // FORM_WINDOW
const EDGE_WINDOW = 10;
const BASELINE_WINDOW = 30;

const formGames = rawStats.slice(-formWindow);      // Last 5 games
const edgeGames = rawStats.slice(-EDGE_WINDOW);     // Last 10 games
const baselineGames = rawStats.slice(-BASELINE_WINDOW); // Last 30 games

// Step 2: Calculate statistics for each window (sums, averages, etc.)
const fT = sum(formGames);      // Form total
const eT = sum(edgeGames);      // Edge total
const bT = sum(baselineGames);  // Baseline total

// Step 3: Compute actual game counts
const fC = formGames.length || 1;      // Actual form game count
const eC = edgeGames.length || 1;      // Actual edge game count
const bC = baselineGames.length || 1;  // Actual baseline game count

// Step 4: Determine window completeness
const hasFullFormWindow = formGames.length >= formWindow;     // Have we reached target 5?
const hasFullEdgeWindow = edgeGames.length >= EDGE_WINDOW;    // Have we reached target 10?
const hasFullBaselineWindow = baselineGames.length >= BASELINE_WINDOW; // Target 30?

// Step 5: Compute dataQuality from actual completeness
let dataQuality = 'strong';
if (!hasFullFormWindow || !hasFullEdgeWindow || !hasFullBaselineWindow) {
  dataQuality = hasFullEdgeWindow ? 'moderate' : 'weak';
}
```

### Data Quality Scale
```
STRONG   = All three windows complete (5g, 10g, 30g available)
           → Confidence in prediction is high, player history is established

MODERATE = Edge window (10g) complete, but form or baseline incomplete
           → Core signal is solid, but missing context on recent form or season baseline
           → Example: Player traded 2 weeks ago (incomplete baseline, but 10g in new team)

WEAK     = Even edge window (10g) incomplete
           → Rookie player (< 10 games played), recently returned from injury, etc.
           → Prediction is based on limited data, confidence should be lower
```

### What Gets Passed to AI
```javascript
buildNBAPrompt() receives:
  - Actual counts: formGamesCount, edgeGamesCount, baselineGamesCount
  - Completeness flags: hasFullFormWindow, hasFullEdgeWindow, hasFullBaselineWindow
  - Data quality: dataQuality ('strong'|'moderate'|'weak')
  - Window stats: formPoints, avgPoints, baselinePoints, etc.

Example prompt excerpt:
  THREE-WINDOW ANALYSIS:
    FORM     (last 5g): avg 23.4, min/g 28 ← Have we reached target 5? YES
    EDGE     (last 10g): avg 24.1, min/g 29 ← Have we reached target 10? YES
    BASELINE (last 30g): avg 22.8, min/g 27 ← Have we reached target 30? YES
  
  → AI infers: dataQuality should be 'strong'
```

### What the AI Returns
```javascript
{
  "recommendation": "over",
  "confidence": "high",
  "factors": [...],
  "risks": [...],
  "dataQuality": "strong" ← AI re-derives from the data we showed it
}
```

### Storage
- **Insight.dataQuality** (enum: 'weak'|'moderate'|'strong')
- **Insight.aiLog.processedStats** includes:
  - formGamesCount (actual)
  - edgeGamesCount (actual)
  - baselineGamesCount (actual)
  - hasFullFormWindow (bool)
  - hasFullEdgeWindow (bool)
  - hasFullBaselineWindow (bool)

### Recalculation
- **Every time** `generateInsight()` is called
- **Also**: Recalculated when:
  - Player gets more recent games (game log grows)
  - Evaluating different stat types (windows may differ by stat)
  - Checking stale insights (propWatcher re-scores every 30 mins)

---

## 5. ALIGNMENT ISSUES

### Issue 1: Injury Fields Not Persisted
**Current State**: InsightService tries to store `injuryStatus` and `injuryReason`, but Insight schema doesn't define them → silently ignored

**Impact**:
- Frontend can show injury during insight generation (from fresh API call)
- But can't retrieve it after page reload (not in DB)
- Frontend must re-query injuryService for every insight view

**Fix**: Add to Insight schema:
```javascript
injuryStatus: {
  type: String,
  enum: ['Out', 'Doubtful', 'Questionable', 'Day-to-Day', null],
  default: null,
},
injuryReason: {
  type: String,
  default: null,
},
```

### Issue 2: Window Counts vs Completeness Not Coordinated
**Current State**: 
- Formulas send `formGamesCount: 5` (actual)
- Formulas also send `hasFullFormWindow: true/false` (completeness)
- But AI doesn't always receive completeness flags clearly in prompt

**Impact**: AI may misinterpret small windows as full

**Fix**: Make completeness more explicit in prompt:
```javascript
FORM     (${formGamesCount}/5 games): avg ${formStat} ${!hasFullFormWindow ? '⚠️ INCOMPLETE' : '✓ COMPLETE'}
```

### Issue 3: DataQuality Derivation Inconsistency
**Current State**:
1. NBAFormulas computes dataQuality from window completeness
2. AI also receives this data and outputs its own dataQuality
3. InsightService stores AI's version: `dataQuality: parsed.dataQuality || 'moderate'`

**Impact**: AI might compute different dataQuality than formulas if it misreads the prompt

**Fix**: Have NBAFormulas pass computed value and tell AI to confirm:
```javascript
// In prompt:
"dataQuality (should be 'strong'|'moderate'|'weak' based on window completeness above)"

// Then InsightService validates:
if (parsed.dataQuality !== formulas.dataQuality) {
  logger.warn('DataQuality mismatch', { formula: formulas.dataQuality, ai: parsed.dataQuality });
  // Use formula value as source of truth
  dataQuality = formulas.dataQuality;
}
```

### Issue 4: No Signal When Injury API Fails
**Current State**:
```javascript
try {
  injuryContext = await getInjuryPromptContext(...);
} catch {
  // Silent fail, continue without injury context
  // But no flag marking that injury data is unavailable
}
```

**Impact**: Insight looks normal, but actually lacks injury context

**Fix**: Add tracking:
```javascript
const injuryApiResult = { status: 'unknown', error: null };
try {
  injuryContext = await getInjuryPromptContext(...);
  injuryApiResult.status = 'success';
} catch (err) {
  injuryApiResult.status = 'failed';
  injuryApiResult.error = err.message;
}

insight.create({
  injuryApiStatus: injuryApiResult.status,
  // Frontend knows to distrust injury signal if status !== 'success'
});
```

---

## 6. WHEN EACH VALUE IS RECALCULATED

```
┌──────────────────────┬────────────────────────────────────────┐
│ TRIGGER              │ WHAT RECALCULATES                      │
├──────────────────────┼────────────────────────────────────────┤
│ generateInsight()    │ ALL (edge, confidence, dataQuality,    │
│                      │ injury context, aiLog)                 │
│ propWatcher cron     │ edge, confidence, flags                │
│ (every 30 mins)      │ (for PlayerProp cache)                 │
│ Injury API call      │ injuryStatus, injuryReason             │
│ (on-demand, cached)  │ (6h TTL per team+date)                 │
│ Manual test script   │ Depends on what script calls           │
└──────────────────────┴────────────────────────────────────────┘
```

---

## 7. SUMMARY TABLE: What's Stored vs Calculated

```
FIELD                      CALCULATED  STORED TO        RETRIEVE FROM      CACHED
────────────────────────────────────────────────────────────────────────────────────
edgePercentage             ✅          Insight          DB query           ✅ in Insight
confidenceScore            ✅          Insight          DB query           ✅ in Insight
isHighConfidence           ✅ derived   Insight          DB query           ✅ in Insight
isBestValue                ✅ derived   Insight          DB query           ✅ in Insight
dataQuality                ✅          Insight          DB query           ✅ in Insight
hasFullFormWindow          ✅          aiLog.processed  DB query (aiLog)    ❌
hasFullEdgeWindow          ✅          aiLog.processed  DB query (aiLog)    ❌
hasFullBaselineWindow      ✅          aiLog.processed  DB query (aiLog)    ❌
injuryStatus               ✅          ❌ NOT STORED    API call needed     ✅ API cached
injuryReason               ✅          ❌ NOT STORED    API call needed     ✅ API cached
injuryContext (prompt str) ✅          aiLog.prompt     DB query (aiLog)    ❌ (inline)
formGamesCount (actual)    ✅          Insight          DB query           ✅ in Insight
edgeGamesCount (actual)    ✅          Insight          DB query           ✅ in Insight
baselineGamesCount (actual)✅          Insight          DB query           ✅ in Insight
```

---

## 8. TESTING CHECKLIST

To ensure alignment across all systems:

- [ ] Test that `formGamesCount` == actual game count, never equals window constant
- [ ] Test that `hasFullFormWindow` accurately reflects window completeness
- [ ] Test that `dataQuality` matches window completeness (strong→all 3, moderate→edge only, weak→edge incomplete)
- [ ] Test that AI receives completeness flags in prompt
- [ ] Test that AI's returned `dataQuality` matches formula-computed value
- [ ] Test that injury status is returned when player is Out/Doubtful
- [ ] Test that injury status is NULL when player is healthy
- [ ] Test that injuryStatus is stored in Insight schema (after fix)
- [ ] Test that edge and confidence are recalculated on every insight gen
- [ ] Test that confidence fallback works when game log is empty
- [ ] Test that injury API failure doesn't crash insight generation
- [ ] Test that edge/confidence values are consistent across insight views (no recalc variance)
