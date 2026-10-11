import { z } from 'zod';

/** Who is asking. Shared by every tool; see scope.ts. */
const user = z
  .string()
  .min(1)
  .optional()
  .describe(
    'Name of the person you are talking to, exactly as the system prompt gives it ' +
      '(the current user). Omit it only when no user is known.',
  );

export const saveFactSchema = {
  content: z.string().min(1),
  tags: z.array(z.string()).optional(),
  user,
  shared: z
    .boolean()
    .optional()
    .describe(
      'true for something the whole household should know (the Wi-Fi password, where ' +
        "the fuse box is); false or omitted for the user's own (their allergy, their " +
        'plans). Always shared when no user is given.',
    ),
};

export const getFactSchema = {
  id: z.string().min(1),
  user,
};

export const DEFAULT_SEARCH_LIMIT = 5;
export const MAX_SEARCH_LIMIT = 20;

export const searchFactsSchema = {
  query: z.string().min(1),
  user,
  filter: z.object({ tags: z.array(z.string()).optional() }).optional(),
  // Inclusive bounds survive Home Assistant's OpenAPI schema conversion.
  limit: z.number().int().min(1).optional(),
};

export const updateFactSchema = {
  id: z.string().min(1),
  user,
  fact: z.object({
    content: z.string().min(1).optional(),
    tags: z.array(z.string()).optional(),
  }),
};

export const similarFactsSchema = {
  id: z.string().min(1),
  user,
  limit: z.number().int().min(1).optional(),
};

export const deleteFactSchema = {
  id: z.string().min(1),
  user,
};
