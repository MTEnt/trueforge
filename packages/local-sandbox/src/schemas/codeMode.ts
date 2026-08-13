/**
 * Code Mode UDS wire shapes: host request/response framing and handler view.
 */
import { z } from 'zod';

/**
 * Code Mode UDS request: host requires `op` + non-empty `request_id`;
 * remaining fields are forwarded to the tool handler.
 */
export const CodeModeToolRequestSchema = z
  .object({
    request_id: z.string().min(1),
    op: z.string().min(1),
  })
  .passthrough();
export type CodeModeToolRequest = z.infer<typeof CodeModeToolRequestSchema>;

/** Tool handler / gateway response body (object map; `request_id` set by host). */
export const CodeModeToolResponseBodySchema = z.record(z.string(), z.unknown());

/** Smoke / handler view of a tool request (request_id already checked by host). */
export const ToolRequestViewSchema = z
  .object({
    op: z.string(),
    arguments: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type ToolRequestView = z.infer<typeof ToolRequestViewSchema>;
