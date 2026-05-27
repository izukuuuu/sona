'use client';

import { ConfigProvider, ThemeProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import { useSyncExternalStore } from 'react';

const subscribe = () => () => {};
const getClientSnapshot = () => true;
const getServerSnapshot = () => false;

/**
 * Lobe ThemeProvider uses antd-style/emotion; SSR markup order differs from the client.
 * Mount theme only after hydration to avoid mismatch (see ant-app vs emotion global style).
 * ConfigProvider (motion) must wrap the tree on every render — Lobe UI components require it.
 */
export function Providers({ children }: Readonly<{ children: React.ReactNode }>) {
  const themeReady = useSyncExternalStore(subscribe, getClientSnapshot, getServerSnapshot);

  if (!themeReady) {
    return (
      <div className="sonaProvidersShell" suppressHydrationWarning style={{ display: 'contents' }}>
        <ConfigProvider motion={motion}>{children}</ConfigProvider>
      </div>
    );
  }

  return (
    <ConfigProvider motion={motion}>
      <ThemeProvider
        customTheme={{
          neutralColor: 'slate',
          primaryColor: 'blue',
        }}
        theme={{
          token: {
            colorPrimary: '#3f6872',
            colorPrimaryActive: '#2f535c',
            colorPrimaryBg: '#e8eef0',
            colorPrimaryBgHover: '#dbe5e8',
            colorPrimaryBorder: '#bccbd0',
            colorPrimaryHover: '#4d7882',
            colorPrimaryText: '#355f69',
          },
        }}
        enableCustomFonts={false}
        themeMode="light"
      >
        {children}
      </ThemeProvider>
    </ConfigProvider>
  );
}
