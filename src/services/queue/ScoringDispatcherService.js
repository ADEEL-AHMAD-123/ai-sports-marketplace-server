const StrategyService = require('../StrategyService');
const JobQueueService = require('./JobQueueService');
const logger = require('../../config/logger');

async function scoreSport(sport, source = 'propWatcher', options = {}) {
  const queueEnabled = JobQueueService.isEnabled()
    && String(process.env.SCORING_QUEUE_ENABLED || 'true').toLowerCase() === 'true';

  if (!queueEnabled) {
    return StrategyService.scoreAllPropsForSport(sport, options);
  }

  try {
    const job = await JobQueueService.enqueueSportScoring({ sport, source, ...options });
    if (!job) return StrategyService.scoreAllPropsForSport(sport, options);

    return { queued: true, jobId: job.id, sport, eventCount: options?.eventIds?.length || null };
  } catch (err) {
    logger.warn('[ScoringDispatcherService] Queue enqueue failed, running inline', {
      sport,
      error: err.message,
    });
    return StrategyService.scoreAllPropsForSport(sport, options);
  }
}

module.exports = { scoreSport };
