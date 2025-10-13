import { Router, Request, Response } from 'express';
import { Worker } from 'worker_threads';
import { join } from 'path';
import { randomUUID } from 'crypto';
import logger from '@/utils/logger';
import { ApiResponse } from '@/utils/response';
import { ServerState, SERVER_STATES } from '@/modules/compute';
import {
  checkExistingTask,
  setWorkerTask,
  updateTaskStatus,
  generateServerStateTaskKey,
  TaskStatus,
  WorkerTask,
  getRedisClient
} from '@/utils/redis';

const router = Router();

// UDM Client Count endpoints
const UDM_THRESHOLD = 30; // Constant threshold

router.put('/udm/clients', async (req: Request, res: Response) => {
  const { clientCount } = req.body;

  logger.info('UDM client count update received', {
    clientCount,
    threshold: UDM_THRESHOLD,
    body: req.body,
  });

  if (typeof clientCount !== 'number') {
    return ApiResponse.badRequest(res, 'Client count is required', 'clientCount must be a number');
  }

  try {
    // Store UDM client count in Redis
    const redis = getRedisClient();
    const udmData = {
      clientCount,
      threshold: UDM_THRESHOLD,
      timestamp: new Date().toISOString(),
      lastUpdate: Date.now(),
      status: clientCount > UDM_THRESHOLD ? 'HIGH' : clientCount < UDM_THRESHOLD ? 'LOW' : 'NORMAL'
    };

    await redis.setex('udm:client_count', 3600, JSON.stringify(udmData)); // 1 hour TTL

    logger.info('UDM client count stored successfully', udmData);

    // Note: Auto-triggering will be handled by external Python script
    // This endpoint only stores the client count data

    return ApiResponse.ok(res, 'UDM client count updated successfully', udmData);

  } catch (error: any) {
    logger.error('Failed to update UDM client count', {
      clientCount,
      threshold: UDM_THRESHOLD,
      error: error.message,
    });

    return ApiResponse.internalError(
      res,
      'Failed to update UDM client count',
      error.message
    );
  }
});

// Simple endpoint for bash scripts - returns just the client count number
router.get('/udm/count', async (_req: Request, res: Response) => {
  try {
    const redis = getRedisClient();
    const udmData = await redis.get('udm:client_count');

    if (!udmData) {
      // Return 0 if no data found
      res.setHeader('Content-Type', 'text/plain');
      return res.status(200).send('0');
    }

    const parsedData = JSON.parse(udmData);
    
    // Return just the number as plain text
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).send(parsedData.clientCount.toString());

  } catch (error: any) {
    logger.error('Failed to get UDM client count', {
      error: error.message,
    });

    // Return 0 on error
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).send('0');
  }
});

router.get('/udm/status', async (_req: Request, res: Response) => {
  try {
    const redis = getRedisClient();
    const udmData = await redis.get('udm:client_count');

    if (!udmData) {
      return ApiResponse.notFound(res, 'No UDM client count data found');
    }

    const parsedData = JSON.parse(udmData);
    
    // Also get current server task status
    const taskKey = generateServerStateTaskKey('main-server');
    const currentTask = await redis.get(taskKey);
    
    const responseData = {
      ...parsedData,
      currentTask: currentTask ? JSON.parse(currentTask) : null,
      lastUpdateAgo: `${Math.round((Date.now() - parsedData.lastUpdate) / 1000)}s ago`
    };

    return ApiResponse.ok(res, 'UDM status retrieved successfully', responseData);

  } catch (error: any) {
    logger.error('Failed to get UDM status', {
      error: error.message,
    });

    return ApiResponse.internalError(
      res,
      'Failed to get UDM status',
      error.message
    );
  }
});

