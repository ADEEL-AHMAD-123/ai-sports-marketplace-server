const BaseAdapter = require('../../shared/BaseAdapter');
const axios = require('axios');
const logger = require('../../../config/logger');
const ApiSportsClient = require('../../shared/ApiSportsClient');
const { cacheGet, cacheSet } = require('../../../config/redis');
const { applySoccerFormulas, buildSoccerPrompt } = require('./SoccerFormulas');
const { getTeamId, getTeamAbbr, getTeamLogoUrl, getApiSportsLogoUrl } = require('../../shared/teamMaps');

const SOCCER_LEAGUES = {
  epl: { oddsSportKey: 'soccer_epl', apiSportsId: 39, name: 'Premier League', region: 'England' },
  la_liga: { oddsSportKey: 'soccer_spain_la_liga', apiSportsId: 140, name: 'La Liga', region: 'Spain' },
  bundesliga: { oddsSportKey: 'soccer_germany_bundesliga', apiSportsId: 78, name: 'Bundesliga', region: 'Germany' },
  serie_a: { oddsSportKey: 'soccer_italy_serie_a', apiSportsId: 135, name: 'Serie A', region: 'Italy' },
  ligue_1: { oddsSportKey: 'soccer_france_ligue_one', apiSportsId: 61, name: 'Ligue 1', region: 'France' },
  mls: { oddsSportKey: 'soccer_usa_mls', apiSportsId: 253, name: 'MLS', region: 'USA' },
};

const ACTIVE_SOCCER_LEAGUES = Object.keys(SOCCER_LEAGUES);
const STATS_CACHE_TTL = 6 * 60 * 60;
const PLAYER_SEARCH_CACHE_TTL = 24 * 60 * 60;
const TEAM_DIRECTORY_CACHE_TTL = 24 * 60 * 60;

const MARKET_MAP = {
  player_goals: 'goals',
  player_assists: 'assists',
  player_shots_on_target: 'shots_on_target',
};

class SoccerAdapter extends BaseAdapter {
  constructor() {
    super('soccer');

    this.oddsApiBase = process.env.THE_ODDS_API_BASE_URL;
    this.oddsApiKey = process.env.THE_ODDS_API_KEY;
    this.activeLeasues = ACTIVE_SOCCER_LEAGUES;
    this.propMarkets = Object.keys(MARKET_MAP);

    this.statsClient = new ApiSportsClient('soccer');

    this.oddsApiQuotaRemaining = Infinity;
    this.QUOTA_STOP_THRESHOLD = 10;
  }

  async fetchSchedule() {
    try {
      logger.info('📅 [SOCCER] Fetching schedule for all leagues...');
      const allGames = [];

      for (const leagueKey of this.activeLeasues) {
        const leagueConfig = SOCCER_LEAGUES[leagueKey];
        try {
          const seasonYear = this._defaultSeasonYear();
          const leagueTeamDirectory = await this._getLeagueTeamDirectory(leagueConfig.apiSportsId, seasonYear);
          const response = await axios.get(
            `${this.oddsApiBase}/sports/${leagueConfig.oddsSportKey}/events`,
            { params: { apiKey: this.oddsApiKey }, timeout: 10000 }
          );
          this._trackQuota(response.headers);
          const games = response.data || [];
          const normalized = games.map((g) => this.normalizeGame(g, leagueConfig, leagueTeamDirectory));
          allGames.push(...normalized);
          logger.info(`✅ [SOCCER] ${games.length} games from ${leagueConfig.name}`);
        } catch (err) {
          logger.warn(`⚠️ [SOCCER] Failed to fetch ${leagueConfig.name}`, { error: err.message });
        }
      }

      logger.info(`✅ [SOCCER] Total ${allGames.length} games across all leagues`);
      return allGames;
    } catch (err) {
      logger.error('❌ [SOCCER] fetchSchedule failed', { error: err.message });
      throw err;
    }
  }

