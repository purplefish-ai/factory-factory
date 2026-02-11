import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from './logger.service';

// Helper type for testing circular references - allows dynamic property assignment
type CircularTestObject = Record<string, unknown>;

describe('LoggerService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('circular reference handling', () => {
    it('should not crash when logging a simple circular reference', () => {
      const logger = createLogger('test');
      const circular: CircularTestObject = { foo: 'bar' };
      circular.self = circular;

      expect(() => {
        logger.info('Test circular', circular);
      }).not.toThrow();
    });

    it('should not crash when logging nested circular references', () => {
      const logger = createLogger('test');
      const obj: CircularTestObject = { a: { b: { c: {} } } };
      (((obj.a as CircularTestObject).b as CircularTestObject).c as CircularTestObject).circular =
        obj;

      expect(() => {
        logger.warn('Test nested circular', obj);
      }).not.toThrow();
    });

    it('should not crash when logging an error with circular references', () => {
      const logger = createLogger('test');
      const circular: CircularTestObject = { message: 'error context' };
      circular.self = circular;

      expect(() => {
        logger.error('Test error with circular context', circular);
      }).not.toThrow();
    });

    it('should not crash when logging arrays with circular references', () => {
      const logger = createLogger('test');
      const arr: unknown[] = [1, 2, 3];
      arr.push(arr);

      expect(() => {
        logger.debug('Test circular array', { items: arr });
      }).not.toThrow();
    });

    it('should not crash when logging cross-referenced objects', () => {
      const logger = createLogger('test');
      const obj1: CircularTestObject = { name: 'obj1' };
      const obj2: CircularTestObject = { name: 'obj2' };
      obj1.ref = obj2;
      obj2.ref = obj1;

      expect(() => {
        logger.info('Test cross-reference', { obj1, obj2 });
      }).not.toThrow();
    });

    it('should still log normal objects correctly', () => {
      const logger = createLogger('test');
      const normalObj = {
        name: 'test',
        value: 42,
        nested: { deep: { data: 'hello' } },
      };

      expect(() => {
        logger.info('Test normal object', normalObj);
      }).not.toThrow();
    });

    it('should handle undefined and null in context', () => {
      const logger = createLogger('test');

      expect(() => {
        logger.info('Test undefined', { value: undefined });
      }).not.toThrow();

      expect(() => {
        logger.info('Test null', { value: null });
      }).not.toThrow();
    });
  });

  describe('agentEvent', () => {
    it('should not crash with circular references in context', () => {
      const logger = createLogger('test');
      const circular: CircularTestObject = { data: 'test' };
      circular.self = circular;

      expect(() => {
        logger.agentEvent('created', 'agent-123', 'test-agent', circular);
      }).not.toThrow();
    });
  });

  describe('taskEvent', () => {
    it('should not crash with circular references in context', () => {
      const logger = createLogger('test');
      const circular: CircularTestObject = { data: 'test' };
      circular.self = circular;

      expect(() => {
        logger.taskEvent('started', 'task-456', circular);
      }).not.toThrow();
    });
  });

  describe('apiCall', () => {
    it('should not crash with circular references in context', () => {
      const logger = createLogger('test');
      const circular: CircularTestObject = { request: 'data' };
      circular.self = circular;

      expect(() => {
        logger.apiCall('test-service', 'testMethod', 100, true, circular);
      }).not.toThrow();
    });
  });
});
