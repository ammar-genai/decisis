#!/usr/bin/env node
/**
 * decisis MCP server: typed decisions as tools, for any agent that speaks MCP.
 *
 *   OPENROUTER_API_KEY   required
 *   DECISIS_MODEL        decision model (default: TypeSafe Jev via OpenRouter)
 *   DECISIS_LLM_MODEL    set this instead to answer with an ordinary chat model
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { jevDecider, llmDecider, loadKey, type Decider } from '@decisis/core';
import { classify, decideTool, routeModel, errorResult, DEFAULT_TIERS, type ToolResult } from './tools.ts';

export function deciderFromEnv(env: NodeJS.ProcessEnv = process.env): Decider {
  const key = loadKey('OPENROUTER_API_KEY', { env }) ?? undefined;
  return env.DECISIS_LLM_MODEL
    ? llmDecider({ key, model: env.DECISIS_LLM_MODEL, title: 'decisis-mcp' })
    : jevDecider({ key, model: env.DECISIS_MODEL ?? undefined, title: 'decisis-mcp' });
}

/** Keeps a tool's failure inside the tool result: an MCP client should see the reason, not a crash. */
export const guard = (fn: () => Promise<ToolResult>): Promise<ToolResult> => fn().catch((e: Error) => errorResult(e.message));

export function buildServer(decide: Decider): McpServer {
  const server = new McpServer({ name: 'decisis', version: '0.1.0' });

  server.registerTool(
    'classify',
    {
      title: 'Classify into one of several options',
      description: 'Pick one option out of a named set for the given state, with confidence. Pass `ladder` (options ordered from least to most cautious) to have a low-confidence answer resolved towards the safer end.',
      inputSchema: {
        state: z.string().describe('The text or JSON to classify.'),
        options: z.record(z.string(), z.string()).describe('Option name -> what that option means. At least two.'),
        instructions: z.string().optional().describe('The question to answer. Defaults to "which option fits best".'),
        ladder: z.array(z.string()).optional().describe('The same option names ordered least to most cautious.'),
        confidence_floor: z.number().optional().describe('Below this confidence the ladder resolves to the safer option. Default 0.6.'),
      },
    },
    async (args) => guard(() => classify(args, decide)),
  );

  server.registerTool(
    'decide',
    {
      title: 'Answer several typed questions at once',
      description: 'Ask a set of typed questions about one state: `noul` (a probability), `choice` (one option from `criteria`), `score` (a level from an ordered list). Returns typed answers, never prose.',
      inputSchema: {
        state: z.string().describe('The text or JSON the questions are about.'),
        questions: z.record(z.string(), z.any()).describe('name -> {type: "noul"|"choice"|"score", instructions, criteria}'),
      },
    },
    async (args) => guard(() => decideTool(args, decide)),
  );

  server.registerTool(
    'route_model',
    {
      title: 'Choose a model tier for a coding task',
      description: `Pick the cheapest model tier that will do a task well (default ${DEFAULT_TIERS.join(' < ')}), raised when the work is risky or under-specified. Returns the tier and the reasons.`,
      inputSchema: {
        task: z.string().describe('What the task is: title and enough description to judge it.'),
        tiers: z.array(z.string()).optional().describe(`Tier names, cheapest first. Default: ${DEFAULT_TIERS.join(', ')}.`),
        confidence_floor: z.number().optional(),
      },
    },
    async (args) => guard(() => routeModel(args, decide)),
  );

  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = buildServer(deciderFromEnv());
  await server.connect(new StdioServerTransport());
}
