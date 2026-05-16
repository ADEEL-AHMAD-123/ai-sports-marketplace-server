const IORedis = require('ioredis');
const { Queue, Worker, QueueEvents } = require('bullmq');
const crypto = require('crypto');
const logger = require('../../config/logger');

const INSIGHT_QUEUE_NAME = 'insight-generation';
const OUTCOME_QUEUE_NAME = 'outcome-grading';
const SCORING_QUEUE_NAME = 'sport-scoring';

const _toBool = (value, fallback = true) => {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
};

class JobQueueService {
  constructor() {
    const redisEnabled = process.env.REDIS_ENABLED !== 'false';
    const queueEnabled = _toBool(process.env.JOB_QUEUE_ENABLED, true);
    const testMode = process.env.NODE_ENV === 'test';

    this.enabled = redisEnabled && queueEnabled && !testMode;
    this.workers = [];
    this.workerConnection = null;
    this.queueConnection = null;
    this.initialized = false;

    this.insightQueue = null;
    this.outcomeQueue = null;
    this.scoringQueue = null;
    this.insightEvents = null;
  }

  isEnabled() {
    return this.enabled;
  }

  _createConnection() {
    const config = {
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      db: parseInt(process.env.REDIS_DB || '0', 10),
      maxRetriesPerRequest: null,
      lazyConnect: true,
      ...(process.env.REDIS_TLS === 'true' ? { tls: {} } : {}),
    };

    if (process.env.REDIS_PASSWORD) config.password = process.env.REDIS_PASSWORD;

    return new IORedis(config);
  }

  async _init() {
    if (!this.enabled || this.initialized) return;

    this.queueConnection = this._createConnection();
    this.insightQueue = new Queue(INSIGHT_QUEUE_NAME, { connection: this.queueConnection });
    this.outcomeQueue = new Queue(OUTCOME_QUEUE_NAME, { connection: this.queueConnection });
    this.scoringQueue = new Queue(SCORING_QUEUE_NAME, { connection: this.queueConnection });
    this.insightEvents = new QueueEvents(INSIGHT_QUEUE_NAME, { connection: this._createConnection() });
    this.initialized = true;

    logger.info('[JobQueueService] BullMQ initialized', {
      insightQueue: INSIGHT_QUEUE_NAME,
      outcomeQueue: OUTCOME_QUEUE_NAME,
      scoringQueue: SCORING_QUEUE_NAME,
    });
  }

  async enqueueInsightGeneration(payload) {
    if (!this.enabled) return null;
    await this._init();

    return this.insightQueue.add('generate', payload, {
      attempts: Math.max(1, parseInt(process.env.INSIGHT_QUEUE_ATTEMPTS || '3', 10)),
      backoff: { type: 'exponential', delay: parseInt(process.env.INSIGHT_QUEUE_BACKOFF_MS || '1500', 10) },
      removeOnComplete: { age: 60 * 60, count: 1000 },
      removeOnFail: { age: 6 * 60 * 60, count: 2000 },
      priority: 3,
    });
  }

  async waitForInsightResult(job, timeoutMs) {
    if (!this.enabled || !job || !this.insightEvents) return null;
    try {
      return await job.waitUntilFinished(this.insightEvents, timeoutMs);
    } catch (err) {
      if (String(err?.message || '').includes('timed out')) return null;
      throw err;
    }
  }

  async getInsightJobStatus(jobId) {
    if (!this.enabled || !jobId) return null;
    await this._init();

    const job = await this.insightQueue.getJob(jobId);
    if (!job) return null;

    const state = await job.getState();
    return {
      id: job.id,
      name: job.name,
      state,
      data: job.data,
      result: job.returnvalue || null,
      failedReason: job.failedReason || null,
      attemptsMade: job.attemptsMade,
      createdAt: job.timestamp ? new Date(job.timestamp).toISOString() : null,
      processedAt: job.processedOn ? new Date(job.processedOn).toISOString() : null,
      finishedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
    };
  }

  async enqueueOutcomeGrading({ sport, eventIds, source = 'postGameSync' }) {
    if (!this.enabled || !Array.isArray(eventIds) || !eventIds.length) return null;
    await this._init();

    return this.outcomeQueue.add('grade-events', {
      sport,
      eventIds: [...new Set(eventIds.filter(Boolean))],
      source,
    }, {
      attempts: Math.max(1, parseInt(process.env.OUTCOME_QUEUE_ATTEMPTS || '4', 10)),
      backoff: { type: 'exponential', delay: parseInt(process.env.OUTCOME_QUEUE_BACKOFF_MS || '2000', 10) },
      removeOnComplete: { age: 60 * 60, count: 1000 },
      removeOnFail: { age: 24 * 60 * 60, count: 3000 },
      priority: 2,
    });
  }

