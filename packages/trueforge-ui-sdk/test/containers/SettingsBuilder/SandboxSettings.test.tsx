// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import SandboxSettings from '@/containers/SettingsBuilder/SandboxSettings.js';
import { ServerProvider } from '@/server/ServerContext.js';
import type {
  CreateSandboxProviderRequest,
  SandboxProviderBase,
  SandboxProviderCatalogEntry,
  UpdateSandboxProviderRequest,
} from '@/server/types.js';
import { createMockAgentUIServer, createMockCatalog } from '../../server/mockServer.js';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
  };
});

const catalogEntry: SandboxProviderCatalogEntry = {
  id: 'cat-daytona',
  name: 'Daytona',
  type: 'daytona',
  execTimeoutMs: 300000,
  autoStopIntervalInMinutes: 15,
  autoArchiveIntervalInMinutes: 10080,
  autoDeleteIntervalInMinutes: 43200,
};

function createFakeHost(initial: SandboxProviderBase[] = []) {
  let providers = [...initial];
  let listCalls = 0;
  const created: CreateSandboxProviderRequest[] = [];
  const updated: UpdateSandboxProviderRequest[] = [];

  const sandboxCatalog = {
    getSandboxProviderCatalog: async () => [catalogEntry],
    listSandboxProviders: async () => {
      listCalls += 1;
      return providers;
    },
    createSandboxProvider: async (req: CreateSandboxProviderRequest) => {
      created.push(req);
      const provider: SandboxProviderBase = {
        id: `sb-${req.catalogId}`,
        name: req.name,
        catalogId: req.catalogId,
        isConnected: true,
        imageSync: { status: 'syncing', errorMessage: undefined, isUpdating: true },
        execTimeoutMs: req.execTimeoutMs,
        autoStopIntervalInMinutes: req.autoStopIntervalInMinutes,
        autoArchiveIntervalInMinutes: req.autoArchiveIntervalInMinutes,
        autoDeleteIntervalInMinutes: req.autoDeleteIntervalInMinutes,
      };
      providers = [...providers, provider];
      return provider;
    },
    updateSandboxProvider: async (req: UpdateSandboxProviderRequest) => {
      updated.push(req);
      providers = providers.map(provider =>
        provider.id === req.id
          ? {
              ...provider,
              execTimeoutMs: req.execTimeoutMs,
              autoStopIntervalInMinutes: req.autoStopIntervalInMinutes,
              autoArchiveIntervalInMinutes: req.autoArchiveIntervalInMinutes,
              autoDeleteIntervalInMinutes: req.autoDeleteIntervalInMinutes,
            }
          : provider,
      );
      const next = providers.find(provider => provider.id === req.id);
      if (next === undefined) {
        throw new Error(`Sandbox provider "${req.id}" not found`);
      }
      return next;
    },
  };

  const server = createMockAgentUIServer({
    catalog: createMockCatalog({ sandboxCatalog }),
  });

  return {
    created,
    updated,
    getListCalls: () => listCalls,
    getProviders: () => providers,
    setProviders: (next: SandboxProviderBase[]) => {
      providers = next;
    },
    wrapper: ({ children }: { children: ReactNode }) => <ServerProvider server={server}>{children}</ServerProvider>,
  };
}

