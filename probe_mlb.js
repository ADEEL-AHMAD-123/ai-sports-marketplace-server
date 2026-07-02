/**
 * probe_mlb.js — one-off diagnostic for the MLB Stats API field fix.
 *
 * Run from the server dir:   node probe_mlb.js
 *
 * Verifies that _getPersonDetails now returns populated:
 *   - currentTeam.name  (was undefined before hydrate=currentTeam)
 *   - batSide.code      (was {} because the old `fields` projection dropped it)
 *   - pitchHand.code    (same reason)
 *
 * If all three columns print non-null values, the pipeline will now correctly
 * resolve playerSide + opposing starter + starter.hand + platoon on the next
 * insight regeneration. Safe to delete this file after confirming.
 */
const mlb = require('./src/services/shared/MLBStatsClient');

(async () => {
  const targets = ['Bryan Reynolds', 'Brandon Marsh', 'Brandon Lowe', 'Alan Rangel'];
  console.log('name\t\t\tid\tteam\t\t\tbat\thand');
  console.log('----\t\t\t--\t----\t\t\t---\t----');
  for (const name of targets) {
    try {
      const id  = await mlb.findPlayerId(name);
      const det = await mlb._getPersonDetails(id);
      const team = det?.currentTeam?.name || 'NULL';
      const bat  = det?.batSide?.code     || 'NULL';
      const hand = det?.pitchHand?.code   || 'NULL';
      console.log(`${name.padEnd(22)}\t${id}\t${team.padEnd(22)}\t${bat}\t${hand}`);
    } catch (e) {
      console.log(`${name}\tERROR: ${e.message}`);
    }
  }

  console.log('\nresolvePlayerTeamName:');
  for (const name of targets) {
    const t = await mlb.resolvePlayerTeamName(name);
    console.log(`  ${name.padEnd(22)} → ${t || 'NULL'}`);
  }

  console.log('\nsplits (vsLHP AB / vsRHP AB) — needs sitCodes to be non-empty:');
  const yr = new Date().getFullYear();
  for (const name of ['Nick Gonzales', 'Aaron Judge', 'Bryan Reynolds']) {
    const id = await mlb.findPlayerId(name);
    const splits = await mlb._getStatSplits(id, yr, 'hitting');
    const vl = splits.find(s => s.split?.code === 'vl')?.stat?.atBats ?? null;
    const vr = splits.find(s => s.split?.code === 'vr')?.stat?.atBats ?? null;
    console.log(`  ${name.padEnd(22)} → vsLHP AB: ${vl ?? 'NULL'}, vsRHP AB: ${vr ?? 'NULL'}`);
  }
  process.exit(0);
})();