  async enqueueSportScoring({ sport, source = 'propWatcher', eventIds = null }) {
    if (!this.enabled || !sport) return null;
    await this._init();

    const uniqueEventIds = Array.isArray(eventIds)
      ? [...new Set(eventIds.filter(Boolean).map(String))].sort()
      : [];

    const jobId = uniqueEventIds.length
      ? `score-${sport}-${crypto.createHash('sha1').update(uniqueEventIds.join('|')).digest('hex').slice(0, 12)}`
      : `score-${sport}`;

    return this.scoringQueue.add('score-sport', {
      sport,
      source,
      eventIds: uniqueEventIds,
    }, {
      jobId,
      attempts: Math.max(1, parseInt(process.env.SCORING_QUEUE_ATTEMPTS || '3', 10)),
      backoff: { type: 'exponential', delay: parseInt(process.env.SCORING_QUEUE_BACKOFF_MS || '1500', 10) },
      removeOnComplete: { age: 30 * 60, count: 500 },
      removeOnFail: { age: 6 * 60 * 60, count: 2000 },
      priority: 1,
    });
  }

  async startWorkers() {
    if (!this.enabled || this.workers.length) return;
    await this._init();

    this.workerConnection = this._createConnection();

    const insightWorker = new Worker(
      INSIGHT_QUEUE_NAME,
      async (job) => {
        const InsightService = require('../InsightService');
        const User = require('../../models/User.model');

        const user = await User.findById(job.data.userId);
        if (!user) {
          return { insight: null, creditDeducted: false, error: 'User not found for queued job.' };
        }

        return InsightService.generateInsight({
          sport: job.data.sport,
          eventId: job.data.eventId,
          playerName: job.data.playerName,
          statType: job.data.statType,
          bettingLine: Number(job.data.bettingLine),
          marketType: job.data.marketType,
          apiSportsPlayerId: job.data.apiSportsPlayerId || null,
          user,
        });
      },
      {
        connection: this.workerConnection,
        concurrency: Math.max(1, parseInt(process.env.INSIGHT_WORKER_CONCURRENCY || '4', 10)),
      }
    );

    const outcomeWorker = new Worker(
      OUTCOME_QUEUE_NAME,
      async (job) => {
        const InsightOutcomeService = require('../InsightOutcomeService');
        return InsightOutcomeService.persistOutcomesForEvents(job.data.eventIds || []);
      },
      {
        connection: this.workerConnection,
        concurrency: Math.max(1, parseInt(process.env.OUTCOME_WORKER_CONCURRENCY || '3', 10)),
      }
    );

    const scoringWorker = new Worker(
      SCORING_QUEUE_NAME,
      async (job) => {
        const StrategyService = require('../StrategyService');
        return StrategyService.scoreAllPropsForSport(job.data.sport, {
          eventIds: job.data.eventIds,
        });
      },
      {
        connection: this.workerConnection,
        concurrency: Math.max(1, parseInt(process.env.SCORING_WORKER_CONCURRENCY || '2', 10)),
      }
    );

    for (const worker of [insightWorker, outcomeWorker, scoringWorker]) {
      worker.on('failed', (job, err) => {
        logger.error('[JobQueueService] Worker job failed', {
          queue: worker.name,
          jobId: job?.id,
          attemptsMade: job?.attemptsMade,
          error: err.message,
        });
      });

      worker.on('completed', (job) => {
        logger.debug('[JobQueueService] Worker job completed', {
          queue: worker.name,
          jobId: job?.id,
        });
      });
    }

    this.workers.push(insightWorker, outcomeWorker, scoringWorker);

    logger.info('[JobQueueService] Workers started', {
      insightConcurrency: parseInt(process.env.INSIGHT_WORKER_CONCURRENCY || '4', 10),
      outcomeConcurrency: parseInt(process.env.OUTCOME_WORKER_CONCURRENCY || '3', 10),
      scoringConcurrency: parseInt(process.env.SCORING_WORKER_CONCURRENCY || '2', 10),
    });
  }

  async close() {
    const closers = [];

    for (const worker of this.workers) closers.push(worker.close());
    this.workers = [];

    if (this.insightEvents) closers.push(this.insightEvents.close());
    if (this.insightQueue) closers.push(this.insightQueue.close());
    if (this.outcomeQueue) closers.push(this.outcomeQueue.close());
    if (this.scoringQueue) closers.push(this.scoringQueue.close());
    if (this.queueConnection) closers.push(this.queueConnection.quit());
    if (this.workerConnection) closers.push(this.workerConnection.quit());

    await Promise.allSettled(closers);

    this.initialized = false;
    this.insightQueue = null;
    this.outcomeQueue = null;
    this.scoringQueue = null;
    this.insightEvents = null;
    this.queueConnection = null;
    this.workerConnection = null;
  }
}

module.exports = new JobQueueService();
