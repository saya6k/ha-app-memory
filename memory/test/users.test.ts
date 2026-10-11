import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HomeAssistantUsers, resolveUser, type UserDirectory } from '../src/users.js';

let server: Server;
let api: string;
let requests: { path?: string; auth?: string }[];
let status: number;

const STATES = [
  { entity_id: 'person.dad', attributes: { user_id: 'u-dad', friendly_name: '아빠' } },
  { entity_id: 'person.mina', attributes: { user_id: 'u-mina', friendly_name: 'Mina Kim' } },
  // A person without a login cannot ask anything, so is not a user.
  { entity_id: 'person.grandma', attributes: { user_id: null, friendly_name: 'Grandma' } },
  { entity_id: 'light.kitchen', attributes: { friendly_name: 'Kitchen' } },
];

beforeEach(async () => {
  requests = [];
  status = 200;
  server = createServer((req, res) => {
    requests.push({ path: req.url, auth: req.headers.authorization });
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(STATES));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  api = `http://127.0.0.1:${(server.address() as AddressInfo).port}/core/api`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('HomeAssistantUsers', () => {
  it('reads people with a login from the person entities, with the token', async () => {
    const people = await new HomeAssistantUsers(api, 'secret').people();

    expect(people).toEqual([
      { userId: 'u-dad', name: '아빠', slug: 'dad' },
      { userId: 'u-mina', name: 'Mina Kim', slug: 'mina' },
    ]);
    expect(requests).toEqual([{ path: '/core/api/states', auth: 'Bearer secret' }]);
  });

  it('caches the list, but not a failure', async () => {
    const users = new HomeAssistantUsers(api, 'secret');
    status = 500;
    await expect(users.people()).rejects.toThrow(/HTTP 500/);

    status = 200;
    await users.people();
    await users.people();
    expect(requests).toHaveLength(2);
  });
});

describe('resolveUser', () => {
  const directory: UserDirectory = {
    people: async () => [
      { userId: 'u-dad', name: '아빠', slug: 'dad' },
      { userId: 'u-mina', name: 'Mina Kim', slug: 'mina' },
    ],
  };

  it('matches the display name or the person slug, ignoring case and spaces', async () => {
    expect((await resolveUser(directory, ' mina kim ')).userId).toBe('u-mina');
    expect((await resolveUser(directory, 'Dad')).userId).toBe('u-dad');
    expect((await resolveUser(directory, '아빠')).userId).toBe('u-dad');
  });

  it('names the known people when it cannot match', async () => {
    await expect(resolveUser(directory, 'Bob')).rejects.toThrow(
      'Unknown user "Bob". Known people: 아빠, Mina Kim.',
    );
  });
});
