import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentProposalSchema, type AgentProposal } from '@/shared/agent-proposal';
import { createAgentAuthoringEvalFixture } from '@/test-utils/agent-authoring-eval-fixture';
import { AcpRuntimeManager } from './acp-runtime-manager';
import { getChildWorkspaceMcpServerConfig } from './child-workspace-mcp-server';

const enabled = process.env.RUN_AGENT_AUTHORING_EVAL === '1';
const cases = [
  {
    name: 'feedback and focused follow-up',
    prompt:
      'Create an agent to investigate possible bugs in the Company Slack workspace, in #customer-feedback, #data-quality, and #bug-reports. People report bugs directly as well as bots. Ignore ordinary conversation, but prefer investigating uncertain reports. Use a development database. Include the thread for context.',
    type: 'SLACK_MESSAGE',
    ids: ['C-bugs', 'C-data', 'C-feedback'],
    followUp:
      'Also watch #engineering-bugs in Company. Keep the task instructions and all other settings unchanged.',
  },
  {
    name: 'packet unlock inside a thread',
    prompt:
      'Create an agent for the Company Slack workspace. When a message in a thread in #fillet-packet-review announces a packet has been unlocked, QA is complete. Compare QA edits to investigate potential bugs. Include the whole thread. Wording may vary; it is not always literally packet unlocked.',
    type: 'SLACK_MESSAGE',
    ids: ['C-review'],
  },
  {
    name: 'agent-labeled GitHub issues',
    prompt:
      'Create an agent for this Factory Factory project to execute GitHub issues tagged agent. Include issues that already have that label when created and issues that receive it later. Implement the requested change and open a PR.',
    type: 'GITHUB_ISSUE',
    ids: ['123'],
  },
  {
    name: 'ambiguous workspace asks before proposing',
    prompt:
      'Create an agent to investigate messages in #bug-reports on Slack. I have not chosen which connected Slack workspace; please ask me if there is more than one match.',
    type: 'CLARIFY',
    ids: [],
  },
];

function collectReply(event: import('./acp-runtime-events').AcpRuntimeEvent, reply: string[]) {
  if (
    event.type === 'acp_session_update' &&
    event.update.sessionUpdate === 'agent_message_chunk' &&
    event.update.content.type === 'text'
  ) {
    reply.push(event.update.content.text);
  }
}

function assertTrigger(proposal: AgentProposal, scenario: (typeof cases)[number]) {
  expect(proposal.specification.triggers).toHaveLength(1);
  const trigger = proposal.specification.triggers[0];
  expect(trigger?.type).toBe(scenario.type);
  if (trigger?.type === 'SLACK_MESSAGE') {
    expect(trigger.connectionId).toBe('slack-company');
    expect([...trigger.config.channelIds].sort()).toEqual(scenario.ids);
    expect(trigger.config.context.includeThread).toBe(true);
    expect(trigger.config.senderIds).toBeUndefined();
    expect(trigger.config.messageContains).toBeUndefined();
    expect(trigger.filterInstructions).toBeTruthy();
  } else if (trigger?.type === 'GITHUB_ISSUE') {
    expect(trigger.config.repositoryIds).toEqual(['123']);
    expect([...trigger.config.actions].sort()).toEqual(['labeled', 'opened']);
    expect(trigger.config.labels).toEqual(['agent']);
  }
  return trigger;
}

async function verifyFollowUp(
  manager: AcpRuntimeManager,
  sessionId: string,
  prompt: string,
  proposal: AgentProposal,
  fixture: Awaited<ReturnType<typeof createAgentAuthoringEvalFixture>>
) {
  await manager.sendPrompt(sessionId, [{ type: 'text', text: prompt }], 120_000);
  const revised = agentProposalSchema
    .strip()
    .parse(await fixture.db.prisma.agentProposal.findUniqueOrThrow({ where: { id: proposal.id } }));
  expect(revised.revision).toBeGreaterThan(proposal.revision);
  expect(revised.specification.instructions).toBe(proposal.specification.instructions);
  const trigger = revised.specification.triggers[0];
  if (trigger?.type !== 'SLACK_MESSAGE') {
    throw new Error('Expected Slack trigger');
  }
  expect([...trigger.config.channelIds].sort()).toEqual([
    'C-bugs',
    'C-data',
    'C-engineering',
    'C-feedback',
  ]);
  expect(trigger.filterInstructions).toBe(proposal.specification.triggers[0]?.filterInstructions);
}

describe.skipIf(!enabled)('live natural-language agent authoring evaluation', () => {
  for (const scenario of cases) {
    it(
      scenario.name,
      async () => {
        const fixture = await createAgentAuthoringEvalFixture();
        const manager = new AcpRuntimeManager();
        const sessionId = `agent-authoring-eval-${crypto.randomUUID()}`;
        const reply: string[] = [];
        const events: unknown[] = [];
        try {
          const mcp = getChildWorkspaceMcpServerConfig({
            nodeExecPath: process.execPath,
            workspaceId: fixture.workspaceId,
            parentWorkspaceId: null,
            apiBaseUrl: fixture.apiBaseUrl,
          });
          await manager.getOrCreateClient(
            sessionId,
            {
              provider: 'CODEX',
              workingDir: fixture.db.tempDir,
              sessionId,
              permissionPreset: 'YOLO',
              ...(process.env.AGENT_AUTHORING_EVAL_MODEL
                ? { model: process.env.AGENT_AUTHORING_EVAL_MODEL }
                : {}),
              mcpServers: [mcp],
            },
            {
              onAcpEvent: (_id, event) => {
                events.push(event);
                collectReply(event, reply);
              },
            },
            { workspaceId: fixture.workspaceId, workingDir: fixture.db.tempDir }
          );
          await manager.sendPrompt(
            sessionId,
            [
              {
                type: 'text',
                text: `You are helping a user configure an agent in Factory Factory. Use the available Factory Factory authoring tools. Do not run shell commands, edit files, or create/enable an agent yourself. Present the proposal for the user's Create agent action; ask for clarification when needed.\n\n${scenario.prompt}`,
              },
            ],
            120_000
          );
          expect(fixture.paths.some((path) => path.includes('agent.sources'))).toBe(true);
          const proposals = await fixture.db.prisma.agentProposal.findMany({
            where: { workspaceId: fixture.workspaceId },
          });
          if (scenario.type === 'CLARIFY') {
            expect(proposals).toHaveLength(0);
            expect(reply.join('').toLowerCase()).toMatch(/company|partner|workspace/);
          } else {
            expect(proposals).toHaveLength(1);
            const proposal = agentProposalSchema.strip().parse(proposals[0]);
            assertTrigger(proposal, scenario);
            if (scenario.followUp) {
              await verifyFollowUp(manager, sessionId, scenario.followUp, proposal, fixture);
            }
          }
          expect(await fixture.db.prisma.agentDefinition.count()).toBe(0);
          const output = process.env.AGENT_AUTHORING_EVAL_OUTPUT;
          if (output) {
            await writeFile(
              join(output, `${scenario.name.replaceAll(' ', '-')}.json`),
              JSON.stringify(
                {
                  scenario,
                  reply,
                  events,
                  paths: fixture.paths,
                  proposals: await fixture.db.prisma.agentProposal.findMany(),
                },
                null,
                2
              )
            );
          }
        } finally {
          await manager.stopAllClients();
          await fixture.close();
        }
      },
      300_000
    );
  }
});