router.put('/servers/:serverName/states', async (req: Request, res: Response) => {
  const { serverName } = req.params;
  let { state } = req.body;

  logger.info('Server state update webhook received', {
    serverName,
    state,
    body: req.body,
  });

  if (!serverName) {
    return ApiResponse.badRequest(res, 'Server name is required', 'Missing serverName parameter');
  }

  if (serverName.length === 0 || serverName.length > 255) {
    return ApiResponse.badRequest(res, 'Invalid server name', 'Server name must be between 1 and 255 characters');
  }

  if (!state) {
    return ApiResponse.badRequest(res, 'State is required', 'Missing state in request body');
  }

  // Normalize state to uppercase
  state = state.toUpperCase();

  if (!SERVER_STATES.includes(state as ServerState)) {
    return ApiResponse.badRequest(
      res,
      'Invalid state value',
      `State must be one of: ${SERVER_STATES.join(', ')}`
    );
  }

  try {
    // Generate a Redis key for this server (locks ALL state changes for this server)
    const taskKey = generateServerStateTaskKey(serverName);

    const existingTask = await checkExistingTask(taskKey);

    if (existingTask) {
      logger.info('Task already processing for server state change', {
        serverName,
        requestedState: state,
        existingTaskId: existingTask.taskId,
        existingTargetState: existingTask.targetState,
        startedAt: existingTask.startedAt,
      });

      // Check if it's the same state or a different one
      const isSameState = existingTask.targetState === state;

      return ApiResponse.accepted(res, 'Server state change already in progress', {
        taskId: existingTask.taskId,
        serverName,
        currentProcessingState: existingTask.targetState,
        requestedState: state as ServerState,
        status: 'already_processing',
        startedAt: existingTask.startedAt,
        message: isSameState
          ? `A worker is already processing the state change to ${state}. Please wait for it to complete.`
          : `A worker is currently changing the server state to ${existingTask.targetState}. Please wait for it to complete before requesting a change to ${state}.`,
      });
    }

    const taskId = randomUUID();

    logger.info(`Spawning updateServerState worker with taskId: ${taskId}`, {
      serverName,
      targetState: state,
    });

    const workerTask: WorkerTask = {
      taskId,
      serverName,
      targetState: state,
      status: TaskStatus.PROCESSING,
      startedAt: new Date().toISOString(),
    };

    await setWorkerTask(taskKey, workerTask);

    const workerPath = join(__dirname, '../workers/updateServerStateWorker.js');
    const worker = new Worker(workerPath, {
      workerData: {
        taskId,
        taskKey,  // Pass the Redis key to the worker
        serverName,
        targetState: state as ServerState,
        maxRetries: 30, // Check for up to 5 minutes
        pollInterval: 10000, // Check every 10 seconds
      },
    });

    worker.on('message', async (result) => {
      if (result.success) {
        logger.info(`Worker ${taskId} successfully updated server state`, {
          serverName: result.serverName,
          targetState: result.targetState,
          finalStatus: result.finalStatus,
          attempts: result.attempts,
        });

        await updateTaskStatus(taskKey, TaskStatus.COMPLETED);
      } else {
        logger.error(`Worker ${taskId} failed to update server state`, {
          serverName: result.serverName,
          error: result.error,
        });

        await updateTaskStatus(taskKey, TaskStatus.FAILED, result.error);
      }
    });

    worker.on('error', async (error) => {
      logger.error(`Worker ${taskId} encountered an error`, {
        error: error.message,
        serverName,
      });

      await updateTaskStatus(taskKey, TaskStatus.FAILED, error.message);
    });

    worker.on('exit', async (code) => {
      if (code !== 0) {
        logger.error(`Worker ${taskId} stopped with exit code ${code}`);

        await updateTaskStatus(taskKey, TaskStatus.FAILED, `Worker exited with code ${code}`);
      }
    });

    return ApiResponse.ok(res, 'Server state change initiated', {
      taskId,
      serverName,
      targetState: state as ServerState,
      status: 'processing',
      message: `Worker thread spawned to change server state to ${state}. The process will poll until state change is confirmed.`,
    });

  } catch (error: any) {
    logger.error('Failed to spawn worker for server state change', {
      serverName,
      state,
      error: error.message,
    });

    return ApiResponse.internalError(
      res,
      'Failed to initiate server state change',
      error.message
    );
  }
});

export default router;