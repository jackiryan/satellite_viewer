export class MessageBroker {
    static instance;
    worker;

    constructor() { }

    static getInstance() {
        if (!MessageBroker.instance) {
            MessageBroker.instance = new MessageBroker();
        }
        return MessageBroker.instance;
    }

    setWorker(worker) {
        this.worker = worker;
    }

    getPosVel(group, iid) {
        if (!this.worker) {
            throw new Error('Worker not initialized');
        }

        this.worker.postMessage({
            action: 'getPosVel',
            data: {
                group,
                iid
            }
        });
    }
}