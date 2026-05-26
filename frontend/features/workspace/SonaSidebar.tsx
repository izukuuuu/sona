'use client';

import { useMemo } from 'react';
import { Dropdown } from 'antd';
import {
  ActionIcon,
  DraggableSideNav,
  Flexbox,
  Menu,
  type MenuItemType,
  Text,
} from '@lobehub/ui';
import {
  Archive,
  ArrowLeft,
  Brain,
  ChevronDown,
  Copy,
  Hash,
  Home,
  Link,
  MessageSquarePlus,
  MoreHorizontal,
  Pencil,
  Puzzle,
  RefreshCw,
  Search,
  Settings,
  Trash2,
} from 'lucide-react';
import type { ApiHealth } from '@/types/sona';

const SIDEBAR_DEFAULT_WIDTH = 360;
const SIDEBAR_MIN_WIDTH = 64;

export type SidebarSession = {
  task_id: string;
  description?: string;
  initial_query?: string;
};

export type SonaSidebarProps = {
  activeTaskId?: string;
  apiError: string;
  expand: boolean;
  health: ApiHealth | null;
  homeMode: boolean;
  settingsMode: boolean;
  settingsTab: 'skills' | 'memory';
  onExpandChange: (expand: boolean) => void;
  onCreateSession: () => void;
  onCloseSettings: () => void;
  onHome: () => void;
  onOpenProfile: () => void;
  onOpenSettings: () => void;
  onOpenSettingsTab: (tab: 'skills' | 'memory') => void;
  onOpenTasks: () => void;
  onRefresh: () => void;
  onSearchChange: (value: string) => void;
  onSelectSession: (taskId: string) => void;
  onSessionAction: (taskId: string, action: string) => void;
  onToday: () => void;
  searchText: string;
  sessionTitle: (session: SidebarSession) => string;
  sessions: SidebarSession[];
};

function SidebarHeader({
  expand,
  onCloseSettings,
  onHome,
  settingsMode,
}: {
  expand: boolean;
  onCloseSettings: () => void;
  onHome: () => void;
  settingsMode: boolean;
}) {
  if (settingsMode) {
    return (
      <Flexbox>
        <Flexbox
          align="center"
          gap={8}
          horizontal
          justify="space-between"
          padding="8px 6px"
          style={{ minHeight: 42, width: '100%' }}
        >
          {expand ? <Text>Settings</Text> : null}
          <ActionIcon icon={ArrowLeft} onClick={onCloseSettings} size="small" title="返回" />
        </Flexbox>
      </Flexbox>
    );
  }

  return (
    <Flexbox>
      <Flexbox
        align="center"
        gap={8}
        horizontal
        justify="flex-start"
        padding={4}
        style={{ margin: 4, cursor: 'pointer' }}
        onClick={onHome}
      >
        <span className="sonaMark">📡</span>
        {expand ? (
          <>
            <Flexbox flex={1} style={{ overflow: 'hidden' }}>
              <Text ellipsis>Sona AI</Text>
            </Flexbox>
            <ActionIcon icon={ChevronDown} size="small" />
          </>
        ) : null}
      </Flexbox>
    </Flexbox>
  );
}