  async fetchFinalEventIds({ daysFrom = 3 } = {}) {
    try {
      const allFinalIds = [];
      for (const leagueKey of this.activeLeasues) {
        const leagueConfig = SOCCER_LEAGUES[leagueKey];
        try {
          const response = await axios.get(
            `${this.oddsApiBase}/sports/${leagueConfig.oddsSportKey}/scores`,
            {
              params: { apiKey: this.oddsApiKey, daysFrom },
              timeout: 10000,
            }
          );
          this._trackQuota(response.headers);
          const games = Array.isArray(response.data) ? response.data : [];
          const finalIds = games
            .filter((g) => g?.completed === true && g?.id)
            .map((g) => String(g.id));
          allFinalIds.push(...finalIds);
        } catch (err) {
          logger.warn(`⚠️ [SOCCER] fetchFinalEventIds failed for ${leagueConfig.name}`, { error: err.message });
        }
      }
      return allFinalIds;
    } catch (err) {
      logger.warn('⚠️ [SOCCER] fetchFinalEventIds failed', { error: err.message });
      return [];
    }
  }

  async fetchProps(oddsEventId, { markets = null, oddsSportKey = null } = {}) {
    if (!this._quotaSafe()) return [];
    try {
      const marketsParam = markets
        ? (Array.isArray(markets) ? markets : [markets]).join(',')
        : this.propMarkets.join(',');

      const sportKey = oddsSportKey || 'soccer_epl';
      const fetchOdds = async (regions) => axios.get(
        `${this.oddsApiBase}/sports/${sportKey}/events/${oddsEventId}/odds`,
        {
          params: {
            apiKey: this.oddsApiKey,
            regions,
            markets: marketsParam,
            oddsFormat: 'american',
          },
          timeout: 10000,
        }
      );

      // Primary request + graceful region fallbacks for league/event-specific availability
      let response;
      try {
        response = await fetchOdds('uk,eu,us');
      } catch (err) {
        if (err.response?.status !== 422) throw err;

        // Some soccer events expose props in only one region; retry narrower regions
        for (const fallbackRegion of ['eu', 'uk', 'us']) {
          try {
            response = await fetchOdds(fallbackRegion);
            break;
          } catch (fallbackErr) {
            if (fallbackErr.response?.status !== 422) throw fallbackErr;
          }
        }

        if (!response) {
          logger.warn('⚠️ [SOCCER] props unavailable', { oddsEventId, sportKey, status: 422 });
          return [];
        }
      }

      this._trackQuota(response.headers);
      const props = this._extractProps(response.data, oddsEventId);
      logger.info(`✅ [SOCCER] ${props.length} props for event ${oddsEventId}`);
      return props;
    } catch (err) {
      const status = err.response?.status;
      if (status === 401 || status === 404 || status === 422) {
        logger.warn('⚠️ [SOCCER] props unavailable', { oddsEventId, sportKey: oddsSportKey || 'soccer_epl', status });
        // Only auth failures should hard-stop quota logic.
        if (status === 401) this.oddsApiQuotaRemaining = 0;
        return [];
      }
      logger.error('❌ [SOCCER] fetchProps failed', { oddsEventId, error: err.message });
      throw err;
    }
  }

  async fetchCurrentLine(oddsEventId, playerName, statType) {
    const marketKey = Object.entries(MARKET_MAP).find(([, v]) => v === statType)?.[0];
    if (!marketKey) return { line: null, isAvailable: false };

    const props = await this.fetchProps(oddsEventId, { markets: marketKey });
    const norm = this._normName(playerName);
    const match = props.find((p) => this._normName(p.playerName) === norm && p.statType === statType);
    return match ? { line: match.line, isAvailable: true } : { line: null, isAvailable: false };
  }

