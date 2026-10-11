import type { Fact } from '../db/facts.js';
import { type Owner, SHARED } from '../db/manuals.js';
import { resolveUser, type UserDirectory } from '../users.js';

/** What one tool call may see: always the shared owner, plus the asking user's own. */
export interface Scope {
  owners: Owner[];
  /** The asking user's HA user id, when the model said who is asking. */
  userId?: string;
}

/**
 * The scope for a tool call. `user` comes from the model, which takes it from
 * `{{ user_name }}` in the conversation agent's prompt; it is trusted as given.
 * Without it only shared things are visible. An unknown name is an error, so
 * the model can correct it rather than silently losing the user's memories.
 */
export async function scopeFor(users: UserDirectory, user: string | undefined): Promise<Scope> {
  if (!user) return { owners: [SHARED] };
  const person = await resolveUser(users, user);
  return { owners: [SHARED, person.userId], userId: person.userId };
}

export function canSee(scope: Scope, owner: Owner): boolean {
  return scope.owners.includes(owner);
}

/** A fact as the model sees it: whose it is as a flag, never a user id. */
export function presentFact<T extends Fact>(fact: T) {
  const { owner, ...rest } = fact;
  return { ...rest, personal: owner !== SHARED };
}
