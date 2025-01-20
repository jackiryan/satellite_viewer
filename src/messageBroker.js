// messageBroker.js
export class MessageBroker {
    static instance = null;

    static getInstance() {
        if (!MessageBroker.instance) {
            MessageBroker.instance = new MessageBroker();
        }
        return MessageBroker.instance;
    }

    constructor() {
        this.workerPool = null;
        this.subscribers = new Map();
    }

    setWorkerPool(workerPool) {
        this.workerPool = workerPool;
    }

    subscribe(messageType, callback) {
        if (!this.subscribers.has(messageType)) {
            this.subscribers.set(messageType, new Set());
        }
        this.subscribers.get(messageType).add(callback);
    }

    unsubscribe(messageType, callback) {
        if (this.subscribers.has(messageType)) {
            this.subscribers.get(messageType).delete(callback);
        }
    }

    publish(messageType, data) {
        if (this.subscribers.has(messageType)) {
            this.subscribers.get(messageType).forEach(callback => {
                callback(data);
            });
        }
    }

    getPosVel(group, satId) {
        if (this.workerPool) {
            this.workerPool.postMessage(group, {
                action: 'getPosVel',
                data: {
                    group: group,
                    iid: satId
                }
            });
        }
    }
}