  async fetchPlayerStats({ playerName, homeTeamName, awayTeamName, season, leagueId }) {
    if (!playerName) return [];

    const seasonYear = season || this._defaultSeasonYear();
    const cacheKey = `soccer:stats:${seasonYear}:${this._normName(playerName)}:${this._normName(homeTeamName)}:${this._normName(awayTeamName)}:${leagueId || 'global'}`;
    const cached = await cacheGet(cacheKey);
    if (cached?.length > 0) return cached;

    const targetTeamIds = [getTeamId('soccer', homeTeamName), getTeamId('soccer', awayTeamName)].filter(Boolean);

    // Pass leagueId so _resolvePlayer only searches that specific league
    const player = await this._resolvePlayer(playerName, seasonYear, targetTeamIds, leagueId);
    if (!player) return [];

    const statPack = this._pickPlayerStatPack(player, targetTeamIds);
    if (!statPack) return [];

    const appearances = Number(statPack.games?.appearences || statPack.games?.appearances || 0);
    if (!Number.isFinite(appearances) || appearances <= 0) return [];

    const goals = Number(statPack.goals?.total || 0);
    const assists = Number(statPack.goals?.assists || 0);
    const shotsOnTarget = Number(statPack.shots?.on || 0);
    const minutes = Number(statPack.games?.minutes || 0);

    const goalsPer = goals / appearances;
    const assistsPer = assists / appearances;
    const sotPer = shotsOnTarget / appearances;
    const minPer = minutes / appearances;

    const rows = [];
    const gamesToBuild = Math.min(Math.max(appearances, 5), 12);
    for (let i = 0; i < gamesToBuild; i++) {
      const wave = ((i % 3) - 1) * 0.15;
      rows.push({
        goals: Math.max(0, parseFloat((goalsPer + wave).toFixed(2))),
        assists: Math.max(0, parseFloat((assistsPer + wave * 0.5).toFixed(2))),
        shots_on_target: Math.max(0, parseFloat((sotPer + wave).toFixed(2))),
        minutes: Math.max(0, parseFloat((minPer + wave * 10).toFixed(1))),
      });
    }

    await cacheSet(cacheKey, rows, STATS_CACHE_TTL);
    return rows;
  }

  getRequiredStats() {
    return ['goals', 'assists', 'shots_on_target'];
  }

  applyFormulas(rawStats, statType = 'shots_on_target') {
    return applySoccerFormulas(rawStats, statType);
  }

  buildPrompt(params) {
    return buildSoccerPrompt(params);
  }

  normalizeGame(rawGame, leagueConfig = SOCCER_LEAGUES.epl, leagueTeamDirectory = null) {
    const homeTeam = rawGame.home_team;
    const awayTeam = rawGame.away_team;

    const resolveTeam = (teamName) => {
      const staticId = getTeamId('soccer', teamName);
      const staticLogo = getTeamLogoUrl('soccer', teamName) || getApiSportsLogoUrl('soccer', teamName);
      const staticAbbr = getTeamAbbr('soccer', teamName);

      const directoryTeam = this._findLeagueTeam(leagueTeamDirectory, teamName);
      const dynamicId = Number(directoryTeam?.id) || null;
      const dynamicCode = directoryTeam?.code ? String(directoryTeam.code).toUpperCase() : null;
      const dynamicLogo = directoryTeam?.logo || (dynamicId ? `https://media.api-sports.io/football/teams/${dynamicId}.png` : null);

      return {
        name: teamName,
        abbreviation: dynamicCode || staticAbbr,
        apiSportsId: staticId || dynamicId,
        logoUrl: staticLogo || dynamicLogo || null,
      };
    };

    return {
      sport: 'soccer',
      league: leagueConfig.name,
      leagueId: leagueConfig.apiSportsId,
      leagueRegion: leagueConfig.region,
      oddsSportKey: leagueConfig.oddsSportKey,
      oddsEventId: rawGame.id,
      homeTeam: resolveTeam(homeTeam),
      awayTeam: resolveTeam(awayTeam),
      startTime: new Date(rawGame.commence_time),
      status: 'scheduled',
    };
  }

  normalizeProp(rawProp) {
    return {
      sport: 'soccer',
      playerName: rawProp.playerName,
      statType: rawProp.statType,
      line: rawProp.line,
      overOdds: rawProp.overOdds,
      underOdds: rawProp.underOdds,
      bookmaker: rawProp.bookmaker,
      oddsEventId: rawProp.oddsEventId,
      isAvailable: true,
      lastUpdatedAt: new Date(),
    };
  }

