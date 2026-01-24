import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgent, createMail } from '../testing/factories';

// Hoist mock definitions
const mockPrisma = vi.hoisted(() => ({
  mail: {
    create: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../db', () => ({
  prisma: mockPrisma,
}));

// Import after mocking
import { mailAccessor } from './mail.accessor';

describe('MailAccessor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('create', () => {
    it('should create a mail between agents', async () => {
      const fromAgent = createAgent({ id: 'from-agent' });
      const toAgent = createAgent({ id: 'to-agent' });
      const expectedMail = createMail({
        fromAgentId: fromAgent.id,
        toAgentId: toAgent.id,
        subject: 'Test Subject',
        body: 'Test body content',
      });

      mockPrisma.mail.create.mockResolvedValue(expectedMail);

      const result = await mailAccessor.create({
        fromAgentId: fromAgent.id,
        toAgentId: toAgent.id,
        subject: 'Test Subject',
        body: 'Test body content',
      });

      expect(mockPrisma.mail.create).toHaveBeenCalledWith({
        data: {
          fromAgentId: fromAgent.id,
          toAgentId: toAgent.id,
          isForHuman: false,
          subject: 'Test Subject',
          body: 'Test body content',
        },
      });
      expect(result.subject).toBe('Test Subject');
    });

    it('should create mail for human notification', async () => {
      const fromAgent = createAgent({ id: 'from-agent' });
      const expectedMail = createMail({
        fromAgentId: fromAgent.id,
        toAgentId: null,
        isForHuman: true,
        subject: 'Human Notification',
        body: 'This needs human attention',
      });

      mockPrisma.mail.create.mockResolvedValue(expectedMail);

      const result = await mailAccessor.create({
        fromAgentId: fromAgent.id,
        isForHuman: true,
        subject: 'Human Notification',
        body: 'This needs human attention',
      });

      expect(mockPrisma.mail.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          isForHuman: true,
          toAgentId: undefined,
        }),
      });
      expect(result.isForHuman).toBe(true);
    });

    it('should default isForHuman to false', async () => {
      const mail = createMail({ isForHuman: false });
      mockPrisma.mail.create.mockResolvedValue(mail);

      await mailAccessor.create({
        subject: 'Test',
        body: 'Test body',
      });

      expect(mockPrisma.mail.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          isForHuman: false,
        }),
      });
    });
  });

  describe('findById', () => {
    it('should return mail with relations', async () => {
      const mail = createMail();
      mockPrisma.mail.findUnique.mockResolvedValue(mail);

      const result = await mailAccessor.findById(mail.id);

      expect(mockPrisma.mail.findUnique).toHaveBeenCalledWith({
        where: { id: mail.id },
        include: {
          fromAgent: true,
          toAgent: true,
        },
      });
      expect(result).toEqual(mail);
    });

    it('should return null for non-existent mail', async () => {
      mockPrisma.mail.findUnique.mockResolvedValue(null);

      const result = await mailAccessor.findById('non-existent');

      expect(result).toBeNull();
    });
  });

  describe('update', () => {
    it('should update isRead status', async () => {
      const mail = createMail({ isRead: false });
      const updatedMail = { ...mail, isRead: true, readAt: new Date() };
      mockPrisma.mail.update.mockResolvedValue(updatedMail);

      const result = await mailAccessor.update(mail.id, { isRead: true });

      expect(mockPrisma.mail.update).toHaveBeenCalledWith({
        where: { id: mail.id },
        data: expect.objectContaining({
          isRead: true,
          readAt: expect.any(Date),
        }),
      });
      expect(result.isRead).toBe(true);
    });

    it('should set readAt when marking as read', async () => {
      const mail = createMail({ isRead: false });
      mockPrisma.mail.update.mockResolvedValue(mail);

      await mailAccessor.update(mail.id, { isRead: true });

      expect(mockPrisma.mail.update).toHaveBeenCalledWith({
        where: { id: mail.id },
        data: expect.objectContaining({
          readAt: expect.any(Date),
        }),
      });
    });

    it('should use provided readAt if given', async () => {
      const mail = createMail();
      const customReadAt = new Date('2024-01-01');
      mockPrisma.mail.update.mockResolvedValue(mail);

      await mailAccessor.update(mail.id, { readAt: customReadAt });

      expect(mockPrisma.mail.update).toHaveBeenCalledWith({
        where: { id: mail.id },
        data: expect.objectContaining({
          readAt: customReadAt,
        }),
      });
    });

    it('should clear readAt when explicitly set to null', async () => {
      const mail = createMail({ readAt: new Date() });
      mockPrisma.mail.update.mockResolvedValue(mail);

      await mailAccessor.update(mail.id, { readAt: null });

      expect(mockPrisma.mail.update).toHaveBeenCalledWith({
        where: { id: mail.id },
        data: expect.objectContaining({
          readAt: null,
        }),
      });
    });
  });

  describe('listInbox', () => {
    it('should return unread mail for agent by default', async () => {
      const agentId = 'test-agent';
      const mails = [
        createMail({ toAgentId: agentId, isRead: false }),
        createMail({ toAgentId: agentId, isRead: false }),
      ];
      mockPrisma.mail.findMany.mockResolvedValue(mails);

      const result = await mailAccessor.listInbox(agentId);

      expect(mockPrisma.mail.findMany).toHaveBeenCalledWith({
        where: {
          toAgentId: agentId,
          isRead: false,
        },
        orderBy: { createdAt: 'desc' },
        include: {
          fromAgent: true,
          toAgent: true,
        },
      });
      expect(result).toHaveLength(2);
    });

    it('should include read mail when specified', async () => {
      const agentId = 'test-agent';
      mockPrisma.mail.findMany.mockResolvedValue([]);

      await mailAccessor.listInbox(agentId, true);

      expect(mockPrisma.mail.findMany).toHaveBeenCalledWith({
        where: {
          toAgentId: agentId,
        },
        orderBy: { createdAt: 'desc' },
        include: expect.any(Object),
      });
    });
  });

  describe('listHumanInbox', () => {
    it('should return unread human notifications by default', async () => {
      const mails = [createMail({ isForHuman: true, isRead: false })];
      mockPrisma.mail.findMany.mockResolvedValue(mails);

      const result = await mailAccessor.listHumanInbox();

      expect(mockPrisma.mail.findMany).toHaveBeenCalledWith({
        where: {
          isForHuman: true,
          isRead: false,
        },
        orderBy: { createdAt: 'desc' },
        include: expect.any(Object),
      });
      expect(result[0].isForHuman).toBe(true);
    });

    it('should filter by projectId when provided', async () => {
      const projectId = 'test-project';
      mockPrisma.mail.findMany.mockResolvedValue([]);

      await mailAccessor.listHumanInbox(false, projectId);

      expect(mockPrisma.mail.findMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          isForHuman: true,
          isRead: false,
          fromAgent: {
            currentTask: {
              projectId,
            },
          },
        }),
        orderBy: { createdAt: 'desc' },
        include: expect.any(Object),
      });
    });

    it('should include read notifications when specified', async () => {
      mockPrisma.mail.findMany.mockResolvedValue([]);

      await mailAccessor.listHumanInbox(true);

      expect(mockPrisma.mail.findMany).toHaveBeenCalledWith({
        where: {
          isForHuman: true,
        },
        orderBy: { createdAt: 'desc' },
        include: expect.any(Object),
      });
    });
  });

  describe('listAll', () => {
    it('should return all mail including read by default', async () => {
      const mails = [createMail({ isRead: true }), createMail({ isRead: false })];
      mockPrisma.mail.findMany.mockResolvedValue(mails);

      const result = await mailAccessor.listAll();

      expect(mockPrisma.mail.findMany).toHaveBeenCalledWith({
        where: {},
        orderBy: { createdAt: 'desc' },
        include: expect.any(Object),
      });
      expect(result).toHaveLength(2);
    });

    it('should filter to unread only when specified', async () => {
      mockPrisma.mail.findMany.mockResolvedValue([]);

      await mailAccessor.listAll(false);

      expect(mockPrisma.mail.findMany).toHaveBeenCalledWith({
        where: {
          isRead: false,
        },
        orderBy: { createdAt: 'desc' },
        include: expect.any(Object),
      });
    });

    it('should filter by projectId', async () => {
      const projectId = 'test-project';
      mockPrisma.mail.findMany.mockResolvedValue([]);

      await mailAccessor.listAll(true, projectId);

      expect(mockPrisma.mail.findMany).toHaveBeenCalledWith({
        where: {
          OR: [
            { fromAgent: { currentTask: { projectId } } },
            { toAgent: { currentTask: { projectId } } },
          ],
        },
        orderBy: { createdAt: 'desc' },
        include: expect.any(Object),
      });
    });
  });

  describe('markAsRead', () => {
    it('should update mail to read status', async () => {
      const mail = createMail({ isRead: false });
      const updatedMail = { ...mail, isRead: true };
      mockPrisma.mail.update.mockResolvedValue(updatedMail);

      const result = await mailAccessor.markAsRead(mail.id);

      expect(mockPrisma.mail.update).toHaveBeenCalledWith({
        where: { id: mail.id },
        data: expect.objectContaining({
          isRead: true,
        }),
      });
      expect(result.isRead).toBe(true);
    });
  });

  describe('delete', () => {
    it('should delete mail', async () => {
      const mail = createMail();
      mockPrisma.mail.delete.mockResolvedValue(mail);

      const result = await mailAccessor.delete(mail.id);

      expect(mockPrisma.mail.delete).toHaveBeenCalledWith({
        where: { id: mail.id },
      });
      expect(result).toEqual(mail);
    });
  });
});

