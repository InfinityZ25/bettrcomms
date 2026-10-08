import {
  expect,
  test,
  type APIResponse,
  type BrowserContext,
} from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173';
const headers = { Origin: new URL(baseURL).origin };
type User = { id: string; name: string };
type Room = { id: string; name: string; is_private: boolean };
type Community = { id: string; name: string; channels: Room[] };
async function value<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json() as Promise<T>;
}
async function expectHiddenChannel(response: APIResponse, room: Room) {
  expect(response.status()).toBe(403);
  const body = await response.json();
  expect(body).toEqual({
    error: { code: 'not_a_member', message: 'room membership required' },
  });
  const serialized = JSON.stringify(body);
  expect(serialized).not.toContain(room.id);
  expect(serialized).not.toContain(room.name);
}
async function login(context: BrowserContext, name: string, suffix: string) {
  return (
    await value<{ user: User }>(
      await context.request.post('/api/v1/auth/dev', {
        headers,
        data: {
          name,
          email: `${name.toLowerCase().replaceAll(' ', '-')}-${suffix}@example.test`,
        },
      }),
    )
  ).user;
}

test('custom roles grant private channel access and live voice/read revocation follows overrides', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const owner = await browser.newContext({ baseURL });
  const member = await browser.newContext({ baseURL });
  let communityId = '';
  try {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await login(owner, 'ACL Owner', suffix);
    const user = await login(member, 'ACL Member', suffix);
    const { request } = await value<{ request: { id: string } }>(
      await owner.request.post('/api/v1/friends/requests', {
        headers,
        data: { user_id: user.id },
      }),
    );
    await value(
      await member.request.post(
        `/api/v1/friends/requests/${request.id}/accept`,
        { headers, data: {} },
      ),
    );
    const { community } = await value<{ community: Community }>(
      await owner.request.post('/api/v1/communities', {
        headers,
        data: { name: `Private friends ${suffix}` },
      }),
    );
    communityId = community.id;
    await value(
      await owner.request.post(`/api/v1/communities/${communityId}/members`, {
        headers,
        data: { user_id: user.id },
      }),
    );
    const ownerPage = await owner.newPage();
    const memberPage = await member.newPage();
    await ownerPage.goto('/');
    await memberPage.goto('/');
    const memberList = memberPage.getByRole('list', {
      name: `${community.name} channel list`,
      exact: true,
    });
    await ownerPage
      .getByRole('button', {
        name: `${community.name} room settings`,
        exact: true,
      })
      .click();
    const settings = ownerPage.getByRole('dialog', {
      name: community.name,
      exact: true,
    });
    await settings.getByRole('button', { name: 'Roles', exact: true }).click();
    await settings
      .getByRole('button', { name: 'Create role', exact: true })
      .click();
    const createRole = ownerPage.getByRole('dialog', {
      name: 'Create a role',
      exact: true,
    });
    await createRole
      .getByRole('textbox', { name: 'Role name', exact: true })
      .fill('Squad');
    await createRole
      .getByRole('combobox', { name: 'Default pin messages', exact: true })
      .selectOption('allow');
    await createRole
      .getByRole('button', { name: 'Save role', exact: true })
      .click();
    await expect(createRole).toBeHidden();
    await settings.getByRole('button', { name: /^Members(?: ·|$)/ }).click();
    await settings
      .getByRole('button', {
        name: `Custom roles for ${user.name}`,
        exact: true,
      })
      .click();
    const memberRoles = ownerPage.getByRole('dialog', {
      name: `Roles for ${user.name}`,
      exact: true,
    });
    await memberRoles
      .getByRole('checkbox', { name: 'Squad', exact: true })
      .check();
    await memberRoles
      .getByRole('button', { name: 'Save member roles', exact: true })
      .click();
    await expect(memberRoles).toBeHidden();
    await settings.getByRole('button', { name: /^Channels(?: ·|$)/ }).click();
    await settings
      .getByRole('button', { name: 'New channel', exact: true })
      .click();
    const channelDialog = ownerPage.getByRole('dialog', {
      name: 'Create a channel',
      exact: true,
    });
    await channelDialog
      .getByRole('textbox', { name: 'Channel name', exact: true })
      .fill('secret');
    await channelDialog
      .getByRole('checkbox', { name: /Private channel/ })
      .check();
    await channelDialog
      .getByRole('button', { name: 'Create channel', exact: true })
      .click();
    await expect(channelDialog).toBeHidden();
    await expect(
      memberList.getByRole('button', { name: 'secret', exact: true }),
    ).toHaveCount(0);
    const latest = (
      await value<{ community: Community }>(
        await owner.request.get(`/api/v1/communities/${communityId}`),
      )
    ).community;
    const secret = latest.channels.find(
      (channel) => channel.name === 'secret',
    )!;
    expect(secret.is_private).toBe(true);
    await expectHiddenChannel(
      await member.request.get(`/api/v1/rooms/${secret.id}`),
      secret,
    );
    await settings
      .getByRole('button', { name: 'Manage access to secret', exact: true })
      .click();
    const access = ownerPage.getByRole('dialog', {
      name: 'Access to #secret',
      exact: true,
    });
    const roles = (
      await value<{ roles: { id: string; name: string }[] }>(
        await owner.request.get(`/api/v1/communities/${communityId}/roles`),
      )
    ).roles;
    const squad = roles.find((role) => role.name === 'Squad')!;
    await access
      .getByRole('combobox', { name: 'Permissions for role', exact: true })
      .selectOption(squad.id);
    await access
      .getByRole('combobox', { name: 'View channel override', exact: true })
      .selectOption('allow');
    await access
      .getByRole('button', { name: 'Save channel access', exact: true })
      .click();
    await expect(access).toBeHidden();
    await memberList
      .getByRole('button', { name: 'secret', exact: true })
      .click();
    await expect(
      memberPage.getByRole('textbox', { name: 'Message secret', exact: true }),
    ).toBeVisible();
    await memberPage
      .getByRole('region', { name: `${community.name} · secret`, exact: true })
      .getByRole('button', { name: 'Join voice', exact: true })
      .click();
    await expect(
      memberPage.getByRole('button', { name: 'Leave call', exact: true }),
    ).toBeVisible();
    await settings
      .getByRole('button', { name: 'Manage access to secret', exact: true })
      .click();
    await access
      .getByRole('combobox', { name: 'Permissions for role', exact: true })
      .selectOption(squad.id);
    await access
      .getByRole('combobox', { name: 'Join voice override', exact: true })
      .selectOption('deny');
    await access
      .getByRole('button', { name: 'Save channel access', exact: true })
      .click();
    await expect(access).toBeHidden();
    await expect(
      memberPage.getByRole('button', { name: 'Leave call', exact: true }),
    ).toHaveCount(0);
    await expect(
      memberPage.getByRole('textbox', { name: 'Message secret', exact: true }),
    ).toBeVisible();
    await settings
      .getByRole('button', { name: 'Manage access to secret', exact: true })
      .click();
    await access
      .getByRole('combobox', { name: 'Permissions for role', exact: true })
      .selectOption('member');
    await access
      .getByRole('combobox', { name: 'View channel override', exact: true })
      .selectOption('deny');
    await access
      .getByRole('button', { name: 'Save channel access', exact: true })
      .click();
    await expect(access).toBeHidden();
    await expect(
      memberList.getByRole('button', { name: 'secret', exact: true }),
    ).toHaveCount(0);
    await expectHiddenChannel(
      await member.request.get(`/api/v1/rooms/${secret.id}/messages`),
      secret,
    );
    expect(
      (
        await member.request.put(
          `/api/v1/communities/${communityId}/members/${user.id}/custom-roles`,
          { headers, data: { role_ids: [squad.id] } },
        )
      ).status(),
    ).toBe(403);
    expect(
      (
        await member.request.put(
          `/api/v1/communities/${communityId}/channels/${secret.id}/permissions`,
          { headers, data: { is_private: false, overrides: [] } },
        )
      ).status(),
    ).toBe(403);
  } finally {
    if (communityId)
      await owner.request.delete(`/api/v1/communities/${communityId}`, {
        headers,
      });
    await member.close();
    await owner.close();
  }
});