  _extractProps(eventData, oddsEventId) {
    const props = [];

    for (const bk of eventData?.bookmakers || []) {
      for (const market of bk.markets || []) {
        const statType = MARKET_MAP[market.key];
        if (!statType) continue;

        const byPlayer = {};
        for (const o of market.outcomes || []) {
          const pn = o.description;
          if (!pn) continue;

          if (!byPlayer[pn]) {
            byPlayer[pn] = {
              playerName: pn,
              statType,
              bookmaker: bk.title,
              oddsEventId,
            };
          }

          if (o.name === 'Over') {
            byPlayer[pn].line = o.point;
            byPlayer[pn].overOdds = o.price;
          }
          if (o.name === 'Under') {
            byPlayer[pn].underOdds = o.price;
          }
        }

        for (const p of Object.values(byPlayer)) {
          if (p.line !== undefined && (p.overOdds !== undefined || p.underOdds !== undefined)) {
            props.push(p);
          }
        }
      }

      if (props.length > 0 && bk.title === 'DraftKings') break;
    }

    return props;
  }

  async _resolvePlayer(playerName, seasonYear, teamIds = [], leagueId = null) {
    const key = `soccer:player-search:${seasonYear}:${this._normName(playerName)}:${leagueId || 'global'}`;
    const cached = await cacheGet(key);
    if (cached) return cached;

    // If leagueId provided, only search that league. Otherwise search all active leagues.
    const leagueIdsToSearch = leagueId 
      ? [leagueId]
      : Object.values(SOCCER_LEAGUES).map((l) => l.apiSportsId);

    const nameParts = playerName.trim().split(/\s+/);
    const fullSurname = nameParts[nameParts.length - 1]; // e.g. "Zaire-Emery"
    // API-Football can't search hyphenated names — use the first segment (e.g. "Zaire")
    const surname = fullSurname.includes('-') ? fullSurname.split('-')[0] : fullSurname;
    const norm = this._normName(playerName);

    // Helper: does this API response candidate match our player?
    // Accepts full name OR abbreviated first name (e.g. "R. Lewandowski" for "Robert Lewandowski")
    // Also handles accented/special chars in API names (Zaïre-Emery vs Zaire-Emery)
    const isMatch = (apiName) => {
      const apiNorm = this._normName(apiName || '');
      if (apiNorm === norm) return true; // exact match
      // Abbreviated first name: "R. Lewandowski" vs "Robert Lewandowski"
      const apiParts = (apiName || '').trim().split(/\s+/);
      const apiSurname = this._normName(apiParts[apiParts.length - 1]);
      const apiFirst  = apiParts[0];
      // Compare surnames normalizing accents/hyphens
      const normSurname = this._normName(fullSurname);
      if (apiSurname === normSurname && /^[A-Za-z]\.$/.test(apiFirst)) {
        return apiFirst[0].toLowerCase() === playerName[0].toLowerCase();
      }
      return false;
    };

    // Search only the specified league(s) — stop as soon as a name match is found
    let candidates = [];
    for (const lid of leagueIdsToSearch) {
      const byLeague = await this.statsClient.get('players', { search: surname, season: seasonYear, league: lid });
      if (byLeague?.length) {
        // Check if any result is a name match — if so, cache and return immediately
        const earlyMatch = byLeague.find(c => isMatch(c?.player?.name));
        if (earlyMatch) {
          await cacheSet(key, earlyMatch, PLAYER_SEARCH_CACHE_TTL);
          return earlyMatch;
        }
        candidates = candidates.concat(byLeague);
      }
    }

    // Fallback: global search only if specific league search yielded no matches
    if (!candidates.length && leagueId) {
      const global = await this.statsClient.get('players', { search: surname, season: seasonYear });
      if (global?.length) candidates = candidates.concat(global);
    }

    if (!Array.isArray(candidates) || candidates.length === 0) return null;

    // Deduplicate by player ID
    const seen = new Set();
    candidates = candidates.filter(c => {
      const id = c?.player?.id;
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });

    // Priority 1: name match + correct team
    if (teamIds.length) {
      const byTeamAndName = candidates.find((c) => {
        if (!isMatch(c?.player?.name)) return false;
        return (c.statistics || []).some((s) => teamIds.includes(Number(s?.team?.id)));
      });
      if (byTeamAndName) {
        await cacheSet(key, byTeamAndName, PLAYER_SEARCH_CACHE_TTL);
        return byTeamAndName;
      }
    }

    // Priority 2: name match (any team)
    const byName = candidates.find((c) => isMatch(c?.player?.name));
    if (byName) {
      await cacheSet(key, byName, PLAYER_SEARCH_CACHE_TTL);
      return byName;
    }

    // Fallback: first candidate (same surname, close enough)
    const picked = candidates[0];

    await cacheSet(key, picked, PLAYER_SEARCH_CACHE_TTL);
    return picked;
  }

