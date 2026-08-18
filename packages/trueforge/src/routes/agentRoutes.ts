/**
 * Agent registry route definitions (mounted at /api/v1/agents).
 * Handlers are registered in apis/agents.ts.
 */
import { createRoute, z } from '@hono/zod-openapi';
import {
  CreateAgentRequestSchema,
  DeleteAgentResponseSchema,
  GetAgentResponseSchema,
  ListAgentsResponseSchema,
  PutAgentRequestSchema,
} from '../schemas/agent';
import { NameSchema } from '../schemas/common';
import { RequestErrorResponseSchema } from '../schemas/errors';

const AGENTS_TAG = 'Agents';

const AgentNameParamsSchema = z.object({
  name: NameSchema,
});

export const listAgentsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [AGENTS_TAG],
  summary: 'List agents',
  description: 'All configured agents for the tenant.',
  'x-fern-sdk-group-name': ['agents'],
  'x-fern-sdk-method-name': 'list',
  responses: {
    200: {
      content: { 'application/json': { schema: ListAgentsResponseSchema } },
      description: 'All configured agents.',
    },
    401: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'OIDC is configured and the request has no valid session cookie.',
    },
  },
});

export const createAgentRoute = createRoute({
  method: 'post',
  path: '/',
  tags: [AGENTS_TAG],
  summary: 'Create an agent',
  description:
    'Creates an agent and allocates an immutable id. Fails if `name` is already taken. Name cannot be changed later.',
  'x-fern-sdk-group-name': ['agents'],
  'x-fern-sdk-method-name': 'create',
  request: {
    body: {
      content: { 'application/json': { schema: CreateAgentRequestSchema } },
      required: true,
    },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: GetAgentResponseSchema } },
      description: 'The created agent.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid request body or unknown model/MCP/skill refs.',
    },
    409: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'An agent with this name already exists.',
    },
    422: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description:
        'The agent spec is valid but requires a capability this server does not provide (e.g. sandbox or skills).',
    },
  },
});

export const putAgentRoute = createRoute({
  method: 'put',
  path: '/',
  tags: [AGENTS_TAG],
  summary: 'Create or replace an agent',
  description:
    'Create or replace by unique `name`. Allocates an id on create; later writes keep that id. Name cannot be changed.',
  'x-fern-sdk-group-name': ['agents'],
  'x-fern-sdk-method-name': 'create_or_update',
  request: {
    body: {
      content: { 'application/json': { schema: PutAgentRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: GetAgentResponseSchema } },
      description: 'The saved agent.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid request body or unknown model/MCP/skill refs.',
    },
    422: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description:
        'The agent spec is valid but requires a capability this server does not provide (e.g. sandbox or skills).',
    },
  },
});

export const getAgentRoute = createRoute({
  method: 'get',
  path: '/{name}',
  tags: [AGENTS_TAG],
  summary: 'Get an agent',
  description: 'Fetch a configured agent by unique name.',
  'x-fern-sdk-group-name': ['agents'],
  'x-fern-sdk-method-name': 'get',
  request: {
    params: AgentNameParamsSchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: GetAgentResponseSchema } },
      description: 'The agent.',
    },
    404: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Agent not found.',
    },
  },
});

export const deleteAgentRoute = createRoute({
  method: 'delete',
  path: '/{name}',
  tags: [AGENTS_TAG],
  summary: 'Delete an agent',
  description: 'Delete a configured agent by unique name. Idempotent if already gone.',
  'x-fern-sdk-group-name': ['agents'],
  'x-fern-sdk-method-name': 'delete',
  request: {
    params: AgentNameParamsSchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: DeleteAgentResponseSchema } },
      description: 'Agent deleted.',
    },
    401: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'OIDC is configured and the request has no valid session cookie.',
    },
  },
});