describe('SandboxSettings', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('autofills create form from catalog except apiKey', async () => {
    const host = createFakeHost();
    const { wrapper: Wrapper } = host;
    render(
      <Wrapper>
        <SandboxSettings />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(screen.getByText('Daytona')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Configure' }));

    expect(screen.getByLabelText('Exec timeout (ms)')).toHaveProperty('value', '300000');
    expect(screen.getByLabelText('Auto-stop interval (minutes)')).toHaveProperty('value', '15');
    expect(screen.getByLabelText('Auto-archive interval (minutes)')).toHaveProperty('value', '10080');
    expect(screen.getByLabelText('Auto-delete interval (minutes)')).toHaveProperty('value', '43200');
    expect(screen.getByLabelText('API key')).toHaveProperty('value', '');

    fireEvent.change(screen.getByLabelText('API key'), {
      target: { value: 'dtn_secret' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(host.created).toHaveLength(1);
    });
    expect(host.created[0]).toMatchObject({
      catalogId: 'cat-daytona',
      name: 'Daytona',
      type: 'daytona',
      execTimeoutMs: 300000,
      autoStopIntervalInMinutes: 15,
      autoArchiveIntervalInMinutes: 10080,
      autoDeleteIntervalInMinutes: 43200,
      apiKey: 'dtn_secret',
    });
  });

  it('prefills update form and allows saving without re-entering apiKey', async () => {
    const existing: SandboxProviderBase = {
      id: 'sb-1',
      name: 'Daytona',
      catalogId: 'cat-daytona',
      isConnected: true,
      imageSync: { status: 'ready', errorMessage: undefined, isUpdating: false },
      execTimeoutMs: 60000,
      autoStopIntervalInMinutes: 30,
      autoArchiveIntervalInMinutes: 1440,
      autoDeleteIntervalInMinutes: 10080,
    };
    const host = createFakeHost([existing]);
    const { wrapper: Wrapper } = host;
    render(
      <Wrapper>
        <SandboxSettings />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Update' })).toBeTruthy();
    });
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Update' }));

    expect(screen.getByLabelText('Exec timeout (ms)')).toHaveProperty('value', '60000');
    expect(screen.getByLabelText('Auto-stop interval (minutes)')).toHaveProperty('value', '30');
    expect(screen.getByLabelText(/API key/)).toHaveProperty('value', '');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(host.updated).toHaveLength(1);
    });
    expect(host.updated[0]).toEqual({
      id: 'sb-1',
      execTimeoutMs: 60000,
      autoStopIntervalInMinutes: 30,
      autoArchiveIntervalInMinutes: 1440,
      autoDeleteIntervalInMinutes: 10080,
    });
    expect(host.updated[0]).not.toHaveProperty('apiKey');
  });

  it('hides other catalog providers once one is configured', async () => {
    const existing: SandboxProviderBase = {
      id: 'sb-1',
      name: 'Daytona',
      catalogId: 'cat-daytona',
      isConnected: true,
      imageSync: { status: 'ready', errorMessage: undefined, isUpdating: false },
      execTimeoutMs: 60000,
      autoStopIntervalInMinutes: 30,
      autoArchiveIntervalInMinutes: 1440,
      autoDeleteIntervalInMinutes: 10080,
    };
    const host = createFakeHost([existing]);
    const { wrapper: Wrapper } = host;
    render(
      <Wrapper>
        <SandboxSettings />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(screen.getByText('Sandbox providers')).toBeTruthy();
    });
    expect(screen.queryByRole('button', { name: 'Configure' })).toBeNull();
    expect(screen.getByText('One provider is set up. Update it or remove it to switch.')).toBeTruthy();
  });

  it('shows readiness separately from update progress and the last error', async () => {
    const existing: SandboxProviderBase = {
      id: 'sb-1',
      name: 'Daytona',
      catalogId: 'cat-daytona',
      isConnected: true,
      imageSync: {
        status: 'ready',
        errorMessage: 'manifest unknown',
        isUpdating: true,
      },
      execTimeoutMs: 60000,
      autoStopIntervalInMinutes: 30,
      autoArchiveIntervalInMinutes: 1440,
      autoDeleteIntervalInMinutes: 10080,
    };
    const host = createFakeHost([existing]);
    const { wrapper: Wrapper } = host;

    render(
      <Wrapper>
        <SandboxSettings />
      </Wrapper>,
    );

    expect(await screen.findByText('Image ready')).toBeTruthy();
    expect(screen.getByText('Connected')).toBeTruthy();
    expect(screen.getByText('Preparing a newer sandbox image…')).toBeTruthy();
    expect(screen.getByText('manifest unknown')).toBeTruthy();
  });

  it('polls while unavailable and stops once an active image is ready', async () => {
    vi.useFakeTimers();
    const syncing: SandboxProviderBase = {
      id: 'sb-1',
      name: 'Daytona',
      catalogId: 'cat-daytona',
      isConnected: true,
      imageSync: { status: 'failed', errorMessage: 'build failed', isUpdating: false },
      execTimeoutMs: 60000,
      autoStopIntervalInMinutes: 30,
      autoArchiveIntervalInMinutes: 1440,
      autoDeleteIntervalInMinutes: 10080,
    };
    const host = createFakeHost([syncing]);
    const { wrapper: Wrapper } = host;

    render(
      <Wrapper>
        <SandboxSettings />
      </Wrapper>,
    );
    await act(async () => {});
    expect(host.getListCalls()).toBe(1);

    host.setProviders([
      {
        ...syncing,
        imageSync: { status: 'ready', errorMessage: undefined, isUpdating: false },
      },
    ]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(host.getListCalls()).toBe(2);
    expect(screen.getByText('Image ready')).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(host.getListCalls()).toBe(2);
  });

  it('does not poll a ready image solely because its last update failed', async () => {
    vi.useFakeTimers();
    const host = createFakeHost([
      {
        id: 'sb-1',
        name: 'Daytona',
        catalogId: 'cat-daytona',
        isConnected: true,
        imageSync: { status: 'ready', errorMessage: 'manifest unknown', isUpdating: false },
        execTimeoutMs: 60000,
        autoStopIntervalInMinutes: 30,
        autoArchiveIntervalInMinutes: 1440,
        autoDeleteIntervalInMinutes: 10080,
      },
    ]);
    const { wrapper: Wrapper } = host;

    render(
      <Wrapper>
        <SandboxSettings />
      </Wrapper>,
    );
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(host.getListCalls()).toBe(1);
  });
});