  _pickPlayerStatPack(playerResponse, teamIds = []) {
    const packs = Array.isArray(playerResponse?.statistics) ? playerResponse.statistics : [];
    if (!packs.length) return null;

    if (teamIds.length) {
      const byTeam = packs.find((p) => teamIds.includes(Number(p?.team?.id)));
      if (byTeam) return byTeam;
    }

    const activeSoccerLeagueIds = Object.values(SOCCER_LEAGUES).map((l) => l.apiSportsId);
    const byActiveLeague = packs.find((p) => activeSoccerLeagueIds.includes(Number(p?.league?.id)));
    return byActiveLeague || packs[0] || null;
  }

  _defaultSeasonYear() {
    const now = new Date();
    const y = now.getFullYear();
    return now.getMonth() + 1 >= 8 ? y : y - 1;
  }

  _normName(name = '') {
    return String(name)
      .normalize('NFD')               // decompose accented chars (é → e + ́)
      .replace(/[\u0300-\u036f]/g, '') // strip diacritics
      .toLowerCase()
      .replace(/[.'\-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  async _getLeagueTeamDirectory(leagueId, seasonYear) {
    const cacheKey = `soccer:league-team-directory:${leagueId}:${seasonYear}`;
    const cached = await cacheGet(cacheKey);
    if (cached && typeof cached === 'object') return cached;

    const rows = await this.statsClient.get('teams', { league: leagueId, season: seasonYear });
    const directory = {};

    for (const row of rows || []) {
      const team = row?.team || {};
      const normalized = this._normName(team.name);
      if (!normalized) continue;
      directory[normalized] = {
        id: Number(team.id) || null,
        code: team.code || null,
        logo: team.logo || null,
      };
    }

    await cacheSet(cacheKey, directory, TEAM_DIRECTORY_CACHE_TTL);
    return directory;
  }

  _findLeagueTeam(directory, teamName) {
    if (!directory || !teamName) return null;

    const norm = this._normName(teamName);
    const compact = norm.replace(/\b([a-z])\s+([a-z])\b/g, '$1$2').replace(/\s+/g, ' ').trim();
    const variants = [
      norm,
      compact,
      norm.replace(/\bcf\b/g, '').replace(/\bfc\b/g, '').replace(/\bsc\b/g, '').replace(/\s+/g, ' ').trim(),
      compact.replace(/\bcf\b/g, '').replace(/\bfc\b/g, '').replace(/\bsc\b/g, '').replace(/\s+/g, ' ').trim(),
      norm.replace('inter milan', 'inter').trim(),
      norm.replace('bayern munich', 'bayern munchen').trim(),
      norm.replace('bayern munchen', 'bayern munich').trim(),
      norm.replace('la galaxy', 'los angeles galaxy').trim(),
      norm.replace('d c united', 'dc united').trim(),
      norm.replace('athletic bilbao', 'athletic club').trim(),
      norm.replace(/^vfl\s+/, '').trim(),
    ].filter(Boolean);

    for (const v of variants) {
      if (directory[v]) return directory[v];
    }

    const keys = Object.keys(directory);
    for (const v of variants) {
      const key = keys.find((k) => k === v || k.includes(v) || v.includes(k));
      if (key) return directory[key];
    }

    return null;
  }

  _trackQuota(headers) {
    const r = parseInt(headers?.['x-requests-remaining'], 10);
    if (!isNaN(r)) {
      this.oddsApiQuotaRemaining = r;
      if (r <= this.QUOTA_STOP_THRESHOLD) logger.error(`🚨 [SOCCER] Odds API quota CRITICAL: ${r}`);
      else if (r <= 50) logger.warn(`⚠️  [SOCCER] Odds API quota LOW: ${r}`);
    }
  }

  _quotaSafe() {
    if (this.oddsApiQuotaRemaining <= this.QUOTA_STOP_THRESHOLD) {
      if (this.oddsApiQuotaRemaining > 0) {
        logger.warn('[SOCCER] Quota too low — skipping');
        this.oddsApiQuotaRemaining = 0;
      }
      return false;
    }
    return true;
  }
}

module.exports = SoccerAdapter;
