/**
 * Wire / host JSON shapes for local-sandbox. One owner for Zod schemas used by
 * the provider, Code Mode bridge, and frame decode.
 */
import { z } from 'zod';

/** `stat` / xfer probe output from sandboxed python. */
export const XferFileInfoSchema = z.object({
  size: z.number(),
  isDir: z.boolean(),
});
export type XferFileInfo = z.infer<typeof XferFileInfoSchema>;

/** Length-prefixed frame payload after JSON.parse (any JSON value). */
export const JsonFrameValueSchema = z.json();

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
