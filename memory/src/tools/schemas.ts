import { z } from 'zod';

export const saveFactSchema = {
  content: z.string().min(1),
  tags: z.array(z.string()).optional(),
};

export const getFactSchema = {
  id: z.string().min(1),
};

export const DEFAULT_SEARCH_LIMIT = 5;
export const MAX_SEARCH_LIMIT = 20;

export const searchFactsSchema = {
  query: z.string().min(1),
  filter: z.object({ tags: z.array(z.string()).optional() }).optional(),
  limit: z.number().int().positive().optional(),
};

export const updateFactSchema = {
  id: z.string().min(1),
  fact: z.object({
    content: z.string().min(1).optional(),
    tags: z.array(z.string()).optional(),
  }),
};

export const similarFactsSchema = {
  id: z.string().min(1),
  limit: z.number().int().positive().optional(),
};

export const deleteFactSchema = {
  id: z.string().min(1),
};
