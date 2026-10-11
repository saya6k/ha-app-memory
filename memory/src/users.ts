import { fetch } from 'undici';

/** A household member: a HA person entity linked to a HA user. */
export interface Person {
  /** HA user id — the key for personal facts and documents. */
  userId: string;
  /** The person's name as shown in HA (friendly_name). */
  name: string;
  /** The person entity's object id, e.g. `dad` for person.dad. */
  slug: string;
}

export interface UserDirectory {
  people(): Promise<Person[]>;
}

/** Thrown when a tool is given a user name that matches nobody. */
export class UnknownUserError extends Error {
  constructor(name: string, people: Person[]) {
    const known = people.map((p) => p.name).join(', ') || 'none';
    super(`Unknown user "${name}". Known people: ${known}.`);
  }
}

interface StateRow {
  entity_id: string;
  attributes: { user_id?: string | null; friendly_name?: string };
}

const CACHE_MS = 60_000;

/**
 * Reads the household from Home Assistant's person entities, through the
 * Supervisor's Core API proxy (needs `homeassistant_api: true`). Person rather
 * than user: the REST API lists no users, but every person linked to a login
 * carries that user's id, and people are exactly the household members.
 *
 * Cached for a minute; a failed lookup is not cached, so the next call retries.
 */
export class HomeAssistantUsers implements UserDirectory {
  private cached: { at: number; people: Person[] } | undefined;

  constructor(
    private readonly apiUrl: string,
    private readonly token: string,
  ) {}

  async people(): Promise<Person[]> {
    if (this.cached && Date.now() - this.cached.at < CACHE_MS) return this.cached.people;

    const res = await fetch(`${this.apiUrl}/states`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) throw new Error(`Home Assistant API returned HTTP ${res.status} for /states`);

    const people = ((await res.json()) as StateRow[]).flatMap((row) => {
      const userId = row.attributes.user_id;
      if (!row.entity_id.startsWith('person.') || !userId) return [];
      const slug = row.entity_id.slice('person.'.length);
      return [{ userId, name: row.attributes.friendly_name ?? slug, slug }];
    });
    this.cached = { at: Date.now(), people };
    return people;
  }
}

/** For running outside Home Assistant: nobody is known, so everything is shared. */
export const NO_USERS: UserDirectory = { people: async () => [] };

function normalize(name: string): string {
  return name.normalize('NFC').trim().toLowerCase();
}

/**
 * The person a name refers to: their display name or person slug, ignoring
 * case and surrounding space. What `{{ user_name }}` gives the model is the HA
 * user's name, which is normally the person's name too.
 */
export async function resolveUser(directory: UserDirectory, name: string): Promise<Person> {
  const people = await directory.people();
  const wanted = normalize(name);
  const person = people.find((p) => normalize(p.name) === wanted || normalize(p.slug) === wanted);
  if (!person) throw new UnknownUserError(name, people);
  return person;
}
