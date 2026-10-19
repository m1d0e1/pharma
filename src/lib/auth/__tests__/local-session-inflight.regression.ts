const mockDbGet = jest.fn();
const mockInvoke = jest.fn();
const mockLogoutWeb = jest.fn();
let mockNative = false;

jest.mock('@/lib/env', () => ({
  isClient: true,
  get isTauri() { return mockNative; },
}));
jest.mock('@/lib/db/tauri', () => ({
  dbGet: (...args: unknown[]) => mockDbGet(...args),
  dbExecute: jest.fn(),
}));
jest.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => mockInvoke(...args) }));
jest.mock('@/app/actions-client/auth', () => ({ logoutLocalAction: (...args: unknown[]) => mockLogoutWeb(...args) }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const alice = { id: 'alice', username: 'alice', role: 'cashier', pharmacy_id: 'ph-a', permissions: '{"can_view_sales":true}' };
const bob = { id: 'bob', username: 'bob', role: 'manager', pharmacy_id: 'ph-b', permissions: '{"can_view_sales":false}' };
function store(user: typeof alice) {
  localStorage.setItem('pharma_session_user', JSON.stringify(user));
}

beforeEach(() => {
  jest.resetModules();
  mockDbGet.mockReset();
  mockInvoke.mockReset();
  mockLogoutWeb.mockReset().mockResolvedValue(undefined);
  mockNative = false;
  localStorage.clear();
});

it('singleflights concurrent web getClientSession and getLocalSession without caching subsequent permission checks', async () => {
  store(alice);
  const first = deferred<typeof alice>();
  mockDbGet.mockReturnValueOnce(first.promise)
    .mockResolvedValueOnce({ ...alice, permissions: '{"can_view_sales":false}' });
  const { getClientSession, getLocalSession } = await import('@/lib/auth/local');

  const reads = [...Array.from({ length: 15 }, () => getClientSession()), getLocalSession()];
  expect(mockDbGet).toHaveBeenCalledTimes(1);
  expect(mockDbGet).toHaveBeenCalledWith(expect.stringContaining('FROM users WHERE id = ?'), ['alice']);
  first.resolve(alice);
  expect((await Promise.all(reads)).every(user => user?.id === 'alice')).toBe(true);
  expect(mockDbGet).toHaveBeenCalledTimes(1);
  expect((await getClientSession())?.permissions).toBe('{"can_view_sales":false}');
  expect(mockDbGet).toHaveBeenCalledTimes(2);
});

it('a pending web user lookup cannot resurrect a logged-out session', async () => {
  store(alice);
  const pending = deferred<typeof alice>();
  mockDbGet.mockReturnValueOnce(pending.promise);
  const { getClientSession, logoutLocal } = await import('@/lib/auth/local');

  const result = getClientSession();
  await logoutLocal();
  expect(mockLogoutWeb).toHaveBeenCalledTimes(1);
  expect(localStorage.getItem('pharma_session_user')).toBeNull();
  pending.resolve(alice);
  await expect(result).resolves.toBeNull();
  expect(localStorage.getItem('pharma_session_user')).toBeNull();
  expect(mockDbGet).toHaveBeenCalledTimes(1);
});

it('parallel old and new actors never share in-flight lookups or overwrite newer tenant/role', async () => {
  store(alice);
  const pendingA = deferred<typeof alice>();
  const pendingB = deferred<typeof bob>();
  mockDbGet.mockImplementation((_sql: string, [id]: string[]) => id === 'alice' ? pendingA.promise : pendingB.promise);
  const { getClientSession } = await import('@/lib/auth/local');

  const a = getClientSession();
  store(bob);
  const b = getClientSession();
  expect(mockDbGet).toHaveBeenCalledTimes(2);
  expect(mockDbGet.mock.calls.map((call: unknown[]) => call[1])).toEqual([['alice'], ['bob']]);
  pendingB.resolve(bob);
  await expect(b).resolves.toMatchObject({ id: 'bob', pharmacy_id: 'ph-b' });
  pendingA.resolve(alice);
  await expect(a).resolves.toBeNull();
  expect(JSON.parse(localStorage.getItem('pharma_session_user') || 'null')).toMatchObject(bob);
});

it('cannot reuse an in-flight identity check after the same account signs in again', async () => {
  store(alice);
  const pending = deferred<typeof alice>();
  mockDbGet.mockReturnValueOnce(pending.promise);
  const priorFetch = globalThis.fetch;
  globalThis.fetch = jest.fn().mockResolvedValue({ json: async () => ({
    success: true,
    user: {
      id: alice.id, username: alice.username, role: alice.role,
      fullName: alice.username, pharmacyId: alice.pharmacy_id,
      permissions: { can_view_sales: true },
    },
  }) }) as typeof fetch;
  try {
    const { getClientSession, loginLocal } = await import('@/lib/auth/local');
    const stale = getClientSession();
    await expect(loginLocal('alice', 'new secret')).resolves.toMatchObject({ success: true });
    pending.resolve(alice);
    await expect(stale).resolves.toBeNull();
    expect(JSON.parse(localStorage.getItem('pharma_session_user') || 'null').id).toBe('alice');
  } finally {
    globalThis.fetch = priorFetch;
  }
});

it('rejects inconsistent database identity rather than storing another actor under a requested id', async () => {
  store(alice);
  mockDbGet.mockResolvedValueOnce(bob);
  const { getClientSession } = await import('@/lib/auth/local');
  await expect(getClientSession()).resolves.toBeNull();
  expect(JSON.parse(localStorage.getItem('pharma_session_user') || 'null').id).toBe('alice');
});

it('a cross-window storage event invalidates a concurrent identity check even if the snapshot is unchanged', async () => {
  store(alice);
  const pending = deferred<typeof alice>();
  mockDbGet.mockReturnValue(pending.promise);
  const { getClientSession } = await import('@/lib/auth/local');
  const result = getClientSession();
  window.dispatchEvent(new StorageEvent('storage', { key: 'pharma_session_user', oldValue: '{}', newValue: JSON.stringify(alice) }));
  pending.resolve(alice);
  await expect(result).resolves.toBeNull();
  expect(mockDbGet).toHaveBeenCalledTimes(1);
});

it('an inactive/deleted web account cannot leave a stale cached localStorage identity', async () => {
  store(alice);
  mockDbGet.mockResolvedValueOnce(null);
  const { getClientSession } = await import('@/lib/auth/local');
  await expect(getClientSession()).resolves.toBeNull();
  expect(localStorage.getItem('pharma_session_user')).toBeNull();
});

it('singleflights concurrent native current_local_user lookups, but revalidates again later', async () => {
  mockNative = true;
  const pending = deferred<typeof alice>();
  mockInvoke.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(bob);
  const { getClientSession, getLocalSession } = await import('@/lib/auth/local');
  const reads = [...Array.from({ length: 12 }, () => getClientSession()), getLocalSession()];
  // Native IPC is not called until the dynamic import finishes.
  await Promise.resolve();
  await Promise.resolve();
  pending.resolve(alice);
  expect((await Promise.all(reads)).every(user => user?.id === 'alice')).toBe(true);
  expect(mockInvoke.mock.calls.filter(([command]) => command === 'current_local_user')).toHaveLength(1);
  await expect(getClientSession()).resolves.toMatchObject({ id: 'bob' });
  expect(mockInvoke.mock.calls.filter(([command]) => command === 'current_local_user')).toHaveLength(2);
  expect(mockDbGet).not.toHaveBeenCalled();
});

it('a pending native current_local_user response cannot resurrect identity after logout', async () => {
  mockNative = true;
  store(alice);
  const pending = deferred<typeof alice>();
  mockInvoke.mockImplementation((command: string) => command === 'current_local_user' ? pending.promise : Promise.resolve(null));
  const { getClientSession, logoutLocal } = await import('@/lib/auth/local');
  const read = getClientSession();
  await logoutLocal();
  expect(mockInvoke).toHaveBeenCalledWith('logout_local');
  pending.resolve(alice);
  await expect(read).resolves.toBeNull();
  expect(localStorage.getItem('pharma_session_user')).toBeNull();
});

it('native login switches authoritative identity without accepting an older native session lookup', async () => {
  mockNative = true;
  store(alice);
  const pending = deferred<typeof alice>();
  mockInvoke.mockImplementation((command: string) => command === 'current_local_user'
    ? pending.promise : Promise.resolve({ success: true, user: bob }));
  const { getClientSession, loginLocal } = await import('@/lib/auth/local');
  const old = getClientSession();
  await expect(loginLocal('bob', 'valid secret')).resolves.toMatchObject({ success: true, user: bob });
  pending.resolve(alice);
  await expect(old).resolves.toBeNull();
  expect(JSON.parse(localStorage.getItem('pharma_session_user') || 'null')).toMatchObject(bob);
});