describe('Mail System Behavior', () => {
  describe('message delivery', () => {
    it('mail should start as unread', () => {
      const mail = createMail();
      expect(mail.isRead).toBe(false);
      expect(mail.readAt).toBeNull();
    });

    it('mail should have a subject and body', () => {
      const mail = createMail({
        subject: 'Important Message',
        body: 'This is the message content',
      });
      expect(mail.subject).toBe('Important Message');
      expect(mail.body).toBe('This is the message content');
    });

    it('mail should track sender and recipient', () => {
      const mail = createMail({
        fromAgentId: 'sender-agent',
        toAgentId: 'recipient-agent',
      });
      expect(mail.fromAgentId).toBe('sender-agent');
      expect(mail.toAgentId).toBe('recipient-agent');
    });
  });

  describe('human notifications', () => {
    it('human notifications have isForHuman=true and no toAgentId', () => {
      const notification = createMail({
        isForHuman: true,
        toAgentId: null,
        subject: 'Needs Human Review',
      });
      expect(notification.isForHuman).toBe(true);
      expect(notification.toAgentId).toBeNull();
    });
  });

  describe('read tracking', () => {
    it('readAt should be set when mail is read', () => {
      const readTime = new Date();
      const mail = createMail({
        isRead: true,
        readAt: readTime,
      });
      expect(mail.isRead).toBe(true);
      expect(mail.readAt).toEqual(readTime);
    });
  });
});
