export class QueuedMessageNotFoundError extends Error {
  constructor() {
    super('Message not found in queue');
    this.name = 'QueuedMessageNotFoundError';
  }
}