function SidebarBody({
  activeTaskId,
  apiError,
  expand,
  homeMode,
  onCreateSession,
  onHome,
  onOpenProfile,
  onOpenSettingsTab,
  onOpenTasks,
  onSearchChange,
  onSelectSession,
  onSessionAction,
  onToday,
  searchText,
  settingsMode,
  settingsTab,
  sessionTitle,
  sessions,
}: Omit<SonaSidebarProps, 'expand' | 'health' | 'onRefresh' | 'onExpandChange'> & {
  expand: boolean;
}) {
  const selectedKeys = useMemo(() => {
    if (homeMode) return ['home'];
    if (activeTaskId) return [activeTaskId];
    return [];
  }, [activeTaskId, homeMode]);

  const mainItems: MenuItemType[] = useMemo(
    () => [
      { icon: MessageSquarePlus, key: 'new', label: '开启新话题' },
      { icon: Archive, key: 'profile', label: '助理档案' },
      { icon: Home, key: 'home', label: '首页' },
    ],
    [],
  );

  const sessionItems: MenuItemType[] = useMemo(
    () =>
      sessions.map((session) => ({
        icon: Hash,
        key: session.task_id,
        label: expand ? (
          <Flexbox
            align="center"
            horizontal
            justify="space-between"
            style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}
          >
            <Text ellipsis style={{ flex: 1 }}>
              {sessionTitle(session)}
            </Text>
            <Dropdown
              menu={{
                onClick: ({ key, domEvent }) => {
                  domEvent.stopPropagation();
                  onSessionAction(session.task_id, key);
                },
                items: [
                  { icon: <Pencil size={15} />, key: 'rename', label: '重命名' },
                  { icon: <Copy size={15} />, key: 'copyId', label: '复制会话 ID' },
                  { icon: <Link size={15} />, key: 'copyLink', label: '复制链接' },
                  { danger: true, icon: <Trash2 size={15} />, key: 'delete', label: '删除' },
                ],
              }}
              trigger={['click']}
            >
              <span
                className="topicMenu"
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
                role="presentation"
              >
                <MoreHorizontal size={16} />
              </span>
            </Dropdown>
          </Flexbox>
        ) : (
          <Text ellipsis>{sessionTitle(session)}</Text>
        ),
      })),
    [expand, onSessionAction, sessionTitle, sessions],
  );

  const menuItems = useMemo(() => {
    if (expand) {
      return [
        {
          children: mainItems,
          key: 'nav-group',
          label: '导航',
          type: 'group' as const,
        },
        { key: 'divider-nav', style: { marginBlock: 4, opacity: 0 }, type: 'divider' as const },
        {
          children: sessionItems,
          key: 'sessions-group',
          label: '今天',
          type: 'group' as const,
        },
      ];
    }
    return [...mainItems, ...sessionItems];
  }, [expand, mainItems, sessionItems]);

  function handleSelect(key: string) {
    if (key === 'settings-skills') {
      onOpenSettingsTab('skills');
      return;
    }
    if (key === 'settings-memory') {
      onOpenSettingsTab('memory');
      return;
    }
    if (key === 'new') {
      onCreateSession();
      return;
    }
    if (key === 'profile') {
      onOpenProfile();
      return;
    }
    if (key === 'home') {
      onHome();
      return;
    }
    if (key === 'tasks') {
      onOpenTasks();
      return;
    }
    onSelectSession(key);
  }

  if (settingsMode) {
    const settingsItems: MenuItemType[] = [
      { icon: Puzzle, key: 'settings-skills', label: 'Skills' },
      { icon: Brain, key: 'settings-memory', label: 'Memory' },
    ];
    return (
      <Flexbox style={{ flex: 1, minHeight: 0, overflow: 'hidden', position: 'relative' }}>
        <Menu
          inlineCollapsed={!expand}
          items={settingsItems}
          mode="inline"
          selectable
          selectedKeys={[`settings-${settingsTab}`]}
          variant="borderless"
          onSelect={({ key }) => handleSelect(String(key))}
        />
      </Flexbox>
    );
  }

  return (
    <Flexbox style={{ flex: 1, minHeight: 0, overflow: 'hidden', position: 'relative' }}>
      {expand ? (
        <label className="sonaSideNavSearch">
          <Search size={18} />
          <input
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="搜索"
            value={searchText}
          />
        </label>
      ) : null}
      {apiError && expand ? <p className="errorText">{apiError}</p> : null}
      <Menu
        inlineCollapsed={!expand}
        items={menuItems}
        mode="inline"
        selectable
        selectedKeys={selectedKeys}
        variant="borderless"
        onSelect={({ key }) => handleSelect(String(key))}
      />
      {expand ? (
        <button className="sonaSideNavSectionLink" onClick={onToday} type="button">
          刷新话题列表
        </button>
      ) : null}
      {expand ? (
        <button className="sonaSideNavSectionLink" onClick={onOpenTasks} type="button">
          任务 ›
        </button>
      ) : null}
    </Flexbox>
  );
}

function SidebarFooter({
  expand,
  health,
  onOpenSettings,
  onRefresh,
}: {
  expand: boolean;
  health: ApiHealth | null;
  onOpenSettings: () => void;
  onRefresh: () => void;
}) {
  return (
    <Flexbox
      align="center"
      gap={8}
      horizontal={expand}
      justify={expand ? 'space-between' : 'center'}
      padding={8}
      style={{ flexDirection: expand ? 'row' : 'column' }}
    >
      {expand ? (
        <Text fontSize={12} type={health ? 'success' : 'danger'}>
          {health ? '在线' : '离线'}
        </Text>
      ) : (
        <span className={`statusDot ${health ? 'ok' : 'bad'}`} title={health ? '在线' : '离线'} />
      )}
      <Flexbox align="center" gap={2} horizontal>
        <ActionIcon icon={RefreshCw} onClick={onRefresh} size="small" title="刷新" />
        <Dropdown
          menu={{
            onClick: ({ key }) => {
              if (key === 'settings') onOpenSettings();
            },
            items: [{ icon: <Settings size={15} />, key: 'settings', label: 'Settings' }],
          }}
          placement="topLeft"
          trigger={['click']}
        >
          <span className="sonaFooterMenu" onClick={(event) => event.preventDefault()} role="button" tabIndex={0}>
            <MoreHorizontal size={16} />
          </span>
        </Dropdown>
      </Flexbox>
    </Flexbox>
  );
}

export function SonaSidebar(props: SonaSidebarProps) {
  const { expand, health, onCloseSettings, onExpandChange, onOpenSettings, onRefresh, onHome, settingsMode } = props;

  return (
    <DraggableSideNav
      className="sonaSideNav"
      defaultWidth={SIDEBAR_DEFAULT_WIDTH}
      expand={expand}
      minWidth={SIDEBAR_MIN_WIDTH}
      onExpandChange={onExpandChange}
      showHandle
      showHandleHighlight
      body={(renderExpand) => <SidebarBody {...props} expand={renderExpand} />}
      footer={(renderExpand) => (
        <SidebarFooter
          expand={renderExpand}
          health={health}
          onOpenSettings={onOpenSettings}
          onRefresh={onRefresh}
        />
      )}
      header={(renderExpand) => (
        <SidebarHeader
          expand={renderExpand}
          onCloseSettings={onCloseSettings}
          onHome={onHome}
          settingsMode={settingsMode}
        />
      )}
    />
  );
}
