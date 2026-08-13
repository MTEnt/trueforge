/** Length-prefixed frame payload after JSON.parse (any JSON value). */
import { z } from 'zod';

export const JsonFrameValueSchema = z.json();
