'use client';

import { useEffect, useState } from 'react';

import { Icon } from '../icons/Icon.js';
import '../icons/registerAgentIcons.js';
import { libraryAgentId, useOptionalShellMode } from '../server/ShellModeContext.js';
import type { AgentLibraryEntry, AgentSpec } from '../server/types.js';
import { auiButtonClass } from './lib/buttonClasses.js';
import { cn } from './lib/cn.js';
import { useSearchAgentsList } from './lib/useSearchAgentsList.js';
import { CatalogLogo } from './primitives/CatalogLogo.js';
import { CenteredModal } from './primitives/CenteredModal.js';
import SearchInput from './primitives/SearchInput.js';
import { Skeleton } from './primitives/Skeleton.js';

export type AgentsLibraryProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectAgent?: (agentName: string) => void;
};

type AgentLibraryCardProps = {
  agent: AgentLibraryEntry;
  showEdit: boolean;
  onTry: () => void;
  onEdit: () => void;
};

function modelSegment(modelName: string): string {
  const slash = modelName.lastIndexOf('/');
  return slash >= 0 ? modelName.slice(slash + 1) : modelName;
}

function countLabel({ count, singular }: { count: number; singular: string }): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

/** Hosts may widen `model` with `providerLogo`; base AgentSpec has no logo field. */
function optionalModelLogo(model: AgentSpec['model']): string | undefined {
  if (!('providerLogo' in model)) return undefined;
  const value = Reflect.get(model, 'providerLogo');
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function ModelMark({ logo, className }: { logo?: string; className?: string }) {
  if (logo != null && logo.length > 0) {
    return <CatalogLogo src={logo} alt="" className={cn('shrink-0 rounded object-contain', className)} aria-hidden />;
  }
  // Local fallback only — never fetched; agentSpec rarely carries providerLogo today.
  return <Icon name="ai" className={cn('shrink-0 text-foreground', className)} />;
}

function AgentLibraryCard({ agent, showEdit, onTry, onEdit }: AgentLibraryCardProps) {
  const agentSpec = agent.agentSpec;
  const instructions = agentSpec?.instructions?.trim() ?? '';
  const model = agentSpec?.model;
  const modelName = model?.name;
  const modelLogo = model != null ? optionalModelLogo(model) : undefined;
  const toolCount = agentSpec?.mcpServers?.length ?? 0;
  const skillCount = agentSpec?.skills?.length ?? 0;

  return (
    <div
      role="menuitem"
      className={cn(
        'group flex min-h-[9rem] flex-col justify-between gap-4 rounded-xl border border-border bg-background p-4',
        'transition-colors hover:border-border hover:bg-accent/40',
        'focus-within:border-border focus-within:bg-accent/40',
      )}
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-foreground truncate text-sm font-semibold leading-5">{agent.name}</h3>
          {agentSpec != null && modelName != null ? (
            <p className="text-muted-foreground mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs leading-4">
              <span className="inline-flex min-w-0 max-w-full items-center gap-1">
                <ModelMark logo={modelLogo} className="size-3.5" />
                <span className="truncate">{modelSegment(modelName)}</span>
              </span>
              <span aria-hidden>·</span>
              <span className="shrink-0">{countLabel({ count: toolCount, singular: 'tool' })}</span>
              <span aria-hidden>·</span>
              <span className="shrink-0">{countLabel({ count: skillCount, singular: 'skill' })}</span>
            </p>
          ) : null}
        </div>
        <div className="-mr-1 -mt-0.5 flex shrink-0 items-center gap-0.5">
          {showEdit ? (
            <button
              type="button"
              aria-label={`Edit agent ${agent.name}`}
              className={auiButtonClass({ variant: 'ghost', size: 'sm' })}
              onClick={onEdit}
            >
              <Icon name="pencil" className="size-3.5" />
              Edit
            </button>
          ) : null}
          <button
            type="button"
            aria-label={`Try agent ${agent.name}`}
            className={auiButtonClass({ variant: 'secondary', size: 'sm' })}
            onClick={onTry}
          >
            <Icon name="play" className="size-3.5" />
            Try
          </button>
        </div>
      </div>
      {instructions.length > 0 ? (
        <p className="text-muted-foreground mt-auto line-clamp-2 text-xs leading-5">{instructions}</p>
      ) : (
        <div className="mt-auto" aria-hidden />
      )}
    </div>
  );
}

export function AgentsLibrary({ open, onOpenChange, onSelectAgent }: AgentsLibraryProps) {
  const shell = useOptionalShellMode();
  const [query, setQuery] = useState('');

  const canEdit = shell?.isComposerEnabled === true;
  const agentsListEpoch = shell?.agentsListEpoch ?? 0;

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const { agents, isInitialLoading, isSearching, loadingMore, error, hasMore, listRef, sentinelRef } =
    useSearchAgentsList({
      enabled: open,
      query,
      refreshKey: agentsListEpoch,
    });

  const closeLibrary = () => {
    onOpenChange(false);
    setQuery('');
  };

  const handleTry = (agent: AgentLibraryEntry) => {
    closeLibrary();
    onSelectAgent?.(agent.name);
    shell?.selectLibraryAgent({
      isMutable: false,
      agentId: libraryAgentId(agent),
      agentName: agent.name,
    });
  };

  const handleEdit = (agent: AgentLibraryEntry, agentSpec: AgentSpec) => {
    closeLibrary();
    onSelectAgent?.(agent.name);
    shell?.selectLibraryAgent({
      isMutable: true,
      agentId: libraryAgentId(agent),
      agentName: agent.name,
      agentSpec,
    });
  };

  return (
    <CenteredModal open={open} onOpenChange={onOpenChange} title="Agents Library">
      <div className="bg-muted/40 flex min-h-0 flex-1 flex-col">
        <div className="shrink-0 border-b border-border px-4 py-3">
          <SearchInput query={query} setQuery={setQuery} placeholder="Search agents" />
          {isSearching ? (
            <p className="text-muted-foreground mt-1.5 text-xs" role="status">
              Searching…
            </p>
          ) : null}
        </div>
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-3" role="menu" aria-label="Agents">
          {isInitialLoading ? (
            <div
              className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
              role="status"
              aria-label="Loading agents"
            >
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="h-[8.5rem] w-full rounded-lg" />
              ))}
            </div>
          ) : error ? (
            <p className="text-destructive px-3 py-8 text-center text-sm">{error}</p>
          ) : agents.length === 0 ? (
            <p className="text-muted-foreground px-3 py-8 text-center text-sm">
              {query.trim()
                ? `No agents match "${query.trim()}".`
                : 'No agents yet. Build one in a chat, then save it as an agent.'}
            </p>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {agents.map(agent => {
                  const agentSpec = agent.agentSpec;
                  const showEdit = canEdit && agentSpec != null;
                  return (
                    <AgentLibraryCard
                      key={libraryAgentId(agent)}
                      agent={agent}
                      showEdit={showEdit}
                      onTry={() => handleTry(agent)}
                      onEdit={() => {
                        if (agentSpec != null) handleEdit(agent, agentSpec);
                      }}
                    />
                  );
                })}
              </div>
              {hasMore ? (
                <div ref={sentinelRef} className="flex h-8 shrink-0 items-center justify-center" aria-hidden>
                  {loadingMore ? (
                    <span className="text-muted-foreground text-xs" role="status">
                      Loading more…
                    </span>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </CenteredModal>
  );
}

declare module '../theme/SlotsProvider.js' {
  interface AtomSlots {
    AgentsLibrary: typeof AgentsLibrary;
  }
}
