// workerPool.js
import Worker from './satelliteWorker.js?worker';

export class WorkerPool {
    constructor(numWorkers = navigator.hardwareConcurrency || 4) {
        this.workers = [];
        this.workQueue = new Map(); // Maps group URLs to worker indices
        this.currentWorkerIndex = 0;

        // Initialize workers
        for (let i = 0; i < numWorkers; i++) {
            const worker = new Worker();
            worker.onmessage = this.handleWorkerMessage.bind(this, i);
            this.workers.push({
                worker: worker,
                groups: new Set(), // Keep track of which groups this worker handles
                busy: false
            });
        }

        this.messageCallbacks = new Map(); // For storing callbacks by group
    }

    // Register a callback for a specific group
    registerCallback(groupUrl, callback) {
        this.messageCallbacks.set(groupUrl, callback);
    }

    // Handle messages from any worker in the pool
    handleWorkerMessage(workerIndex, event) {
        const { type, payload } = event.data;

        // Find the callback for this group
        if (type === 'eventLoopStarted') {
            const callback = this.messageCallbacks.get(payload);
            if (callback) {
                callback(event.data);
            }
        } else if (type === 'posVel') {
            const callback = this.messageCallbacks.get(payload.group);
            if (callback) {
                callback(event.data);
            }
        }
    }

    // Assign a group to the least busy worker
    getLeastBusyWorker() {
        let minGroups = Infinity;
        let selectedWorker = 0;

        this.workers.forEach((workerInfo, index) => {
            if (workerInfo.groups.size < minGroups) {
                minGroups = workerInfo.groups.size;
                selectedWorker = index;
            }
        });

        return selectedWorker;
    }

    // Send a message to the appropriate worker for a group
    postMessage(groupUrl, message) {
        let workerIndex;

        // If this group is already assigned to a worker, use that worker
        if (this.workQueue.has(groupUrl)) {
            workerIndex = this.workQueue.get(groupUrl);
        } else {
            // Assign to the least busy worker
            workerIndex = this.getLeastBusyWorker();
            this.workQueue.set(groupUrl, workerIndex);
            this.workers[workerIndex].groups.add(groupUrl);
        }

        this.workers[workerIndex].worker.postMessage(message);
    }

    // Remove a group from a worker's assignments
    removeGroup(groupUrl) {
        if (this.workQueue.has(groupUrl)) {
            const workerIndex = this.workQueue.get(groupUrl);
            this.workers[workerIndex].groups.delete(groupUrl);
            this.workQueue.delete(groupUrl);
            this.messageCallbacks.delete(groupUrl);
        }
    }

    // Terminate all workers in the pool
    terminate() {
        this.workers.forEach(workerInfo => {
            workerInfo.worker.terminate();
        });
        this.workers = [];
        this.workQueue.clear();
        this.messageCallbacks.clear();
    }
}