import { parentPort, workerData } from 'node:worker_threads';
import { indexShare, type IndexJob } from './index.js';

// one worker's share of an index, off svalld's main thread; it posts its result once and exits
parentPort?.postMessage(await indexShare(workerData as IndexJob));
