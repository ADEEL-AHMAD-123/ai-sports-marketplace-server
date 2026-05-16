const InsightOutcomeService = require('../InsightOutcomeService');
const JobQueueService = require('./JobQueueService');
const logger = require('../../config/logger');

async function gradeEvents(eventIds, { sport = null, source = 'postGameSync' } = {}) {
  const uniqueEventIds = [...new Set((eventIds || []).filter(Boolean))];
  if (!uniqueEventIds.length) return { processed: 0, updated: 0, unresolved: 0 };

  const queueEnabled = JobQueueService.isEnabled()
    && String(process.env.OUTCOME_QUEUE_ENABLED || 'true').toLowerCase() === 'true';
  const queueAsync = String(process.env.OUTCOME_QUEUE_ASYNC || 'true').toLowerCase() === 'true';

  if (!queueEnabled) {
    return InsightOutcomeService.persistOutcomesForEvents(uniqueEventIds);
  }

  try {
    const job = await JobQueueService.enqueueOutcomeGrading({
      sport,
      eventIds: uniqueEventIds,
      source,
    });

    if (!job) {
      return InsightOutcomeService.persistOutcomesForEvents(uniqueEventIds);
    }

    if (queueAsync) {
      return { queued: true, jobId: job.id, eventCount: uniqueEventIds.length };
    }

    return InsightOutcomeService.persistOutcomesForEvents(uniqueEventIds);
  } catch (err) {
    logger.warn('[OutcomeDispatcherService] Queue enqueue failed, grading inline', {
      sport,
      eventCount: uniqueEventIds.length,
      error: err.message,
    });
    return InsightOutcomeService.persistOutcomesForEvents(uniqueEventIds);
  }
}

module.exports = { gradeEvents };
